/**
 * src/line.js
 * LINE アカウント連携（LINE Login チャネルの認可コードフロー）クライアント側モジュール
 *
 * ■ これは「LINEでログイン」ではありません
 *   Firebase Auth のアカウント（= 生徒手帳のアカウント）に対して
 *   LINE のユーザーID（Uxxxxxxxx...）を紐づけ、Messaging API 経由で
 *   通知を LINE に送れるようにするための「連携」機能です。
 *   したがって未ログイン状態では利用できません（マイページ限定）。
 *
 * ■ フロー（PWA/別タブ分断対応版）
 *   OAuth の「同じタブ・同じログイン状態に戻ってくる」前提を捨て、
 *   Firestore の lineLinkSessions/{state} を中継する「セッション＋ポーリング」方式。
 *   コールバック側はどのブラウザ・タブ・アプリで開かれてもよい。
 *
 *   1. マイページの連携バナーをクリック（ログイン済み）
 *      → state を生成し、lineLinkSessions/{state} に
 *        { uid, status:'pending', createdAt } を作成（beginLineLink）
 *      → 認可URLを新しいタブ/ウィンドウで開く（元のタブ/PWAは残る）
 *      → 元のタブは watchLineSession でセッションを監視（onSnapshot）
 *   2. LINEの認可画面 → コールバック（line-callback.html）がどこで開かれても可
 *      （ログイン不要・sessionStorage不要）
 *      → code を Workers /line/exchange に渡して LINE userId を取得
 *      → lineLinkSessions/{state} を status:'done' + プロフィールに更新
 *   3. 元のタブ/PWA が done を検知（completeLineLink）
 *      → 自分（認証済み）の権限で users/{uid} に lineUserId 等を保存
 *      → セッションを status:'consumed' にして使い捨てを確定
 *
 * ■ LINE Developers Console に登録すべきコールバックURL
 *   https://mito1-tetyo.tech/line-callback.html
 *   （ローカル開発時は http://localhost:5173/line-callback.html も追加）
 */
import { db } from './firebase.js'
import {
  doc, updateDoc, getDoc, getDocs, collection, query, where,
  deleteField, deleteDoc, serverTimestamp, setDoc, onSnapshot,
} from 'firebase/firestore'

// Workers のベースURL（cases.js と同じデプロイ先）
export const WORKERS_URL = 'https://mito1-hundbook.asanuma-ryuto.workers.dev'

// LINE Login のコールバックURL（LINE Developers Console に登録する値と完全一致させる）
export const LINE_CALLBACK_PATH = '/line-callback.html'

// =============================================
// state（CSRF対策 / セッションdoc の ID）
// =============================================
function genState() {
  const arr = new Uint8Array(24)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
}

export function callbackUrl() {
  return window.location.origin + LINE_CALLBACK_PATH
}

// =============================================
// 連携開始（バナークリック時）
// =============================================
/**
 * セッションdoc（lineLinkSessions/{state}）を作成し、LINE 認可URLを返す。
 * ここでは画面遷移しない。呼び出し側で認可URLを新しいタブ/ウィンドウで開き、
 * 元の画面は watchLineSession() でセッションを監視する。
 * @param {string} uid ログイン中のユーザーUID
 * @returns {Promise<{state:string, authorizeUrl:string}>}
 */
export async function beginLineLink(uid) {
  const state = genState()
  await setDoc(doc(db, 'lineLinkSessions', state), {
    uid,
    status: 'pending',
    createdAt: serverTimestamp(),
  })
  const params = new URLSearchParams({
    state,
    redirect_uri: callbackUrl(),
  })
  return {
    state,
    authorizeUrl: `${WORKERS_URL}/line/authorize?${params.toString()}`,
  }
}

/**
 * セッションを監視する。コールバック側が done を書き込むと onDone が呼ばれる。
 * @param {string} state beginLineLink が返した state
 * @param {{onDone:Function, onError?:Function}} handlers
 * @returns {() => void} 監視解除関数（unsubscribe）
 */
export function watchLineSession(state, { onDone, onError }) {
  return onSnapshot(doc(db, 'lineLinkSessions', state), snap => {
    const d = snap.data()
    if (!d) return
    if (d.status === 'done' && onDone) onDone(d)
  }, err => {
    if (onError) onError(err)
  })
}

/**
 * 連携を確定する（元のタブ/PWA側・認証済みで実行）。
 * users/{uid} に保存し、セッションを使い捨て（consumed）にする。
 * @param {string} uid ログイン中のユーザーUID
 * @param {string} state セッションのstate
 * @param {{lineUserId:string, displayName?:string, pictureUrl?:string}} sessionData
 */
