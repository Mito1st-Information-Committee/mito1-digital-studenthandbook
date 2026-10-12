/**
 * workers/test/push-encrypt.test.mjs
 *
 * Web Push (aes128gcm / RFC8188) 暗号化の回帰テスト。
 *
 * ■ なぜこのテストが必要か
 *   「/push/send が 200 を返すのに iPhone に通知が出ない」不具合があった。
 *   原因はレコードのパディング形式が aes128gcm(RFC8188) ではなく
 *   古い aesgcm(draft-04) のままだったこと。
 *   AES-GCM の認証タグ自体は正しいので Apple は 201 を返してしまい、
 *   復号後のパースに失敗するブラウザ側で黙って捨てられる＝
 *   サーバーのログでは一切検知できないタイプのバグだった。
 *
 *   そのため「送信できたか」ではなく
 *   「ブラウザが実際にデコードして JSON にできるか」を検証する。
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

// --------------------------------------------------------------------------
// workers/index.js は Cloudflare Worker のエントリ（export default fetch）なので、
// テスト対象の純粋関数だけをソースから抜き出して読み込む。
// --------------------------------------------------------------------------
// NOTE: encryptAes128gcm が内部で呼ぶヘルパーもすべて列挙すること。
//       抜けていると「関数は見つかるが実行時に ReferenceError」になる。
const EXPORTED = [
  'encryptAes128gcm', 'vapidJwt',
  'generateEcdhKeyPair', 'exportRawPublicKey',
  'concatBytes', 'hkdfExtract', 'hkdfExpand', 'b64urlToBytes', 'bytesToB64url',
]

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
  return out + `export { ${names.join(', ')} }\n`
}

const tmpFile = path.join(__dirname, '.extracted.mjs')
fs.writeFileSync(tmpFile, extractFunctions(fs.readFileSync(WORKER_SRC, 'utf8'), EXPORTED))
const W = await import(pathToFileUrl(tmpFile))
fs.unlinkSync(tmpFile)

function pathToFileUrl(p) {
  return 'file://' + p
}

const te = new TextEncoder()

/** ブラウザ役の購読鍵ペアを作る（iPhone の PushSubscription 相当） */
async function makeSubscriptionKeys() {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  )
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
  const authSecret = crypto.getRandomValues(new Uint8Array(16))
  return {
    privateKey: keys.privateKey,
    pubRaw,
    authSecret,
    p256dh: W.bytesToB64url(pubRaw),
    auth: W.bytesToB64url(authSecret),
  }
}

/**
 * ブラウザ（Service Worker）側の aes128gcm デコーダを RFC8188 どおりに実装したもの。
 * 実機の Safari / Chrome が行う処理と同じ手順で復号・パディング除去する。
 */
async function decodeAsBrowser(body, sub) {
  assert.ok(body.length > 21, 'ヘッダが短すぎます')

  const salt = body.slice(0, 16)
  const rs = (body[16] << 24) | (body[17] << 16) | (body[18] << 8) | body[19]
  const idlen = body[20]
  const serverPub = body.slice(21, 21 + idlen)
  const ciphertext = body.slice(21 + idlen)

  const serverKey = await crypto.subtle.importKey(
    'raw', serverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  )
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: serverKey }, sub.privateKey, 256
  ))

  const prkKey = await W.hkdfExtract(sub.authSecret, shared)
  const keyInfo = W.concatBytes(
    te.encode('WebPush: info'), new Uint8Array([0]), sub.pubRaw, serverPub
  )
  const ikm = await W.hkdfExpand(prkKey, keyInfo, 32)
  const prk = await W.hkdfExtract(salt, ikm)
  const cek = await W.hkdfExpand(
    prk, W.concatBytes(te.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16
  )
  const nonce = await W.hkdfExpand(
    prk, W.concatBytes(te.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12
  )

  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt'])
  const record = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce }, cekKey, ciphertext
  ))

  // RFC8188 §2: 末尾のパディング(0x00)を読み飛ばし、デリミタを確認する
  let i = record.length - 1
  while (i >= 0 && record[i] === 0x00) i--
  assert.ok(i >= 0, 'レコードが全て0x00でデリミタがありません')
  const delimiter = record[i]

  return {
    rs,
    keyIdLength: idlen,
    delimiter,
    text: new TextDecoder().decode(record.slice(0, i)),
  }
}

// ==========================================================================

test('aes128gcm: ブラウザが復号すると元のJSONに戻る（回帰: 200が返るのに通知が出ない）', async () => {
  const sub = await makeSubscriptionKeys()
  const message = JSON.stringify({
    title: 'テスト通知',
    body: 'PWAプッシュ通知は正常に届いています',
    url: '/#mypage',
    tag: 'mito1-notify',
  })

  const { body } = await W.encryptAes128gcm(sub.p256dh, sub.auth, te.encode(message))
  const decoded = await decodeAsBrowser(body, sub)

  // ★本丸: 最終レコードのデリミタは必ず 0x02。
  //   0x02 以外だとブラウザがパースに失敗し push イベントが配送されない。
  assert.equal(decoded.delimiter, 0x02, '最終レコードのパディングデリミタは0x02であるべき')
  assert.equal(decoded.text, message, '復号結果が元のメッセージと一致すること')

  // Service Worker の e.data.json() が成立すること
  const parsed = JSON.parse(decoded.text)
  assert.equal(parsed.title, 'テスト通知')
  assert.equal(parsed.url, '/#mypage')
})

