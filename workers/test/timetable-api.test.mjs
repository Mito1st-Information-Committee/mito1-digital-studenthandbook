/**
 * workers/test/timetable-api.test.mjs
 *
 * 時間割API（外部提供・Key式）の回帰テスト。
 *
 * ■ なぜこのテストが必要か
 *   - APIキーの形式判定の誤りは「正規の利用者を401で弾く」か
 *     「第三者の推測キーを通す」のどちらかに直結する。有料提供のため境界を固定する。
 *   - origin URL（public/timetable/ の直リンク）を一覧JSONに含めると、
 *     Keyなしの推測取得に使われる。漏洩がないことを固定する。
 *   - date/slot の検証漏れはパストラバーサル（history.json改ざん時の
 *     任意パス読み取り）に直結する。拒否条件を固定する。
 *   - 直近7件の丸め誤りは「8件目が取れる／最新が欠ける」などの課金対象の
 *     ズレになる。件数上限の回帰を防ぐ。
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
  'timetableKeyIdFromKey',
  'isValidTimetableKeyFormat',
  'parseTimetableApiKeyFromParts',
  'sha256Hex',
  'timetableTimingSafeEqual',
  'timetableTodayJst',
  'sanitizeTimetableDate',
  'sanitizeTimetableSlot',
  'timetableContentType',
  'filterTimetableList',
  'buildTimetableListResponse',
  'latestDateOfManifest',
  'resolveTimetableOrigin',
  'verifyTimetableApiKey',
]

// 抜き出した関数が依存する定数を事前に差し込む（workers/index.js と同値）。
const PRELUDE = `
const TIMETABLE_API_KEY_RE = /^mt1_[0-9a-f]{12}_[0-9a-f]{48}$/
const TIMETABLE_API_COLLECTION = 'timetableApiKeys'
const TIMETABLE_API_DEFAULT_QUOTA = 1000
const TIMETABLE_API_KEEP = 7
`

function extractFunctions(src, names) {
  let out = ''
  for (const name of names) {
    // 引数に既定値（例: d = new Date()）の括弧が入っても抜き出せるよう括弧対応で走査する
    const headRe = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
    const m = src.match(headRe)
    assert.ok(m, `workers/index.js に function ${name} が見つかりません`)
    let i = src.indexOf(m[0]) + m[0].length
    let paren = 1
    while (paren > 0 && i < src.length) {
      const c = src[i]
      if (c === '(') paren++
      else if (c === ')') paren--
      i++
    }
    assert.ok(paren === 0, `function ${name} の引数リストが閉じていません`)
    while (i < src.length && /\s/.test(src[i])) i++
    assert.ok(src[i] === '{', `function ${name} の本体が見つかりません`)
    const start = src.indexOf(m[0])
    i++ // '{' を消費
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

const src = fs.readFileSync(WORKER_SRC, 'utf8')
const tmpFile = path.join(__dirname, '.tmp-timetable-api.mjs')
fs.writeFileSync(tmpFile, PRELUDE + extractFunctions(src, EXPORTED))
const T = await import(tmpFile)
fs.unlinkSync(tmpFile)

const VALID_KEY = `mt1_${'a1b2c3d4e5f6'}_${'0'.repeat(48)}`

// --------------------------------------------------------------------------
// キー形式
// --------------------------------------------------------------------------
test('isValidTimetableKeyFormat: 正規の形式だけ通す', () => {
  assert.equal(T.isValidTimetableKeyFormat(VALID_KEY), true)
  assert.equal(T.isValidTimetableKeyFormat(''), false)
  assert.equal(T.isValidTimetableKeyFormat(null), false)
  assert.equal(T.isValidTimetableKeyFormat('mt1_short'), false)
  // 大文字hexは不可（発行は小文字hexに統一）
  assert.equal(T.isValidTimetableKeyFormat(`mt1_${'A1B2C3D4E5F6'}_${'0'.repeat(48)}`), false)
  // prefix違い・区切り違いは不可
  assert.equal(T.isValidTimetableKeyFormat(`xx_${'a1b2c3d4e5f6'}_${'0'.repeat(48)}`), false)
  assert.equal(T.isValidTimetableKeyFormat(`mt1-${'a1b2c3d4e5f6'}-${'0'.repeat(48)}`), false)
})

test('timetableKeyIdFromKey: keyIdを取り出す・不正は空文字', () => {
  assert.equal(T.timetableKeyIdFromKey(VALID_KEY), 'a1b2c3d4e5f6')
  assert.equal(T.timetableKeyIdFromKey('invalid'), '')
  assert.equal(T.timetableKeyIdFromKey(''), '')
  assert.equal(T.timetableKeyIdFromKey(null), '')
})

// --------------------------------------------------------------------------
// キーの取り出し優先度（ヘッダ推奨・imgタグ用にクエリも可）
// --------------------------------------------------------------------------
test('parseTimetableApiKeyFromParts: ヘッダ > Bearer > クエリの優先度', () => {
  assert.equal(
    T.parseTimetableApiKeyFromParts({ xApiKey: 'header-key', authorization: 'Bearer bearer-key', queryKey: 'query-key' }),
    'header-key'
  )
  assert.equal(
    T.parseTimetableApiKeyFromParts({ xApiKey: '', authorization: 'Bearer bearer-key', queryKey: 'query-key' }),
    'bearer-key'
  )
  assert.equal(
    T.parseTimetableApiKeyFromParts({ xApiKey: '', authorization: '', queryKey: 'query-key' }),
    'query-key'
  )
  assert.equal(T.parseTimetableApiKeyFromParts({}), '')
})

test('parseTimetableApiKeyFromParts: Bearerの大文字小文字・前後空白を許容', () => {
  assert.equal(T.parseTimetableApiKeyFromParts({ authorization: 'bearer abc123' }), 'abc123')
  assert.equal(T.parseTimetableApiKeyFromParts({ authorization: '  Bearer   abc123  ' }), 'abc123')
  assert.equal(T.parseTimetableApiKeyFromParts({ authorization: 'Basic abc123' }), '')
})

// --------------------------------------------------------------------------
// ハッシュ・定数時間比較
// --------------------------------------------------------------------------
test('sha256Hex: 既知ベクトルと一致する', async () => {
  assert.equal(await T.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const h = await T.sha256Hex(VALID_KEY)
  assert.match(h, /^[0-9a-f]{64}$/)
})

test('timetableTimingSafeEqual: 一致・不一致・長さ違い', () => {
  assert.equal(T.timetableTimingSafeEqual('abc', 'abc'), true)
  assert.equal(T.timetableTimingSafeEqual('abc', 'abd'), false)
  assert.equal(T.timetableTimingSafeEqual('abc', 'abcd'), false)
  assert.equal(T.timetableTimingSafeEqual('', ''), true)
})

// --------------------------------------------------------------------------
// 日付・slot検証
// --------------------------------------------------------------------------
test('timetableTodayJst: UTC→JSTの日付境界', () => {
  assert.equal(T.timetableTodayJst(new Date('2026-01-01T00:00:00Z')), '2026-01-01')
  // 15:00Z = 翌日00:00JST
  assert.equal(T.timetableTodayJst(new Date('2026-01-01T15:00:00Z')), '2026-01-02')
})

test('sanitizeTimetableDate: YYYY-MM-DDのみ・実在日・走査を拒否', () => {
  assert.equal(T.sanitizeTimetableDate('2026-10-01'), '2026-10-01')
  assert.equal(T.sanitizeTimetableDate(' 2026-10-01 '), '2026-10-01')
  assert.equal(T.sanitizeTimetableDate('2026-13-01'), '')
  assert.equal(T.sanitizeTimetableDate('2026-02-29'), '') // 2026は平年
  assert.equal(T.sanitizeTimetableDate('2024-02-29'), '2024-02-29') // 閏年は可
  assert.equal(T.sanitizeTimetableDate('../secret'), '')
  assert.equal(T.sanitizeTimetableDate('history/2026-10-01'), '')
  assert.equal(T.sanitizeTimetableDate(''), '')
  assert.equal(T.sanitizeTimetableDate(null), '')
})

test('sanitizeTimetableSlot: 省略時は0・範囲外は-1', () => {
  assert.equal(T.sanitizeTimetableSlot(undefined), 0)
  assert.equal(T.sanitizeTimetableSlot(''), 0)
  assert.equal(T.sanitizeTimetableSlot('0'), 0)
  assert.equal(T.sanitizeTimetableSlot('3'), 3)
  assert.equal(T.sanitizeTimetableSlot('-1'), -1)
  assert.equal(T.sanitizeTimetableSlot('10'), -1)
  assert.equal(T.sanitizeTimetableSlot('1.5'), -1)
  assert.equal(T.sanitizeTimetableSlot('../../etc'), -1)
})

test('timetableContentType: 拡張子からContent-Type', () => {
  assert.equal(T.timetableContentType('slot-0.jpg'), 'image/jpeg')
  assert.equal(T.timetableContentType('slot-0.jpeg'), 'image/jpeg')
  assert.equal(T.timetableContentType('slot-0.png'), 'image/png')
  assert.equal(T.timetableContentType('slot-0.webp'), 'image/webp')
  assert.equal(T.timetableContentType('slot-0.gif'), 'image/gif')
  assert.equal(T.timetableContentType('slot-0.bin'), 'application/octet-stream')
})

// --------------------------------------------------------------------------
// 直近7件の丸め
// --------------------------------------------------------------------------
function sampleManifest() {
  return {
    updatedAt: '2026-10-01T10:50:39+09:00',
    updatedAtLabel: '2026年10月1日 10:50更新',
    images: [{ file: 'slot-0.jpg', hash: 'h1', bytes: 100 }],
  }
}

function sampleHistory(n, { duplicateLatest = true } = {}) {
  const out = []
  for (let d = 1; d <= n; d++) {
    const day = String(d).padStart(2, '0')
    out.push({
      date: `2026-10-${day}`,
      updatedAt: `2026-10-${day}T10:00:00+09:00`,
      updatedAtLabel: `2026年10月${d}日 10:00更新`,
      dir: `history/2026-10-${day}`,
      images: [{ file: 'slot-0.jpg', hash: `h${d}`, bytes: 100 }],
    })
  }
  // 先頭を最新と同一updatedAtにして重複ケースを作る
  if (duplicateLatest && out.length) {
    out[0] = {
      date: '2026-10-01',
      updatedAt: '2026-10-01T10:50:39+09:00',
      updatedAtLabel: '2026年10月1日 10:50更新',
      dir: 'history/2026-10-01',
      images: [{ file: 'slot-0.jpg', hash: 'h1', bytes: 100 }],
    }
  }
  return out
}

test('filterTimetableList: 最新と重複するentryを除外し過去は6件まで', () => {
  const { latest, history } = T.filterTimetableList(sampleManifest(), sampleHistory(8))
  assert.equal(latest.updatedAt, '2026-10-01T10:50:39+09:00')
  assert.equal(history.length, 6)
  assert.ok(history.every(e => e.updatedAt !== latest.updatedAt))
})

test('filterTimetableList: historyが空でもlatestは返す', () => {
  const { latest, history } = T.filterTimetableList(sampleManifest(), [])
  assert.ok(latest)
  assert.deepEqual(history, [])
})

test('buildTimetableListResponse: origin URLを含まずAPI相対パスのみ', () => {
  const res = T.buildTimetableListResponse(sampleManifest(), sampleHistory(3), 'https://worker.example')
  const dumped = JSON.stringify(res)
  assert.equal(res.ok, true)
  assert.equal(res.keep, 7)
  assert.ok(res.latest)
  assert.equal(res.latest.isLatest, true)
  // origin の配置情報は一切漏らさない
  assert.ok(!dumped.includes('mito1-tetyo.tech'))
  assert.ok(!dumped.includes('/timetable/slot-'))
  assert.ok(!dumped.includes('history/2026'))
  assert.ok(!dumped.includes('slot-0.jpg'))
  // 画像URLはAPI相対パスのみ
  const firstImg = res.history[0].images[0]
  assert.match(firstImg.url, /^https:\/\/worker\.example\/api\/v1\/timetable\/image\?date=.*&slot=0$/)
})

// --------------------------------------------------------------------------
// origin解決
// --------------------------------------------------------------------------
test('resolveTimetableOrigin: date省略時は最新', () => {
  const r = T.resolveTimetableOrigin(sampleManifest(), sampleHistory(2), '', 0)
  assert.equal(r.error, undefined)
  assert.equal(r.dir, '')
  assert.equal(r.file, 'slot-0.jpg')
})

test('resolveTimetableOrigin: historyの日付・slotを解決する', () => {
  const history = sampleHistory(3, { duplicateLatest: false })
  const r = T.resolveTimetableOrigin(sampleManifest(), history, '2026-10-02', 0)
  assert.equal(r.dir, 'history/2026-10-02')
  assert.equal(r.file, 'slot-0.jpg')
})

test('resolveTimetableOrigin: 存在しない日付は404＋候補日を返す', () => {
  const r = T.resolveTimetableOrigin(sampleManifest(), sampleHistory(2), '2020-01-01', 0)
  assert.equal(r.status, 404)
  assert.ok(Array.isArray(r.availableDates))
})

test('resolveTimetableOrigin: dir/fileの不正（走査・拡張子外）を拒否する', () => {
  const evilDir = [{
    date: '2026-10-02',
    updatedAt: '2026-10-02T10:00:00+09:00',
    dir: 'history/../../etc',
    images: [{ file: 'slot-0.jpg' }],
  }]
  assert.equal(T.resolveTimetableOrigin(sampleManifest(), evilDir, '2026-10-02', 0).status, 500)

  const evilFile = [{
    date: '2026-10-02',
    updatedAt: '2026-10-02T10:00:00+09:00',
    dir: 'history/2026-10-02',
    images: [{ file: '../../secret.png' }],
  }]
  assert.equal(T.resolveTimetableOrigin(sampleManifest(), evilFile, '2026-10-02', 0).status, 500)
})

test('resolveTimetableOrigin: 範囲外slotは404', () => {
  const r = T.resolveTimetableOrigin(sampleManifest(), sampleHistory(2), '', 5)
  assert.equal(r.status, 404)
})

// --------------------------------------------------------------------------
// 認証の早期拒否（ネットワーク不要の経路）
// --------------------------------------------------------------------------
test('verifyTimetableApiKey: 未提示・形式不正はネットワークに触れず401', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error('must not fetch') }
  try {
    assert.deepEqual(await T.verifyTimetableApiKey('', {}), { ok: false, status: 401, error: 'api key required (X-API-Key header or ?key=)' })
    assert.deepEqual((await T.verifyTimetableApiKey('invalid', {})).status, 401)
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
