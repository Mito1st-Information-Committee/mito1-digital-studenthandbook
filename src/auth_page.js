import { onAuth, login, registerStudent, registerTeacher, resetPassword, getCurrentProfile,
  loginWithGoogle } from './auth.js'
import { fetchFeatureFlags, getFlagStatus, FLAG_STATUSES } from './featureFlags.js'
import { classOptionTags } from './classOptions.js'

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

    <!-- Googleログイン（連携済みのみ。新規登録不可。featureFlags 'google-auth' で制御） -->
    <div id="googleLoginWrap" style="display:none">
      <div class="divider"><span>または</span></div>
      <button class="btn-google" id="googleLoginBtn">
        <svg viewBox="0 0 24 24" width="17" height="17"><path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.3H12v4.3h6.5c0 1.1-.7 2.7-2.1 3.8l-.1.1 3 2.4.2.1c1.9-1.8 3-4.4 3-8.4z"/><path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.8-2.9c-.7.4-1.9 1-4.1 1-3.1 0-5.7-2.1-6.6-4.9H1.5v3C3.5 21.3 7.5 24 12 24z"/><path fill="#FBBC05" d="M5.4 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3v-3H1.5C.6 8.2 0 10 0 12s.6 3.8 1.5 5.3l3.9-3z"/><path fill="#EA4335" d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.5 0 3.5 2.7 1.5 6.7l3.9 3c.9-2.8 3.5-5 6.6-5z"/></svg>
        Googleでログイン <span class="beta-pill" id="googleBetaPill" style="display:none">β</span>
      </button>
      <div class="link-guide" id="googleLinkGuide" style="display:none"></div>
      <div class="hint">※ Googleでの新規登録はできません。先にメールアドレスで登録し、マイページで連携してください。<br>学校Googleアカウント（@mito1-h.ibk.ed.jp）のみ利用できます。</div>
    </div>
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
          <select class="form-input" id="regClass">${classOptionTags()}</select>
        </div>
        <div class="form-group">
          <label class="form-label">出席番号 <span class="req">必須</span></label>
          <input class="form-input" id="regNumber" type="number" min="1" max="50" placeholder="1" required>
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
document.getElementById('googleLoginBtn')?.addEventListener('click', doGoogleLogin)
document.getElementById('regStudentBtn').addEventListener('click', doRegisterStudent)
document.getElementById('regTeacherBtn').addEventListener('click', doRegisterTeacher)
document.getElementById('resetLink').addEventListener('click', showReset)
// Googleボタン表示は featureFlags 'google-auth' で制御。
// ※ 未ログイン時はβテスター判定ができないため、disabled 以外（beta/enabled）で表示し、
//    beta の場合はβバッジを付ける。厳密なゲートはマイページの連携ボタン側で行う
;(async () => {
  try {
    const flags = await fetchFeatureFlags()
    const status = getFlagStatus(flags, 'google-auth')
    if (status !== FLAG_STATUSES.DISABLED) {
      document.getElementById('googleLoginWrap').style.display = ''
      if (status === FLAG_STATUSES.BETA) {
        document.getElementById('googleBetaPill').style.display = ''
      }
    }
  } catch { /* 取得失敗時は非表示のまま（従来ログインを妨げない） */ }
})()
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
    'auth/invalid-attendance-number': '出席番号を入力してください（1〜50）',
    'auth/invalid-class-info': '学年・クラスが不正です',
    'auth/popup-closed-by-user': 'Googleの選択画面が閉じられました。もう一度お試しください',
    'auth/cancelled-popup-request': '処理中です。そのままお待ちください',
    'auth/popup-blocked':        'ポップアップがブロックされました。ブラウザの許可設定をご確認ください',
    'auth/account-exists-with-different-credential': 'このメールアドレスはパスワード登録済みです。下の案内に沿って連携してください',
    'google/no-profile':         'このGoogleアカウントは登録されていません。先にメールアドレスで新規登録し、マイページでGoogle連携を行ってください',
    'google/domain-not-allowed': '学校のGoogleアカウント（@mito1-h.ibk.ed.jp）のみ利用できます',
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
    await login(email, pass)
    // onAuth がリダイレクト
    // ※ Google連携はマイページの連携ボタンからのみ行う。
    //   ここで自動リンクしない（解除後に再リンクされて「解除できない」に見える原因になるため）
  } catch(e) {
    showErr(fbErr(e.code))
    setBtn('loginBtn', false, 'ログイン')
  }
}

// ── Googleでログイン（連携済みのみ。新規登録不可） ──────────────────
// 同メアドのパスワード登録がある場合（未連携・解除済み含む）は衝突エラーになるため、
// パスワードでログイン後にマイページの連携ボタンから紐付けるよう案内する
async function doGoogleLogin() {
  clearErr()
  setGoogleBtn(true)
  try {
    await loginWithGoogle()
    // onAuth がリダイレクト
  } catch(e) {
    setGoogleBtn(false)
    if (e?.code === 'auth/account-exists-with-different-credential') {
      showLinkGuide()
      showErr('このGoogleアカウントはまだ連携されていません。上のメール欄からパスワードでログインし、マイページのGoogle連携ボタンから連携してください')
      return
    }
    if (e?.code === 'auth/popup-closed-by-user') return // キャンセルは何も表示しない
    showErr(fbErr(e?.code))
  }
}

function setGoogleBtn(loading) {
  const btn = document.getElementById('googleLoginBtn')
  if (btn) btn.disabled = loading
}

function showLinkGuide() {
  const el = document.getElementById('googleLinkGuide')
  if (el) {
    el.innerHTML = '🔗 <b>Google連携の手順</b><br>1. 上のメール欄からパスワードでログイン<br>2. マイページのGoogle連携カードで「連携する」を押す'
    el.style.display = ''
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
  if (!num || !/^\d+$/.test(String(num).trim()) || Number(num) < 1 || Number(num) > 50) { showErr('出席番号を入力してください（1〜50）'); return }
  if (pass !== pass2)           { showErr('パスワードが一致しません'); return }
  if (pass.length < 6)          { showErr('パスワードは6文字以上にしてください'); return }
  setBtn('regStudentBtn', true, '登録して始める')

  skipAuthRedirect = true
  try {
    await registerStudent({
      email, password: pass, name,
      grade: Number(grade), classLabel: Number(cls),
      number: Number(num)
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
