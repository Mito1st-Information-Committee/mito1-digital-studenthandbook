/**
 * src/classOptions.js
 * クラス（組）の選択肢・ラベル変換・バリデーションの共通定義
 *
 * Firestore の users.class は「数値」で保持する（既存データ・Security Rules との
 * 互換性のため）。7 / 8 はそれぞれ A組 / B組 として扱う。
 * ラベルを変更したいときは、このファイルだけ編集すれば全画面へ反映される。
 */

export const CLASS_OPTIONS = [
  { value: 1, label: '1組' },
  { value: 2, label: '2組' },
  { value: 3, label: '3組' },
  { value: 4, label: '4組' },
  { value: 5, label: '5組' },
  { value: 6, label: '6組' },
  { value: 7, label: 'A組' },
  { value: 8, label: 'B組' },
]

const LABEL_BY_VALUE = new Map(CLASS_OPTIONS.map(o => [String(o.value), o.label]))

export const MAX_CLASS_VALUE = CLASS_OPTIONS[CLASS_OPTIONS.length - 1].value

/**
 * クラス値を数値に正規化する。空欄・数値として解釈できない値は null を返す。
 * Firestore に number で保存するため、select の value（文字列）も必ずこれで通す。
 */
export function normalizeClass(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

/** クラス値の表示ラベル（'A組' など）。未設定なら空文字。 */
export function classLabel(v) {
  const n = normalizeClass(v)
  if (n === null) return ''
  return LABEL_BY_VALUE.get(String(n)) ?? `${n}組`
}

/** 登録可能なクラス値かどうか */
export function isValidClass(v) {
  const n = normalizeClass(v)
  return n !== null && n >= CLASS_OPTIONS[0].value && n <= MAX_CLASS_VALUE
}

/** <select> 用の <option> 文字列。selectedValue に一致するものだけ選択済みにする。 */
export function classOptionTags(selectedValue = '', { includeEmpty = false, emptyLabel = '—' } = {}) {
  const selected = normalizeClass(selectedValue)
  const head = includeEmpty ? `<option value=""${selected === null ? ' selected' : ''}>${emptyLabel}</option>` : ''
  return head + CLASS_OPTIONS.map(o =>
    `<option value="${o.value}"${selected === o.value ? ' selected' : ''}>${o.label}</option>`
  ).join('')
}