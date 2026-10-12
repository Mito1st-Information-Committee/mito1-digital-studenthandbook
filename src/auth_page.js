import { onAuth, login, registerStudent, registerTeacher, resetPassword, getCurrentProfile, ensureUserDoc } from './auth.js'

const BASE = ''

// ── UIを描画 ──────────────────────────────────────────────────────
document.getElementById('mainCard').innerHTML = `
  <div class="tabs">
    <div class="tab on" id="tabLogin" onclick="switchTab('login')">ログイン</div>
    <div class="tab" id="tabRegister" onclick="switchTab('register')">新規登録</div>
  </div>
  <div class="err" id="authErr"></div>

  <div class="section on" id="sec-login">
    <div class="form-group">
      <label class="form-label">メールアドレス <span class="req">必須</span></label>
      <input class="form-input" id="loginEmail" type="email" placeholder="example@mito1-h.ibk.ed.jp" autocomplete="email">
    </div>
    <div class="form-group">
      <label class="form-label">パスワード <span class="req">必須</span></label>
      <input class="form-input" id="loginPass" type="password" placeholder="パスワード" autocomplete="current-password">
    </div>
    <button class="btn-primary" id="loginBtn">ログイン</button>
    <div class="hint"><a id="resetLink">パスワードを忘れた方</a></div>
  </div>

  <div class="section" id="sec-register">
    <div class="role-tabs">
      <div class="role-tab on" id="roleStudent" onclick="switchRole('student')">生徒</div>
      <div class="role-tab" id="roleTeacher" onclick="switchRole('teacher')">先生</div>
    </div>

    <div id="formStudent">
      <div class="form-group">
        <label class="form-label">氏名 <span class="req">必須</span></label>
        <input class="form-input" id="regName" type="text" placeholder="山田 太郎">
      </div>
      <div class="row3">
        <div class="form-group">
          <label class="form-label">学年 <span class="req">必須</span></label>
          <select class="form-input" id="regGrade">
            <option value="1">1年</option><option value="2">2年</option><option value="3">3年</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">クラス <span class="req">必須</span></label>
          <select class="form-input" id="regClass">
            <option value="1">1組</option><option value="2">2組</option><option value="3">3組</option>
            <option value="4">4組</option><option value="5">5組</option><option value="6">6組</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">出席番号</label>
          <input class="form-input" id="regNumber" type="number" min="1" max="50" placeholder="1">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">メールアドレス <span class="req">必須</span></label>
        <input class="form-input" id="regEmail" type="email" placeholder="example@mito1-h.ibk.ed.jp">
        <div style="font-size:11px;color:var(--text-3);margin-top:4px">※学校のメールアドレス（@mito1-h.ibk.ed.jp）の使用を推奨します。</div>
      </div>
      <div class="row2">
        <div class="form-group">
          <label class="form-label">パスワード <span class="req">必須</span></label>
          <input class="form-input" id="regPass" type="password" placeholder="6文字以上">
        </div>
        <div class="form-group">
          <label class="form-label">確認</label>
          <input class="form-input" id="regPass2" type="password" placeholder="再入力">
        </div>
      </div>
      <button class="btn-primary" id="regStudentBtn">登録して始める</button>
    </div>

    <div id="formTeacher" style="display:none">
      <div class="form-group">
        <label class="form-label">氏名（フルネーム） <span class="req">必須</span></label>
        <input class="form-input" id="regTeacherName" type="text" placeholder="鈴木 太郎">
        <div style="font-size:11px;color:var(--text-3);margin-top:4px">※「先生」は付けずにフルネームで入力してください。ダッシュボードでは自動で「先生」が付加されます。</div>
      </div>
      <div class="form-group">
        <label class="form-label">メールアドレス <span class="req">必須</span></label>
        <input class="form-input" id="regTeacherEmail" type="email" placeholder="teacher@mito1-h.ibk.ed.jp">
        <div style="font-size:11px;color:var(--text-3);margin-top:4px">※学校のメールアドレス（@mito1-h.ibk.ed.jp）の使用を推奨します。</div>
      </div>
      <div class="row2">
        <div class="form-group">
          <label class="form-label">パスワード <span class="req">必須</span></label>
          <input class="form-input" id="regTeacherPass" type="password" placeholder="6文字以上">
        </div>
        <div class="form-group">
          <label class="form-label">確認</label>
          <input class="form-input" id="regTeacherPass2" type="password" placeholder="再入力">
        </div>
      </div>
      <button class="btn-primary" id="regTeacherBtn">登録して始める</button>
    </div>
  </div>
`

