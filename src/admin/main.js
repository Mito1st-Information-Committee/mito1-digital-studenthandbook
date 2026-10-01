import { db, auth } from '../firebase.js'
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth'
import {
  collection, collectionGroup, doc, getDocs, getDoc,
  addDoc, setDoc, updateDoc, deleteDoc, deleteField,
  orderBy, query, where, serverTimestamp, Timestamp, writeBatch,
} from 'firebase/firestore'
import { getCurrentProfile } from '../auth.js'
import {
  ROLE_LABELS as R_LABELS, ROLE_COLORS as R_COLORS, ROLE_BGS as R_BGS,
  canAccessAdminPanel, canViewCasesAdmin, canManageRoles, canToggleApproval,
  canEditUserInfo, canViewUsers, canReplyInquiries, canManageTargetRole,
  canAssignRole, assignableRoles, canManageBetaTester,
} from '../roles.js'
import {
  FLAG_STATUSES, FLAG_STATUS_LABELS, validateFlagKey, normalizeFlag, KNOWN_FLAGS,
} from '../featureFlags.js'
import { classLabel, classOptionTags, normalizeClass } from '../classOptions.js'

// =============================================
// STATE
// =============================================
let currentSection = 'dashboard'
let editingId   = null
let editingType = null
let myProfile   = null // ログイン中の管理者/モデレーターのプロフィール（roles.js の権限判定に使用）

/**
 * 直近に読み込んだコレクションの内容をキャッシュする。
 *  - ↑↓ での並び替え（order の再採番）
 *  - 「章」「教科」などの入力候補（datalist）生成
 *  - 追加時の order 自動採番（最大値 + 10）
 * に使用する。DBのスキーマは一切変更しない。
 */
const listCache = {}

// =============================================
// 入力の引き継ぎ（sticky）— 同じ項目を何度も打たなくて済むように
// =============================================
const STICKY_KEY = 'mito1_admin_sticky_v1'
let stickyStore = {}
try { stickyStore = JSON.parse(localStorage.getItem(STICKY_KEY) || '{}') } catch { stickyStore = {} }

function getSticky(type) {
  return stickyStore[type] || {}
}
function setSticky(type, values) {
  stickyStore[type] = { ...(stickyStore[type] || {}), ...values }
  try { localStorage.setItem(STICKY_KEY, JSON.stringify(stickyStore)) } catch { /* ignore */ }
}
function clearSticky(type) {
  delete stickyStore[type]
  try { localStorage.setItem(STICKY_KEY, JSON.stringify(stickyStore)) } catch { /* ignore */ }
}

