/**
 * workers/test/timetable-cron.test.mjs
 *
 * Workers Cron → GitHub repository_dispatch（時間割ポーリングの迂回路）の回帰テスト。
 *
 * ■ なぜこのテストが必要か
 *   GitHubのscheduleが発火しない事象があり、Workers Cronからのdispatchに
 *   切り替えた経緯がある。配線（triggers設定・scheduledハンドラ・
 *   dispatch先・イベント名・timetable.yml側の受け口）のどれかが欠けると
 *   無言で止まるため、3ファイルの整合性を固定する。
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
const WRANGLER_TOML = path.join(__dirname, '..', 'wrangler.toml')
const TIMETABLE_YML = path.join(__dirname, '..', '..', '.github', 'workflows', 'timetable.yml')

const src = fs.readFileSync(WORKER_SRC, 'utf8')
const toml = fs.readFileSync(WRANGLER_TOML, 'utf8')
const yml = fs.readFileSync(TIMETABLE_YML, 'utf8')

test('wrangler.toml: Cron Triggerが10分おきに設定されている', () => {
  assert.match(toml, /\[triggers\]/)
  assert.match(toml, /\*\/10 \* \* \* \*/)
})

test('workers/index.js: scheduledハンドラがdispatchを呼ぶ', () => {
  assert.match(src, /async scheduled\s*\(\s*event\s*,\s*env/)
  assert.match(src, /githubDispatch\(env\)/)
  assert.match(
    src,
    /api\.github\.com\/repos\/Ryuto-dev\/mito1-digital-studenthandbook\/dispatches/
  )
})

test('workers/index.js: dispatchの組み立て（URL・イベント名）', async () => {
  const re = /function\s+buildDispatchRequest\s*\([^)]*\)\s*\{/
  const m = src.match(re)
  assert.ok(m, 'function buildDispatchRequest が見つかりません')
  const start = src.indexOf(m[0])
  let i = start + m[0].length
  let depth = 1
  while (depth > 0 && i < src.length) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  const tmpFile = path.join(__dirname, '.tmp-dispatch.mjs')
  fs.writeFileSync(tmpFile, src.slice(start, i) + '\nexport { buildDispatchRequest }\n')
  const { buildDispatchRequest } = await import(tmpFile)
  fs.unlinkSync(tmpFile)

  const { url, init } = buildDispatchRequest('DUMMY_PAT')
  assert.equal(
    url,
    'https://api.github.com/repos/Ryuto-dev/mito1-digital-studenthandbook/dispatches'
  )
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, 'Bearer DUMMY_PAT')
  assert.deepEqual(JSON.parse(init.body), { event_type: 'timetable-poll' })
})

test('timetable.yml: repository_dispatchの受け口がある', () => {
  assert.match(yml, /repository_dispatch:/)
  assert.match(yml, /timetable-poll/)
})
