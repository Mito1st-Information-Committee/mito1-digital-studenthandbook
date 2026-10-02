/**
 * src/auth.js
 * Firebase Auth ヘルパー + ユーザープロフィール管理
 */
import { auth, db } from './firebase.js'
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  browserSessionPersistence,
  browserLocalPersistence,
  setPersistence,
  GoogleAuthProvider,
  signInWithPopup,
  linkWithPopup,
  unlink,
  deleteUser,
} from 'firebase/auth'
import {
  doc, setDoc, getDoc, getDocs, collection, serverTimestamp, query, where,
  updateDoc, arrayUnion, deleteField,
} from 'firebase/firestore'
import { normalizeClass, isValidClassForGrade } from './classOptions.js'

// =============================================
// Auth永続化ポリシー（#54）
//  - PWA（ホーム画面追加の standalone 等）: browserLocalPersistence
//    → 端末側に保持し、タスクキル後もログイン継続
//  - 通常ブラウザタブ: browserSessionPersistence（従来通り）
//    → タブを閉じたらログアウト（共用端末での取り残し防止）
// Firebaseのpersistenceは次回以降のsignInに適用されるため、
// ログイン/登録系の直前にも ensureAuthPersistence() で再適用する。
// =============================================
export function isStandalonePwa() {
  try {
    if (typeof window === 'undefined') return false
    if (window.matchMedia) {
      if (window.matchMedia('(display-mode: standalone)').matches) return true
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true
      if (window.matchMedia('(display-mode: minimal-ui)').matches) return true
    }
    if (window.navigator && window.navigator.standalone === true) return true
  } catch { /* noop */ }
  return false
}

export function resolveAuthPersistence() {
  return isStandalonePwa() ? browserLocalPersistence : browserSessionPersistence
}

export function ensureAuthPersistence() {
  try {
    return setPersistence(auth, resolveAuthPersistence()).catch(() => {})
  } catch {
    return Promise.resolve()
  }
}

// 初期適用（モジュール読込時。次回起動時の復元にも効く）
ensureAuthPersistence()

// display-modeの変化（インストール直後など）に追従し、
// PWA化されたら次回起動からlocal復元できるよう切り替える
try {
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mql = window.matchMedia('(display-mode: standalone)')
    const onChange = (e) => { if (e.matches) ensureAuthPersistence() }
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange)
    else if (typeof mql.addListener === 'function') mql.addListener(onChange)
  }
} catch { /* noop */ }

// =============================================
// 新規登録（生徒）
// =============================================
export async function registerStudent({ email, password, name, grade, classLabel, number }) {
  // 学年・クラス・出席番号は必須。Authユーザー作成前に弾くことで孤児ユーザーを残さない
  const num = Number(number)
  const g = Number(grade)
  const c = normalizeClass(classLabel)
  if (!name || !Number.isInteger(num) || num < 1 || num > 50) {
    const e = new Error('出席番号を入力してください（1〜50）')
    e.code = 'auth/invalid-attendance-number'
    throw e
  }
  if (!Number.isInteger(g) || g < 1 || g > 3 || !isValidClassForGrade(c, g)) {
    const e = new Error('学年・クラスが不正です')
    e.code = 'auth/invalid-class-info'
    throw e
  }
  // メール形式チェック（学校ドメインは任意制限・今は全ドメイン許可）
  await ensureAuthPersistence()
  const cred = await createUserWithEmailAndPassword(auth, email, password)
  const uid  = cred.user.uid

  await setDoc(doc(db, 'users', uid), {
    role:    'student',
    approved: false, // 生徒は登録直後は未承認。承認されるまで一部機能が制限される
    name,
    grade:   g,
    class:   c,
    number:  num,
    email,
    createdAt: serverTimestamp(),
  })

  return cred.user
}