// =============================================
// UTILS
// =============================================
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function escAttr(s) {
  return String(s ?? '').replace(/'/g, "\\'").replace(/\n/g, ' ').slice(0, 100)
}
function $(id) { return document.getElementById(id) }
function val(id, fallback = '') {
  const el = $(id)
  return el ? el.value : fallback
}
function trimVal(id) { return String(val(id)).trim() }

function showToast(msg) {
  const t = $('toast')
  if (!t) return
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(showToast._t)
  showToast._t = setTimeout(() => t.classList.remove('show'), 2600)
}

function spinner(label = '読み込み中...') {
  return `<div class="loading-spinner"><div class="spinner"></div>${label}</div>`
}

function emptyState(msg = 'まだデータがありません', hint = '') {
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    <p>${escHtml(msg)}</p>
    ${hint ? `<p class="empty-hint">${escHtml(hint)}</p>` : ''}
  </div>`
}

function errorState(e) {
  return `<div class="notice warn">読み込みに失敗しました: ${escHtml(e?.message || String(e))}</div>`
}

function initials(nameOrMail) {
  const s = String(nameOrMail || '').trim()
  if (!s) return '—'
  // 日本語氏名は先頭1文字、英字メールは先頭2文字
  return /^[\x20-\x7E]+$/.test(s) ? s.slice(0, 2).toUpperCase() : s.slice(0, 1)
}

const ICON = {
  edit:  '<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
  copy:  '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  up:    '<svg viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
  down:  '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
}

/**
 * 行・カード共通の操作ボタン群（編集 / 複製 / ↑ / ↓ / 削除）。
 * 並び順を手入力しなくても ↑↓ で入れ替えられるようにする。
 */
function itemOps(col, id, idx, total, { reorder = true, duplicate = true } = {}) {
  return `<div class="item-actions">
    ${reorder ? `
    <button class="btn-icon" data-move="${col}|${id}|-1" title="上へ移動" aria-label="上へ移動"${idx <= 0 ? ' disabled' : ''}>${ICON.up}</button>
    <button class="btn-icon" data-move="${col}|${id}|1" title="下へ移動" aria-label="下へ移動"${idx >= total - 1 ? ' disabled' : ''}>${ICON.down}</button>` : ''}
    ${duplicate ? `<button class="btn-icon" data-dup="${col}|${id}" title="複製して追加" aria-label="複製して追加">${ICON.copy}</button>` : ''}
    <button class="btn-icon" data-edit="${col}|${id}" title="編集" aria-label="編集">${ICON.edit}</button>
    <button class="btn-icon del" data-delete="${col}|${id}" title="削除" aria-label="削除">${ICON.trash}</button>
  </div>`
}

/** datalist（入力候補）を生成する。同じ章名などを打ち直さなくて済む */
function datalist(id, values) {
  const uniq = [...new Set(values.filter(v => v !== undefined && v !== null && String(v).trim() !== ''))]
  if (!uniq.length) return ''
  return `<datalist id="${id}">${uniq.map(v => `<option value="${escHtml(v)}"></option>`).join('')}</datalist>`
}

/** キャッシュから、あるフィールドの既出値一覧を取り出す */
function knownValues(col, field) {
  return (listCache[col] || []).map(x => x[field]).filter(Boolean)
}

/** 追加時の order 自動採番（既存の最大 order + 10）。手入力は不要にする */
function nextOrder(col) {
  const items = listCache[col] || []
  if (!items.length) return 10
  const max = items.reduce((m, x) => Math.max(m, Number(x.order) || 0), 0)
  return max + 10
}

// =============================================
// DOM READY
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  // --- Login ---
  $('loginBtn')?.addEventListener('click', doLogin)
  $('loginPass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })
  $('loginEmail')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('loginPass')?.focus() })

  // --- Logout ---
  $('logoutBtnEl')?.addEventListener('click', doLogout)

  // --- Sidebar ---
  document.querySelectorAll('.adm-sb-item[data-sec]').forEach(btn => {
    btn.addEventListener('click', () => switchSec(btn.dataset.sec))
  })
  $('menuBtn')?.addEventListener('click', toggleSidebar)
  $('sbCloseBtn')?.addEventListener('click', closeSidebar)
  $('sbOverlay')?.addEventListener('click', closeSidebar)

  // --- Add buttons ---
  document.querySelectorAll('[data-add]').forEach(btn => {
    btn.addEventListener('click', () => openModal(btn.dataset.add))
  })

  // --- Modal ---
  $('modalSaveBtn')?.addEventListener('click', () => saveModal({ keepOpen: false }))
  $('modalSaveMoreBtn')?.addEventListener('click', () => saveModal({ keepOpen: true }))
  $('modalCancelBtn')?.addEventListener('click', closeModal)
  $('modalCloseBtn')?.addEventListener('click', closeModal)
  $('modalOverlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal()
  })

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', e => {
    const modalOpen = $('modalOverlay')?.classList.contains('open')
    if (e.key === 'Escape') {
      if (modalOpen) { closeModal(); return }
      closeSidebar()
    }
    // Ctrl/Cmd + Enter で保存（条文の連続入力を速くする）
    if (modalOpen && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      saveModal({ keepOpen: e.shiftKey })
    }
  })

  // --- 動的生成された要素のイベント委譲 ---
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-edit],[data-delete],[data-nav],[data-save-action],[data-move],[data-dup],[data-filter-preset]')
    if (!btn) return

    if (btn.dataset.edit)   { const [col, id] = btn.dataset.edit.split('|');   openModal(col, id) }
    if (btn.dataset.delete) { const [col, id] = btn.dataset.delete.split('|'); deleteItem(col, id) }
    if (btn.dataset.dup)    { const [col, id] = btn.dataset.dup.split('|');    duplicateItem(col, id) }
    if (btn.dataset.move)   {
      const [col, id, dir] = btn.dataset.move.split('|')
      moveItem(col, id, Number(dir))
    }
    if (btn.dataset.nav) switchSec(btn.dataset.nav)
    if (btn.dataset.filterPreset) applyUserPreset(btn.dataset.filterPreset)

    const act = btn.dataset.saveAction
    if (act === 'goals')              saveGoals()
    if (act === 'council-activities') saveCouncilActivities()
    if (act === 'special-desc')       saveSpecialDesc()
    if (act === 'charter-preamble')   saveCharterPreamble()
  })
})

// =============================================
// AUTH — 管理者権限チェック
// =============================================
// 同一 Firebase Auth セッションをそのまま使うため、管理画面側での再ログインは不要。
// マイページでログイン済みならこの onAuthStateChanged がそのまま発火して入れる。
// 権限不足の場合も signOut しない（マイページ側のセッションを切らないため）。
onAuthStateChanged(auth, async user => {
  const loginBtn = $('loginBtn')
  if (!user) {
    myProfile = null
    updateBackToMypage(null)
    $('loginScreen')?.classList.remove('hide')
    $('appShell')?.classList.remove('show')
    if (loginBtn) loginBtn.disabled = false
    return
  }

  let profile = null
  try {
    profile = await getCurrentProfile(user)
  } catch (e) {
    console.warn('[admin] getCurrentProfile failed', e)
  }
  if (!profile || !canAccessAdminPanel(profile.role)) {
    myProfile = null
    const err = $('loginErr')
    if (err) err.textContent = 'この機能は委員会メンバー（モデレーター以上）のみアクセスできます。一般生徒の方はマイページをご利用ください。'
    $('loginScreen')?.classList.remove('hide')
    $('appShell')?.classList.remove('show')
    if (loginBtn) loginBtn.disabled = false
    // signOut はしない。マイページ（/）のセッションを維持するため。
    // 既にログイン済みの生徒が誤って /admin/ を開いてもログアウトされない。
    updateBackToMypage({ role: profile?.role || 'student' })
    return
  }

  myProfile = profile
  $('loginScreen')?.classList.add('hide')
  $('appShell')?.classList.add('show')
  if (loginBtn) loginBtn.disabled = false

  // ヘッダーのユーザーチップ
  const avatar = $('headerAvatar')
  if (avatar) avatar.textContent = initials(profile.name || user.email)
  const mail = $('headerUser')
  if (mail) { mail.textContent = user.email; mail.title = user.email }
  const roleEl = $('headerRole')
  if (roleEl) roleEl.textContent = R_LABELS[profile.role] || profile.role

  updateBackToMypage(profile)
  applyRoleUI()
  switchSec('dashboard', { skipNavState: true })
  loadBadgeCounts()
  loadSidebarCounts()
})

// モデレーター・管理者（生徒）は前提として生徒のため、管理画面から
// マイページに戻る導線を見せる（ヘッダー＋サイドバー）
function updateBackToMypage(profile) {
  const show = profile && (profile.role === 'moderator' || profile.role === 'admin_student')
  const hdr = $('backToMypageBtn')
  if (hdr) hdr.style.display = show ? 'inline-flex' : 'none'
  const sb = $('sbBackToMypage')
  if (sb) sb.style.display = show ? 'block' : 'none'
}

// ロールに応じたサイドバー／機能の表示切替
function applyRoleUI() {
  if (!myProfile) return
  const role = myProfile.role

  // 公欠申請ケース：管理者(先生)・オーナーのみ閲覧可
  const casesNav = document.querySelector('.adm-sb-item[data-sec="cases"]')
  if (casesNav) casesNav.style.display = canViewCasesAdmin(role) ? '' : 'none'

  // ユーザー管理はスタッフ全員閲覧可（編集・ロール変更は個別制御）
  const usersNav = document.querySelector('.adm-sb-item[data-sec="users"]')
  if (usersNav) usersNav.style.display = canViewUsers(role) ? '' : 'none'
}

async function doLogin() {
  const email = trimVal('loginEmail')
  const pass  = val('loginPass')
  const btn   = $('loginBtn')
  const err   = $('loginErr')
  if (err) err.textContent = ''
  if (btn) btn.disabled = true
  try {
    await signInWithEmailAndPassword(auth, email, pass)
  } catch (e) {
    const msgs = {
      'auth/invalid-credential': 'メールアドレスまたはパスワードが違います',
      'auth/user-not-found':     'ユーザーが見つかりません',
      'auth/wrong-password':     'パスワードが違います',
      'auth/invalid-email':      'メールアドレスの形式が正しくありません',
      'auth/too-many-requests':  '試行回数が多すぎます。しばらく待ってからお試しください',
    }
    if (err) err.textContent = msgs[e.code] || 'ログインに失敗しました（' + e.code + '）'
    if (btn) btn.disabled = false
  }
}

async function doLogout() {
  await signOut(auth)
}

// =============================================
// NAVIGATION（<=980px ではサイドバーがドロワー）
// =============================================
function toggleSidebar() {
  const sb = $('admSidebar')
  const isOpen = sb?.classList.toggle('open')
  $('sbOverlay')?.classList.toggle('show', !!isOpen)
  $('menuBtn')?.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
  document.body.style.overflow = isOpen ? 'hidden' : ''
}

function closeSidebar() {
  $('admSidebar')?.classList.remove('open')
  $('sbOverlay')?.classList.remove('show')
  $('menuBtn')?.setAttribute('aria-expanded', 'false')
  document.body.style.overflow = ''
}

function switchSec(sec, { skipNavState = false } = {}) {
  currentSection = sec
  closeSidebar()
  document.querySelectorAll('.adm-section').forEach(s => s.classList.remove('on'))
  document.querySelectorAll('.adm-sb-item').forEach(s => s.classList.remove('on'))
  $('sec-' + sec)?.classList.add('on')
  document.querySelector(`.adm-sb-item[data-sec="${sec}"]`)?.classList.add('on')
  if (!skipNavState) window.scrollTo({ top: 0, behavior: 'smooth' })
  loadSection(sec)
}

async function loadSection(sec) {
  switch (sec) {
    case 'dashboard':          return loadDashboard()
    case 'history':            return loadList('history', renderHistoryList)
    case 'principals':         return loadList('principals', renderPrincipalsList)
    case 'goals':              return loadGoalsForm()
    case 'songs':              return loadList('songs', renderSongsList)
    case 'rules':              return loadList('rules', renderArticleList('rulesList'))
    case 'special':            return Promise.all([loadList('special', renderArticleList('specialList')), loadSpecialDescForm()])
    case 'curriculum':         return loadList('curriculum', renderCurriculumList)
    case 'events':             return loadList('events', renderEventsList)
    case 'council-activities': return loadCouncilActivitiesForm()
    case 'council-charter':    return Promise.all([loadList('council-charter', renderArticleList('councilCharterList')), loadCharterPreambleForm()])
    case 'council-rules':      return loadList('council-rules', renderArticleList('councilRulesList'))
    case 'inquiries':          return loadInquiries()
    case 'mail':               return loadCustomMailSection()
    case 'announcements':      return loadAnnouncements()
    case 'beta':               return loadBetaFlags()
    case 'cases':              return canViewCasesAdmin(myProfile?.role) ? loadAdminCases() : renderCasesForbidden()
    case 'users':              return loadUsers()
  }
}

// =============================================
// LIST LOADER
// =============================================
async function fetchCollection(col) {
  let docs
  try {
    const snap = await getDocs(query(collection(db, col), orderBy('order', 'asc')))
    docs = snap.docs
  } catch {
    // order フィールドが無いドキュメントが混在する場合のフォールバック
    const snap = await getDocs(collection(db, col))
    docs = snap.docs
  }
  const items = docs.map(d => ({ id: d.id, ...d.data() }))
  items.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
  listCache[col] = items
  return items
}

/** コレクション名 → 一覧を描画するコンテナ ID */
const COL_CONTAINER = {
  rules: 'rulesList',
  special: 'specialList',
  'council-charter': 'councilCharterList',
  'council-rules': 'councilRulesList',
  events: 'eventsList',
  curriculum: 'curriculumList',
  history: 'historyList',
  principals: 'principalsList',
  songs: 'songsList',
}

async function loadList(col, renderFn) {
  const el = $(COL_CONTAINER[col])
  if (el) el.innerHTML = spinner()
  try {
    renderFn(await fetchCollection(col))
    updateSidebarCount(col, (listCache[col] || []).length)
  } catch (e) {
    console.error('[admin] loadList failed', col, e)
    if (el) el.innerHTML = errorState(e)
  }
}

// =============================================
// サイドバーの件数バッジ
// =============================================
const COUNT_COLLECTIONS = [
  'rules', 'special', 'council-charter', 'council-rules',
  'events', 'curriculum', 'history', 'principals', 'songs', 'users',
]

function updateSidebarCount(key, n) {
  document.querySelectorAll(`.sb-count[data-count="${key}"]`).forEach(el => {
    el.textContent = n
  })
}

async function loadSidebarCounts() {
  await Promise.all(COUNT_COLLECTIONS.map(async col => {
    try {
      const snap = await getDocs(collection(db, col))
      updateSidebarCount(col, snap.size)
    } catch { updateSidebarCount(col, '—') }
  }))
}

// =============================================
// 並び替え（↑↓）— order を手入力しなくても済むように
// =============================================
async function moveItem(col, id, dir) {
  const items = listCache[col] || []
  const idx = items.findIndex(x => x.id === id)
  if (idx < 0) return
  const swapIdx = idx + dir
  if (swapIdx < 0 || swapIdx >= items.length) return

  // 配列上で入れ替え、order を 10 刻みで通し番号として振り直す
  const reordered = [...items]
  ;[reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]]

  try {
    const batch = writeBatch(db)
    reordered.forEach((item, i) => {
      const newOrder = (i + 1) * 10
      if (Number(item.order) !== newOrder) {
        batch.update(doc(db, col, item.id), { order: newOrder })
      }
      item.order = newOrder
    })
    await batch.commit()
    listCache[col] = reordered
    showToast('並び順を変更しました')
    loadSection(currentSection)
  } catch (e) {
    showToast('並び替えに失敗しました: ' + (e?.message || e))
  }
}

/** 既存項目をひな形として新規追加（同じ章・年度の連続入力を楽にする） */
async function duplicateItem(col, id) {
  const item = (listCache[col] || []).find(x => x.id === id)
  if (!item) return
  openModal(col, null, { seed: item })
}

// =============================================
// DASHBOARD
// =============================================
const DASH_ICONS = {
  rules:             { bg: 'linear-gradient(135deg,#1a2744,#2c4477)', svg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },
  special:           { bg: 'linear-gradient(135deg,#5b2c6f,#7d3c98)', svg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>' },
  events:            { bg: 'linear-gradient(135deg,#1c5b96,#2980b9)', svg: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
  history:           { bg: 'linear-gradient(135deg,#1e8449,#27ae60)', svg: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>' },
  principals:        { bg: 'linear-gradient(135deg,#a9781a,#d4ac0d)', svg: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
  songs:             { bg: 'linear-gradient(135deg,#a93226,#cb4335)', svg: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' },
  curriculum:        { bg: 'linear-gradient(135deg,#0e6655,#117a65)', svg: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' },
  'council-charter': { bg: 'linear-gradient(135deg,#8b1a2c,#b03a4c)', svg: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' },
  'council-rules':   { bg: 'linear-gradient(135deg,#7d6608,#9a7d0a)', svg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
}

const DASH_SECTIONS = [
  { col: 'rules',           label: '諸規定（本則）',   unit: '条' },
  { col: 'special',         label: '特別教育活動',     unit: '条' },
  { col: 'council-charter', label: '知道生徒会憲章',   unit: '条' },
  { col: 'council-rules',   label: '生徒会関係諸規定', unit: '条' },
  { col: 'events',          label: '年間主要行事',     unit: '件' },
  { col: 'curriculum',      label: '教育課程',         unit: '科目' },
  { col: 'history',         label: '本校の沿革',       unit: '件' },
  { col: 'principals',      label: '歴代校長',         unit: '名' },
  { col: 'songs',           label: '校歌・応援歌',     unit: '曲' },
]

function kpiCard({ num, label, bg, icon, nav = null, alert = false }) {
  return `<${nav ? 'button' : 'div'} class="kpi-card${nav ? ' clickable' : ''}"${nav ? ` data-nav="${nav}" type="button"` : ''}>
    <div class="kpi-icon" style="background:${bg}"><svg viewBox="0 0 24 24">${icon}</svg></div>
    <div class="kpi-body">
      <div class="kpi-num"${alert && num > 0 ? ' style="color:var(--danger)"' : ''}>${num}</div>
      <div class="kpi-label">${escHtml(label)}</div>
    </div>
    ${nav ? '<span class="kpi-arrow"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></span>' : ''}
  </${nav ? 'button' : 'div'}>`
}

async function loadDashboard() {
  const grid = $('dashGrid')
  if (!grid) return
  grid.innerHTML = spinner()

  const counts = await Promise.all(
    DASH_SECTIONS.map(s => getDocs(collection(db, s.col)).then(sn => sn.size).catch(() => 0))
  )
  DASH_SECTIONS.forEach((s, i) => updateSidebarCount(s.col, counts[i]))

  const canSeeCases = canViewCasesAdmin(myProfile?.role)
  let inquiryNew = 0, casePending = 0, totalUsers = 0, unapproved = 0

  try {
    const [iqSnap, usSnap] = await Promise.all([
      getDocs(collection(db, 'inquiries')).catch(() => null),
      getDocs(collection(db, 'users')).catch(() => null),
    ])
    if (iqSnap) inquiryNew = iqSnap.docs.filter(d => d.data().status === 'new').length
    if (usSnap) {
      totalUsers = usSnap.size
      unapproved = usSnap.docs.filter(d => {
        const u = d.data()
        return u.role === 'student' && !u.approved
      }).length
      updateSidebarCount('users', totalUsers)
    }
    if (canSeeCases) {
      const csSnap = await getDocs(collection(db, 'cases')).catch(() => null)
      if (csSnap) casePending = csSnap.docs.filter(d => ['pending_supervisor', 'pending_homeroom'].includes(d.data().status)).length
    }
  } catch { /* ignore */ }

  const totalContent = counts.reduce((a, b) => a + b, 0)
  const myName = myProfile?.name || ''
  const hour = new Date().getHours()
  const greet = hour < 5 ? 'お疲れさまです' : hour < 11 ? 'おはようございます' : hour < 18 ? 'こんにちは' : 'お疲れさまです'

  const kpis = [
    kpiCard({
      num: totalContent, label: '公開中コンテンツ',
      bg: 'linear-gradient(135deg,#1a2744,#2c4477)',
      icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    }),
    kpiCard({
      num: inquiryNew, label: '未対応のお問い合わせ', nav: 'inquiries', alert: true,
      bg: 'linear-gradient(135deg,#a93226,#e74c3c)',
      icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    }),
  ]
  if (canSeeCases) {
    kpis.push(kpiCard({
      num: casePending, label: '承認待ちの公欠申請', nav: 'cases',
      bg: 'linear-gradient(135deg,#8a6100,#d4ac0d)',
      icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
    }))
  }
  if (canViewUsers(myProfile?.role)) {
    kpis.push(kpiCard({
      num: totalUsers, label: '登録ユーザー', nav: 'users',
      bg: 'linear-gradient(135deg,#1e8449,#27ae60)',
      icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    }))
    kpis.push(kpiCard({
      num: unapproved, label: '未承認の生徒', nav: 'users', alert: true,
      bg: 'linear-gradient(135deg,#1c5b96,#3498db)',
      icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>',
    }))
  }

  grid.innerHTML = `
    <div class="dash-hero">
      <div class="dash-hero-inner">
        <div class="dash-hero-eyebrow">ADMIN PORTAL</div>
        <div class="dash-hero-title">${escHtml(greet)}${myName ? '、' + escHtml(myName) + ' さん' : ''}</div>
        <div class="dash-hero-sub">
          水戸第一高等学校 デジタル生徒手帳のコンテンツとユーザーを管理できます。<br>
          保存した内容は生徒手帳側にすぐ反映されます。
        </div>
      </div>
    </div>

    <div class="dash-kpis">${kpis.join('')}</div>

    <div class="dash-block-title">コンテンツ管理</div>
    <div class="dash-grid">
      ${DASH_SECTIONS.map((s, i) => {
        const ic = DASH_ICONS[s.col] || DASH_ICONS.rules
        return `
          <button class="dash-card" type="button" data-nav="${s.col}">
            <div class="dash-card-top">
              <div class="dash-card-icon" style="background:${ic.bg}"><svg viewBox="0 0 24 24">${ic.svg}</svg></div>
              <div class="dash-card-info">
                <div class="dash-card-num">${counts[i]}</div>
                <div class="dash-card-label">${escHtml(s.label)}</div>
              </div>
            </div>
            <div class="dash-card-bottom">
              <span class="dash-card-link">管理する <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></span>
              <span class="dash-card-tag">${counts[i]}${s.unit}</span>
            </div>
          </button>`
      }).join('')}
    </div>
  `
}

// =============================================
// BADGE COUNTS
// =============================================
async function loadBadgeCounts() {
  try {
    const iqSnap = await getDocs(collection(db, 'inquiries'))
    const newCount = iqSnap.docs.filter(d => d.data().status === 'new').length
    const badge = $('inquiryBadge')
    if (badge) { badge.textContent = newCount; badge.style.display = newCount ? '' : 'none' }
  } catch { /* ignore */ }

  if (canViewCasesAdmin(myProfile?.role)) {
    try {
      const csSnap = await getDocs(collection(db, 'cases'))
      const pending = csSnap.docs.filter(d => ['pending_supervisor', 'pending_homeroom'].includes(d.data().status)).length
      const badge = $('casesBadge')
      if (badge) { badge.textContent = pending; badge.style.display = pending ? '' : 'none' }
    } catch { /* ignore */ }
  }

  try {
    // お知らせバッジ（公開中の件数。過去履歴の確認導線）
    const anSnap = await getDocs(collection(db, 'announcements'))
    const pubCount = anSnap.docs.filter(d => (d.data().status || 'published') === 'published').length
    const anBadge = document.getElementById('annBadge')
    if (anBadge) { anBadge.textContent = `${pubCount}件公開中`; anBadge.style.display = pubCount ? '' : 'none' }
  } catch(e) { /* ignore */ }

  try {
    // βテストバッジ（βテスト中の件数。Issue #53）
    const betaSnap = await getDocs(collection(db, 'featureFlags'))
    const betaCount = betaSnap.docs.filter(d => (d.data().status || 'enabled') === FLAG_STATUSES.BETA).length
    const betaBadge = document.getElementById('betaBadge')
    if (betaBadge) { betaBadge.textContent = betaCount ? `${betaCount}件β中` : ''; betaBadge.style.display = betaCount ? '' : 'none' }
  } catch(e) { /* ignore */ }
}

// =============================================
// HISTORY（沿革）
// =============================================
function renderHistoryList(items) {
  const el = $('historyList')
  if (!el) return
  if (!items.length) { el.innerHTML = emptyState('沿革がまだ登録されていません', '「追加」から年号と出来事を登録してください'); return }
  el.innerHTML = `<div class="list-rows">${items.map((item, i) => `
    <div class="list-row">
      <div class="row-meta">${escHtml(item.year)}</div>
      <div class="row-main">${escHtml(item.event)}</div>
      ${itemOps('history', item.id, i, items.length)}
    </div>`).join('')}</div>`
}

// =============================================
// PRINCIPALS（歴代校長）
// =============================================
function renderPrincipalsList(items) {
  const el = $('principalsList')
  if (!el) return
  if (!items.length) { el.innerHTML = emptyState('歴代校長がまだ登録されていません'); return }
  el.innerHTML = `<div class="list-rows">${items.map((item, i) => `
    <div class="list-row principals-row">
      <div><span class="item-num">${escHtml(item.gen)}</span></div>
      <div class="row-main">${escHtml(item.name)}</div>
      <div class="row-meta">${escHtml(item.term)}</div>
      ${itemOps('principals', item.id, i, items.length)}
    </div>`).join('')}</div>`
}

// =============================================
// SONGS（校歌・応援歌）
// =============================================
function renderSongsList(items) {
  const el = $('songsList')
  if (!el) return
  if (!items.length) { el.innerHTML = emptyState('歌詞がまだ登録されていません'); return }
  const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\/.+/i.test(u.trim())
  el.innerHTML = items.map((item, i) => `
    <div class="item-card">
      <div class="item-card-header">
        <span class="item-num">${escHtml(item.type || '校歌')}</span>
        <span class="item-title">${escHtml(item.title)}</span>
        ${item.lyricist ? `<span class="item-chip">作詞 ${escHtml(item.lyricist)}</span>` : ''}
        ${item.composer ? `<span class="item-chip">作曲 ${escHtml(item.composer)}</span>` : ''}
        ${isHttpUrl(item.audioUrl) ? `<span class="item-chip item-chip-audio">♪ 音声あり</span>` : ''}
        ${itemOps('songs', item.id, i, items.length)}
      </div>
      <div class="item-card-body">
        <div class="item-body-text">${(item.verses || []).map((v, n) => `${n + 1}番\n${escHtml(v)}`).join('\n\n')}</div>
        ${isHttpUrl(item.audioUrl) ? `
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
          <div style="font-size:11px;color:var(--text-3);word-break:break-all">音声URL: ${escHtml(item.audioUrl.trim())}</div>
          <audio controls preload="none" src="${escHtml(item.audioUrl.trim())}" style="width:100%;max-width:420px;height:36px"></audio>
        </div>` : ''}
      </div>
    </div>`).join('')
}

// =============================================
// ARTICLES（rules / special / council-charter / council-rules）
// 章ごとにグルーピングして表示（Issue #49: 条文が増えても迷わない）
// =============================================
const CONTAINER_TO_COL = {
  rulesList: 'rules',
  specialList: 'special',
  councilCharterList: 'council-charter',
  councilRulesList: 'council-rules',
}

function renderArticleList(containerId) {
  const colName = CONTAINER_TO_COL[containerId] || containerId.replace('List', '')
  return function (items) {
    const el = $(containerId)
    if (!el) return
    if (!items.length) { el.innerHTML = emptyState('条文がまだ登録されていません', '「条文を追加」から登録してください'); return }

    // 章（chapter）でグループ化。章が無いものは「章なし」にまとめる
    const groups = []
    const indexOfGroup = new Map()
    items.forEach(item => {
      const key = (item.chapter || '').trim() || '__none__'
      if (!indexOfGroup.has(key)) {
        indexOfGroup.set(key, groups.length)
        groups.push({ key, label: key === '__none__' ? '' : key, rows: [] })
      }
      groups[indexOfGroup.get(key)].rows.push(item)
    })

    const card = (item, i, total) => `
      <div class="item-card">
        <div class="item-card-header">
          <span class="item-num">${escHtml(item.number || '—')}</span>
          <span class="item-title">${escHtml(item.title)}</span>
          ${item.section ? `<span class="item-chip">${escHtml(item.section)}</span>` : ''}
          ${itemOps(colName, item.id, i, total)}
        </div>
        ${(item.body || (item.items || []).length) ? `
        <div class="item-card-body">
          ${item.body ? `<div class="item-body-text">${escHtml(item.body)}</div>` : ''}
          ${(item.items || []).length ? `<div class="item-body-text"${item.body ? ' style="margin-top:8px"' : ''}>${item.items.map(x => escHtml(x)).join('\n')}</div>` : ''}
        </div>` : ''}
      </div>`

    // 章が1つ（=章なしだけ）ならヘッダーを出さずフラット表示
    if (groups.length === 1 && groups[0].key === '__none__') {
      el.innerHTML = items.map((item, i) => card(item, i, items.length)).join('')
      return
    }

    // 全体通しの index を使うことで ↑↓ が章をまたいでも正しく動く
    let cursor = 0
    el.innerHTML = groups.map(g => {
      const html = `
        ${g.label ? `<div class="dash-block-title" style="margin-top:18px">${escHtml(g.label)}<span class="dash-card-tag">${g.rows.length}条</span></div>` : ''}
        ${g.rows.map(item => card(item, cursor++, items.length)).join('')}`
      return html
    }).join('')
  }
}

// =============================================
// CURRICULUM（教育課程）— 入学年度ごとのテーブル
// =============================================
function renderCurriculumList(items) {
  const el = $('curriculumList')
  if (!el) return
  if (!items.length) { el.innerHTML = emptyState('教育課程がまだ登録されていません'); return }

  const byYear = {}
  items.forEach(item => {
    const y = String(item.year || '—')
    ;(byYear[y] ||= []).push(item)
  })

  const indexOf = new Map(items.map((x, i) => [x.id, i]))

  el.innerHTML = Object.keys(byYear).sort((a, b) => String(b).localeCompare(String(a))).map(year => `
    <div class="panel" style="margin-bottom:14px">
      <div class="panel-head">
        <span class="item-num">${escHtml(year)}年度入学</span>
        <span class="panel-title">${byYear[year].length}科目</span>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr>
            <th>教科</th><th>科目</th>
            <th class="num">1年</th><th class="num">2年</th><th class="num">3年</th>
            <th class="num">必選</th><th></th>
          </tr></thead>
          <tbody>
            ${byYear[year].map(r => `
              <tr>
                <td>${escHtml(r.subject)}</td>
                <td>${escHtml(r.course)}</td>
                <td class="num">${escHtml(r.y1 || '—')}</td>
                <td class="num">${escHtml(r.y2 || '—')}</td>
                <td class="num">${escHtml(r.y3 || '—')}</td>
                <td class="num">${escHtml(r.required || '—')}</td>
                <td>${itemOps('curriculum', r.id, indexOf.get(r.id), items.length)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`).join('')
}

// =============================================
// EVENTS（年間主要行事）— 月ごと
// =============================================
function renderEventsList(items) {
  const el = $('eventsList')
  if (!el) return
  if (!items.length) { el.innerHTML = emptyState('行事がまだ登録されていません'); return }

  const byMonth = {}
  items.forEach(item => { (byMonth[String(item.month || 1)] ||= []).push(item) })
  const indexOf = new Map(items.map((x, i) => [x.id, i]))

  // 学校の年度に合わせて 4月 始まりで並べる
  const order = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]

  el.innerHTML = order.filter(m => byMonth[String(m)]).map(m => `
    <div class="panel" style="margin-bottom:12px">
      <div class="panel-head">
        <span class="item-num">${m}月</span>
        <span class="panel-title">${byMonth[String(m)].length}件</span>
      </div>
      <div class="list-rows">
        ${byMonth[String(m)].map(item => `
          <div class="list-row" style="grid-template-columns:1fr auto">
            <div class="row-main">${escHtml(item.name)}</div>
            ${itemOps('events', item.id, indexOf.get(item.id), items.length)}
          </div>`).join('')}
      </div>
    </div>`).join('')
}

// =============================================
// 単一ドキュメント系フォーム
// =============================================
async function loadGoalsForm() {
  const el = $('goalsForm')
  if (!el) return
  el.innerHTML = spinner()
  const snap = await getDoc(doc(db, 'content', 'goals')).catch(() => null)
  const data = snap?.data() || {}
  el.innerHTML = `
    <div class="form-row">
      <label>校是の画像URL</label>
      <input type="text" id="goalsImgUrl" value="${escHtml(data.imageUrl)}" placeholder="https://...">
      <div class="form-hint">空欄の場合、生徒手帳側では画像が非表示になります。</div>
    </div>
    <div class="form-row">
      <label>就学の目標（本文）</label>
      <textarea id="goalsText" rows="9" placeholder="目標の内容を入力...">${escHtml(data.text)}</textarea>
    </div>
    <button class="btn-save" data-save-action="goals">保存</button>`
}

async function saveGoals() {
  await setDoc(doc(db, 'content', 'goals'), {
    imageUrl: trimVal('goalsImgUrl'),
    text:     trimVal('goalsText'),
  })
  showToast('就学の目標を保存しました')
}

async function loadCouncilActivitiesForm() {
  const el = $('councilActivitiesForm')
  if (!el) return
  el.innerHTML = spinner()
  const snap = await getDoc(doc(db, 'content', 'council-activities')).catch(() => null)
  const data = snap?.data() || {}
  // overview と committees を1枠に統合して表示（既存データとの後方互換）
  const merged = [data.overview, data.committees].filter(Boolean).join('\n\n')
  el.innerHTML = `
    <div class="form-row">
      <label>生徒会活動の内容（本文）</label>
      <div class="form-hint" style="margin-bottom:6px">1枠でまとめて入力してください。段落は空行で区切られます。</div>
      <textarea id="caContent" rows="14">${escHtml(merged)}</textarea>
    </div>
    <button class="btn-save" data-save-action="council-activities">保存</button>`
}

async function saveCouncilActivities() {
  // 後方互換のため overview に保存、committees は空にする
  await setDoc(doc(db, 'content', 'council-activities'), { overview: trimVal('caContent'), committees: '' })
  showToast('生徒会活動を保存しました')
}

async function loadSpecialDescForm() {
  const el = $('specialDescForm')
  if (!el) return
  el.innerHTML = spinner()
  const snap = await getDoc(doc(db, 'content', 'special')).catch(() => null)
  const data = snap?.data() || {}
  el.innerHTML = `
    <div class="form-row">
      <textarea id="specialDescription" rows="6" placeholder="特別教育活動の目的や概要を入力...">${escHtml(data.description)}</textarea>
    </div>
    <button class="btn-save" data-save-action="special-desc">保存</button>`
}

async function saveSpecialDesc() {
  const snap = await getDoc(doc(db, 'content', 'special')).catch(() => null)
  await setDoc(doc(db, 'content', 'special'), { ...(snap?.data() || {}), description: trimVal('specialDescription') })
  showToast('特別教育活動の説明文を保存しました')
}

async function loadCharterPreambleForm() {
  const el = $('charterPreambleForm')
  if (!el) return
  el.innerHTML = spinner()
  const snap = await getDoc(doc(db, 'content', 'council-charter')).catch(() => null)
  const data = snap?.data() || {}
  el.innerHTML = `
    <div class="form-row">
      <textarea id="charterPreamble" rows="6" placeholder="憲章の前文を入力...">${escHtml(data.preamble)}</textarea>
    </div>
    <button class="btn-save" data-save-action="charter-preamble">保存</button>`
}

async function saveCharterPreamble() {
  const snap = await getDoc(doc(db, 'content', 'council-charter')).catch(() => null)
  await setDoc(doc(db, 'content', 'council-charter'), { ...(snap?.data() || {}), preamble: trimVal('charterPreamble') })
  showToast('憲章の前文を保存しました')
}

// =============================================
// 条番号の自動採番ヘルパー
// 「第一条」「第12条」などの直前の値から次の番号を推定する。
// 入力欄を空にしておけば自動で次の条番号が入るようにするため。
// =============================================
const KANJI_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九']

function kanjiToNumber(s) {
  const str = String(s || '')
  if (!/[一二三四五六七八九十百]/.test(str)) return null
  let total = 0, section = 0, current = 0
  for (const ch of str) {
    const d = KANJI_DIGITS.indexOf(ch)
    if (d > 0) { current = d; continue }
    if (ch === '十') { section += (current || 1) * 10; current = 0; continue }
    if (ch === '百') { section += (current || 1) * 100; current = 0; continue }
  }
  total += section + current
  return total || null
}

function numberToKanji(n) {
  if (n <= 0) return ''
  if (n < 10) return KANJI_DIGITS[n]
  if (n < 100) {
    const t = Math.floor(n / 10), o = n % 10
    return (t > 1 ? KANJI_DIGITS[t] : '') + '十' + (o ? KANJI_DIGITS[o] : '')
  }
  const h = Math.floor(n / 100), rest = n % 100
  return (h > 1 ? KANJI_DIGITS[h] : '') + '百' + (rest ? numberToKanji(rest) : '')
}

/**
 * 同じコレクション内の既存条文から「次の条番号」を推定する。
 * 漢数字で入力されていれば漢数字、算用数字なら算用数字を維持する。
 */
function suggestArticleNumber(col, chapter = '') {
  const items = listCache[col] || []
  if (!items.length) return ''
  // 章が指定されていればその章の中の最後、なければ全体の最後を見る
  const scoped = chapter
    ? items.filter(x => (x.chapter || '').trim() === chapter.trim())
    : items
  const pool = scoped.length ? scoped : items

  let best = null // { n, kanji }
  pool.forEach(x => {
    const num = String(x.number || '')
    const arabic = num.match(/(\d+)/)
    if (arabic) {
      const n = Number(arabic[1])
      if (!best || n > best.n) best = { n, kanji: false }
      return
    }
    const k = kanjiToNumber(num.replace(/^第/, '').replace(/条$/, ''))
    if (k && (!best || k > best.n)) best = { n: k, kanji: true }
  })
  if (!best) return ''
  const next = best.n + 1
  return best.kanji ? `第${numberToKanji(next)}条` : `第${next}条`
}

// =============================================
// 項エディタ用のツールバー
// =============================================
function itemsToolbar(targetId) {
  return `<div class="input-toolbar">
    <button type="button" class="tool-btn" data-items-tool="number|${targetId}">
      <svg viewBox="0 0 24 24"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/></svg>
      番号付きの項を追加
    </button>
    <button type="button" class="tool-btn" data-items-tool="sub|${targetId}">
      <svg viewBox="0 0 24 24"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>
      サブ項目（ア イ ウ）を追加
    </button>
    <button type="button" class="tool-btn" data-items-tool="renumber|${targetId}">
      <svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      番号を振り直す
    </button>
  </div>`
}

const KATA_SUB = ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ', 'キ', 'ク', 'ケ', 'コ', 'サ', 'シ', 'ス', 'セ', 'ソ']

function handleItemsTool(tool, targetId) {
  const ta = $(targetId)
  if (!ta) return
  const lines = ta.value.split('\n')

  if (tool === 'number') {
    // 最上位（字下げされていない）項の数 + 1 を採番
    const topCount = lines.filter(l => l.trim() && !/^[\s\u3000]/.test(l)).length
    if (ta.value && !ta.value.endsWith('\n')) ta.value += '\n'
    ta.value += `${topCount + 1} `
  } else if (tool === 'sub') {
    // 直前の最上位項に属するサブ項目の数から ア イ ウ... を採番
    let subCount = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]
      if (!l.trim()) continue
      if (/^[\s\u3000]/.test(l)) { subCount++; continue }
      break
    }
    if (ta.value && !ta.value.endsWith('\n')) ta.value += '\n'
    ta.value += `  ${KATA_SUB[subCount] || 'ア'} `
  } else if (tool === 'renumber') {
    let top = 0, sub = 0
    ta.value = lines.map(l => {
      if (!l.trim()) return l
      if (/^[\s\u3000]/.test(l)) {
        const body = l.trim().replace(/^[ア-ン][\s\u3000.．]*/, '')
        const label = KATA_SUB[sub] || 'ア'
        sub++
        return `  ${label} ${body}`
      }
      const body = l.trim().replace(/^\d+[\s\u3000.．]*/, '')
      top++; sub = 0
      return `${top} ${body}`
    }).join('\n')
    showToast('項の番号を振り直しました')
  }
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)
}

