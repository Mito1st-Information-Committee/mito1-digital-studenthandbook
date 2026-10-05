/**
 * src/classOptions.js
 * クラス（組）の選択肢・ラベル変換・バリデーションの共通定義
 *
 * Firestore の users.class は「数値」で保持する（既存データ・Security Rules との
 * 互換性のため）。内部値とラベルの対応は下表のとおり。
 *
 *   1〜6 → 1組〜6組（全学年・高校）
 *   7    → 7組（3年のみ。`grades: [3]` の指定で学年連動の選択肢から出し分けする）
 *   8    → A組（附属中学校のみ）
 *   9    → B組（附属中学校のみ）
 *
 * ラベルや追加クラスを変えたいときは、このファイルだけ編集すれば
 * 登録フォーム・管理画面・マイページへ反映される。
 */

export const CLASS_OPTIONS = [
  { value: 1, label: '1組' },
  { value: 2, label: '2組' },
  { value: 3, label: '3組' },
  { value: 4, label: '4組' },
  { value: 5, label: '5組' },
  { value: 6, label: '6組' },
  { value: 7, label: '7組', grades: [3] }, // 3年のみ
  { value: 8, label: 'A組' },
  { value: 9, label: 'B組' },
]

const LABEL_BY_VALUE = new Map(CLASS_OPTIONS.map(o => [String(o.value), o.label]))

/**
 * 附属中学校のクラス内部値（A組=8 / B組=9）。
 * 高校に A組・B組は存在しないため、この値を持つユーザーは中学生として扱う。
 */
export const JUNIOR_HIGH_CLASS_VALUES = [8, 9]

/** 附属中学校のクラス（A組/B組）かどうか */
export function isJuniorHighClass(v) {
  const n = normalizeClass(v)
  return n !== null && JUNIOR_HIGH_CLASS_VALUES.includes(n)
}

export const MAX_CLASS_VALUE = CLASS_OPTIONS[CLASS_OPTIONS.length - 1].value

export const GRADE_OPTIONS = [
  { value: 1, label: '1年' },
  { value: 2, label: '2年' },
  { value: 3, label: '3年' },
]

/**
 * クラス値を数値に正規化する。空欄・数値として解釈できない値は null を返す。
 * Firestore に number で保存するため、select の value（文字列）も必ずこれで通す。
 */
export function normalizeClass(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

/** 学年値を数値に正規化する。1〜3以外・数値として解釈できない値は null。 */
export function normalizeGrade(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && GRADE_OPTIONS.some(g => g.value === n) ? n : null
}

/** クラス値の表示ラベル（'A組' など）。未設定なら空文字。 */
export function classLabel(v) {
  const n = normalizeClass(v)
  if (n === null) return ''
  return LABEL_BY_VALUE.get(String(n)) ?? `${n}組`
}

/** その学年で選択できるクラスの選択肢を返す（学年の不正時は全選択肢） */
export function classOptionsForGrade(grade) {
  const g = normalizeGrade(grade)
  if (g === null) return CLASS_OPTIONS
  return CLASS_OPTIONS.filter(o => !o.grades || o.grades.includes(g))
}

/** クラス値として妥当かどうか（その学年で選択できるかは見ていない） */
export function isValidClass(v) {
  const n = normalizeClass(v)
  return n !== null && LABEL_BY_VALUE.has(String(n))
}

/** その学年で選択できるクラスかどうか */
export function isValidClassForGrade(v, grade) {
  const n = normalizeClass(v)
  if (n === null) return false
  return classOptionsForGrade(grade).some(o => o.value === n)
}

/**
 * <select> 用の <option> 文字列。
 *  - grade: 学年（未指定なら全クラス）
 *  - selected: 選択状態にするクラス値
 *  - includeEmpty: 先頭に空欄（—）を付けるか
 */
export function classOptionTags({ grade, selected, includeEmpty = false, emptyLabel = '—' } = {}) {
  const options = classOptionsForGrade(grade)
  const sel = normalizeClass(selected)
  const head = includeEmpty ? `<option value=""${sel === null ? ' selected' : ''}>${emptyLabel}</option>` : ''
  return head + options.map(o =>
    `<option value="${o.value}"${sel === o.value ? ' selected' : ''}>${o.label}</option>`
  ).join('')
}
