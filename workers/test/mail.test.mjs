/**
 * workers/test/mail.test.mjs
 *
 * メール送信（Resend）まわりの回帰テスト。
 *
 * ■ なぜこのテストが必要か
 *   「公欠申請したら『顧問への承認依頼メールの自動送信に失敗しました』が出る」
 *   という不具合があった。原因は2つ:
 *
 *   1. RESEND_FROM が未設定だと、Workers が Resend を呼びもせずに 403 を返していた。
 *      実際には onboarding@resend.dev でも「Resend アカウント所有者宛」なら届くので、
 *      送信を試みる前に諦めるのは誤り。
 *      さらにこの 403 は本当の原因（キー失効・ドメイン未認証など）を隠していた。
 *
 *   2. wrangler.toml の [vars] に RESEND_FROM が書かれていなかったため、
 *      ダッシュボードで手動設定した値が自動デプロイのたびに消えていた。
 *      （[vars] はデプロイ時に全置換されるため）
 *
 *   そこで「送信を諦めないこと」「本当のエラーが利用者まで届くこと」を検証する。
 *
 * 実行:
 *   npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_SRC = path.join(__dirname, '..', 'index.js')
const src = fs.readFileSync(WORKER_SRC, 'utf8')

// --------------------------------------------------------------------------
// workers/index.js から純粋関数だけを抜き出して読み込む
// （push-encrypt.test.mjs と同じ方式）
// --------------------------------------------------------------------------
const EXPORTED = ['sendMail', 'resendHint', 'json', 'applyMergeVars', 'escMailHtml', 'mailBodyToHtml', 'buildHandbookMail']

function extractFunctions(source, names) {
  let out = ''
  for (const name of names) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`)
    const m = source.match(re)
    assert.ok(m, `workers/index.js に function ${name} が見つかりません`)
    const start = source.indexOf(m[0])
    let i = start + m[0].length
    let depth = 1
    while (depth > 0 && i < source.length) {
      const c = source[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      i++
    }
    out += source.slice(start, i) + '\n'
  }
  return out
}

// sendMail はモジュール定数 RESEND_SANDBOX_FROM と CORS に依存する
const PRELUDE = `
const RESEND_SANDBOX_FROM = 'mito1-handbook <onboarding@resend.dev>'
const CORS = {}
`

const tmpFile = path.join(__dirname, '.extracted-mail.mjs')
fs.writeFileSync(
  tmpFile,
  PRELUDE + extractFunctions(src, EXPORTED) + `export { ${EXPORTED.join(', ')} }\n`
)
const W = await import('file://' + tmpFile)
fs.unlinkSync(tmpFile)

/** fetch をモックして、送信されたリクエストを記録する */
function mockFetch(responder) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null })
    return responder(url, init)
  }
  return {
    calls,
    restore: () => { globalThis.fetch = original },
  }
}

const okResponse = () => new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 })

// ==========================================================================

test('RESEND_FROM 未設定でも送信を諦めず、サンドボックス送信元で実際に送る（本丸の回帰）', async () => {
  const m = mockFetch(okResponse)
  try {
    const r = await W.sendMail(
      { RESEND_API_KEY: 're_test' },
      { to: 'teacher@example.com', subject: 's', html: '<p>x</p>' }
    )

    // ★旧実装はここで Resend を一度も呼ばずに 403 を返していた
    assert.equal(m.calls.length, 1, 'Resend API が呼ばれること')
    assert.equal(m.calls[0].url, 'https://api.resend.com/emails')
    assert.equal(m.calls[0].body.from, 'mito1-handbook <onboarding@resend.dev>')
    assert.equal(m.calls[0].body.to[0], 'teacher@example.com')
    assert.equal(r.ok, true, '送信は成功として扱われること')
  } finally {
    m.restore()
  }
})

test('RESEND_FROM が設定されていればその送信元が使われる', async () => {
  const m = mockFetch(okResponse)
  try {
    await W.sendMail(
      { RESEND_API_KEY: 're_test', RESEND_FROM: 'handbook <noreply@mito1-tetyo.tech>' },
      { to: 'teacher@example.com', subject: 's', html: '<p>x</p>' }
    )
    assert.equal(m.calls[0].body.from, 'handbook <noreply@mito1-tetyo.tech>')
  } finally {
    m.restore()
  }
})