/** 並び順の入力欄（自動採番済み・通常は折りたたみの中） */
function orderField(col, currentOrder) {
  const auto = currentOrder === undefined || currentOrder === null
  const value = auto ? nextOrder(col) : currentOrder
  return `<details class="collapse">
    <summary>詳細設定（並び順）</summary>
    <div class="collapse-body">
      <div class="form-row" style="margin-bottom:0">
        <label>並び順 <span class="form-tag auto">自動</span></label>
        <input type="number" id="f_order" value="${value}">
        <div class="form-hint">
          通常は入力不要です。自動で末尾に追加されます。<br>
          一覧の <strong>↑ ↓</strong> ボタンでも並び替えできます。
        </div>
      </div>
    </div>
  </details>`
}

function orderValue(col) {
  const el = $('f_order')
  if (!el || el.value === '') return nextOrder(col)
  return Number(el.value)
}

// =============================================
// MODAL CONFIGS
//
// 各設定は以下を持つ:
//   title    : モーダルのタイトル
//   fields(ctx) : 入力欄の HTML。ctx = { col, editing, seed }
//   getData(col) : 保存するデータ
//   fill(data)   : 編集時に値を流し込む
//   sticky       : 「保存して続けて追加」で引き継ぐフィールド名（DOM id）
// =============================================
const MODAL_CONFIGS = {}

MODAL_CONFIGS.history = {
  title: '沿革',
  sticky: [],
  fields: ({ col, seed }) => `
    <div class="form-row">
      <label>年号 <span class="form-tag req">必須</span></label>
      <input type="text" id="f_year" list="dl_hist_year" value="${escHtml(seed?.year)}" placeholder="1878（明11）8・12">
      ${datalist('dl_hist_year', knownValues(col, 'year'))}
      <div class="form-hint">例: 1878（明11）8・12</div>
    </div>
    <div class="form-row">
      <label>出来事 <span class="form-tag req">必須</span></label>
      <textarea id="f_event" rows="3" placeholder="茨城県立第一中学校創立">${escHtml(seed?.event)}</textarea>
    </div>
    ${orderField(col, seed ? undefined : undefined)}`,
  getData: (col) => ({
    year:  trimVal('f_year'),
    event: trimVal('f_event'),
    order: orderValue(col),
  }),
  fill: (data) => {
    $('f_year').value  = data.year  || ''
    $('f_event').value = data.event || ''
    if ($('f_order')) $('f_order').value = data.order ?? 0
  },
}

MODAL_CONFIGS.principals = {
  title: '歴代校長',
  sticky: [],
  fields: ({ col, seed }) => `
    <div class="form-row-2 form-row">
      <div>
        <label>代数 <span class="form-tag req">必須</span></label>
        <input type="text" id="f_gen" value="${escHtml(seed?.gen)}" placeholder="初代">
      </div>
      <div>
        <label>氏名 <span class="form-tag req">必須</span></label>
        <input type="text" id="f_name" value="${escHtml(seed?.name)}" placeholder="〇〇 〇〇">
      </div>
    </div>
    <div class="form-row">
      <label>在任期間</label>
      <input type="text" id="f_term" value="${escHtml(seed?.term)}" placeholder="明治13・7 ― 明治14・5">
    </div>
    ${orderField(col)}`,
  getData: (col) => ({
    gen:   trimVal('f_gen'),
    name:  trimVal('f_name'),
    term:  trimVal('f_term'),
    order: orderValue(col),
  }),
  fill: (data) => {
    $('f_gen').value  = data.gen  || ''
    $('f_name').value = data.name || ''
    $('f_term').value = data.term || ''
    if ($('f_order')) $('f_order').value = data.order ?? 0
  },
}