export async function completeLineLink(uid, state, sessionData) {
  await saveLineLink(uid, {
    userId:      sessionData.lineUserId,
    displayName: sessionData.displayName || '',
    pictureUrl:  sessionData.pictureUrl  || '',
  })
  try {
    await updateDoc(doc(db, 'lineLinkSessions', state), {
      status: 'consumed',
    })
  } catch (e) {
    console.warn('[line] failed to consume session:', e)
  }
}

/**
 * 連携を中断する（キャンセル/タイムアウト時）。
 * @param {string} state セッションのstate
 */
export async function cancelLineSession(state) {
  if (!state) return
  try {
    await updateDoc(doc(db, 'lineLinkSessions', state), { status: 'cancelled' })
  } catch (e) {
    console.warn('[line] failed to cancel session:', e)
  }
}

/**
 * 放置された古いセッション（pending/done のまま一定時間経過）を削除する。
 * タブを閉じるなどでキャンセル処理が走らなかった場合の掃除用。
 * @param {string} uid ログイン中のユーザーUID
 * @param {number} maxAgeMs この時間を超えたら削除（既定30分）
 */
export async function cleanupLineSessions(uid, maxAgeMs = 30 * 60 * 1000) {
  if (!uid) return
  try {
    const q = query(collection(db, 'lineLinkSessions'), where('uid', '==', uid))
    const snap = await getDocs(q)
    const now = Date.now()
    const dels = snap.docs
      .filter(d => {
        const data = d.data()
        if (data.status === 'consumed') return false
        const t = data.createdAt?.toMillis?.()
        return !!t && (now - t) > maxAgeMs
      })
      .map(d => deleteDoc(d.ref))
    await Promise.all(dels)
  } catch (e) {
    console.warn('[line] cleanupLineSessions failed:', e)
  }
}

// =============================================
// 認可コード → LINE プロフィール（Workers 経由）
// =============================================
/**
 * @param {string} code LINE から返ってきた認可コード（10分間・1回のみ有効）
 * @returns {Promise<{userId:string, displayName:string, pictureUrl?:string}>}
 */
export async function exchangeCodeForProfile(code) {
  const res = await fetch(`${WORKERS_URL}/line/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirectUri: callbackUrl() }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data?.error_description || data?.detail || data?.error || `LINE連携に失敗しました (${res.status})`)
  }
  if (!data.userId) throw new Error('LINEのユーザーIDを取得できませんでした')
  return data
}

// =============================================
// Firestore（users/{uid}）への保存・解除
// =============================================
/**
 * LINEユーザーIDをユーザードキュメントに書き込む
 */
export async function saveLineLink(uid, profile) {
  await updateDoc(doc(db, 'users', uid), {
    lineUserId:      profile.userId,
    lineDisplayName: profile.displayName || '',
    linePictureUrl:  profile.pictureUrl || '',
    lineNotify:      true,          // LINE通知の有効/無効（将来的に個別設定できるように）
    lineLinkedAt:    serverTimestamp(),
  })

  // 連携前に作成された進行中の申請ケースにも studentLineUserId を同期設定
  try {
    const q = query(
      collection(db, 'cases'),
      where('studentId', '==', uid)
    )
    const snap = await getDocs(q)
    const updates = snap.docs
      .filter(d => ['pending_supervisor', 'pending_homeroom'].includes(d.data().status))
      .map(d => updateDoc(doc(db, 'cases', d.id), { studentLineUserId: profile.userId }))
    await Promise.all(updates)
  } catch (e) {
    console.warn('[saveLineLink] failed to update pending cases with studentLineUserId:', e)
  }
}

/**
 * 連携解除（LINEユーザーIDを削除）
 */
export async function unlinkLine(uid) {
  await updateDoc(doc(db, 'users', uid), {
    lineUserId:      deleteField(),
    lineDisplayName: deleteField(),
    linePictureUrl:  deleteField(),
    lineNotify:      deleteField(),
    lineLinkedAt:    deleteField(),
  })
}

/**
 * 連携状態の取得
 */
export async function getLineLinkStatus(uid) {
  const snap = await getDoc(doc(db, 'users', uid))
  if (!snap.exists()) return { linked: false }
  const d = snap.data()
  return {
    linked:      !!d.lineUserId,
    userId:      d.lineUserId || '',
    displayName: d.lineDisplayName || '',
    pictureUrl:  d.linePictureUrl || '',
    notify:      d.lineNotify !== false,
  }
}

export function isLinked(profile) {
  return !!(profile && profile.lineUserId)
}