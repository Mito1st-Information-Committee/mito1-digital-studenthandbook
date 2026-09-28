/**
 * workers/test/theme.test.mjs
 *
 * Issue #103: ダークモード自動判別の回帰テスト。
 *
 * 仕様:
 *  - テーマ指定は localStorage `mito1_theme` に保存する 3 値: auto / light / dark。
 *    未設定（= 今までテーマを触っていない利用者）は auto として扱う。
 *  - auto のときは端末のダークモード設定（prefers-color-scheme）に追従する。
 *  - light / dark は利用者の明示的な指定なので、端末設定より優先する。
 *  - <head> の初期適用スクリプトは「最初の描画からちらつかせない」ために
 *    src/theme.js と同じ判定で <html data-theme> を確定させる。
 *
 * 実行:
 *   node --test workers/test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import {
  THEME_STORAGE_KEY,
  THEME_MODES,
  THEME_COLORS,
  SUN_SVG,
  MOON_SVG,
  normalizeThemeMode,
  resolveThemeMode,
  nextThemeLabel,
  themeModeLabel,
  themeToggleIcon,
} from '../../src/theme.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const readRepoFile = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8')

// =============================================
// テーマ指定の正規化
// =============================================
test('未設定・不正値は「自動」として扱う（今までテーマを触っていない利用者）', () => {
  assert.equal(THEME_STORAGE_KEY, 'mito1_theme')
  assert.equal(normalizeThemeMode(null), THEME_MODES.AUTO)
  assert.equal(normalizeThemeMode(undefined), THEME_MODES.AUTO)
  assert.equal(normalizeThemeMode(''), THEME_MODES.AUTO)
  assert.equal(normalizeThemeMode('dark-mode'), THEME_MODES.AUTO)
  assert.equal(normalizeThemeMode(true), THEME_MODES.AUTO)
})

test('保存済みの light / dark / auto はそのまま受け付ける', () => {
  assert.equal(normalizeThemeMode(THEME_MODES.AUTO), THEME_MODES.AUTO)
  assert.equal(normalizeThemeMode(THEME_MODES.LIGHT), THEME_MODES.LIGHT)
  assert.equal(normalizeThemeMode(THEME_MODES.DARK), THEME_MODES.DARK)
})

// =============================================
// 解決（このテストの中心: 端末のダークモード自動判別）
// =============================================
test('自動のときは端末がダークモードならダーク、ライトならライトになる', () => {
  assert.equal(resolveThemeMode(null, true), 'dark')
  assert.equal(resolveThemeMode(null, false), 'light')
  assert.equal(resolveThemeMode('auto', true), 'dark')
  assert.equal(resolveThemeMode('auto', false), 'light')
})

test('明示的な light / dark は端末設定より優先する（既存の dark / light 保存値を引き継ぐ）', () => {
  assert.equal(resolveThemeMode('dark', false), 'dark', 'ライト端末でも dark 指定は dark')
  assert.equal(resolveThemeMode('light', true), 'light', 'ダーク端末でも light 指定は light')
})

// =============================================
// ラベル
// =============================================
test('切替ボタンのアイコンは「現在の表示と逆」になる（ダーク表示なら太陽）', () => {
  assert.equal(themeToggleIcon('dark'), SUN_SVG)
  assert.equal(themeToggleIcon('light'), MOON_SVG)
  assert.notEqual(SUN_SVG, MOON_SVG)
  for (const svg of [SUN_SVG, MOON_SVG]) {
    assert.match(svg, /^<[a-z]+ /, 'SVG要素の文字列であること')
  }
})

test('切替ボタンのラベルは「次に切り替えると何になるか」を示す', () => {
  assert.equal(nextThemeLabel('dark'), 'ライトモード')
  assert.equal(nextThemeLabel('light'), 'ダークモード')
})

test('設定シートのラベルは現在の指定を示し、自動のときは実際の表示テーマを補足する', () => {
  assert.equal(themeModeLabel('dark', true), 'ダーク')
  assert.equal(themeModeLabel('dark', false), 'ダーク')
  assert.equal(themeModeLabel('light', true), 'ライト')
  assert.equal(themeModeLabel(null, true), '自動（ダーク）')
  assert.equal(themeModeLabel(null, false), '自動（ライト）')
})

test('ステータスバー色は解決後のテーマに合わせている', () => {
  assert.equal(THEME_COLORS[resolveThemeMode(null, true)], THEME_COLORS.dark)
  assert.equal(THEME_COLORS[resolveThemeMode(null, false)], THEME_COLORS.light)
  assert.notEqual(THEME_COLORS.light, THEME_COLORS.dark)
})

// =============================================
// index.html <head> の初期適用スクリプト
// =============================================
/**
 * index.html の <head> にあるテーマ初期適用のインラインスクリプトを取り出す。
 * src/theme.js は module なので head で同期実行できず、
 * 「最初の描画からちらつかせない」ための初期適用はインラインで持つ必要がある。
 */