MODAL_CONFIGS.songs = {
  title: '歌詞',
  sticky: ['f_type', 'f_lyricist', 'f_composer'],
  fields: ({ col, seed }) => {
    const s = { ...getSticky('songs'), ...(seed || {}) }
    const audioUrl = seed?.audioUrl ?? s.audioUrl ?? s.f_audioUrl ?? ''
    return `
    <div class="form-row-2 form-row">
      <div>
        <label>種別</label>
        <select id="f_type">
          ${['校歌', '応援歌', 'その他'].map(t => `<option value="${t}"${(s.type || s.f_type) === t ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div>
        <label>タイトル <span class="form-tag req">必須</span></label>
        <input type="text" id="f_title" value="${escHtml(seed?.title)}" placeholder="水戸第一高等学校校歌">
      </div>
    </div>
    <div class="form-row-2 form-row">
      <div>
        <label>作詞者 <span class="form-tag">引き継ぎ</span></label>
        <input type="text" id="f_lyricist" list="dl_lyricist" value="${escHtml(s.lyricist ?? s.f_lyricist)}" placeholder="〇〇 〇〇">
        ${datalist('dl_lyricist', knownValues(col, 'lyricist'))}
      </div>
      <div>
        <label>作曲者 <span class="form-tag">引き継ぎ</span></label>
        <input type="text" id="f_composer" list="dl_composer" value="${escHtml(s.composer ?? s.f_composer)}" placeholder="〇〇 〇〇">
        ${datalist('dl_composer', knownValues(col, 'composer'))}
      </div>
    </div>
    <div class="form-row">
      <label>音声URL（任意）</label>
      <input type="url" id="f_audioUrl" inputmode="url" value="${escHtml(audioUrl)}" placeholder="https://.../kouka.mp3">
      <div class="form-hint">校歌・応援歌のMP3などのURLを入れると、生徒手帳側に試聴プレイヤーが表示されます。空欄でも歌詞のみで従来どおり動作します。</div>
    </div>
    <div class="form-row">
      <label>一番</label>
      <textarea id="f_v1" rows="4" placeholder="歌詞を入力...">${escHtml((seed?.verses || [])[0])}</textarea>
    </div>
    <div class="form-row">
      <label>二番（なければ空欄）</label>
      <textarea id="f_v2" rows="4">${escHtml((seed?.verses || [])[1])}</textarea>
    </div>
    <div class="form-row">
      <label>三番（なければ空欄）</label>
      <textarea id="f_v3" rows="4">${escHtml((seed?.verses || [])[2])}</textarea>
    </div>
    ${orderField(col)}`
  },
  getData: (col) => ({
    type:     val('f_type'),
    title:    trimVal('f_title'),
    lyricist: trimVal('f_lyricist'),
    composer: trimVal('f_composer'),
    audioUrl: trimVal('f_audioUrl'),
    verses:   ['f_v1', 'f_v2', 'f_v3'].map(trimVal).filter(Boolean),
    order:    orderValue(col),
  }),
  fill: (data) => {
    $('f_type').value     = data.type     || '校歌'
    $('f_title').value    = data.title    || ''
    $('f_lyricist').value = data.lyricist || ''
    $('f_composer').value = data.composer || ''
    if ($('f_audioUrl')) $('f_audioUrl').value = data.audioUrl || ''
    const v = data.verses || []
    $('f_v1').value = v[0] || ''
    $('f_v2').value = v[1] || ''
    $('f_v3').value = v[2] || ''
    if ($('f_order')) $('f_order').value = data.order ?? 0
  },
}

MODAL_CONFIGS.events = {
  title: '年間行事',
  sticky: ['f_month'],
  fields: ({ col, seed }) => {
    const s = { ...getSticky('events'), ...(seed || {}) }
    const selMonth = Number(s.month ?? s.f_month ?? (new Date().getMonth() + 1))
    return `
    <div class="form-row-2 form-row">
      <div>
        <label>月 <span class="form-tag">引き継ぎ</span></label>
        <select id="f_month">
          ${[4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map(m => `<option value="${m}"${m === selMonth ? ' selected' : ''}>${m}月</option>`).join('')}
        </select>
      </div>
      <div>
        <label>行事名 <span class="form-tag req">必須</span></label>
        <input type="text" id="f_name" list="dl_event_name" value="${escHtml(seed?.name)}" placeholder="始業式">
        ${datalist('dl_event_name', knownValues(col, 'name'))}
      </div>
    </div>
    <div class="notice" style="margin-bottom:15px">
      「保存して続けて追加」を使うと <strong>月を選び直さずに</strong> 続けて行事を登録できます。
    </div>
    ${orderField(col)}`
  },
  getData: (col) => ({
    month: Number(val('f_month')),
    name:  trimVal('f_name'),
    order: orderValue(col),
  }),
  fill: (data) => {
    $('f_month').value = data.month || 4
    $('f_name').value  = data.name  || ''
    if ($('f_order')) $('f_order').value = data.order ?? 0
  },
}

MODAL_CONFIGS.curriculum = {
  title: '教育課程',
  sticky: ['f_year', 'f_subject', 'f_required'],
  fields: ({ col, seed }) => {
    const s = { ...getSticky('curriculum'), ...(seed || {}) }
    const req = s.required ?? s.f_required ?? '必修'
    return `
    <div class="form-row-2 form-row">
      <div>
        <label>入学年度 <span class="form-tag">引き継ぎ</span></label>
        <input type="text" id="f_year" list="dl_cur_year" value="${escHtml(s.year ?? s.f_year)}" placeholder="2024">
        ${datalist('dl_cur_year', knownValues(col, 'year'))}
      </div>
      <div>
        <label>教科 <span class="form-tag">引き継ぎ</span></label>
        <input type="text" id="f_subject" list="dl_cur_subject" value="${escHtml(s.subject ?? s.f_subject)}" placeholder="国語">
        ${datalist('dl_cur_subject', knownValues(col, 'subject'))}
      </div>
    </div>
    <div class="form-row">
      <label>科目 <span class="form-tag req">必須</span></label>
      <input type="text" id="f_course" value="${escHtml(seed?.course)}" placeholder="現代の国語">
    </div>
    <div class="form-row-3 form-row">
      <div><label>1年（単位）</label><input type="text" id="f_y1" value="${escHtml(seed?.y1)}" placeholder="2"></div>
      <div><label>2年（単位）</label><input type="text" id="f_y2" value="${escHtml(seed?.y2)}" placeholder="—"></div>
      <div><label>3年（単位）</label><input type="text" id="f_y3" value="${escHtml(seed?.y3)}" placeholder="—"></div>
    </div>
    <div class="form-row">
      <label>必修 / 選択 <span class="form-tag">引き継ぎ</span></label>
      <select id="f_required">
        ${['必修', '選択'].map(r => `<option value="${r}"${req === r ? ' selected' : ''}>${r}</option>`).join('')}
      </select>
    </div>
    <div class="notice" style="margin-bottom:15px">
      「保存して続けて追加」で <strong>入学年度・教科・必修選択を引き継いだまま</strong> 次の科目を入力できます。
    </div>
    ${orderField(col)}`
  },
  getData: (col) => ({
    year:     trimVal('f_year'),
    subject:  trimVal('f_subject'),
    course:   trimVal('f_course'),
    y1:       trimVal('f_y1'),
    y2:       trimVal('f_y2'),
    y3:       trimVal('f_y3'),
    required: val('f_required'),
    order:    orderValue(col),
  }),
  fill: (data) => {
    $('f_year').value     = data.year     || ''
    $('f_subject').value  = data.subject  || ''
    $('f_course').value   = data.course   || ''
    $('f_y1').value       = data.y1       || ''
    $('f_y2').value       = data.y2       || ''
    $('f_y3').value       = data.y3       || ''
    $('f_required').value = data.required || '必修'
    if ($('f_order')) $('f_order').value = data.order ?? 0
  },
}

// --- 条文系（rules / special / council-charter / council-rules）は共通フォーム ---
const articleForm = (type) => ({
  title: '条文',
  sticky: ['f_chapter', 'f_section'],
  fields: ({ col, seed }) => {
    const s = { ...getSticky(type), ...(seed || {}) }
    const chapter = s.chapter ?? s.f_chapter ?? ''
    const section = s.section ?? s.f_section ?? ''
    // 条番号は空欄なら自動採番（章が同じものの続き番号）
    const suggested = seed?.number || suggestArticleNumber(col, chapter)
    return `
    <div class="form-row">
      <label>章見出し <span class="form-tag">引き継ぎ</span></label>
      <input type="text" id="f_chapter" list="dl_chapter" value="${escHtml(chapter)}" placeholder="第一章 総則">
      ${datalist('dl_chapter', knownValues(col, 'chapter'))}
      <div class="form-hint">既に登録済みの章は入力欄をクリックすると候補から選べます。「保存して続けて追加」では章がそのまま引き継がれます。</div>
    </div>
    ${type === 'council-charter' ? `
    <div class="form-row">
      <label>セクション <span class="form-tag">引き継ぎ</span></label>
      <input type="text" id="f_section" list="dl_section" value="${escHtml(section)}" placeholder="総則">
      ${datalist('dl_section', knownValues(col, 'section'))}
      <div class="form-hint">「総則」「細則」などに分かれる場合に指定します。</div>
    </div>` : ''}
    <div class="form-row-2 form-row">
      <div>
        <label>条番号 <span class="form-tag auto">自動</span></label>
        <input type="text" id="f_number" value="${escHtml(suggested)}" placeholder="第一条">
        <div class="form-hint">前の条文から自動で採番されます。違う場合は直接書き換えてください。</div>
      </div>
      <div>
        <label>条名</label>
        <input type="text" id="f_title_art" value="${escHtml(seed?.title)}" placeholder="目的">
      </div>
    </div>
    <div class="form-row">
      <label>本文</label>
      <textarea id="f_body" rows="4" placeholder="条文の本文を入力...">${escHtml(seed?.body)}</textarea>
    </div>
    <div class="form-row">
      <label>項（1行1項）</label>
      ${itemsToolbar('f_items')}
      <textarea id="f_items" rows="8" placeholder="1 授業に関すること&#10;  ア 遅刻について&#10;  イ 欠席について&#10;2 施設の利用に関すること">${escHtml((seed?.items || []).join('\n'))}</textarea>
      <div class="form-hint">
        上のボタンで番号・サブ項目を自動で挿入できます。<br>
        サブ項目は行頭をスペースで字下げするか「ア」「イ」等で始めてください。
      </div>
    </div>
    <div class="notice" style="margin-bottom:15px">
      <strong>連続入力のコツ:</strong> 「保存して続けて追加」（${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} + Shift + Enter）を押すと、
      章とセクションを引き継いだまま条番号だけ1つ進んだ空のフォームが開きます。
    </div>
    ${orderField(col)}`
  },
  getData: (col) => {
    const data = {
      number:  trimVal('f_number'),
      title:   trimVal('f_title_art'),
      chapter: trimVal('f_chapter'),
      body:    trimVal('f_body'),
      items:   trimVal('f_items').split('\n').filter(l => l.trim()),
      order:   orderValue(col),
    }
    if ($('f_section')) data.section = trimVal('f_section')
    return data
  },
  fill: (data) => {
    $('f_number').value    = data.number  || ''
    $('f_title_art').value = data.title   || ''
    $('f_chapter').value   = data.chapter || ''
    $('f_body').value      = data.body    || ''
    $('f_items').value     = (data.items || []).join('\n')
    if ($('f_order')) $('f_order').value = data.order ?? 0
    if ($('f_section')) $('f_section').value = data.section || ''
  },
})

MODAL_CONFIGS['rules']           = articleForm('rules')
MODAL_CONFIGS['special']         = articleForm('special')
MODAL_CONFIGS['council-charter'] = articleForm('council-charter')
MODAL_CONFIGS['council-rules']   = articleForm('council-rules')

/** 必須項目の簡易バリデーション */
const REQUIRED_FIELDS = {
  history:    [['f_year', '年号'], ['f_event', '出来事']],
  principals: [['f_gen', '代数'], ['f_name', '氏名']],
  songs:      [['f_title', 'タイトル']],
  events:     [['f_name', '行事名']],
  curriculum: [['f_course', '科目']],
  rules:              [['f_number', '条番号']],
  special:            [['f_number', '条番号']],
  'council-charter':  [['f_number', '条番号']],
  'council-rules':    [['f_number', '条番号']],
  announcements:      [['f_ann_title', 'タイトル'], ['f_ann_body', '本文']],
  featureFlags:       [['f_flag_key', 'キー（機能ID）'], ['f_flag_name', '機能名']],
}

function validateModal(type) {
  for (const [id, label] of (REQUIRED_FIELDS[type] || [])) {
    if (!trimVal(id)) {
      showToast(`${label}を入力してください`)
      $(id)?.focus()
      return false
    }
  }
  // 校歌・応援歌: 音声URLは任意だが、入力時は http(s) のみ許可（後方互換のため空欄はOK）
  if (type === 'songs') {
    const u = trimVal('f_audioUrl')
    if (u && !/^https?:\/\/.+/i.test(u)) {
      showToast('音声URLは https:// または http:// から始まるURLを入力してください')
      $('f_audioUrl')?.focus()
      return false
    }
  }
  return true
}

// =============================================
// MODAL 開閉・保存
// =============================================
/** ユーザー編集モーダルが saveBtn を奪っている場合に元へ戻す */
function resetModalSaveHandlers() {
  const saveBtn = $('modalSaveBtn')
  if (saveBtn) saveBtn.onclick = null
}

async function openModal(type, id = null, { seed = null } = {}) {
  const cfg = MODAL_CONFIGS[type]
  if (!cfg) return

  editingType = type
  editingId   = id
  resetModalSaveHandlers()

  // 一覧キャッシュが無い状態（ダッシュボードから直接追加など）では先に取得して
  // order の自動採番・入力候補が正しく効くようにする
  if (!listCache[type]) {
    try { await fetchCollection(type) } catch { listCache[type] = [] }
  }

  $('modalTitle').textContent = (id ? '編集 — ' : '追加 — ') + cfg.title
  $('modalBody').innerHTML = cfg.fields({ col: type, editing: !!id, seed })

  // 「保存して続けて追加」は新規追加時のみ表示
  const moreBtn = $('modalSaveMoreBtn')
  if (moreBtn) moreBtn.style.display = id ? 'none' : ''

  // 項エディタのツールバー
  $('modalBody').querySelectorAll('[data-items-tool]').forEach(btn => {
    const [tool, target] = btn.dataset.itemsTool.split('|')
    btn.addEventListener('click', () => handleItemsTool(tool, target))
  })

  // 条文フォーム: 章を変えたら条番号の候補も追従させる
  const chapterEl = $('f_chapter')
  const numberEl  = $('f_number')
  if (!id && chapterEl && numberEl) {
    chapterEl.addEventListener('change', () => {
      const next = suggestArticleNumber(type, chapterEl.value)
      if (next) numberEl.value = next
    })
  }

  if (id) {
    const snap = await getDoc(doc(db, type, id))
    if (snap.exists()) cfg.fill(snap.data())
  }

  $('modalOverlay').classList.add('open')

  // 最初の入力欄にフォーカス（連続入力を速くする）
  setTimeout(() => {
    const first = $('modalBody').querySelector('input:not([disabled]),textarea,select')
    // 条文追加時は「章」ではなく「条名」から打ちたいので条番号の次にフォーカス
    const preferred = (!id && $('f_title_art')) ? $('f_title_art') : first
    preferred?.focus()
  }, 60)
}

function closeModal() {
  $('modalOverlay')?.classList.remove('open')
  resetModalSaveHandlers()
  editingId = null
  editingType = null
}

async function saveModal({ keepOpen = false } = {}) {
  const type = editingType
  const cfg = MODAL_CONFIGS[type]
  if (!cfg) return
  if (!validateModal(type)) return

  const btns = [$('modalSaveBtn'), $('modalSaveMoreBtn')].filter(Boolean)
  btns.forEach(b => { b.disabled = true })

  try {
    const data = cfg.getData(type)
    // お知らせ (Issue #37): 新規作成時に createdAt を付与（必須チェックは REQUIRED_FIELDS 側で行う）
    if (type === 'announcements' && !editingId) data.createdAt = serverTimestamp()
    // 機能フラグ (Issue #53): 新規作成時に作成情報を付与
    if (type === 'featureFlags' && !editingId) {
      data.createdAt = serverTimestamp()
      data.createdBy = auth.currentUser?.email || auth.currentUser?.uid || ''
    }

    if (editingId) {
      await updateDoc(doc(db, type, editingId), data)
      showToast(type === 'announcements' ? 'お知らせを更新しました' : '更新しました')
    } else {
      await addDoc(collection(db, type), data)
      if (type === 'announcements') {
        showToast(data.status === 'published' ? 'お知らせを配信しました' : '下書きを保存しました')
      } else {
        showToast(keepOpen ? '保存しました。続けて入力できます' : '追加しました')
      }
    }

    // 引き継ぎ対象の値を保存（次回モーダルを開いたときの初期値になる）
    if (cfg.sticky?.length) {
      const picked = {}
      cfg.sticky.forEach(fid => { if ($(fid)) picked[fid] = val(fid) })
      setSticky(type, picked)
    }

    // キャッシュを更新（order 自動採番・条番号自動採番のため）
    await fetchCollection(type).catch(() => {})

    if (keepOpen && !editingId) {
      // 引き継ぎ項目だけ残した空フォームを開き直す
      await openModal(type, null)
    } else {
      closeModal()
    }
    loadSection(currentSection)
    loadSidebarCounts()
  } catch (e) {
    showToast('エラーが発生しました: ' + (e?.message || e))
  }

  btns.forEach(b => { b.disabled = false })
}

async function deleteItem(col, id) {
  const item = (listCache[col] || []).find(x => x.id === id)
  const label = item ? (item.number || item.name || item.title || item.year || item.course || item.gen || '') : ''
  if (!confirm(`${label ? `「${label}」を` : 'この項目を'}削除しますか？\nこの操作は取り消せません。`)) return
  try {
    await deleteDoc(doc(db, col, id))
    showToast('削除しました')
    loadSection(currentSection)
    loadSidebarCounts()
  } catch (e) {
    const msg = e?.message || String(e)
    if (msg.includes('Missing or insufficient permissions')) {
      alert('削除に失敗しました: Firestoreのセキュリティルールで操作が拒否されました。\nFirebase Console でルールを更新してください（firestore.rules を参照）。')
    } else {
      alert('削除に失敗しました: ' + msg)
    }
  }
}

// 「引き継ぎ」値をリセットできるようにグローバルへ公開
window.resetAdminSticky = function (type) {
  if (type) clearSticky(type)
  else { stickyStore = {}; try { localStorage.removeItem(STICKY_KEY) } catch { /* ignore */ } }
  showToast('入力の引き継ぎをリセットしました')
}

// =============================================
// お知らせ配信 (Issue #37)
// 管理画面から配信・過去履歴の確認。Push通知連携なし。
// =============================================
const ANN_CATEGORIES = {
  info:      { label: 'お知らせ', color: '#1a2744', bg: 'rgba(26,39,68,.08)' },
  update:    { label: '更新',     color: '#0e6655', bg: '#d1f2eb' },
  feature:   { label: '新機能',   color: '#5b2c6f', bg: '#e8daef' },
  important: { label: '重要',     color: '#922b21', bg: '#fadbd8' },
  welcome:   { label: 'ウェルカム', color: '#7d6608', bg: '#fcf3cf' },
}
const ANN_PAGES = [
  { v: '', label: 'リンクなし' },
  { v: 'home', label: 'ホーム' },
  { v: 'notices', label: 'お知らせ' },
  { v: 'rules', label: '諸規定' },
  { v: 'special', label: '特別教育活動' },
  { v: 'events', label: '年間主要行事' },
  { v: 'curriculum', label: '教育課程' },
  { v: 'songs', label: '歌詞' },
  { v: 'council-charter', label: '知道生徒会憲章' },
  { v: 'council-rules', label: '生徒会関係諸規定' },
  { v: 'council-activities', label: '生徒会活動' },
  { v: 'apply', label: '公欠申請' },
  { v: 'contact', label: 'お問い合わせ' },
]

function annMillis(v) {
  if (v == null) return 0
  try {
    if (typeof v?.toMillis === 'function') return v.toMillis()
    if (typeof v?.toDate === 'function') return v.toDate().getTime()
  } catch { /* ignore */ }
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isNaN(t) ? 0 : t
}

function annDateStr(v) {
  const ms = annMillis(v)
  if (!ms) return '—'
  return new Date(ms).toLocaleString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// datetime-local input用の値（ローカル時刻）
function toLocalInputValue(v) {
  const ms = annMillis(v) || Date.now()
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

async function loadAnnouncements() {
  const el = document.getElementById('announcementsList')
  if (!el) return
  el.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>読み込み中...</div>'
  let items = []
  try {
    const snap = await getDocs(query(collection(db, 'announcements'), orderBy('publishedAt', 'desc')))
    items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch {
    const snap = await getDocs(collection(db, 'announcements'))
    items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    items.sort((a, b) => annMillis(b.publishedAt || b.createdAt) - annMillis(a.publishedAt || a.createdAt))
  }

  const published = items.filter(a => (a.status || 'published') === 'published').length
  const badge = document.getElementById('annBadge')
  if (badge) { badge.textContent = `${published}件公開中`; badge.style.display = published ? '' : 'none' }

  if (!items.length) {
    el.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      <p>まだお知らせがありません。「お知らせを作成」から配信できます。</p>
    </div>`
    return
  }

  el.innerHTML = items.map(a => {
    const meta = ANN_CATEGORIES[a.category] || ANN_CATEGORIES.info
    const isPub = (a.status || 'published') === 'published'
    return `
    <div class="item-card" style="margin-bottom:10px">
      <div class="item-card-header">
        <span class="item-num" style="color:${meta.color};background:${meta.bg}">${meta.label}</span>
        <span class="item-title">${escHtml(a.title || '(無題)')}</span>
        <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;color:${isPub ? '#155724' : '#856404'};background:${isPub ? '#d4edda' : '#fff3cd'}">${isPub ? '公開中' : '下書き'}</span>
        ${a.pinned ? '<span style="font-size:10px;font-weight:700;color:var(--enjii)">📌固定</span>' : ''}
        <div class="item-actions">
          <button class="btn-icon" data-edit="announcements|${a.id}">
            <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-icon del" data-delete="announcements|${a.id}">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      </div>
      <div class="item-card-body">
        <div style="font-size:11px;color:var(--text-3);margin-bottom:6px">公開日時: ${annDateStr(a.publishedAt || a.createdAt)}${a.linkPage ? ` ／ リンク: ${escHtml(a.linkPage)}` : ''}</div>
        <div class="item-body-text" style="white-space:pre-wrap">${escHtml(a.body || '')}</div>
      </div>
    </div>`
  }).join('')
}

MODAL_CONFIGS['announcements'] = {
  title: 'お知らせ',
  fields: () => `
    <div class="form-row">
      <label>タイトル（例: ○○を更新しました！）</label>
      <input type="text" id="f_ann_title" placeholder="例: 年間行事予定を更新しました！" maxlength="80">
    </div>
    <div class="form-row-2 form-row">
      <div>
        <label>カテゴリ</label>
        <select id="f_ann_category">
          <option value="info">お知らせ</option>
          <option value="update">更新</option>
          <option value="feature">新機能</option>
          <option value="important">重要</option>
          <option value="welcome">ウェルカム（新規ユーザー向け）</option>
        </select>
      </div>
      <div>
        <label>状態</label>
        <select id="f_ann_status">
          <option value="published">公開（配信する）</option>
          <option value="draft">下書き（配信しない）</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <label>本文</label>
      <textarea id="f_ann_body" rows="6" placeholder="ユーザーに伝えたい内容を入力..."></textarea>
    </div>
    <div class="form-row-2 form-row">
      <div>
        <label>公開日時</label>
        <input type="datetime-local" id="f_ann_publishedAt">
      </div>
      <div>
        <label>関連ページ（任意）</label>
        <select id="f_ann_linkPage">
          ${ANN_PAGES.map(p => `<option value="${p.v}">${p.label}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="f_ann_pinned" style="width:auto"> 一覧の上部に固定表示する
      </label>
    </div>
  `,
  getData: () => {
    const pubRaw = document.getElementById('f_ann_publishedAt').value
    const pubDate = pubRaw ? new Date(pubRaw) : new Date()
    return {
      title: document.getElementById('f_ann_title').value.trim(),
      category: document.getElementById('f_ann_category').value,
      status: document.getElementById('f_ann_status').value,
      body: document.getElementById('f_ann_body').value.trim(),
      linkPage: document.getElementById('f_ann_linkPage').value,
      pinned: document.getElementById('f_ann_pinned').checked,
      publishedAt: Timestamp.fromDate(pubDate),
      updatedAt: serverTimestamp(),
      createdBy: auth.currentUser?.email || auth.currentUser?.uid || '',
    }
  },
  fill: (data) => {
    document.getElementById('f_ann_title').value = data.title || ''
    document.getElementById('f_ann_category').value = data.category || 'info'
    document.getElementById('f_ann_status').value = data.status || 'published'
    document.getElementById('f_ann_body').value = data.body || ''
    document.getElementById('f_ann_linkPage').value = data.linkPage || ''
    document.getElementById('f_ann_pinned').checked = !!data.pinned
    document.getElementById('f_ann_publishedAt').value = toLocalInputValue(data.publishedAt || data.createdAt)
  },
}

// =============================================
// 機能フラグ管理 (Issue #53: βテスト)
// 公開フロー: 無効 → βテスト中（βテスターのみ） → 公開（全員）
// =============================================
const FLAG_STATUS_META = {
  [FLAG_STATUSES.DISABLED]: { label: '無効', color: '#818894', bg: '#eceef2' },
  [FLAG_STATUSES.BETA]:     { label: 'βテスト中', color: '#5b2c6f', bg: '#e8daef' },
  [FLAG_STATUSES.ENABLED]:  { label: '公開', color: '#155724', bg: '#d4edda' },
}

function flagStatusPill(status) {
  const m = FLAG_STATUS_META[status] || FLAG_STATUS_META[FLAG_STATUSES.ENABLED]
  return `<span style="font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;white-space:nowrap;color:${m.color};background:${m.bg}">${m.label}</span>`
}

async function loadBetaFlags() {
  const el = document.getElementById('betaFlagsList')
  if (!el) return
  el.innerHTML = spinner()
  let items = []
  try {
    const snap = await getDocs(collection(db, 'featureFlags'))
    items = snap.docs.map(d => ({ id: d.id, ...normalizeFlag(d.data()) }))
    items.sort((a, b) => String(a.key).localeCompare(String(b.key), 'ja'))
  } catch (e) {
    el.innerHTML = errorState(e)
    return
  }

  const betaCount = items.filter(f => f.status === FLAG_STATUSES.BETA).length
  const badge = document.getElementById('betaBadge')
  if (badge) { badge.textContent = betaCount ? `${betaCount}件β中` : ''; badge.style.display = betaCount ? '' : 'none' }

  if (!items.length) {
    el.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24"><path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8z"/></svg>
      <p>まだ機能フラグがありません。「機能フラグを追加」からβテストを開始できます。</p>
      <p class="empty-hint">例: キー「new-search」／機能名「新しい検索画面」／状態「βテスト中」</p>
    </div>`
    return
  }

  el.innerHTML = items.map(f => `
    <div class="item-card" style="margin-bottom:10px">
      <div class="item-card-header">
        <span class="item-num">β</span>
        <span class="item-title">${escHtml(f.name || '(名称未設定)')} <span style="font-weight:400;color:var(--text-3);font-size:11px">key: ${escHtml(f.key)}</span></span>
        ${flagStatusPill(f.status)}
        <div class="item-actions">
          <button class="btn-icon" data-edit="featureFlags|${f.id}" title="編集" aria-label="編集">
            <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-icon del" data-delete="featureFlags|${f.id}" title="削除" aria-label="削除">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      </div>
      ${f.description ? `<div class="item-card-body"><div class="item-body-text">${escHtml(f.description)}</div></div>` : ''}
    </div>`).join('')

  // アプリに組み込まれた既知フラグで未作成のものは、デフォルト状態で動作中である旨を表示
  const existingKeys = new Set(items.map(f => f.key))
  const missingKnown = Object.entries(KNOWN_FLAGS).filter(([key]) => !existingKeys.has(key))
  if (missingKnown.length) {
    el.innerHTML += `
      <div class="dash-block-title" style="margin-top:18px">未作成の組み込み機能（デフォルト状態で動作中）</div>
      ${missingKnown.map(([key, meta]) => `
      <div class="item-card" style="margin-bottom:10px;opacity:.85">
        <div class="item-card-header">
          <span class="item-num">β</span>
          <span class="item-title">${escHtml(meta.name)} <span style="font-weight:400;color:var(--text-3);font-size:11px">key: ${escHtml(key)}</span></span>
          ${flagStatusPill(meta.defaultStatus)}
        </div>
        <div class="item-card-body">
          <div class="item-body-text">${escHtml(meta.description || '')}</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:6px">ドキュメント未作成のため「${escHtml(FLAG_STATUS_LABELS[meta.defaultStatus] || meta.defaultStatus)}」として動作中。状態を変えるには「機能フラグを追加」で同じキーを作成してください。</div>
        </div>
      </div>`).join('')}`
  }
}

MODAL_CONFIGS['featureFlags'] = {
  title: '機能フラグ',
  fields: () => `
    <div class="form-row">
      <label>キー（機能ID） <span class="form-tag req">必須</span></label>
      <input type="text" id="f_flag_key" placeholder="例: new-search" maxlength="60" style="font-family:monospace">
      <div class="form-hint">半角英小文字・数字・ハイフンのみ。アプリ側の判定キーになります（例: <code>isFeatureEnabled(flags['new-search'], profile)</code>）。作成後の変更は避けてください。</div>
    </div>
    <div class="form-row">
      <label>機能名 <span class="form-tag req">必須</span></label>
      <input type="text" id="f_flag_name" placeholder="例: 新しい検索画面">
    </div>
    <div class="form-row">
      <label>説明（任意）</label>
      <textarea id="f_flag_description" rows="3" placeholder="βテストの内容・確認してほしい点を入力..."></textarea>
    </div>
    <div class="form-row">
      <label>公開状態</label>
      <select id="f_flag_status">
        ${Object.values(FLAG_STATUSES).map(s => `<option value="${s}">${escHtml(FLAG_STATUS_LABELS[s] || s)}</option>`).join('')}
      </select>
      <div class="form-hint">無効→βテスト中→公開の順に切り替えてリリースします。</div>
    </div>
  `,
  getData: () => {
    const keyErr = validateFlagKey(trimVal('f_flag_key'))
    if (keyErr) throw new Error(keyErr)
    return {
      key: trimVal('f_flag_key'),
      name: trimVal('f_flag_name'),
      description: trimVal('f_flag_description'),
      status: val('f_flag_status') || FLAG_STATUSES.BETA,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || auth.currentUser?.uid || '',
    }
  },
  fill: (data) => {
    document.getElementById('f_flag_key').value = data.key || ''
    document.getElementById('f_flag_key').disabled = true
    document.getElementById('f_flag_name').value = data.name || ''
    document.getElementById('f_flag_description').value = data.description || ''
    document.getElementById('f_flag_status').value = data.status || FLAG_STATUSES.BETA
  },
}

// 新規作成時は公開日時の初期値をセット（openModal の呼び出し側で解決される）
// ※ saveModal ボタンのリスナーは登録時の参照を保持するため、
//    saveModal 自体の本体に分岐を入れて対応（ラッパー再代入は使わない）。
const _origOpenModal = openModal
openModal = async function(type, id = null, opts = {}) {
  await _origOpenModal(type, id, opts)
  if (type === 'announcements' && !id) {
    const el = document.getElementById('f_ann_publishedAt')
    if (el && !el.value) el.value = toLocalInputValue(new Date())
  }
}

// =============================================
// お問い合わせ管理
// =============================================
const AI_URL = 'https://mito1-hundbook.asanuma-ryuto.workers.dev'
const CATEGORY_LABELS = { bug: 'バグ・不具合', feature: '機能要望', content: '内容修正依頼', other: 'その他' }
const STATUS_LABELS   = { new: '未対応', replied: '返信済', closed: '完了' }
const STATUS_CLASS    = { new: 'badge-warn', replied: 'badge-muted', closed: 'badge-ok' }

window.loadInquiries = async function () {
  const el = $('inquiriesList')
  if (!el) return
  el.innerHTML = spinner()
  const filter = $('inquiryFilter')?.value || 'all'

  try {
    const snap = await getDocs(query(collection(db, 'inquiries'), orderBy('createdAt', 'desc')))
    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    if (filter !== 'all') items = items.filter(i => i.status === filter)

    const newCount = snap.docs.filter(d => d.data().status === 'new').length
    const badge = $('inquiryBadge')
    if (badge) { badge.textContent = newCount; badge.style.display = newCount ? '' : 'none' }

    if (!items.length) { el.innerHTML = emptyState('該当するお問い合わせはありません'); return }

    // モデレーターは閲覧・AI下書きのみ可能。返信保存/送信/状態変更/削除は管理者以上のみ。
    const iCanReply = canReplyInquiries(myProfile?.role)

    el.innerHTML = items.map(item => `
      <div class="iq-card" id="inq-${item.id}">
        <div class="iq-head">
          <div class="iq-meta-row">
            <span class="badge ${STATUS_CLASS[item.status] || 'badge-muted'}">${STATUS_LABELS[item.status] || escHtml(item.status)}</span>
            <span class="badge badge-muted">${escHtml(CATEGORY_LABELS[item.category] || item.category || 'その他')}</span>
            <span style="font-size:11px;color:var(--text-3);margin-left:auto">${item.createdAt?.toDate ? item.createdAt.toDate().toLocaleString('ja') : ''}</span>
          </div>
          <div class="iq-subject">${escHtml(item.subject || '（件名なし）')}</div>
          <div class="iq-from">差出人: ${escHtml(item.name || '不明')} &lt;${escHtml(item.email || '')}&gt;</div>
          <div class="iq-body">${escHtml(item.body || '')}</div>
          ${item.reply ? `<div class="iq-prev-reply"><strong>返信済み内容</strong><br><span style="white-space:pre-wrap">${escHtml(item.reply)}</span></div>` : ''}
        </div>
        <div class="iq-reply-zone">
          <textarea id="reply-${item.id}" rows="3" placeholder="返信内容を入力（メールで送信する文章）"${iCanReply ? '' : ' readonly'}>${escHtml(item.reply || '')}</textarea>
          <div class="iq-reply-ops">
            <button class="btn-xs" onclick="draftReply('${item.id}','${escAttr(item.subject)}','${escAttr(item.body)}')">✦ AIで下書き</button>
            ${iCanReply ? `
            <button class="btn-xs primary" onclick="saveReply('${item.id}')">返信内容を保存</button>
            <button class="btn-xs send" onclick="sendReplyEmail('${item.id}', event)">メールで送信</button>
            <select class="select-ctl" style="height:34px" onchange="changeStatus('${item.id}',this.value)" aria-label="ステータス変更">
              ${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}"${item.status === k ? ' selected' : ''}>${v}</option>`).join('')}
            </select>
            <button class="btn-xs danger" onclick="deleteInquiry('${item.id}')">削除</button>` : `
            <span style="font-size:11px;color:var(--text-3)">返信・状態変更は管理者以上のみ行えます</span>`}
          </div>
        </div>
      </div>`).join('')
  } catch (e) {
    el.innerHTML = errorState(e)
  }
}

window.draftReply = async function (id, subject, body) {
  const ta = $('reply-' + id)
  if (!ta) return
  const original = ta.value
  ta.value = 'AI生成中...'
  try {
    const prompt = `以下のお問い合わせに対する丁寧な返信メール文を日本語で作成してください。
学校名：茨城県立水戸第一高等学校
件名：${subject}
内容：${body}
---
・200字程度・生徒への敬意ある丁寧な文体・回答がない場合は確認中と書く`
    const res = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    })
    const text = await res.text()
    let d
    try { d = JSON.parse(text) } catch { throw new Error(`AIサーバーの応答を解析できません (${res.status})`) }
    if (!res.ok || d.error) {
      const msg = typeof d.error === 'string' ? d.error : (d.error?.message || `HTTP ${res.status}`)
      throw new Error(msg)
    }
    ta.value = d.candidates?.[0]?.content?.parts?.[0]?.text || d.text || d.result || '生成できませんでした'
  } catch (e) {
    ta.value = original
    showToast('AI下書きの生成に失敗しました: ' + e.message)
  }
}

