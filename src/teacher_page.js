import { auth } from './firebase.js'
import { onAuth, getCurrentProfile, logout, ensureUserDoc } from './auth.js'
import { getTeacherCases, approveByTeacher, rejectByTeacher } from './cases.js'

const STATUS_LABEL = {
  pending_supervisor: '顧問承認待ち',
  pending_homeroom:   '担任承認待ち',
  approved:           '承認済み',
  rejected:           '差し戻し',
}

let currentFilter = 'all'
let allCases = []
let myProfile = null

onAuth(async user => {
  if (!user) { location.href = '/auth.html'; return }
  try {
    myProfile = await getCurrentProfile(user)
    if (!myProfile) {
      // 過去の登録失敗による孤児の可能性があるため修復を試みる（先生ヒント付き）。
      try {
        const { profile } = await ensureUserDoc(user, { role: 'teacher' })
        myProfile = profile
      } catch (e) { console.warn('[teacher] ensureUserDoc failed', e) }
    }
    if (!myProfile) {
      // users ドキュメントが無い場合、auth 情報から最低限のプロフィールを構築
      myProfile = { uid: user.uid, email: user.email, name: user.email, role: 'teacher' }
    }
    document.getElementById('headerName').textContent = `${myProfile.name} 先生`
    await loadCases()
  } catch (e) {
    console.error('Teacher page init error:', e)
    document.getElementById('caseList').innerHTML =
      `<div class="empty">読み込みに失敗しました: ${e.message}<br><br><button onclick="location.reload()" style="padding:8px 16px;cursor:pointer">再読み込み</button></div>`
  }
})

async function loadCases() {
  document.getElementById('caseList').innerHTML =
    '<div class="loading-wrap"><span class="spinner"></span>読み込み中...</div>'
  try {
    // auth.currentUser.email と profile.email の両方で検索
    const authEmail = auth.currentUser?.email
    const profileEmail = myProfile.email
    // メインのメールアドレスで取得
    allCases = await getTeacherCases(profileEmail)
    // auth メールが異なる場合は追加検索してマージ
    if (authEmail && authEmail !== profileEmail) {
      const extra = await getTeacherCases(authEmail)
      const ids = new Set(allCases.map(c => c.id))
      extra.forEach(c => { if (!ids.has(c.id)) allCases.push(c) })
      allCases.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
    }
    renderCases()
  } catch (e) {
    console.error('loadCases error:', e)
    document.getElementById('caseList').innerHTML =
      `<div class="empty">申請の読み込みに失敗しました: ${e.message}<br><br><button onclick="location.reload()" style="padding:8px 16px;cursor:pointer">再読み込み</button></div>`
  }
}

function renderCases() {
  const filtered = currentFilter === 'all'
    ? allCases
    : allCases.filter(c => c.status === currentFilter)

  const el = document.getElementById('caseList')
  if (!filtered.length) {
    el.innerHTML = '<div class="empty">該当する申請はありません</div>'
    return
  }

  el.innerHTML = filtered.map(c => {
    const datesStr = (c.dates || []).join('、')
    const authEmail = auth.currentUser?.email
    const isSupervisor = c.supervisorEmail === myProfile.email || c.supervisorEmail === authEmail
    const isHomeRoom = c.homeRoomEmail === myProfile.email || c.homeRoomEmail === authEmail
    const myRole  = isSupervisor ? '顧問' : '担任'
    const canApprove =
      (isSupervisor && c.status === 'pending_supervisor') ||
      (!isSupervisor && c.status === 'pending_homeroom')

    const progress = renderProgress(c)
    const actions  = canApprove ? `
      <button class="btn-approve" onclick="handleApprove('${c.id}','${isSupervisor?'supervisor':'homeroom'}')">
        ✓ 承認する
      </button>
      <button class="btn-reject" onclick="handleReject('${c.id}','${isSupervisor?'supervisor':'homeroom'}')">
        差し戻す
      </button>` : ''

    return `
      <div class="case-card">
        <div class="case-head">
          <div style="flex:1">
            <div class="case-badges">
              <span class="badge badge-${c.status}">${STATUS_LABEL[c.status]||c.status}</span>
              <span class="badge badge-role">${myRole}として</span>
            </div>
            <div class="case-title">${esc(c.title)}</div>
            <div class="case-meta">
              <span>申請者: ${esc(c.studentName)}</span>
              <span>${esc(c.reasonDetail ? c.reason + '（' + c.reasonDetail + '）' : (c.reason||''))}</span>
              <span>${c.createdAt?.toDate ? c.createdAt.toDate().toLocaleDateString('ja') : ''}</span>
            </div>
            <div class="case-dates">📅 ${esc(datesStr)}</div>
            ${progress}
          </div>
        </div>
        ${actions ? `<div class="case-actions">${actions}</div>` : ''}
      </div>`
  }).join('')
}

function renderProgress(c) {
  const steps = [
    { label: '申請', done: true },
    { label: '顧問承認', done: ['pending_homeroom','approved'].includes(c.status), active: c.status==='pending_supervisor' },
    { label: '担任承認', done: c.status==='approved', active: c.status==='pending_homeroom' },
    { label: '完了', done: c.status==='approved' },
  ]
  return `<div style="margin-top:12px">
    <div class="progress">
      ${steps.map(s=>`
        <div class="prog-step ${s.done?'done':s.active?'active':''}">
          <div class="prog-line ${s.done?'done':s.active?'active':''}"></div>
          ${s.label}
        </div>`).join('')}
    </div>
  </div>`
}

window.setFilter = function(filter, btn) {
  currentFilter = filter
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('on'))
  btn.classList.add('on')
  renderCases()
}

window.handleApprove = async function(caseId, step) {
  if (!confirm('この申請を承認しますか？')) return
  try {
    await approveByTeacher(caseId, step, myProfile.uid)
    await loadCases()
  } catch(e) {
    alert('エラー: ' + e.message)
  }
}

window.handleReject = async function(caseId, step) {
  const reason = prompt('差し戻し理由を入力してください（任意）')
  if (reason === null) return // キャンセル
  try {
    await rejectByTeacher(caseId, step, reason, myProfile.uid)
    await loadCases()
  } catch(e) {
    alert('エラー: ' + e.message)
  }
}

window.doLogout = async function() {
  await logout()
  location.href = '/auth.html'
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