test('APIキー未設定なら送信せず、登録方法を案内する', async () => {
  const m = mockFetch(okResponse)
  try {
    const r = await W.sendMail({}, { to: 'a@example.com', subject: 's', html: 'x' })
    assert.equal(m.calls.length, 0, 'キーが無いなら通信しない')
    assert.equal(r.ok, false)
    assert.match(r.hint, /RESEND_API_KEY/)
  } finally {
    m.restore()
  }
})

test('Resend のエラー本文と対処法(hint)が呼び出し側へ伝わる', async () => {
  const m = mockFetch(() => new Response(
    JSON.stringify({ message: 'The mito1-tetyo.tech domain is not verified.' }),
    { status: 403 }
  ))
  try {
    const r = await W.sendMail(
      { RESEND_API_KEY: 're_test', RESEND_FROM: 'x <noreply@mito1-tetyo.tech>' },
      { to: 'teacher@example.com', subject: 's', html: 'x' }
    )
    assert.equal(r.ok, false)
    assert.equal(r.status, 403)
    assert.match(r.detail, /not verified/, '生のエラー本文が保持されること')
    assert.match(r.hint, /ドメイン/, '日本語の対処法が付くこと')
  } finally {
    m.restore()
  }
})

test('ネットワーク例外でも throw せず失敗として返す（申請保存を巻き戻さないため）', async () => {
  const m = mockFetch(() => { throw new Error('connection reset') })
  try {
    const r = await W.sendMail(
      { RESEND_API_KEY: 're_test' },
      { to: 'a@example.com', subject: 's', html: 'x' }
    )
    assert.equal(r.ok, false)
    assert.equal(r.status, 0)
    assert.match(r.detail, /connection reset/)
  } finally {
    m.restore()
  }
})

test('宛先が不正なら Resend を呼ばない', async () => {
  const m = mockFetch(okResponse)
  try {
    const r = await W.sendMail({ RESEND_API_KEY: 're_test' }, { to: '', subject: 's', html: 'x' })
    assert.equal(r.ok, false)
    assert.equal(m.calls.length, 0)
  } finally {
    m.restore()
  }
})

test('resendHint: 状況ごとに異なる対処法を返す', () => {
  assert.match(W.resendHint(401, 'invalid api key', false), /API ?キー/)
  assert.match(W.resendHint(429, 'rate limit', false), /レート制限/)
  assert.match(
    W.resendHint(403, 'You can only send testing emails to your own email address', true),
    /RESEND_FROM/,
  )
})

// ==========================================================================
// 設定ファイル側の回帰
// ==========================================================================

test('wrangler.toml の [vars] に RESEND_FROM がある（デプロイで消える事故の再発防止）', () => {
  const toml = fs.readFileSync(path.join(__dirname, '..', 'wrangler.toml'), 'utf8')
  // [vars] はデプロイのたびに全置換されるため、
  // ダッシュボードで手動設定した変数は自動デプロイで消える。
  // 平文の環境変数は必ずこのファイルに書いておく必要がある。
  const varsMatch = toml.match(/^\[vars\][\s\S]*$/m)
  assert.ok(varsMatch, 'wrangler.toml に [vars] セクションがあること')
  assert.match(varsMatch[0], /^RESEND_FROM\s*=/m, 'RESEND_FROM が [vars] に定義されていること')
})

test('wrangler.toml の FIREBASE_PROJECT_ID が firebase-config.js と一致する', () => {
  const toml = fs.readFileSync(path.join(__dirname, '..', 'wrangler.toml'), 'utf8')
  const cfg  = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'firebase-config.js'), 'utf8'
  )
  const fromToml = toml.match(/^FIREBASE_PROJECT_ID\s*=\s*"([^"]+)"/m)
  const fromCfg  = cfg.match(/projectId:\s*"([^"]+)"/)

  assert.ok(fromToml, 'wrangler.toml に FIREBASE_PROJECT_ID があること（/resolve-token が500になるため）')
  assert.ok(fromCfg, 'firebase-config.js から projectId を読めること')
  assert.equal(fromToml[1], fromCfg[1], 'Worker とフロントで Firebase プロジェクトが一致すること')
})

