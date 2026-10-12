/**
 * src/theme.js
 * Issue #103: ダークモードの自動判別（端末のダークモード設定に追従）
 *
 * 仕組み:
 *  - テーマの指定は 3 種類。localStorage `mito1_theme` に保存する。
 *      'auto'  : 端末のダークモード設定（prefers-color-scheme）に追従する ← 既定値
 *      'light' : 常にライトモード
 *      'dark'  : 常にダークモード
 *  - 実際の表示は「解決後のテーマ」= 'light' | 'dark' で html[data-theme] に反映する。
 *    CSS 側は [data-theme="dark"] セレクタだけで切り替える（light は明示的な値にする）。
 *  - 端末のダークモード設定は matchMedia で読み取り、変更を購読して追従する。
 *
 * 保存値の変更履歴:
 *  - Issue #103 以前は 'dark' | 'light' の 2 値。'dark'/'light' はそのまま有効なので
 *    過去到现在の利用者の明示的な選択として尊重する（勝手に auto に戻さない）。
 *  - 何も保存していない（localStorage にキー無し）= 今回までにテーマを触っていない = auto。
 *
 * このファイルの純粋関数（normalizeThemeMode / resolveThemeMode / themeModeLabel 等）は
 * DOM や Firebase に依存しないため `node --test` から直接 import して検証できる。
 * 実 DOM への適用は index.html の module 内「ダークモード自動判別」ブロックが行う。
 */

// =============================================
// 定数
// =============================================
/** localStorage のキー（他ファイルと共有する唯一の名前） */
export const THEME_STORAGE_KEY = 'mito1_theme'

/** ユーザーが選べるテーマ指定。localStorage に保存される値でもある。 */
export const THEME_MODES = {
  AUTO: 'auto',
  LIGHT: 'light',
  DARK: 'dark',
}

/** 端末のダークモードを問い合わせるメディアクエリ */
export const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)'

/** 解決後のテーマとして <html data-theme> に指定する値 */
export const RESOLVED_THEMES = {
  LIGHT: 'light',
  DARK: 'dark',
}

/** PWA ステータスバーの色（<meta name="theme-color">）。ダーク時は --bg に合わせる */
export const THEME_COLORS = {
  light: '#1a2744',
  dark: '#0e0e11',
}

/** 切替ボタンのアイコン（表示がダークなら「元に戻す」太陽、ライトなら月を出す） */
export const SUN_SVG = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
export const MOON_SVG = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'

/** テーマ指定の表示名（themeModeLabel / 設定シートの選択肢で使う） */
const THEME_MODE_LABELS = {
  auto: '自動',
  light: 'ライト',
  dark: 'ダーク',
}

/** 設定シートのテーマ選択の説明文 */
export const THEME_MODE_HINTS = {
  auto: '端末のダークモード設定に合わせて自動的に切り替えます。',
  light: '常にライトモードで表示します。',
  dark: '常にダークモードで表示します。',
}

// =============================================
// 純粋関数
// =============================================

/**
 * 保存済みの値を 3 つのテーマ指定のいずれかに正規化する。
 * null / 未設定 / 不正な値は「テーマを触っていない」= auto として扱う。
 * @param {string|null|undefined} stored localStorage から読んだ生値
 * @returns {'auto'|'light'|'dark'}
 */
export function normalizeThemeMode(stored) {
  if (stored === THEME_MODES.LIGHT || stored === THEME_MODES.DARK || stored === THEME_MODES.AUTO) {
    return stored
  }
  return THEME_MODES.AUTO
}

/**
 * テーマ指定と端末のダークモード設定から、実際に表示するテーマを解決する。
 * @param {string|null|undefined} stored localStorage から読んだ生値
 * @param {boolean} prefersDark 端末がダークモードか
 * @returns {'light'|'dark'}
 */
export function resolveThemeMode(stored, prefersDark) {
  const mode = normalizeThemeMode(stored)
  if (mode === THEME_MODES.DARK) return RESOLVED_THEMES.DARK
  if (mode === THEME_MODES.LIGHT) return RESOLVED_THEMES.LIGHT
  return prefersDark ? RESOLVED_THEMES.DARK : RESOLVED_THEMES.LIGHT
}

/**
 * 切替ボタンに表示するアイコンのSVG。
 * 現在の表示がダークなら「元に戻す」太陽、ライトなら月を返す。
 * @param {'light'|'dark'} resolved 現在の表示テーマ
 * @returns {string}
 */
export function themeToggleIcon(resolved) {
  return resolved === RESOLVED_THEMES.DARK ? SUN_SVG : MOON_SVG
}

/**
 * テーマ切替ボタン／more シートのラベル（次に切り替えると何になるか）。
 * 押すと現在の表示と逆のテーマが明示的に設定される。
 * @param {'light'|'dark'} resolved 現在の表示テーマ
 * @returns {string}
 */
export function nextThemeLabel(resolved) {
  return resolved === RESOLVED_THEMES.DARK ? 'ライトモード' : 'ダークモード'
}

/**
 * 設定シートに表示する現在のテーマ指定のラベル。
 * 自動のときは「今どちらで表示されているか」を括弧書きで補足する。
 * @param {string|null|undefined} stored localStorage から読んだ生値
 * @param {boolean} prefersDark 端末がダークモードか
 * @returns {string}
 */
export function themeModeLabel(stored, prefersDark) {
  const mode = normalizeThemeMode(stored)
  if (mode !== THEME_MODES.AUTO) return THEME_MODE_LABELS[mode]
  return `自動（${prefersDark ? THEME_MODE_LABELS.dark : THEME_MODE_LABELS.light}）`
}

// =============================================
// ブラウザAPIのラッパ（DOM依存。node --test では直接呼ばない）
// =============================================

/**
 * 端末がダークモードかを問い合わせる。matchMedia が使えない環境では false（ライト）に倒す。
 * @returns {boolean}
 */
export function isPrefersDark() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(PREFERS_DARK_QUERY).matches === true
  } catch {
    return false
  }
}