window.saveReply = async function (id) {
  if (!canReplyInquiries(myProfile?.role)) { showToast('返信を保存する権限がありません'); return }
  const ta = $('reply-' + id)
  if (!ta) return
  await updateDoc(doc(db, 'inquiries', id), { reply: ta.value, status: 'replied' })
  showToast('返信内容を保存しました')
  loadInquiries()
}

window.sendReplyEmail = async function (id, evt) {
  if (!canReplyInquiries(myProfile?.role)) { showToast('返信を送信する権限がありません'); return }
  const ta = $('reply-' + id)
  if (!ta || !ta.value.trim()) { showToast('返信内容を入力してください'); return }

  const snap = await getDoc(doc(db, 'inquiries', id))
  if (!snap.exists()) { showToast('お問い合わせが見つかりません'); return }
  const data = snap.data()
  if (!data.email) { showToast('送信先メールアドレスがありません'); return }

  const btn = evt?.currentTarget
  if (btn) { btn.disabled = true; btn.textContent = '送信中...' }

  try {
    const res = await fetch(AI_URL + '/send-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientEmail: data.email,
        recipientName:  data.name || '',
        subject:        data.subject || 'お問い合わせ',
        replyBody:      ta.value.trim(),
        appBaseUrl:     window.location.origin,
      }),
    })
    if (!res.ok) {
      // Workers は { error, detail, hint } を返す。
      // hint は「次に何をすればよいか」を日本語で書いたものなので、あれば最優先で見せる。
      // 生の JSON をそのままトーストに出すと原因が読み取れないため。
      const raw = await res.text().catch(() => '')
      let message = raw
      try {
        const parsed = JSON.parse(raw)
        message = parsed.hint || parsed.detail || parsed.error || raw
      } catch {
        // JSON でなければ本文をそのまま使う
      }
      throw new Error(`送信失敗 (${res.status}): ${message}`)
    }
    await updateDoc(doc(db, 'inquiries', id), { reply: ta.value, status: 'replied' })
    showToast('メールを送信しました')
    loadInquiries()
  } catch (e) {
    showToast('メール送信エラー: ' + e.message)
    if (btn) { btn.disabled = false; btn.textContent = 'メールで送信' }
  }
}