// =============================================
// 新規登録（先生）
// =============================================
export async function registerTeacher({ email, password, name }) {
  await ensureAuthPersistence()
  const cred = await createUserWithEmailAndPassword(auth, email, password)
  const uid  = cred.user.uid

  await setDoc(doc(db, 'users', uid), {
    role: 'teacher',
    name,
    email,
    createdAt: serverTimestamp(),
  })

  return cred.user
}

// =============================================
// ログイン
// =============================================
export async function login(email, password) {
  await ensureAuthPersistence()
  const cred = await signInWithEmailAndPassword(auth, email, password)
  return cred.user
}

// =============================================
// ログアウト
// =============================================
export async function logout() {
  await signOut(auth)
}

// =============================================
// Googleログイン（連携のみ・新規登録不可）
//  - 方針: Googleでの新規登録は弾く。既存アカウントへの連携のみ許可
//  - ドメイン: GOOGLE_AUTH_CONFIG で制限（restrictDomain=falseで解除可）
//  - 機能フラグ: featureFlags 'google-auth'（beta既定）でUI表示を制御。
//    フラグ判定自体は呼び出し側（auth_page.js / index.html）が行う
// =============================================
export const GOOGLE_AUTH_CONFIG = {
  // false にすると全ドメイン許可に戻せる
  restrictDomain: true,
  allowedDomains: ['mito1-h.ibk.ed.jp'],
}

/** Googleのメアドが許可ドメインか */
export function isGoogleDomainAllowed(email) {
  if (!GOOGLE_AUTH_CONFIG.restrictDomain) return true
  const addr = String(email || '').trim().toLowerCase()
  return GOOGLE_AUTH_CONFIG.allowedDomains.some(d => addr.endsWith('@' + d.toLowerCase()))
}

function getGoogleProvider() {
  const p = new GoogleAuthProvider()
  // 学校テナントの選択画面に絞るUXヒント（強制力はない。本チェックは別途行う）
  if (GOOGLE_AUTH_CONFIG.restrictDomain && GOOGLE_AUTH_CONFIG.allowedDomains.length === 1) {
    p.setCustomParameters({ hd: GOOGLE_AUTH_CONFIG.allowedDomains[0] })
  }
  return p
}

/** AuthユーザーにGoogleプロバイダが紐付いているか */
export function isGoogleLinked(user) {
  const u = user || auth.currentUser
  if (!u || !Array.isArray(u.providerData)) return false
  return u.providerData.some(p => p?.providerId === GoogleAuthProvider.PROVIDER_ID)
}

/**
 * Googleでログイン（連携済みユーザーのみ）。
 * 未登録（users/{uid}なし）の場合は作成直後のAuthユーザーを掃除して弾く。
 * 同メアドのパスワード登録がある場合は
 * auth/account-exists-with-different-credential が投げられる（呼び出し側で案内UIへ）。
 */
export async function loginWithGoogle() {
  await ensureAuthPersistence()
  const cred = await signInWithPopup(auth, getGoogleProvider())
  const googleEmail = cred.user.email || ''

  if (!isGoogleDomainAllowed(googleEmail)) {
    try { await deleteUser(cred.user) } catch { /* noop */ }
    try { await signOut(auth) } catch { /* noop */ }
    const e = new Error('許可されていないドメインです')
    e.code = 'google/domain-not-allowed'
    throw e
  }

  const profile = await getCurrentProfile(cred.user)
  if (!profile) {
    // 新規登録は不可 → 孤児Authユーザーを残さないよう削除して弾く
    try { await deleteUser(cred.user) } catch { /* noop */ }
    try { await signOut(auth) } catch { /* noop */ }
    const e = new Error('未登録のGoogleアカウントです')
    e.code = 'google/no-profile'
    e.googleEmail = googleEmail
    throw e
  }

  // 正規メアドが古いままなら学校メアドに寄せる（旧メアドは退避）
  try {
    if (profile.email && profile.email !== googleEmail) {
      await updateDoc(doc(db, 'users', cred.user.uid), {
        email: googleEmail,
        previousEmails: arrayUnion(profile.email),
        photoURL: cred.user.photoURL || '',
      })
    } else if (!profile.photoURL && cred.user.photoURL) {
      await updateDoc(doc(db, 'users', cred.user.uid), { photoURL: cred.user.photoURL })
    }
  } catch { /* 同期失敗はログイン自体を妨げない */ }

  return cred.user
}

