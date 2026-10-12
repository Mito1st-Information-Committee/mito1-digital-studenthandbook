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
  setPersistence,
  deleteUser,
} from 'firebase/auth'
import {
  doc, setDoc, getDoc, getDocs, collection, serverTimestamp, query, where,
} from 'firebase/firestore'

// タブを閉じたらログアウト
setPersistence(auth, browserSessionPersistence).catch(() => {})

// =============================================
// 新規登録（生徒）
// Auth作成 → Firestore作成の2段階。Firestore側の書き込みに失敗したら
// Authユーザーを削除して「Authにだけ残る孤児」を作らない（管理画面に表示されない事故の防止）。
// 書き込み後は getDoc で存在確認まで行う。
// =============================================
export async function registerStudent({ email, password, name, grade, classLabel, number }) {
  // メール形式チェック（学校ドメインは任意制限・今は全ドメイン許可）
  const cred = await createUserWithEmailAndPassword(auth, email, password)
  const uid  = cred.user.uid

  try {
    await setDoc(doc(db, 'users', uid), {
      role:    'student',
      approved: false, // 生徒は登録直後は未承認。承認されるまで一部機能が制限される
      name,
      grade:   Number(grade),
      class:   classLabel,
      number:  Number(number),
      email,
      createdAt: serverTimestamp(),
    })

    // 作成確認: 読み返して存在しなければ失敗扱い
    const snap = await getDoc(doc(db, 'users', uid))
    if (!snap.exists()) {
      throw { code: 'firestore/write-not-verified' }
    }
  } catch (e) {
    // ロールバック: Authだけ残すと管理画面に出ず復旧が手作業になるため削除を試みる
    try { await deleteUser(cred.user) } catch { /* 削除失敗時は orphan として残る。ログイン時セルフヒールで回収 */ }
    throw e
  }

  return cred.user
}

// =============================================
// 新規登録（先生）
// 生徒と同様、Firestore書き込み失敗時はAuthユーザーを削除して孤児化を防ぐ。
// =============================================
export async function registerTeacher({ email, password, name }) {
  const cred = await createUserWithEmailAndPassword(auth, email, password)
  const uid  = cred.user.uid

  try {
    await setDoc(doc(db, 'users', uid), {
      role: 'teacher',
      name,
      email,
      createdAt: serverTimestamp(),
    })

    const snap = await getDoc(doc(db, 'users', uid))
    if (!snap.exists()) {
      throw { code: 'firestore/write-not-verified' }
    }
  } catch (e) {
    try { await deleteUser(cred.user) } catch { /* orphan はログイン時セルフヒールで回収 */ }
    throw e
  }

  return cred.user
}

// =============================================
// ログイン
// =============================================
export async function login(email, password) {
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
// 現在のユーザープロフィール取得
// user引数を渡すとauth.currentUserに依存しない
// =============================================
export async function getCurrentProfile(user) {
  const u = user || auth.currentUser
  if (!u) return null
  const snap = await getDoc(doc(db, 'users', u.uid))
  if (!snap.exists()) return null
  return { uid: u.uid, email: u.email, ...snap.data() }
}

// =============================================
// 既存孤児のセルフヒール: users/{uid} が無い Auth ユーザーの修復
// 過去の登録失敗（Authのみ残存）で管理画面に表示されない事故を回収する。
//  - 既存ドキュメントがあればそれを返す（上書きしない）
//  - 無ければ最小限のドキュメントを新規作成する（rules の allow create と整合:
//    role は student/teacher のみ、approved/betaTester 付き作成不可）
//  - role が不明な場合は student として作成する（先生の孤児は管理者が後から昇格）。
//    呼び出し側で hint.role='teacher' を渡すと teacher として作成する。
// 戻り値: { profile, created }
// =============================================
export async function ensureUserDoc(user, hint = {}) {
  const u = user || auth.currentUser
  if (!u) return { profile: null, created: false }
  const ref = doc(db, 'users', u.uid)
  const snap = await getDoc(ref)
  if (snap.exists()) {
    return { profile: { uid: u.uid, email: u.email, ...snap.data() }, created: false }
  }

  const role = hint.role === 'teacher' ? 'teacher' : 'student'
  const fallbackName = (u.displayName || '').trim()
    || String(hint.name || '').trim()
    || String(u.email || '').split('@')[0]
    || '名称未設定'
  const data = role === 'teacher'
    ? {
        role: 'teacher',
        name: fallbackName,
        email: u.email || String(hint.email || ''),
        createdAt: serverTimestamp(),
        healedAt: serverTimestamp(), // 孤児修復で作られた目印（既存フィールドに影響なし）
      }
    : {
        role: 'student',
        approved: false,
        name: fallbackName,
        grade: Number(hint.grade) || 0,
        class: hint.classLabel ?? hint.class ?? 0,
        number: Number(hint.number) || 0,
        email: u.email || String(hint.email || ''),
        createdAt: serverTimestamp(),
        healedAt: serverTimestamp(),
      }

  await setDoc(ref, data)
  const re = await getDoc(ref)
  if (!re.exists()) {
    throw { code: 'firestore/write-not-verified' }
  }
  return { profile: { uid: u.uid, email: u.email, ...re.data() }, created: true }
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