// イベント登録
document.getElementById('loginBtn').addEventListener('click', doLogin)
document.getElementById('regStudentBtn').addEventListener('click', doRegisterStudent)
document.getElementById('regTeacherBtn').addEventListener('click', doRegisterTeacher)
document.getElementById('resetLink').addEventListener('click', showReset)
// Enterキーでもログインできるように（メール→パスワードへ移動、パスワード→ログイン実行）
document.getElementById('loginEmail')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('loginPass')?.focus() }
})
document.getElementById('loginPass')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); doLogin() }
})

// ── ログイン済みチェック → リダイレクト（ログイン時のみ使用）
// 新規登録後は自分でリダイレクト制御するためここでは登録フローを除外
let skipAuthRedirect = false

onAuth(async user => {
  if (!user || skipAuthRedirect) return
  await redirectByRole(user)
})

async function redirectByRole(user) {
  const profile = await getCurrentProfile(user)
  if (profile) {
    // モデレーター・管理者（生徒）は前提として生徒のため、一般生徒と同じくマイページへ。
    // 自動で管理画面へ遷移させるのは管理者（先生）・オーナーのみ。
    if (['admin_teacher', 'owner'].includes(profile.role)) {
      location.href = BASE + '/admin/'; return
    }
    if (profile.role === 'teacher') { location.href = BASE + '/teacher.html'; return }
  }
  // sessionStorageでマイページへ遷移するよう伝達
  // （student / moderator / admin_student はここに来る）
  sessionStorage.setItem('mito1_nav', 'mypage')
  location.href = BASE + '/'
}

// ── ユーティリティ ─────────────────────────────────────────────────
function fbErr(code) {
  return ({
    'auth/user-not-found':       'このメールアドレスは登録されていません',
    'auth/wrong-password':       'パスワードが正しくありません',
    'auth/invalid-credential':   'メールアドレスまたはパスワードが正しくありません',
    'auth/email-already-in-use': 'このメールアドレスはすでに使用されています',
    'auth/weak-password':        'パスワードは6文字以上にしてください',
    'auth/invalid-email':        'メールアドレスの形式が正しくありません',
    'auth/too-many-requests':    'しばらく時間をおいてから再試行してください',
    'auth/network-request-failed': '通信に失敗しました。接続を確認して再試行してください',
    'permission-denied':         'ユーザー情報の保存に失敗しました（権限エラー）。時間をおいて再試行してください',
    'unavailable':               'サーバーに接続できませんでした。再試行してください',
    'firestore/write-not-verified': '登録情報の確認に失敗しました。再試行してください',
  })[code] || 'エラー（' + code + '）'
}
function showErr(msg) {
  const el = document.getElementById('authErr')
  if (el && typeof msg === 'string') { el.textContent = msg; el.classList.add('show') }
}
function clearErr() { document.getElementById('authErr')?.classList.remove('show') }
function setBtn(id, loading, text) {
  const btn = document.getElementById(id)
  if (btn) { btn.disabled = loading; btn.textContent = loading ? '処理中...' : text }
}

