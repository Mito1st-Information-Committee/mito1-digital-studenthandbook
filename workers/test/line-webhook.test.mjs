/**
 * workers/test/line-webhook.test.mjs
 *
 * LINE Webhook（Reply API による時間割・申請状況の問い合わせ応答）の回帰テスト。
 *
 * ■ なぜこのテストが必要か
 *   - 署名検証の誤りは「正規のLINEイベントを403で捨てる」か
 *     「第三者の偽造リクエストでReply APIを悪用される」のどちらかに直結する。
 *     本番でしか気づけない類の不具合のため、HMAC-SHA256の正系・誤系を固定する。
 *   - キーワード判定の変更（例：正規表現の編集ミス）で「時間割」「申請状況」と送っても
 *     無反応になると、ユーザーからは原因不明の沈黙に見える。境界例を固定する。
 *   - Reply上限（5件/回）を超える構成だとAPIが400を返し、replyTokenを
 *     使い捨てる（再送不可）。件数上限の回帰を防ぐ。
 *   - 申請状況カードの進行状況（プログレスバー）がステータスごとに
 *     正しい段階を「済み／進行中」で描けるかを固定する（#31）。
 *
 * 実行:
 *   node --test workers/test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_SRC = path.join(__dirname, '..', 'index.js')

// テスト対象の純粋関数だけをソースから抜き出して読み込む。
const EXPORTED = [
  'isTimetableQuery',
  'isStatusQuery',
  'verifyLineSignature',
  'buildTimetableReplyMessages',
  'buildStatusFlex',
  'pemToDer',
  'bytesToB64url',
  'buildServiceAccountJwt',
  'getFirestoreAccessToken',
  'firestoreFetch',
]

// 抜き出した関数が依存するモジュール定数・状態を事前に差し込む
// （mail.test.mjs の PRELUDE と同じ方式）
const PRELUDE = `
const FIRESTORE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FIRESTORE_SCOPE     = 'https://www.googleapis.com/auth/datastore'
let _firestoreToken = { token: '', expiresAt: 0 }
function resetFirestoreTokenCache() { _firestoreToken = { token: '', expiresAt: 0 } }
`

function extractFunctions(src, names) {
  let out = ''
  for (const name of names) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`)
    const m = src.match(re)
    assert.ok(m, `workers/index.js に function ${name} が見つかりません`)
    const start = src.indexOf(m[0])
    let i = start + m[0].length
    let depth = 1
    while (depth > 0 && i < src.length) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      i++
    }
    out += src.slice(start, i) + '\n'
  }
  return out + `export { ${names.join(', ')} }\n` + `export { resetFirestoreTokenCache }\n`
}

const src = fs.readFileSync(WORKER_SRC, 'utf8')
const tmpFile = path.join(__dirname, '.tmp-line-webhook.mjs')
fs.writeFileSync(tmpFile, PRELUDE + extractFunctions(src, EXPORTED))
const {
  isTimetableQuery, isStatusQuery, verifyLineSignature, buildTimetableReplyMessages, buildStatusFlex,
  pemToDer, bytesToB64url, buildServiceAccountJwt, getFirestoreAccessToken, firestoreFetch,
  resetFirestoreTokenCache,
} = await import(tmpFile)
fs.unlinkSync(tmpFile)

/** トークンキャッシュをリセット（テスト間の干渉を防ぐ） */
function resetTokenCache() {
  resetFirestoreTokenCache()
}

// --------------------------------------------------------------------------
// キーワード判定
// --------------------------------------------------------------------------
test('isTimetableQuery: 「>時間割」の完全一致のみ検出する', () => {
  assert.equal(isTimetableQuery('>時間割'), true)
  assert.equal(isTimetableQuery('＞時間割'), true)
  assert.equal(isTimetableQuery('  >時間割  '), true)
})

test('isTimetableQuery: 無関係・部分一致には反応しない', () => {
  assert.equal(isTimetableQuery('時間割'), false)
  assert.equal(isTimetableQuery('今日の時間割教えて'), false)
  assert.equal(isTimetableQuery('じかんわり'), false)
  assert.equal(isTimetableQuery('timetable'), false)
  assert.equal(isTimetableQuery('>時間割です'), false)
  assert.equal(isTimetableQuery('こんにちは'), false)
  assert.equal(isTimetableQuery(''), false)
  assert.equal(isTimetableQuery(null), false)
  assert.equal(isTimetableQuery(undefined), false)
})