test('aes128gcm: ヘッダが salt(16)+rs(4)+idlen(1)+公開鍵(65) の形式である', async () => {
  const sub = await makeSubscriptionKeys()
  const { body } = await W.encryptAes128gcm(sub.p256dh, sub.auth, te.encode('{"a":1}'))
  const decoded = await decodeAsBrowser(body, sub)

  assert.equal(decoded.rs, 4096, 'record size は 4096')
  assert.equal(decoded.keyIdLength, 65, 'keyid は非圧縮P-256公開鍵の65バイト')
  assert.equal(body[21], 0x04, 'サーバー公開鍵は非圧縮形式(0x04始まり)')
})

test('aes128gcm: 先頭2バイトに古いaesgcm形式のパディング長が混入していない', async () => {
  const sub = await makeSubscriptionKeys()
  const message = '{"title":"x"}'
  const { body } = await W.encryptAes128gcm(sub.p256dh, sub.auth, te.encode(message))
  const decoded = await decodeAsBrowser(body, sub)

  // 旧実装は平文の前に [0x00,0x00] を付けていたため、
  // 復号結果が "\u0000\u0000{...}" になり JSON.parse が失敗していた。
  assert.ok(decoded.text.startsWith('{'), '復号結果はJSONとして直接始まること')
  assert.doesNotThrow(() => JSON.parse(decoded.text))
})

test('aes128gcm: マルチバイト(日本語)でも本文が壊れない', async () => {
  const sub = await makeSubscriptionKeys()
  const message = JSON.stringify({ title: '承認完了', body: '申請が承認されました。🎉' })
  const { body } = await W.encryptAes128gcm(sub.p256dh, sub.auth, te.encode(message))
  const decoded = await decodeAsBrowser(body, sub)
  assert.equal(decoded.text, message)
})

test('aes128gcm: 暗号文はAppleの4KBペイロード上限に収まる', async () => {
  const sub = await makeSubscriptionKeys()
  const message = JSON.stringify({
    title: '承認完了', body: 'あ'.repeat(200), url: '/#mypage', tag: 'mito1-notify',
  })
  const { body } = await W.encryptAes128gcm(sub.p256dh, sub.auth, te.encode(message))
  assert.ok(body.length <= 4096, `ペイロードが4096バイトを超えています: ${body.length}`)
})

test('aes128gcm: 毎回異なるsaltとエフェメラル鍵が使われる', async () => {
  const sub = await makeSubscriptionKeys()
  const a = await W.encryptAes128gcm(sub.p256dh, sub.auth, te.encode('{"a":1}'))
  const b = await W.encryptAes128gcm(sub.p256dh, sub.auth, te.encode('{"a":1}'))
  assert.notDeepEqual(a.body.slice(0, 16), b.body.slice(0, 16), 'saltは毎回ランダム')
  assert.notDeepEqual(a.body.slice(21, 86), b.body.slice(21, 86), 'サーバー鍵は毎回新規')
})

test('VAPID JWT: ES256署名が公開鍵で検証できる', async () => {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  )
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
  const pubB64 = W.bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))

  const jwt = await W.vapidJwt('https://web.push.apple.com', 'mailto:a@example.com', pubB64, jwk.d)
  const [h, p, s] = jwt.split('.')

  const header = JSON.parse(Buffer.from(h, 'base64url').toString())
  assert.equal(header.alg, 'ES256')
  assert.equal(header.typ, 'JWT')

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
  assert.equal(claims.aud, 'https://web.push.apple.com', 'audはスキーム+ホストのみ')
  assert.equal(claims.sub, 'mailto:a@example.com', 'subはmailto:またはhttps:のURL')
  // Appleは有効期限24時間以内を要求する
  assert.ok(claims.exp > Math.floor(Date.now() / 1000), 'expは未来')
  assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 24 * 3600, 'expは24時間以内')

  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey,
    W.b64urlToBytes(s), te.encode(`${h}.${p}`)
  )
  assert.ok(ok, 'JWT署名が検証できること')
})

test('VAPID JWT: 不正な公開鍵は拒否される', async () => {
  await assert.rejects(
    () => W.vapidJwt('https://web.push.apple.com', 'mailto:a@b.c', W.bytesToB64url(new Uint8Array(10)), 'x'),
    /invalid VAPID_PUBLIC_KEY/,
  )
})

test('フロントの VAPID_PUBLIC_KEY は有効な非圧縮P-256公開鍵である', async () => {
  const pushSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'push.js'), 'utf8')
  const m = pushSrc.match(/VAPID_PUBLIC_KEY\s*=\s*\n?\s*'([A-Za-z0-9_-]+)'/)
  assert.ok(m, 'src/push.js から VAPID_PUBLIC_KEY を読み取れること')

  const bytes = W.b64urlToBytes(m[1])
  assert.equal(bytes.length, 65, '非圧縮P-256公開鍵は65バイト')
  assert.equal(bytes[0], 0x04, '非圧縮形式は0x04始まり')

  // 点が本当に P-256 曲線上にあるか (y^2 == x^3 - 3x + b mod p)
  const P = (1n << 256n) - (1n << 224n) + (1n << 192n) + (1n << 96n) - 1n
  const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
  const toBig = (u8) => BigInt('0x' + Buffer.from(u8).toString('hex'))
  const x = toBig(bytes.slice(1, 33))
  const y = toBig(bytes.slice(33, 65))
  assert.equal((y * y) % P, (((x * x % P) * x % P) + (P - 3n) * x % P + B) % P,
    'VAPID公開鍵がP-256曲線上の点であること')
})
