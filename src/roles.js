/**
 * src/roles.js
 * ロール定義・権限判定の共通モジュール（Issue #18: ロールの細分化）
 *
 * ロール一覧:
 *  - student        : 生徒（未承認 / 承認済みは users.approved フラグで区別）
 *  - teacher        : 先生（顧問・担任として公欠申請を承認する既存ロール。委員会の管理者ではない）
 *  - moderator      : モデレーター（生徒）— 委員会内の委員
 *  - admin_student  : 管理者（生徒）— 委員会内の管理者
 *  - admin_teacher   : 管理者（先生）— 委員の顧問先生
 *  - owner          : オーナー — 全て可能
 *
 * 権限マトリクス（Issue #18 コメントより）:
 *  生徒(未承認)   → システム使用可能。デジタル身分証・先生サジェストは不可
 *  生徒(承認済み) → 生徒機能すべて利用可能
 *  モデレーター   → 公欠申請ケース閲覧不可 / ロール変更不可 / 生徒承認の切替は可能 /
 *                   ユーザー情報閲覧可・変更不可 / 条文変更可 / 問い合わせ閲覧可・下書き可・返信不可
 *  管理者(生徒)   → 公欠申請ケース閲覧不可 / ロール変更は自分と同等まで可 / 生徒承認可 /
 *                   ユーザー情報変更可 / 条文変更可 / 問い合わせ返信可
 *  管理者(先生)   → 公欠申請ケース閲覧可能。他は管理者(生徒)と同じ
 *  オーナー       → 全て可能
 */

// =============================================
// ロール定義
// =============================================
export const ROLES = {
  STUDENT:       'student',
  TEACHER:       'teacher',
  MODERATOR:     'moderator',
  ADMIN_STUDENT: 'admin_student',
  ADMIN_TEACHER: 'admin_teacher',
  OWNER:         'owner',
}

// 表示ラベル
export const ROLE_LABELS = {
  student:       '生徒',
  teacher:       '先生',
  moderator:     'モデレーター',
  admin_student: '管理者（生徒）',
  admin_teacher: '管理者（先生）',
  owner:         'オーナー',
}

export const ROLE_COLORS = {
  student:       '#004085',
  teacher:       '#856404',
  moderator:     '#5b2c6f',
  admin_student: '#0e6655',
  admin_teacher: '#7d6608',
  owner:         '#922b21',
}

export const ROLE_BGS = {
  student:       '#cce5ff',
  teacher:       '#fff3cd',
  moderator:     '#e8daef',
  admin_student: '#d1f2eb',
  admin_teacher: '#fcf3cf',
  owner:         '#fadbd8',
}

// 委員会内の「レベル」（ロール変更可否の上限判定に使用）
// student/teacher は委員会外の一般ロールなのでレベル0
const ROLE_LEVEL = {
  student:       0,
  teacher:       0,
  moderator:     1,
  admin_student: 2,
  admin_teacher: 2,
  owner:         99,
}

export function roleLevel(role) {
  return ROLE_LEVEL[role] ?? 0
}

// =============================================
// 基本判定
// =============================================
export function isStaff(role) {
  // モデレーター以上（委員会メンバー）
  return roleLevel(role) >= 1
}

export function isCommitteeAdmin(role) {
  // 管理者（生徒/先生）またはオーナー
  return role === ROLES.ADMIN_STUDENT || role === ROLES.ADMIN_TEACHER || role === ROLES.OWNER
}

export function isOwnerRole(role) {
  return role === ROLES.OWNER
}

// =============================================
// 個別権限
// =============================================

// 管理者パネルにログインできるか
export function canAccessAdminPanel(role) {
  return isStaff(role)
}

// 公欠申請ケース（管理用の一覧）を閲覧できるか
// fix: 管理者（生徒）からの「ケースが見れない」問い合わせ対応。
// 管理画面の導線統一のため管理者（生徒）にも閲覧を許可する。
export function canViewCasesAdmin(role) {
  return role === ROLES.ADMIN_STUDENT || role === ROLES.ADMIN_TEACHER || role === ROLES.OWNER
}

// ユーザーのロールを変更できるか（対象ロールのレベルが自分以下であることは呼び出し側で別途チェック）
export function canManageRoles(role) {
  return isCommitteeAdmin(role)
}

// 生徒の承認状態（承認済み/未承認）を切り替えられるか
export function canToggleApproval(role) {
  return isStaff(role)
}

// βテスター指定（users.betaTester）を切り替えられるか
// 先行公開の対象者選定は露出に直結するため、委員会管理者以上のみ。
export function canManageBetaTester(role) {
  return isCommitteeAdmin(role)
}

// ユーザー情報（氏名・学年・クラス等）を変更できるか
export function canEditUserInfo(role) {
  return isCommitteeAdmin(role)
}

// ユーザー一覧・詳細を閲覧できるか
export function canViewUsers(role) {
  return isStaff(role)
}

// 条文・コンテンツ（校則・行事等）を変更できるか
export function canEditContent(role) {
  return isStaff(role)
}

// お問い合わせを閲覧できるか
export function canViewInquiries(role) {
  return isStaff(role)
}

// お問い合わせに返信（保存・送信）できるか。AIによる下書き生成自体はブラウザ内だけなので全スタッフ可。
export function canReplyInquiries(role) {
  return isCommitteeAdmin(role)
}