// ── ログイン ──────────────────────────────────────────────────────
async function doLogin() {
  clearErr()
  const email = document.getElementById('loginEmail').value.trim()
  const pass  = document.getElementById('loginPass').value
  if (!email || !pass) { showErr('メールアドレスとパスワードを入力してください'); return }
  setBtn('loginBtn', true, 'ログイン')
  try {
    const user = await login(email, pass)
    // 過去の登録失敗で Firestore ドキュメントが無い孤児はここで修復する。
    // 修復できなくてもログイン自体は継続（マイページ側で再試行される）。
    try { await ensureUserDoc(user) } catch (e) { console.warn('[auth] ensureUserDoc failed', e) }
    // onAuth がリダイレクト
  } catch(e) {
    showErr(fbErr(e.code))
    setBtn('loginBtn', false, 'ログイン')
  }
}

// ── 生徒新規登録 ──────────────────────────────────────────────────
async function doRegisterStudent() {
  clearErr()
  const name  = document.getElementById('regName').value.trim()
  const grade = document.getElementById('regGrade').value
  const cls   = document.getElementById('regClass').value
  const num   = document.getElementById('regNumber').value
  const email = document.getElementById('regEmail').value.trim()
  const pass  = document.getElementById('regPass').value
  const pass2 = document.getElementById('regPass2').value
  if (!name || !email || !pass) { showErr('必須項目を入力してください'); return }
  if (pass !== pass2)           { showErr('パスワードが一致しません'); return }
  if (pass.length < 6)          { showErr('パスワードは6文字以上にしてください'); return }
  setBtn('regStudentBtn', true, '登録して始める')

  skipAuthRedirect = true
  try {
    await registerStudent({
      email, password: pass, name,
      grade: Number(grade), classLabel: Number(cls),
      number: num ? Number(num) : 0
    })
    location.href = BASE + '/'
  } catch(e) {
    skipAuthRedirect = false
    showErr(fbErr(e.code))
    setBtn('regStudentBtn', false, '登録して始める')
  }
}

// ── 先生新規登録 ──────────────────────────────────────────────────
async function doRegisterTeacher() {
  clearErr()
  const name  = document.getElementById('regTeacherName').value.trim()
  const email = document.getElementById('regTeacherEmail').value.trim()
  const pass  = document.getElementById('regTeacherPass').value
  const pass2 = document.getElementById('regTeacherPass2').value
  if (!name || !email || !pass) { showErr('必須項目を入力してください'); return }
  if (pass !== pass2)           { showErr('パスワードが一致しません'); return }
  if (pass.length < 6)          { showErr('パスワードは6文字以上にしてください'); return }
  setBtn('regTeacherBtn', true, '登録して始める')

  skipAuthRedirect = true
  try {
    await registerTeacher({ email, password: pass, name })
    location.href = BASE + '/teacher.html'
  } catch(e) {
    skipAuthRedirect = false
    showErr(fbErr(e.code))
    setBtn('regTeacherBtn', false, '登録して始める')
  }
}

// ── パスワードリセット ─────────────────────────────────────────────
async function showReset() {
  const email = prompt('登録時のメールアドレスを入力してください')
  if (!email) return
  try {
    await resetPassword(email)
    alert('パスワードリセットメールを送信しました')
  } catch(e) {
    alert('送信に失敗: ' + fbErr(e.code))
  }
}

window.switchTab = function(tab) {
  ['login','register'].forEach(t => {
    document.getElementById('tab'+(t==='login'?'Login':'Register'))?.classList.toggle('on',t===tab)
    document.getElementById('sec-'+t)?.classList.toggle('on',t===tab)
  })
  document.getElementById('authErr')?.classList.remove('show')
}
window.switchRole = function(role) {
  document.getElementById('roleStudent')?.classList.toggle('on',role==='student')
  document.getElementById('roleTeacher')?.classList.toggle('on',role==='teacher')
  document.getElementById('formStudent').style.display = role==='student' ? '' : 'none'
  document.getElementById('formTeacher').style.display = role==='teacher' ? '' : 'none'
}