test('メール送信経路が resend() ではなく sendMail() を使っている', () => {
  // 旧 resend() は Response 風の偽オブジェクトを返す実装で、
  // 呼び出し側が await r.text() する必要があり扱いを誤りやすかった。
  assert.ok(!/\bawait resend\(/.test(src), '古い resend() の呼び出しが残っていないこと')
  const calls = src.match(/await sendMail\(env,/g) || []
  assert.ok(calls.length >= 4, '承認依頼・完了通知・お問い合わせ回答・カスタム送信の4経路が sendMail を使うこと')
})

test('GET /mail/diag が配線されている', () => {
  assert.match(src, /url\.pathname === '\/mail\/diag'/, '診断エンドポイントが存在すること')
})

test('メール失敗レスポンスに hint が必ず含まれる（UIが対処法を出せること）', () => {
  // detail だけ返して hint を落とすと、利用者には英語の生エラーしか見えない。
  const failures = src.match(/json\(\{ error: 'Email send failed'[^}]*\}/g) || []
  assert.equal(failures.length, 4, '承認依頼・完了通知・お問い合わせ回答・カスタム送信の4経路があること')
  for (const f of failures) {
    assert.match(f, /hint: r\.hint/, `hint を返していない箇所がある: ${f}`)
  }
})

// ==========================================================================
// カスタム送信（管理画面メール送信）の回帰
// ==========================================================================

test('POST /send-custom が配線されている', () => {
  assert.match(src, /url\.pathname === '\/send-custom'/, 'カスタム送信エンドポイントが存在すること')
  assert.match(src, /function sendCustom\(/, 'sendCustom ハンドラが存在すること')
})

test('applyMergeVars: {{変数}} を置換し、未知は残す', () => {
  assert.equal(
    W.applyMergeVars('{{お名前}}様、{{Slack招待URL}}へ', { 'お名前': '山田 太郎', 'Slack招待URL': 'https://x' }),
    '山田 太郎様、https://xへ',
  )
  assert.equal(W.applyMergeVars('{{ お名前 }}様', { 'お名前': '山田' }), '山田様')
  assert.equal(W.applyMergeVars('{{未知}}様', {}), '{{未知}}様')
})

test('mailBodyToHtml: 改行・URL・XSS対策', () => {
  const out = W.mailBodyToHtml('こんにちは\nhttps://example.com\n<script>alert(1)</script>')
  assert.match(out, /<br>/)
  assert.match(out, /<a href="https:\/\/example\.com"/)
  assert.ok(!out.includes('<script>'))
})

test('buildHandbookMail: バッジ・見出し・ボタンを含む手帳デザイン', () => {
  const html = W.buildHandbookMail({
    badge: '情報委員会', title: '加入を歓迎します',
    greetingHtml: '山田 様', bodyHtml: '本文',
    buttonLabel: 'Slackに参加', buttonUrl: 'https://example.com/join',
    footerNote: '注記', base: 'https://mito1-tetyo.tech', subtitle: 'デジタル生徒手帳',
  })
  assert.match(html, /情報委員会/)
  assert.match(html, /加入を歓迎します/)
  assert.match(html, /Slackに参加/)
  assert.match(html, /https:\/\/example\.com\/join/)
  assert.match(html, /#1a2744/)
})

// ==========================================================================
// フロント側の回帰（Workers が返す hint が利用者の画面まで届くか）
// ==========================================================================

const readRepoFile = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8')

test('src/cases.js がエラー応答から hint を取り出して呼び出し側へ返す', () => {
  const cases = readRepoFile('src', 'cases.js')
  assert.match(cases, /parsed\.hint/, 'JSON から hint を読むこと')
  assert.match(cases, /emailHint:\s*emailResult\.hint/, 'createCase が emailHint を返すこと')
})

test('index.html が emailHint を優先表示し、HTMLエスケープしている', () => {
  const html = readRepoFile('index.html')
  assert.match(
    html, /result\.emailHint \|\| result\.emailError/,
    'hint を emailError より優先すること',
  )
  // エラー本文は Resend 由来の外部文字列なので、そのまま innerHTML に入れない。
  assert.match(html, /esc\(detailText\)/, 'エスケープしてから埋め込むこと')
})

test('管理画面のお問い合わせ返信も hint を表示する', () => {
  const admin = readRepoFile('src', 'admin', 'main.js')
  assert.match(
    admin, /parsed\.hint \|\| parsed\.detail/,
    '生の JSON ではなく hint をトーストに出すこと',
  )
})