// あるロールを、自分が「割り当てられる」ロールかどうか判定
// （自分のレベル以下のロールにしか変更できない。オーナーは無制限）
export function canAssignRole(myRole, targetRole) {
  if (myRole === ROLES.OWNER) return true
  if (!canManageRoles(myRole)) return false
  return roleLevel(targetRole) <= roleLevel(myRole)
}

// 対象ユーザーの現在のロールを自分が操作できるか
// （自分のレベル以下のユーザーにしか操作できない。オーナーは無制限）
export function canManageTargetRole(myRole, targetRole) {
  if (myRole === ROLES.OWNER) return true
  if (!canManageRoles(myRole)) return false
  return roleLevel(targetRole) <= roleLevel(myRole)
}

// =============================================
// 生徒（一般ユーザー）向け機能ゲート
// =============================================

// 生徒が「承認済み」かどうか（role !== 'student' の場合は対象外 = true 扱い）
// モデレーター・管理者（生徒）は前提として生徒であり、承認済みであることが
// 当たり前のため、常に承認済み扱い（承認バッジ・承認注意文は表示しない）
export function isApprovedStudent(profile) {
  if (!profile) return false
  if (profile.role !== ROLES.STUDENT) return true
  return !!profile.approved
}

// モデレーター・管理者（生徒）は前提として生徒のため、一般生徒と同じく
// 公欠申請などの生徒機能を通常通り利用できる
export function isStudentLike(profileOrRole) {
  const role = typeof profileOrRole === 'string' ? profileOrRole : profileOrRole?.role
  return role === ROLES.STUDENT || role === ROLES.MODERATOR || role === ROLES.ADMIN_STUDENT
}

// 学年・クラス・出席番号の割り当てが必須のロール
// （生徒はもちろん、モデレーター・管理者（生徒）も生徒が前提のため必須）
export function requiresClassInfo(role) {
  return role === ROLES.STUDENT || role === ROLES.MODERATOR || role === ROLES.ADMIN_STUDENT
}

export function hasClassInfo(profile) {
  if (!profile) return false
  return !!(profile.grade && profile.class)
}

// デジタル身分証を利用できるか
export function canUseDigitalId(profile) {
  return isApprovedStudent(profile)
}

// 先生のメールアドレスサジェスト（一覧から選ぶ）機能を利用できるか
export function canUseTeacherSuggest(profile) {
  return isApprovedStudent(profile)
}

// このロールが割り当て可能な選択肢一覧（自分のレベル以下）を返す
export function assignableRoles(myRole) {
  return Object.values(ROLES).filter(r => canAssignRole(myRole, r))
}

// =============================================
// バッジ表示用ヘルパー（マイページ／管理パネル共通）
// =============================================

/**
 * ロールバッジの表示情報を返す
 * @param {string} role
 * @returns {{label:string, color:string, bg:string}}
 */
export function roleBadge(role) {
  return {
    label: ROLE_LABELS[role] || role || '不明',
    color: ROLE_COLORS[role] || '#888888',
    bg:    ROLE_BGS[role]    || '#eeeeee',
  }
}

/**
 * 承認状態バッジの表示情報を返す。
 * 生徒（role === 'student'）のみ「承認済み / 未承認」の概念があるため、
 * それ以外のロールでは null を返す（バッジ非表示）。
 * @param {object} profile users/{uid} のドキュメント（role, approved を含む）
 * @returns {{label:string, color:string, bg:string, approved:boolean}|null}
 */
export function approvalBadge(profile) {
  if (!profile || profile.role !== ROLES.STUDENT) return null
  const approved = !!profile.approved
  return approved
    ? { label: '✓ 承認済み', color: '#155724', bg: '#d4edda', approved: true }
    : { label: '未承認',     color: '#856404', bg: '#fff3cd', approved: false }
}

/**
 * βテスターの表示情報を返す（Issue #53）。
 * users.betaTester === true の場合のみバッジを返す。
 * @param {object} profile users/{uid} のドキュメント
 * @returns {{label:string, color:string, bg:string}|null}
 */
export function betaBadge(profile) {
  if (!profile || profile.betaTester !== true) return null
  return { label: 'βテスター', color: '#5b2c6f', bg: '#e8daef' }
}

/**
 * マイページに並べて表示するバッジ一覧を返す。
 * 生徒: [ロール, 承認状態]  / それ以外: [ロール]
 * βテスターは全ロール共通で末尾に追加。
 * @param {object} profile
 * @returns {Array<{label:string,color:string,bg:string}>}
 */
export function profileBadges(profile) {
  const badges = [roleBadge(profile?.role)]
  const appr = approvalBadge(profile)
  if (appr) badges.push({ label: appr.label, color: appr.color, bg: appr.bg })
  const beta = betaBadge(profile)
  if (beta) badges.push(beta)
  return badges
}

/**
 * 未承認の生徒に対して表示する制限事項の説明文（null = 制限なし）
 */
export function approvalNotice(profile) {
  const appr = approvalBadge(profile)
  if (!appr || appr.approved) return null
  return '現在は未承認アカウントです。デジタル身分証や先生のメールアドレスサジェストなど、一部の機能がご利用いただけません。承認は生徒会（委員会）の担当者が行います。'
}