window.changeStatus = async function (id, status) {
  if (!canReplyInquiries(myProfile?.role)) { showToast('ステータスを変更する権限がありません'); return }
  await updateDoc(doc(db, 'inquiries', id), { status })
  showToast('ステータスを変更しました')
  loadInquiries()
}

window.deleteInquiry = async function (id) {
  if (!canReplyInquiries(myProfile?.role)) { showToast('削除する権限がありません'); return }
  if (!confirm('このお問い合わせを削除しますか？\nこの操作は取り消せません。')) return
  await deleteDoc(doc(db, 'inquiries', id))
  showToast('削除しました')
  loadInquiries()
}

// =============================================
// 公欠申請ケース管理
// =============================================
const CASE_STATUS_LABEL = { pending_supervisor: '顧問承認待ち', pending_homeroom: '担任承認待ち', approved: '承認済み', rejected: '差し戻し' }
const CASE_STATUS_CLASS = { pending_supervisor: 'badge-warn', pending_homeroom: 'badge-muted', approved: 'badge-ok', rejected: 'badge-warn' }

function renderCasesForbidden() {
  const el = $('adminCasesList')
  if (el) {
    el.innerHTML = `<div class="notice warn">
      公欠申請ケースの閲覧権限がありません。<br>（管理者（先生）またはオーナーのみ閲覧可能です）
    </div>`
  }
}

window.loadAdminCases = async function () {
  const el = $('adminCasesList')
  if (!el) return
  if (!canViewCasesAdmin(myProfile?.role)) { renderCasesForbidden(); return }
  el.innerHTML = spinner()
  const filter = $('casesFilter')?.value || 'all'

  try {
    const snap = await getDocs(query(collection(db, 'cases'), orderBy('createdAt', 'desc')))
    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    if (filter !== 'all') items = items.filter(c => c.status === filter)

    const pending = snap.docs.filter(d => ['pending_supervisor', 'pending_homeroom'].includes(d.data().status)).length
    const badge = $('casesBadge')
    if (badge) { badge.textContent = pending; badge.style.display = pending ? '' : 'none' }

    if (!items.length) { el.innerHTML = emptyState('該当するケースはありません'); return }

    el.innerHTML = items.map(c => {
      const st = c.status
      const steps = [
        { label: '申請',     done: true },
        { label: '顧問承認', done: ['pending_homeroom', 'approved'].includes(st), active: st === 'pending_supervisor' },
        { label: '担任承認', done: st === 'approved', active: st === 'pending_homeroom' },
        { label: '完了',     done: st === 'approved' },
      ]
      const progress = st === 'rejected'
        ? `<div class="notice warn" style="margin-top:12px">差し戻し${c.rejectedReason ? '：' + escHtml(c.rejectedReason) : ''}</div>`
        : `<div class="case-steps">${steps.map(s => `
            <div class="case-step${s.done ? ' done' : ''}${s.active ? ' active' : ''}">
              <div class="case-step-bar"></div>
              <span class="case-step-lbl">${s.label}</span>
            </div>`).join('')}</div>`

      return `
        <div class="case-card">
          <div class="iq-meta-row">
            <span class="badge ${CASE_STATUS_CLASS[st] || 'badge-muted'}">${CASE_STATUS_LABEL[st] || escHtml(st)}</span>
            <span style="font-size:11px;color:var(--text-3);margin-left:auto">${c.createdAt?.toDate ? c.createdAt.toDate().toLocaleString('ja') : ''}</span>
          </div>
          <div class="iq-subject">${escHtml(c.title || '')}</div>
          <dl class="case-rows">
            <dt>申請者</dt><dd>${escHtml(c.studentName || '')} &lt;${escHtml(c.studentEmail || '')}&gt;</dd>
            <dt>公欠日</dt><dd>${escHtml((c.dates || []).join('、'))}</dd>
            <dt>事由</dt><dd>${escHtml(c.reasonDetail ? `${c.reason}（${c.reasonDetail}）` : (c.reason || ''))}</dd>
            <dt>顧問</dt><dd>${escHtml(c.supervisorEmail || '')}</dd>
            <dt>担任</dt><dd>${escHtml(c.homeRoomEmail || '')}</dd>
          </dl>
          ${progress}
          <div class="case-foot">
            <button class="btn-xs danger" onclick="deleteAdminCase('${c.id}')">削除</button>
          </div>
        </div>`
    }).join('')
  } catch (e) {
    el.innerHTML = errorState(e)
  }
}

window.deleteAdminCase = async function (caseId) {
  if (!canViewCasesAdmin(myProfile?.role)) { showToast('この操作を行う権限がありません'); return }
  if (!confirm('このケースを削除しますか？\nこの操作は取り消せません。')) return
  try {
    await deleteDoc(doc(db, 'cases', caseId))
    showToast('ケースを削除しました')
    loadAdminCases()
  } catch (e) {
    const msg = e?.message || String(e)
    if (msg.includes('Missing or insufficient permissions')) {
      alert('削除に失敗しました: Firestoreのセキュリティルールで操作が拒否されました。\nFirebase Console > Firestore Database > Rules でルールを更新してください。')
    } else {
      alert('削除に失敗しました: ' + msg)
    }
  }
}

// =============================================
// ユーザー管理（Issue #49: 属性が増えたのでテーブル+カード併用）
// Issue #21: LINE連携解除 / Push利用状況の確認を追加
// ロールのラベル・配色は roles.js（R_LABELS/R_COLORS/R_BGS）を共通利用
// =============================================
let allUsers = []
let userFilters = { role: 'all', grade: 'all', class: 'all', status: 'all', search: '' }
let userSort = 'role'
// uid → 登録されているPush購読（端末）数
let pushCountByUid = {}

const ROLE_ORDER = { owner: 0, admin_teacher: 1, admin_student: 2, moderator: 3, teacher: 4, student: 5 }

async function loadUsers() {
  const el = $('usersList')
  if (!el) return
  el.innerHTML = spinner()
  try {
    const [snap, pushSnap] = await Promise.all([
      getDocs(collection(db, 'users')),
      // Push利用状況: 全ユーザーの購読をcollectionGroupで1クエリに集約
      // （firestore.rules に collectionGroup の読み取りルールが必要。未デプロイ時はフォールバック）
      getDocs(query(collectionGroup(db, 'pushSubscriptions'))).catch(() => null),
    ])
    allUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }))

    pushCountByUid = {}
    if (pushSnap) {
      for (const d of pushSnap.docs) {
        const uid = d.ref.parent.parent.id // users/{uid}/pushSubscriptions/{subId}
        if (uid) pushCountByUid[uid] = (pushCountByUid[uid] || 0) + 1
      }
    } else {
      // 集約失敗時（ルール未デプロイ等）はユーザーごとのフィールド値でフォールバック
      for (const u of allUsers) {
        if (u.pushEnabled) pushCountByUid[u.id] = Math.max(pushCountByUid[u.id] || 0, 1)
      }
    }

    updateSidebarCount('users', allUsers.length)
    renderUsers()
  } catch (e) {
    el.innerHTML = errorState(e)
  }
}

window.reloadUsers = loadUsers