/**
 * ログイン中のアカウントにGoogleを後付け連携（私用メアド→学校メアドの移行も可）。
 * 連携後に users.email を学校メアドに更新し、旧メアドは previousEmails に退避。
 * 承認状態（approved）は引き継がれるため再承認は不要。
 */
export async function linkGoogleAccount() {
  const user = auth.currentUser
  if (!user) {
    const e = new Error('ログインが必要です')
    e.code = 'google/not-logged-in'
    throw e
  }
  const result = await linkWithPopup(user, getGoogleProvider())
  // 紐付け直後のuser.emailは旧メアドのままの場合があるためproviderDataから取得
  const gProfile = (result.user.providerData || []).find(p => p?.providerId === GoogleAuthProvider.PROVIDER_ID)
  const googleEmail = gProfile?.email || result.user.email || user.email || ''

  if (!isGoogleDomainAllowed(googleEmail)) {
    // 紐付けを取り消して弾く
    try { await unlink(user, GoogleAuthProvider.PROVIDER_ID) } catch { /* noop */ }
    const e = new Error('許可されていないドメインです')
    e.code = 'google/domain-not-allowed'
    throw e
  }

  const profile = await getCurrentProfile(user)
  const patch = {
    authProvider: 'google',
    photoURL: result.user.photoURL || '',
    googleLinkedAt: serverTimestamp(),
  }
  if (googleEmail && profile && profile.email && profile.email !== googleEmail) {
    patch.email = googleEmail
    patch.previousEmails = arrayUnion(profile.email)
  } else if (googleEmail && (!profile || !profile.email)) {
    patch.email = googleEmail
  }
  await updateDoc(doc(db, 'users', user.uid), patch)
  return googleEmail
}

/** Google連携の解除（パスワードログインは残る） */
export async function unlinkGoogleAccount() {
  const user = auth.currentUser
  if (!user) return
  await unlink(user, GoogleAuthProvider.PROVIDER_ID)
  try {
    await updateDoc(doc(db, 'users', user.uid), {
      authProvider: deleteField(),
      photoURL: deleteField(),
      googleLinkedAt: deleteField(),
    })
  } catch { /* noop */ }
}

/**
 * 現在のユーザープロフィール取得
 * user引数を渡すとauth.currentUserに依存しない
 */
export async function getCurrentProfile(user) {
  const u = user || auth.currentUser
  if (!u) return null
  const snap = await getDoc(doc(db, 'users', u.uid))
  if (!snap.exists()) return null
  return { uid: u.uid, email: u.email, ...snap.data() }
}

// =============================================
// Auth状態変化を監視してコールバック
// =============================================
export function onAuth(callback) {
  return onAuthStateChanged(auth, callback)
}

// =============================================
// パスワードリセットメール送信
// =============================================
export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email)
}

// =============================================
// 先生のメールアドレス一覧取得（公欠申請フォームのサジェスト用）
// 承認済み生徒のみ呼び出し可能（firestore.rules で制限）。
// role === 'teacher' のユーザーのみを対象とする
// （委員会の管理者(先生)等は既存の顧問・担任フローの対象外のため含めない）。
// =============================================
let _teacherDirectoryCache = null
export async function getTeacherDirectory() {
  if (_teacherDirectoryCache) return _teacherDirectoryCache
  const q = query(collection(db, 'users'), where('role', '==', 'teacher'))
  const snap = await getDocs(q)
  const list = snap.docs
    .map(d => ({ email: d.data().email || '', name: d.data().name || '' }))
    .filter(t => !!t.email)
  _teacherDirectoryCache = list
  return list
}