test('isStatusQuery: 「>申請状況」の完全一致のみ検出する', () => {
  assert.equal(isStatusQuery('>申請状況'), true)
  assert.equal(isStatusQuery('＞申請状況'), true)
  assert.equal(isStatusQuery('  >申請状況  '), true)
})

test('isStatusQuery: 無関係・部分一致には反応しない', () => {
  assert.equal(isStatusQuery('申請状況'), false)
  assert.equal(isStatusQuery('申請状況を教えて'), false)
  assert.equal(isStatusQuery('>時間割'), false)
  assert.equal(isStatusQuery('>公欠'), false)
  assert.equal(isStatusQuery('しんせいじょうきょう'), false)
  assert.equal(isStatusQuery(''), false)
  assert.equal(isStatusQuery(null), false)
  assert.equal(isStatusQuery(undefined), false)
})

// --------------------------------------------------------------------------
// 署名検証（HMAC-SHA256）
// --------------------------------------------------------------------------
async function hmacSign(bodyText, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const mac = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(bodyText)
  ))
  return Buffer.from(mac).toString('base64')
}

test('verifyLineSignature: 正規の署名を通す', async () => {
  const body = '{"events":[{"type":"message"}]}'
  const sig = await hmacSign(body, 'test-channel-secret')
  assert.equal(await verifyLineSignature(body, sig, 'test-channel-secret'), true)
})

test('verifyLineSignature: 改ざん・別鍵・欠損を弾く', async () => {
  const body = '{"events":[{"type":"message"}]}'
  const sig = await hmacSign(body, 'test-channel-secret')
  assert.equal(await verifyLineSignature(body + ' ', sig, 'test-channel-secret'), false)
  assert.equal(await verifyLineSignature(body, sig, 'other-secret'), false)
  assert.equal(await verifyLineSignature(body, '', 'test-channel-secret'), false)
  assert.equal(await verifyLineSignature(body, sig, ''), false)
  assert.equal(await verifyLineSignature(body, '!!!not-base64!!!', 'test-channel-secret'), false)
})

// --------------------------------------------------------------------------
// Replyメッセージ組み立て
// --------------------------------------------------------------------------
const BASE = 'https://mito1-tetyo.tech'

test('buildTimetableReplyMessages: 画像＋案内テキストを返す', () => {
  const manifest = {
    updatedAt: '2026-09-15T08:16:52+09:00',
    updatedAtLabel: '2026年9月15日 8:16更新',
    images: [{ file: 'slot-0.jpg', hash: 'abc', bytes: 132763 }],
  }
  const msgs = buildTimetableReplyMessages(manifest, BASE)
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].type, 'image')
  assert.equal(msgs[0].originalContentUrl, `${BASE}/timetable/slot-0.jpg`)
  assert.equal(msgs[0].previewImageUrl, `${BASE}/timetable/slot-0.jpg`)
  assert.equal(msgs[1].type, 'text')
  assert.match(msgs[1].text, /8:16更新/)
})

test('buildTimetableReplyMessages: 上限5件に収める', () => {
  const manifest = {
    updatedAtLabel: 'x',
    images: Array.from({ length: 10 }, (_, i) => ({ file: `slot-${i}.jpg` })),
  }
  const msgs = buildTimetableReplyMessages(manifest, BASE)
  assert.ok(msgs.length <= 5)
  assert.equal(msgs[msgs.length - 1].type, 'text')
})

test('buildTimetableReplyMessages: 未登録時はテキスト案内のみ', () => {
  for (const manifest of [null, {}, { images: [] }]) {
    const msgs = buildTimetableReplyMessages(manifest, BASE)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].type, 'text')
  }
})

// --------------------------------------------------------------------------
// 申請状況カード（#31）
// --------------------------------------------------------------------------
const caseBase = {
  title: '部活動合宿のため公欠',
  reason: '部活動',
  reasonDetail: '',
  dates: ['2026-10-01', '2026-10-02'],
}