function filteredUsers() {
  let list = [...allUsers]

  if (userFilters.role  !== 'all') list = list.filter(u => u.role === userFilters.role)
  if (userFilters.grade !== 'all') list = list.filter(u => String(u.grade) === userFilters.grade)
  if (userFilters.class !== 'all') list = list.filter(u => String(u.class) === userFilters.class)

  switch (userFilters.status) {
    case 'unapproved': list = list.filter(u => u.role === 'student' && !u.approved); break
    case 'approved':   list = list.filter(u => u.role === 'student' && !!u.approved); break
    case 'beta':       list = list.filter(u => u.betaTester === true); break
    case 'line':       list = list.filter(u => !!u.lineUserId); break
    case 'noline':     list = list.filter(u => !u.lineUserId); break
    case 'push':       list = list.filter(u => (pushCountByUid[u.id] || 0) > 0); break
    case 'nopush':     list = list.filter(u => (pushCountByUid[u.id] || 0) === 0); break
  }

  if (userFilters.search) {
    const kw = userFilters.search.toLowerCase()
    list = list.filter(u =>
      (u.name || '').toLowerCase().includes(kw) ||
      (u.email || '').toLowerCase().includes(kw)
    )
  }

  const byClass = (a, b) => (a.grade || 0) - (b.grade || 0) || (a.class || 0) - (b.class || 0) || (a.number || 0) - (b.number || 0)

  list.sort((a, b) => {
    switch (userSort) {
      case 'class':  return byClass(a, b) || String(a.name || '').localeCompare(String(b.name || ''), 'ja')
      case 'name':   return String(a.name || '').localeCompare(String(b.name || ''), 'ja')
      case 'status': {
        const pa = (a.role === 'student' && !a.approved) ? 0 : 1
        const pb = (b.role === 'student' && !b.approved) ? 0 : 1
        return pa - pb || byClass(a, b)
      }
      default:
        return (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || byClass(a, b)
    }
  })

  return list
}

/** 上部の統計チップ（クリックで絞り込み） */
function renderUserStats() {
  const el = $('usersStats')
  if (!el) return
  const total      = allUsers.length
  const students   = allUsers.filter(u => u.role === 'student')
  const unapproved = students.filter(u => !u.approved).length
  const staff      = allUsers.filter(u => ['moderator', 'admin_student', 'admin_teacher', 'owner'].includes(u.role)).length
  const teachers   = allUsers.filter(u => u.role === 'teacher').length
  const lineLinked = allUsers.filter(u => !!u.lineUserId).length
  const betaTesters = allUsers.filter(u => u.betaTester === true).length
  const pushUsers = allUsers.filter(u => (pushCountByUid[u.id] || 0) > 0).length

  el.innerHTML = `
    <button class="stat-chip clickable" type="button" data-filter-preset="all"><b>${total}</b> 全ユーザー</button>
    <button class="stat-chip clickable" type="button" data-filter-preset="student"><b>${students.length}</b> 生徒</button>
    ${unapproved ? `<button class="stat-chip alert clickable" type="button" data-filter-preset="unapproved"><b>${unapproved}</b> 未承認</button>` : ''}
    <button class="stat-chip clickable" type="button" data-filter-preset="teacher"><b>${teachers}</b> 先生</button>
    <button class="stat-chip clickable" type="button" data-filter-preset="staff"><b>${staff}</b> 委員会メンバー</button>
    <button class="stat-chip clickable" type="button" data-filter-preset="line"><b>${lineLinked}</b> LINE連携済み</button>
    <button class="stat-chip clickable" type="button" data-filter-preset="push"><b>${pushUsers}</b> Push利用中</button>
    ${betaTesters ? `<button class="stat-chip clickable" type="button" data-filter-preset="beta"><b>${betaTesters}</b> βテスター</button>` : ''}`
}

/** 統計チップからのワンクリック絞り込み */
function applyUserPreset(preset) {
  userFilters = { role: 'all', grade: 'all', class: 'all', status: 'all', search: userFilters.search }
  userSort = 'role'

  if (preset === 'student')         { userFilters.role = 'student' }
  else if (preset === 'teacher')    { userFilters.role = 'teacher' }
  else if (preset === 'unapproved') { userFilters.status = 'unapproved'; userSort = 'status' }
  else if (preset === 'beta')       { userFilters.status = 'beta' }
  else if (preset === 'line')       { userFilters.status = 'line' }
  else if (preset === 'push')       { userFilters.status = 'push' }
  else if (preset === 'staff')      { userFilters.status = 'all' } // 下で個別処理

  // セレクトボックスの表示を同期
  const set = (id, v) => { const el = $(id); if (el) el.value = v }
  set('userRoleFilter',   userFilters.role)
  set('userGradeFilter',  userFilters.grade)
  set('userClassFilter',  userFilters.class)
  set('userStatusFilter', userFilters.status)
  set('userSortSelect',   userSort)

  // 「委員会メンバー」は単一 role で表せないので専用フラグで処理
  userFilters._staffOnly = preset === 'staff'
  renderUsers()
}

function roleAttrs(u) {
  const attrs = []
  // 生徒はもちろん、モデレーター・管理者（生徒）も生徒が前提のため学年・クラス・番号を持つ
  if (u.role === 'student' || u.role === 'moderator' || u.role === 'admin_student') {
    if (u.grade)  attrs.push(`${u.grade}年`)
    if (u.class)  attrs.push(classLabel(u.class))
    if (u.number) attrs.push(`${u.number}番`)
    if (!u.grade || !u.class) attrs.push('⚠ 未設定')
  }
  return attrs
}

function approvalCell(u, iCanToggleAppr) {
  if (u.role !== 'student') return '<span style="color:var(--text-3)">—</span>'
  const cls = u.approved ? 'badge-ok' : 'badge-warn'
  const label = u.approved ? '✓ 承認済み' : '未承認'
  if (iCanToggleAppr) {
    return `<button class="toggle-pill ${cls}" onclick="toggleApproval('${u.id}', ${!u.approved})"
      title="クリックで${u.approved ? '未承認に戻す' : '承認する'}">${label}</button>`
  }
  return `<span class="badge ${cls}">${label}</span>`
}

function lineCell(u, iCanUnlink) {
  if (!u.lineUserId) return '<span class="badge badge-muted">未連携</span>'
  const badge = `<span class="badge badge-ok" title="${escHtml(u.lineDisplayName ? 'LINE: ' + u.lineDisplayName : 'LINE連携済み')}">✓ 連携済み</span>`
  if (!iCanUnlink) return badge
  // 管理画面からLINE連携を解除可能（Issue #21）
  return `<span style="display:inline-flex;align-items:center;gap:5px">${badge}
    <button class="toggle-pill" style="color:var(--enjii);background:var(--enjii-bg)" onclick="unlinkUserLine('${u.id}')" title="LINE連携を解除する">解除</button></span>`
}

/** Push利用状況（購読中デバイス数） */
function pushCell(u) {
  const n = pushCountByUid[u.id] || 0
  if (n <= 0) return '<span class="badge badge-muted">未利用</span>'
  return `<span class="badge badge-ok" title="${n}台の端末でプッシュ通知を利用中">✓ ${n}台</span>`
}

// βテスター指定 (Issue #53)。操作は委員会管理者以上のみ。
function betaCell(u, iCanManageBeta) {
  const on = u.betaTester === true
  const pill = on
    ? '<span class="badge" style="color:#5b2c6f;background:#e8daef">β</span>'
    : '<span style="color:var(--text-3)">—</span>'
  if (!iCanManageBeta) return pill
  return `<button class="toggle-pill" style="${on ? 'color:#5b2c6f;background:#e8daef' : 'color:var(--text-3);background:var(--surface3)'}" onclick="toggleBetaTester('${u.id}', ${!on})"
    title="クリックで${on ? 'βテスターから外す' : 'βテスターに指定する'}">${on ? 'β' : '—'}</button>`
}

function renderUsers() {
  const el = $('usersList')
  if (!el) return

  renderUserStats()

  let list = filteredUsers()
  if (userFilters._staffOnly) {
    list = list.filter(u => ['moderator', 'admin_student', 'admin_teacher', 'owner'].includes(u.role))
  }

  if (!list.length) {
    el.innerHTML = emptyState('該当するユーザーはいません', '検索キーワードや絞り込み条件を変更してください')
    return
  }

  const myRole = myProfile?.role
  const iCanEditInfo   = canEditUserInfo(myRole)   // 氏名・学年等の編集
  const iCanToggleAppr = canToggleApproval(myRole) // 承認状態の切替
  const iCanManageRole = canManageRoles(myRole)    // ロール変更・削除
  const iCanManageBeta = canManageBetaTester(myRole) // βテスター指定 (Issue #53)
  // LINE連携解除はユーザー情報の編集権限と同等のロール制約をかける（Issue #21）
  const iCanUnlinkLine = iCanEditInfo

  const ops = (u) => {
    const canOpEdit   = iCanEditInfo   && canManageTargetRole(myRole, u.role)
    const canOpDelete = iCanManageRole && canManageTargetRole(myRole, u.role)
    if (!canOpEdit && !canOpDelete) return '<span style="font-size:11px;color:var(--text-3)">—</span>'
    return `
      ${canOpEdit ? `<button class="btn-xs" onclick="editUser('${u.id}')">編集</button>` : ''}
      ${canOpDelete ? `<button class="btn-xs danger" onclick="deleteUser('${u.id}','${escAttr(u.name || u.email || '')}')">削除</button>` : ''}`
  }

  const canUnlink = (u) => iCanUnlinkLine && canManageTargetRole(myRole, u.role)

  const ident = (u) => `
    <div class="user-ident">
      <div class="user-av" style="background:${R_COLORS[u.role] || '#7a8290'}">${escHtml(initials(u.name || u.email))}</div>
      <div class="user-ident-text">
        <div class="user-name">${escHtml(u.name || '（氏名未登録）')}</div>
        <div class="user-mail">${escHtml(u.email || '')}</div>
      </div>
    </div>`

  const rolePill = (u) => `<span class="role-pill" style="color:${R_COLORS[u.role] || '#666'};background:${R_BGS[u.role] || '#eee'}">${escHtml(R_LABELS[u.role] || u.role || '不明')}</span>`

  el.innerHTML = `
    <div class="result-count">全${allUsers.length}件中 ${list.length}件表示</div>

    <!-- PC/タブレット: テーブル -->
    <div class="panel users-table-wrap">
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>ユーザー</th>
              <th>ロール</th>
              <th class="num">学年・組・番号</th>
              <th class="num">承認</th>
              <th class="num">LINE</th>
              <th class="num">Push</th>
              <th class="num">β</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${list.map(u => `
              <tr>
                <td>${ident(u)}</td>
                <td>${rolePill(u)}</td>
                <td class="num">
                  ${roleAttrs(u).length
                    ? `<div class="user-attrs" style="justify-content:center">${roleAttrs(u).map(a => `<span class="attr">${a}</span>`).join('')}</div>`
                    : '<span style="color:var(--text-3)">—</span>'}
                </td>
                <td class="num">${approvalCell(u, iCanToggleAppr)}</td>
                <td class="num">${lineCell(u, canUnlink(u))}</td>
                <td class="num">${pushCell(u)}</td>
                <td class="num">${betaCell(u, iCanManageBeta)}</td>
                <td><div class="row-ops">${ops(u)}</div></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- スマホ: カード -->
    <div class="user-cards">
      ${list.map(u => `
        <div class="user-card">
          <div class="user-card-top">
            ${ident(u)}
            ${rolePill(u)}
          </div>
          <div class="user-card-attrs">
            ${roleAttrs(u).map(a => `<span class="attr">${a}</span>`).join('')}
            ${approvalCell(u, iCanToggleAppr)}
            ${lineCell(u, canUnlink(u))}
            ${pushCell(u)}
            ${betaCell(u, iCanManageBeta)}
          </div>
          ${(iCanEditInfo || iCanManageRole) ? `<div class="user-card-ops">${ops(u)}</div>` : ''}
        </div>`).join('')}
    </div>`
}

// =============================================
// ユーザー操作（承認切替 / 絞り込み / 編集 / 削除）
// =============================================
window.toggleApproval = async function (uid, newApproved) {
  if (!canToggleApproval(myProfile?.role)) { showToast('この操作を行う権限がありません'); return }
  const user = allUsers.find(u => u.id === uid)
  if (!user) return
  try {
    await updateDoc(doc(db, 'users', uid), { approved: newApproved })
    user.approved = newApproved
    showToast(newApproved ? '生徒を承認済みにしました' : '承認を取り消しました')
    renderUsers()
  } catch (e) {
    showToast('エラー: ' + (e?.message || String(e)))
  }
}

// βテスター指定の切替 (Issue #53)。委員会管理者以上のみ。
// 自分より上位ロールのユーザーには操作できない（ロール変更と同等の制約）。
window.toggleBetaTester = async function (uid, newBeta) {
  if (!canManageBetaTester(myProfile?.role)) { showToast('βテスターの変更権限がありません（委員会管理者以上のみ）'); return }
  const user = allUsers.find(u => u.id === uid)
  if (!user) return
  if (!canManageTargetRole(myProfile?.role, user.role)) { showToast('このユーザーを操作する権限がありません'); return }
  try {
    await updateDoc(doc(db, 'users', uid), { betaTester: newBeta })
    user.betaTester = newBeta
    showToast(newBeta ? 'βテスターに指定しました' : 'βテスターから外しました')
    renderUsers()
  } catch (e) {
    showToast('エラー: ' + (e?.message || String(e)))
  }
}

/**
 * LINE連携の解除（管理画面から。Issue #21）
 * ユーザー情報の編集権限と同じロール制約で操作できる。
 * 解除後も今後ユーザー自身がマイページから再連携できる。
 */
window.unlinkUserLine = async function (uid) {
  if (!canEditUserInfo(myProfile?.role)) { showToast('この操作を行う権限がありません'); return }
  const user = allUsers.find(u => u.id === uid)
  if (!user) return
  if (!canManageTargetRole(myProfile?.role, user.role)) { showToast('このユーザーを操作する権限がありません'); return }
  if (!user.lineUserId) return
  const name = user.lineDisplayName || user.name || user.email || uid
  if (!confirm(`「${name}」のLINE連携を解除しますか？\n以降、このユーザーにはLINE通知が届かなくなります。`)) return
  try {
    // users/{uid} の LINE 連携フィールドを削除（firestore.rules: 委員会管理者以上が対象ロール内で更新可）
    await updateDoc(doc(db, 'users', uid), {
      lineUserId:      deleteField(),
      lineDisplayName: deleteField(),
      linePictureUrl:  deleteField(),
      lineNotify:      deleteField(),
      lineLinkedAt:    deleteField(),
    })
    delete user.lineUserId
    delete user.lineDisplayName
    delete user.linePictureUrl
    delete user.lineNotify
    delete user.lineLinkedAt
    showToast('LINE連携を解除しました')
    renderUsers()
  } catch (e) {
    showToast('エラー: ' + (e?.message || String(e)))
  }
}

window.filterUsers = function (type, value) {
  userFilters[type] = value
  userFilters._staffOnly = false
  renderUsers()
}

window.sortUsers = function (value) {
  userSort = value
  renderUsers()
}

let searchTimer = null
window.searchUsers = function (q) {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    userFilters.search = q
    renderUsers()
  }, 140)
}

window.editUser = async function (uid) {
  const user = allUsers.find(u => u.id === uid)
  if (!user) return

  const myRole = myProfile?.role
  if (!canEditUserInfo(myRole) || !canManageTargetRole(myRole, user.role)) {
    showToast('このユーザーを編集する権限がありません')
    return
  }

  const iCanChangeRole    = canManageRoles(myRole)
  const canUnlinkModal    = canEditUserInfo(myRole) && canManageTargetRole(myRole, user.role)
  const roleOptions = assignableRoles(myRole)
  // 現在のロールが選択肢に無い場合（自分より上位のロールを持つ対象など）は表示のみ追加
  if (!roleOptions.includes(user.role)) roleOptions.push(user.role)

  editingType = null
  editingId   = null

  $('modalTitle').textContent = '編集 — ユーザー'
  const moreBtn = $('modalSaveMoreBtn')
  if (moreBtn) moreBtn.style.display = 'none'

  $('modalBody').innerHTML = `
    <div class="form-row">
      <label>氏名</label>
      <input type="text" id="f_user_name" value="${escHtml(user.name || '')}">
    </div>
    <div class="form-row">
      <label>メールアドレス</label>
      <input type="email" id="f_user_email" value="${escHtml(user.email || '')}" disabled style="opacity:.6;cursor:not-allowed">
      <div class="form-hint">メールアドレスは Firebase Authentication で管理されるため、ここでは変更できません。</div>
    </div>
    <div class="form-row">
      <label>ロール</label>
      <select id="f_user_role"${iCanChangeRole ? '' : ' disabled style="opacity:.6;cursor:not-allowed"'}>
        ${roleOptions.map(r => `<option value="${r}"${user.role === r ? ' selected' : ''}>${escHtml(R_LABELS[r] || r)}</option>`).join('')}
      </select>
      <div class="form-hint">${iCanChangeRole ? '自分と同等以下のロールにのみ変更できます。' : 'ロールの変更権限がありません。'}</div>
    </div>
    <div id="f_user_student_fields" style="${['student', 'moderator', 'admin_student'].includes(user.role) ? '' : 'display:none'}">
      <div class="form-hint" id="f_user_class_req_hint" style="margin-bottom:8px;${['moderator', 'admin_student'].includes(user.role) ? '' : 'display:none'}">モデレーター・管理者（生徒）は生徒が前提のため、学年・クラス・出席番号は必須です。</div>
      <div class="form-row-3 form-row">
        <div>
          <label>学年 <span class="form-tag req" id="f_user_grade_req" style="${['moderator', 'admin_student'].includes(user.role) ? '' : 'display:none'}">必須</span></label>
          <select id="f_user_grade">
            <option value="">—</option>
            ${[1, 2, 3].map(i => `<option value="${i}"${String(user.grade) === String(i) ? ' selected' : ''}>${i}年</option>`).join('')}
          </select>
        </div>
        <div>
          <label>クラス <span class="form-tag req" id="f_user_class_req" style="${['moderator', 'admin_student'].includes(user.role) ? '' : 'display:none'}">必須</span></label>
          <select id="f_user_class">
            <option value="">—</option>
            ${classOptionTags(user.class, { includeEmpty: true })}
          </select>
        </div>
        <div>
          <label>出席番号 <span class="form-tag req" id="f_user_number_req" style="${['moderator', 'admin_student'].includes(user.role) ? '' : 'display:none'}">必須</span></label>
          <input type="number" id="f_user_number" value="${escHtml(user.number || '')}" min="1" max="50">
        </div>
      </div>
    </div>
    <div class="collapse" style="margin-top:4px">
      <details>
        <summary style="padding:9px 13px;font-size:12px;font-weight:600;color:var(--text-2);cursor:pointer;list-style:none">連携・システム情報</summary>
        <div class="collapse-body">
          <dl class="case-rows" style="margin-top:0">
            <dt>UID</dt><dd style="font-family:monospace;font-size:11px">${escHtml(user.id)}</dd>
            <dt>LINE</dt><dd style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              ${user.lineUserId
                ? `連携済み${user.lineDisplayName ? '（' + escHtml(user.lineDisplayName) + '）' : ''}`
                : '未連携'}
              ${user.lineUserId && canUnlinkModal
                ? `<button type="button" class="btn-xs danger" onclick="unlinkUserLine('${user.id}')" style="margin-left:auto">LINE連携を解除</button>`
                : ''}
            </dd>
            <dt>プッシュ通知</dt><dd>${(pushCountByUid[user.id] || 0) > 0
              ? `${pushCountByUid[user.id]}台の端末で利用中`
              : '未利用'}</dd>
            <dt>承認状態</dt><dd>${user.role === 'student' ? (user.approved ? '承認済み' : '未承認') : '—（生徒以外）'}</dd>
          </dl>
        </div>
      </details>
    </div>`

  // 生徒系（生徒／モデレーター／管理者（生徒））以外を選んだら学年・クラス・番号の欄を隠す
  // モデレーター・管理者（生徒）を選んだら必須表示に切り替える
  const roleSel = $('f_user_role')
  const syncStudentFields = () => {
    const v = roleSel?.value || user.role
    const isStudentLike = ['student', 'moderator', 'admin_student'].includes(v)
    const needsRequired = ['moderator', 'admin_student'].includes(v)
    const box = $('f_user_student_fields')
    if (box) box.style.display = isStudentLike ? '' : 'none'
    const hint = $('f_user_class_req_hint')
    if (hint) hint.style.display = needsRequired ? '' : 'none'
    ;['f_user_grade_req', 'f_user_class_req', 'f_user_number_req'].forEach(id => {
      const el = document.getElementById(id)
      if (el) el.style.display = needsRequired ? '' : 'none'
    })
  }
  roleSel?.addEventListener('change', syncStudentFields)

  // ユーザー編集専用の保存処理を一時的にバインド
  const saveBtn = $('modalSaveBtn')
  saveBtn.onclick = async function () {
    saveBtn.disabled = true
    try {
      const data = { name: trimVal('f_user_name') }
      if (iCanChangeRole) {
        const newRole = val('f_user_role')
        if (!canAssignRole(myRole, newRole)) throw new Error('そのロールへの変更権限がありません')
        data.role = newRole
      }
      const targetRole = data.role || user.role
      if (['student', 'moderator', 'admin_student'].includes(targetRole)) {
        const g = val('f_user_grade'), c = val('f_user_class'), n = val('f_user_number')
        // モデレーター・管理者（生徒）は生徒前提のため学年・クラス・番号は必須
        if (['moderator', 'admin_student'].includes(targetRole)) {
          if (!g) throw new Error('学年を入力してください（モデレーター・管理者（生徒）は必須）')
          if (!c) throw new Error('クラスを入力してください（モデレーター・管理者（生徒）は必須）')
          if (!n) throw new Error('出席番号を入力してください（モデレーター・管理者（生徒）は必須）')
          data.grade  = Number(g)
          data.class  = normalizeClass(c)
          data.number = Number(n)
        } else {
          if (g) data.grade  = Number(g)
          if (c) data.class  = normalizeClass(c)
          if (n) data.number = Number(n)
        }
      }
      await updateDoc(doc(db, 'users', uid), data)
      showToast('ユーザーを更新しました')
      closeModal()
      loadUsers()
    } catch (e) {
      showToast('エラー: ' + e.message)
    }
    saveBtn.disabled = false
  }

  $('modalOverlay').classList.add('open')
  setTimeout(() => $('f_user_name')?.focus(), 60)
}

window.deleteUser = async function (uid, name) {
  const target = allUsers.find(u => u.id === uid)
  const myRole = myProfile?.role
  if (!canManageRoles(myRole) || (target && !canManageTargetRole(myRole, target.role))) {
    showToast('このユーザーを削除する権限がありません')
    return
  }
  if (!confirm(`ユーザー「${name}」の登録情報を削除しますか？\n※Firebase Authentication のアカウント自体は Firebase Console から削除する必要があります。`)) return
  try {
    await deleteDoc(doc(db, 'users', uid))
    showToast('ユーザー情報を削除しました')
    loadUsers()
  } catch (e) {
    alert('削除に失敗しました: ' + (e?.message || String(e)))
  }
}

// =============================================
// カスタムメール送信（手帳デザイン・Resend経由・差込対応）
// =============================================
// 宛先リストは「1行目=見出し（変数名）、2行目以降=宛先」のCSV風。
// 例:
//   メール,お名前
//   taro@example.com,山田 太郎
// 件名・本文・ボタン内の {{変数名}} が1通ごとに置換される。
// 送信自体は Workers POST /send-custom を宛先ごとに1通ずつ呼ぶ
// （Workers の30秒制限回避＋BCC漏洩防止のため）。

function mailSplitRow(line) {
  return String(line).split(/[\t,，、]/).map(c => {
    let s = String(c ?? '').trim()
    if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
      s = s.slice(1, -1).trim()
    }
    return s
  })
}

function mailEmailKey(headers) {
  const i = headers.findIndex(h => /メール|mail|e-mail/i.test(h))
  return i >= 0 ? i : -1
}

function parseMailRecipients() {
  const raw = String($('mailRecipients')?.value || '').split('\n').map(s => s.trim()).filter(Boolean)
  if (!raw.length) return { headers: [], rows: [], errors: ['宛先リストが空です'] }
  const first = mailSplitRow(raw[0])
  const looksHeader = first.some(c => /メール|mail|e-mail|お名前|名前|name|学年|組|grade|class/i.test(c))
  const headers = looksHeader ? first : ['メール', 'お名前']
  const dataLines = looksHeader ? raw.slice(1) : raw
  const ei = mailEmailKey(headers)
  if (ei < 0) return { headers, rows: [], errors: ['見出し行に「メール」列がありません（例：メール,お名前）'] }
  const rows = []
  const errors = []
  dataLines.forEach((line, idx) => {
    const cells = mailSplitRow(line)
    const vars = {}
    headers.forEach((h, i) => { vars[h] = cells[i] ?? '' })
    const email = String(vars[headers[ei]] || '').trim()
    const lineNo = (looksHeader ? idx + 2 : idx + 1)
    if (!email || !email.includes('@')) {
      errors.push(`${lineNo}行目：メールアドレスが不正です（${line || '（空）'}）`)
      return
    }
    rows.push({ email, vars, lineNo })
  })
  return { headers, rows, errors }
}

function mailApplyMerge(template, vars) {
  const map = (vars && typeof vars === 'object') ? vars : {}
  return String(template ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, key) => {
    const k = String(key).trim()
    if (Object.prototype.hasOwnProperty.call(map, k)) return String(map[k] ?? '')
    return m
  })
}

function mailCommonVars() {
  return { 'Slack招待URL': String($('mailSlackUrl')?.value || '').trim() }
}

function mailTemplateRaw() {
  return {
    subject:   $('mailSubject')?.value || '',
    badge:     $('mailBadge')?.value || '',
    title:     $('mailTitle')?.value || '',
    greeting:  $('mailGreeting')?.value || '',
    body:      $('mailBody')?.value || '',
    btnLabel:  $('mailBtnLabel')?.value || '',
    btnUrl:    $('mailBtnUrl')?.value || '',
    footer:    $('mailFooter')?.value || '',
  }
}

function mailEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function mailVarsFor(row) {
  return { ...mailCommonVars(), ...(row?.vars || {}) }
}

function mailPreviewHtml(t, vars) {
  const subject = mailApplyMerge(t.subject, vars)
  const badge   = mailApplyMerge(t.badge, vars)
  const title   = mailApplyMerge(t.title, vars)
  const name    = mailApplyMerge(t.greeting, vars).trim()
  const body    = mailApplyMerge(t.body, vars)
  const btnLbl  = mailApplyMerge(t.btnLabel, vars)
  const btnUrl  = mailApplyMerge(t.btnUrl, vars).trim()
  const bodyHtml = mailEsc(body).replace(/\n/g, '<br>')
    .replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" style="color:#1a2744">$1</a>')
  return `
    <div style="font-size:11px;color:#818894;margin-bottom:8px">件名: ${mailEsc(subject) || '（未入力）'}</div>
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e3e6ea">
      <div style="background:#1a2744;padding:16px 20px">
        <div style="color:#fff;font-size:16px;font-weight:700">水戸第一高等学校</div>
        <div style="color:#a0b0cc;font-size:11px;margin-top:2px">デジタル生徒手帳</div>
      </div>
      <div style="padding:20px">
        ${badge ? `<div style="margin-bottom:10px"><span style="display:inline-block;font-size:12px;font-weight:600;color:#1a2744;background:rgba(26,39,68,.07);border:1px solid #e0e0e0;border-radius:999px;padding:3px 10px">${mailEsc(badge)}</span></div>` : ''}
        ${title ? `<div style="font-size:17px;font-weight:700;color:#1a2744;margin:0 0 12px">${mailEsc(title)}</div>` : ''}
        ${name ? `<p style="color:#333;font-size:14px;margin:0 0 12px">${mailEsc(name)} 様<br><br>お世話になっております。</p>` : ''}
        <div style="background:#f8f9fa;border-radius:8px;padding:14px 16px;font-size:13.5px;color:#333;line-height:1.9;border-left:4px solid #1a2744">${bodyHtml || '<span style="color:#818894">（本文未入力）</span>'}</div>
        ${(btnLbl && btnUrl) ? `<div style="text-align:center;margin:16px 0 4px"><span style="display:inline-block;background:#1a2744;color:#fff;padding:12px 26px;border-radius:8px;font-size:13.5px;font-weight:700">${mailEsc(btnLbl)}</span><div style="font-size:11px;color:#818894;margin-top:6px;word-break:break-all">${mailEsc(btnUrl)}</div></div>` : ''}
      </div>
    </div>`
}

function refreshMailCount() {
  const { rows } = parseMailRecipients()
  const el = $('mailCount')
  if (el) el.textContent = `${rows.length} 件`
}

window.previewCustomMail = function () {
  const t = mailTemplateRaw()
  const { rows } = parseMailRecipients()
  const vars = mailVarsFor(rows[0])
  const box = $('mailPreview')
  if (box) box.innerHTML = mailPreviewHtml(t, vars)
  refreshMailCount()
  if (!rows.length) showToast('宛先リストに有効な行がありません')
}

async function mailPostCustom({ to, vars }) {
  const t = mailTemplateRaw()
  const res = await fetch(AI_URL + '/send-custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to,
      subject:      t.subject,
      title:        t.title,
      badge:        t.badge,
      greetingName: t.greeting,
      bodyText:     t.body,
      buttonLabel:  t.btnLabel,
      buttonUrl:    t.btnUrl,
      footerNote:   t.footer,
      vars,
      appBaseUrl:   window.location.origin,
    }),
  })
  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    let message = raw
    try {
      const parsed = JSON.parse(raw)
      message = parsed.hint || parsed.detail || parsed.error || raw
    } catch { /* 非JSONは本文のまま */ }
    throw new Error(`送信失敗 (${res.status}): ${message}`)
  }
  return res.json().catch(() => ({}))
}

function loadCustomMailSection() {
  const can = canReplyInquiries(myProfile?.role)
  const forbidden = $('mailForbidden')
  const form = $('mailForm')
  if (!can) {
    if (forbidden) {
      forbidden.style.display = ''
      forbidden.innerHTML = `<div class="notice warn">メール送信は委員会管理者以上のみ行えます（現在：${mailEsc(myProfile?.role || '不明')}）。プレビューと宛先リストの編集はできますが、送信ボタンは無効です。</div>`
    }
  } else if (forbidden) {
    forbidden.style.display = 'none'
    forbidden.innerHTML = ''
  }
  if (form) form.style.opacity = can ? '' : '.55'
  document.querySelectorAll('#sec-mail button.btn-add, #sec-mail button.btn-xs.send, #sec-mail button.btn-xs:not([onclick^="preview"])').forEach(b => {
    if (/一斉送信|テスト送信/.test(b.textContent)) b.disabled = !can
  })
  const ta = $('mailRecipients')
  if (ta && !ta.dataset.bound) {
    ta.dataset.bound = '1'
    ta.addEventListener('input', refreshMailCount)
  }
  const presetSel = $('mailPreset')
  if (presetSel && !presetSel.dataset.current) presetSel.dataset.current = presetSel.value || 'info-join'
  previewCustomMail()
}

window.sendTestCustomMail = async function (evt) {
  if (!canReplyInquiries(myProfile?.role)) { showToast('送信する権限がありません（委員会管理者以上のみ）'); return }
  const t = mailTemplateRaw()
  if (!t.subject.trim()) { showToast('件名を入力してください'); return }
  if (!t.body.trim()) { showToast('本文を入力してください'); return }
  const { rows, errors } = parseMailRecipients()
  const to = String($('mailTestTo')?.value || '').trim() || rows[0]?.email || ''
  if (!to || !to.includes('@')) { showToast('テスト送信先のアドレスを入力してください'); return }
  const vars = mailVarsFor(rows[0])
  const btn = evt?.currentTarget
  if (btn) { btn.disabled = true; btn.textContent = '送信中...' }
  try {
    await mailPostCustom({ to, vars })
    showToast('テスト送信しました: ' + to)
  } catch (e) {
    showToast('メール送信エラー: ' + e.message)
  }
  if (btn) { btn.disabled = false; btn.textContent = 'テスト送信' }
}

window.sendBulkCustomMail = async function (evt) {
  if (!canReplyInquiries(myProfile?.role)) { showToast('送信する権限がありません（委員会管理者以上のみ）'); return }
  const t = mailTemplateRaw()
  if (!t.subject.trim()) { showToast('件名を入力してください'); return }
  if (!t.body.trim()) { showToast('本文を入力してください'); return }
  const { rows, errors } = parseMailRecipients()
  if (!rows.length) { showToast('有効な宛先がありません' + (errors[0] ? '：' + errors[0] : '')); return }
  if (!confirm(`${rows.length}件に送信しますか？\n件名：${t.subject}\n1件目：${rows[0].email}`)) return
  const btn = evt?.currentTarget
  if (btn) btn.disabled = true
  const bar = $('mailProgressBar')
  const prog = $('mailProgress')
  const out = $('mailResult')
  if (prog) prog.style.display = ''
  if (out) out.textContent = ''
  const failures = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    try {
      await mailPostCustom({ to: r.email, vars: mailVarsFor(r) })
    } catch (e) {
      failures.push(`${r.lineNo}行目 ${r.email}: ${e.message}`)
    }
    if (bar) bar.style.width = `${Math.round(((i + 1) / rows.length) * 100)}%`
    if (out) out.textContent = `送信中... ${i + 1}/${rows.length}`
    if (i < rows.length - 1) await new Promise(res => setTimeout(res, 350))
  }
  if (btn) btn.disabled = false
  const ok = rows.length - failures.length
  if (out) {
    out.textContent = `完了：${ok}/${rows.length}件 成功`
      + (errors.length ? `\nリスト注意：\n- ${errors.join('\n- ')}` : '')
      + (failures.length ? `\n失敗：\n- ${failures.join('\n- ')}` : '')
  }
  showToast(failures.length ? `一斉送信：${ok}/${rows.length}件成功` : `一斉送信が完了しました（${ok}件）`)
}

// =============================================
// カスタムメールのテンプレートプリセット
// =============================================
const MAIL_PRESETS = {
  'info-join': {
    subject: '【情報委員会】加入のお知らせとSlackへのご案内',
    badge: '情報委員会',
    title: '情報委員会への加入を歓迎します',
    greeting: '{{お名前}}',
    body: [
      'このたびは情報委員会への加入を希望いただき、ありがとうございます。',
      '加入手続きが完了しましたので、お知らせします。',
      '',
      '委員会の連絡は Slack で行っています。お手数ですが、下のボタンからワークスペースに参加してください。',
      '参加後、表示名を「学年・組・氏名」にして #general で自己紹介をお願いします。',
      '',
      '招待URL: {{Slack招待URL}}',
      'うまく参加できない場合は、このメールに返信してください。',
      '{{お名前}}様と一緒に活動できるのを楽しみにしています。',
    ].join('\n'),
    btnLabel: 'Slackワークスペースに参加する',
    btnUrl: '{{Slack招待URL}}',
  },
  'beta': {
    subject: '【デジタル生徒手帳】βテスター認定のお知らせ',
    badge: 'βテスター認定',
    title: 'βテスターに認定しました',
    greeting: '{{お名前}}',
    body: [
      'このたびはデジタル生徒手帳のβテストにご協力いただき、ありがとうございます。',
      '{{お名前}}様をβテスターに認定しましたので、お知らせします。',
      '',
      'βテスターには、新機能を正式公開前に先行してお試しいただけます。',
      'つきましては、次の2点をお願いします。',
      '',
      '1．デジタル生徒手帳のアカウント作成（まだの方）',
      'https://mito1-tetyo.tech を開き、新規登録からアカウントを作成してください。',
      '※学校のメールアドレス（@mito1-h.ibk.ed.jp）の使用を推奨します。',
      '※登録直後は「未承認」のため一部機能が制限されます。承認は委員会が行います。',
      '',
      '2．Slackへの参加',
      '委員会からの連絡は Slack で行っています。下のボタンからワークスペースに参加し、表示名を「学年・組・氏名」にしてください。',
      '招待URL: {{Slack招待URL}}',
      '',
      '参加後は、使ってみた感想や不具合の報告をお待ちしています。',
      'うまく登録・参加できない場合は、このメールに返信してください。',
    ].join('\n'),
    btnLabel: 'Slackワークスペースに参加する',
    btnUrl: '{{Slack招待URL}}',
  },
}

window.applyMailPreset = function (key) {
  const p = MAIL_PRESETS[key]
  if (!p) return
  if (!confirm('テンプレートを適用しますか？\n件名・見出し・本文・ボタンが上書きされます（宛先リストは保持されます）。')) {
    const sel = $('mailPreset')
    if (sel) sel.value = sel.dataset.current || 'info-join'
    return
  }
  $('mailSubject').value  = p.subject
  $('mailBadge').value    = p.badge
  $('mailTitle').value    = p.title
  $('mailGreeting').value = p.greeting
  $('mailBody').value     = p.body
  $('mailBtnLabel').value = p.btnLabel
  $('mailBtnUrl').value   = p.btnUrl
  const sel = $('mailPreset')
  if (sel) sel.dataset.current = key
  previewCustomMail()
  showToast('テンプレートを適用しました')
}