function extractHeadBootstrap() {
  const html = readRepoFile('index.html')
  const head = html.slice(0, html.indexOf('<body>'))
  const scripts = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  return scripts.find(s => s.includes('prefers-color-scheme'))
}

test('index.html の head に prefers-color-scheme を読む初期適用スクリプトがある', () => {
  const bootstrap = extractHeadBootstrap()
  assert.ok(bootstrap, 'head にテーマ初期適用のインラインスクリプトがあること')
  // スタイルシートより前に実行される = 描画前からテーマが確定している
  const html = readRepoFile('index.html')
  const at = html.indexOf(bootstrap.trim().slice(0, 40))
  const firstCss = html.indexOf('<link rel="stylesheet"')
  assert.ok(at > -1 && firstCss > -1 && at < firstCss,
    '初期適用スクリプトは最初の <link rel="stylesheet"> より前に置くこと（描画時にちらつかせないため）')
})

test('head の初期適用が src/theme.js と同じ判定で <html data-theme> を決める', () => {
  const bootstrap = extractHeadBootstrap()
  assert.ok(bootstrap)

  for (const stored of [null, '', 'auto', 'light', 'dark', 'unknown-value']) {
    for (const prefersDark of [true, false]) {
      const attrs = {}
      const sandbox = {
        localStorage: { getItem: (k) => (k === THEME_STORAGE_KEY ? stored : null) },
        window: { matchMedia: (q) => ({ matches: q === '(prefers-color-scheme: dark)' && prefersDark }) },
        document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v } } },
      }
      vm.runInNewContext(bootstrap, sandbox)

      assert.equal(attrs['data-theme'], resolveThemeMode(stored, prefersDark),
        `保存値=${JSON.stringify(stored)} / 端末ダーク=${prefersDark} のときの一致`)
      assert.ok(attrs['data-theme'] === 'dark' || attrs['data-theme'] === 'light',
        'data-theme は dark か light のどちらかであること')
    }
  }
})

// =============================================
// フロント側の配線
// =============================================
test('index.html がテーマの初期適用を 3 値（自動/ライト/ダーク）で扱えるようにしている', () => {
  const html = readRepoFile('index.html')
  assert.match(html, /from '\/src\/theme\.js'/, 'src/theme.js を import すること')
  assert.match(html, /<meta name="color-scheme" content="light dark">/,
    'color-scheme  を宣言すること（ブラウザ既定UIをテーマに合わせる）')
  // 端末のダークモード設定の変化に追従する
  assert.match(html, /PREFERS_DARK_QUERY/, 'prefers-color-scheme のメディアクエリを使うこと')
  assert.match(html, /addEventListener\('change'/, 'メディアクエリの change を購読すること')
  // ヘッダー / moreシートの2値切替と、設定シートの3択の両方を公開する
  assert.match(html, /window\.toggleTheme\s*=/, 'ヘッダー・moreシート用の toggleTheme を公開すること')
  assert.match(html, /window\.setThemeMode\s*=/, '設定シート用の setThemeMode を公開すること')
  for (const mode of ['auto', 'light', 'dark']) {
    assert.match(html, new RegExp(`data-theme-mode="${mode}"`),
      `設定シートに「${mode}」の選択肢があること`)
  }
  // 選択中の選択肢は見た目の .on だけでなく aria-pressed でも伝える
  assert.match(html, /btn\.classList\.toggle\('on', on\)/, '選択中の選択肢に .on を付けること')
  assert.match(html, /setAttribute\('aria-pressed', on \? 'true' : 'false'\)/,
    '選択中の選択肢を aria-pressed で伝えること')
})

test('CSS のテーマ切替は data-theme="dark" だけを対象にしている', () => {
  // 初期適用スクリプトはライト時に data-theme="" ではなく "light" を書く。
  // data-theme="dark" 以外のセレクタが混入するとライト表示が崩れるため監視する。
  for (const file of ['tokens.css', 'layout.css', 'home.css', 'search.css',
    'articles.css', 'components.css', 'responsive.css']) {
    const css = readRepoFile('src', 'css', file)
    for (const m of css.matchAll(/\[data-theme="([^"]+)"\]/g)) {
      assert.equal(m[1], 'dark', `src/css/${file} の [data-theme="${m[1]}"] は想定外`)
    }
  }
})

test('tokens.css が解決後のテーマに color-scheme を合わせている', () => {
  const tokens = readRepoFile('src', 'css', 'tokens.css')
  assert.match(tokens, /:root\s*\{[^}]*color-scheme:\s*light/s,
    ':root は既定で color-scheme: light（ライト表示時）')
  assert.match(tokens, /\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/s,
    'ダーク表示では color-scheme: dark（スクロールバー等が白く残らないようにする）')
})