test('buildStatusFlex: pending_supervisor は顧問承認待ち・バーが1段階進行', () => {
  const flex = buildStatusFlex({ caseData: { ...caseBase, status: 'pending_supervisor' }, studentName: '山田 太郎', base: BASE })
  assert.equal(flex.type, 'flex')
  assert.equal(flex.contents.type, 'bubble')
  // ヘッダーにステータス表示
  const headerTexts = JSON.stringify(flex.contents.header)
  assert.match(headerTexts, /公欠申請の状況/)
  assert.match(headerTexts, /顧問承認待ち/)
  // 本文（body）のプログレスバー: 申請=済み(ネイビー)、顧問承認=進行中(琥珀)
  const barBoxes = flex.contents.body.contents.find(c => c.type === 'box' && c.layout === 'horizontal' && c.contents?.[0]?.contents?.[0]?.height === '4px')
  assert.ok(barBoxes, 'プログレスバーが存在すること')
  const barColors = barBoxes.contents.map(s => s.contents[0].backgroundColor)
  assert.equal(barColors[0], '#1A2744') // 申請: 済み
  assert.equal(barColors[1], '#E8A33D') // 顧問承認: 進行中
  assert.equal(barColors[2], '#EEEEE9') // 担任承認: 未
  assert.equal(barColors[3], '#EEEEE9') // 完了: 未
})

test('buildStatusFlex: pending_homeroom は担任承認待ち・バーが2段階進行', () => {
  const flex = buildStatusFlex({ caseData: { ...caseBase, status: 'pending_homeroom' }, studentName: '山田 太郎', base: BASE })
  assert.match(JSON.stringify(flex.contents.header), /担任承認待ち/)
  const barBoxes = flex.contents.body.contents.find(c => c.type === 'box' && c.layout === 'horizontal' && c.contents?.[0]?.contents?.[0]?.height === '4px')
  const barColors = barBoxes.contents.map(s => s.contents[0].backgroundColor)
  assert.equal(barColors[0], '#1A2744')
  assert.equal(barColors[1], '#1A2744')
  assert.equal(barColors[2], '#E8A33D')
  assert.equal(barColors[3], '#EEEEE9')
})

test('buildStatusFlex: approved は承認完了・バーが全段階済み', () => {
  const flex = buildStatusFlex({ caseData: { ...caseBase, status: 'approved' }, studentName: '山田 太郎', base: BASE })
  assert.match(JSON.stringify(flex.contents.header), /承認完了/)
  const barBoxes = flex.contents.body.contents.find(c => c.type === 'box' && c.layout === 'horizontal' && c.contents?.[0]?.contents?.[0]?.height === '4px')
  const barColors = barBoxes.contents.map(s => s.contents[0].backgroundColor)
  assert.ok(barColors.every(c => c === '#1A2744'), '全段階が済み色であること')
})

test('buildStatusFlex: rejected は差し戻し・差し戻し理由を表示', () => {
  const flex = buildStatusFlex({
    caseData: { ...caseBase, status: 'rejected', rejectedReason: '書類の添付がありません' },
    studentName: '山田 太郎', base: BASE,
  })
  assert.match(JSON.stringify(flex.contents.header), /差し戻し/)
  assert.match(JSON.stringify(flex.contents.body), /書類の添付がありません/)
  // 差し戻し時はプログレスバーは「済み＝申請のみ」のままにする
  const barBoxes = flex.contents.body.contents.find(c => c.type === 'box' && c.layout === 'horizontal' && c.contents?.[0]?.contents?.[0]?.height === '4px')
  const barColors = barBoxes.contents.map(s => s.contents[0].backgroundColor)
  assert.equal(barColors[0], '#1A2744')
  assert.ok(barColors.slice(1).every(c => c === '#EEEEE9'), '申請以降は未進行')
})

test('buildStatusFlex: マイページへの導線が含まれる', () => {
  const flex = buildStatusFlex({ caseData: { ...caseBase, status: 'pending_homeroom' }, studentName: '山田 太郎', base: BASE })
  assert.match(JSON.stringify(flex.contents.footer), /マイページで確認/)
  assert.match(JSON.stringify(flex.contents.footer), new RegExp(`${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/#mypage`))
})

// LINEのReply APIは Box の contents（空配列可）を必須とする。
// 省略すると 400 "A message in the request body is invalid" になり、
// Webhook側はエラーを握りつぶすため「既読だけ付いて何も返らない」症状になる（#31回帰防止）。
test('buildStatusFlex: 全ての Box に contents が指定されている', () => {
  const checkBoxes = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((c, i) => checkBoxes(c, `${path}/${i}`))
      return
    }
    if (!node || typeof node !== 'object') return
    if (node.type === 'box') {
      assert.ok(
        Object.prototype.hasOwnProperty.call(node, 'contents'),
        `Box に contents が必須: ${path}`
      )
      assert.ok(Array.isArray(node.contents), `Box.contents は配列: ${path}`)
    }
    for (const [k, v] of Object.entries(node)) checkBoxes(v, `${path}/${k}`)
  }
  for (const status of ['pending_supervisor', 'pending_homeroom', 'approved', 'rejected']) {
    const flex = buildStatusFlex({ caseData: { ...caseBase, status }, studentName: '山田 太郎', base: BASE })
    checkBoxes(flex.contents, 'contents')
  }
})

// --------------------------------------------------------------------------
// Firestore 管理者アクセス（サービスアカウント OAuth2）
// 未認証のままだと users の list/get が 403 になり「未連携」扱いになる（#31）
// --------------------------------------------------------------------------

// テスト用 RSA 鍵ペア（PKCS#8 PEM）を生成する
async function generateRsaKey() {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  )
  const privateDer = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))
  const publicDer  = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey))
  const pem = (der, label) =>
    `-----BEGIN ${label}-----\n${Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END ${label}-----\n`
  return {
    privateKey: kp.privateKey,
    publicKey:  kp.publicKey,
    privatePem: pem(privateDer, 'PRIVATE KEY'),
    publicPem:  pem(publicDer, 'PUBLIC KEY'),
  }
}

test('pemToDer: PEM ヘッダ/フッタを除去して DER バイト列に変換する', () => {
  const key = { privatePem: '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n' }
  const der = pemToDer(key.privatePem)
  assert.equal(Buffer.from(der).toString('base64'), 'QUJD')
})

test('buildServiceAccountJwt: RS256 署名が公開鍵で検証でき、claims が正しい', async () => {
  const key = await generateRsaKey()
  const sa = { client_email: 'svc@timer-c0ed3.iam.gserviceaccount.com', private_key: key.privatePem }
  const jwt = await buildServiceAccountJwt(sa, 1_700_000_000)

  const [h, p, s] = jwt.split('.')
  assert.ok(h && p && s, 'JWT は header.payload.signature の3部構成であること')

  // 署名を公開鍵で検証
  const pubB64 = key.publicPem.replace(/-----BEGIN PUBLIC KEY-----/, '').replace(/-----END PUBLIC KEY-----/, '').replace(/\s+/g, '')
  const pubKey = await crypto.subtle.importKey(
    'spki', Buffer.from(pubB64, 'base64'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  )
  const sigB64url = s.replace(/-/g, '+').replace(/_/g, '/')
  const sig = Uint8Array.from(Buffer.from(sigB64url, 'base64'))
  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' }, pubKey, sig, new TextEncoder().encode(`${h}.${p}`)
  )
  assert.equal(ok, true, 'RS256 署名が公開鍵で検証できること')

  // claims の内容を確認
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
  assert.equal(claims.iss, sa.client_email)
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token')
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/datastore')
  assert.equal(claims.exp - claims.iat, 3600)
})

test('getFirestoreAccessToken: サービスアカウント JSON からトークンを取得し、Authorization ヘッダに付与する', async () => {
  resetTokenCache()
  const key = await generateRsaKey()
  const sa = {
    type: 'service_account',
    project_id: 'timer-c0ed3',
    private_key: key.privatePem,
    client_email: 'svc@timer-c0ed3.iam.gserviceaccount.com',
  }
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }), { status: 200 })
    }
    if (String(url).includes('firestore.googleapis.com')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 404 })
  }
  try {
    const token = await getFirestoreAccessToken({ FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) })
    assert.equal(token, 'fake-access-token')
    assert.equal(calls.filter(c => String(c.url).includes('oauth2.googleapis.com/token')).length, 1, 'トークン交換が1回だけ行われること')

    const res = await firestoreFetch({ FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) },
      'https://firestore.googleapis.com/v1/projects/timer-c0ed3/databases/(default)/documents:runQuery',
      { method: 'POST', body: '{}' }
    )
    assert.ok(res.ok)
    const authHeader = calls.filter(c => String(c.url).includes('firestore.googleapis.com')).pop().init.headers['Authorization']
    assert.equal(authHeader, 'Bearer fake-access-token', 'Firestore へ Bearer トークンが付与されること')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('getFirestoreAccessToken: サービスアカウント未設定ならトークンを取得しない（従来挙動維持）', async () => {
  resetTokenCache()
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    return new Response(JSON.stringify({}), { status: 200 })
  }
  try {
    const token = await getFirestoreAccessToken({})
    assert.equal(token, '')
    assert.equal(calls.length, 0, '未設定時は外部へ一切アクセスしないこと')
  } finally {
    globalThis.fetch = originalFetch
  }
})
