/**
 * src/push.js
 * Web Push クライアントモジュール（PWA / iPhone対応）
 *
 * ■ 仕組み
 *   1. Service Worker（/sw.js）の pushManager でブラウザのプッシュサーバー
 *      （Apple/Google）に購読登録 → endpoint + p256dh/auth鍵を取得
 *   2. 購読情報を Firestore users/{uid}/pushSubscriptions/{subId} に保存
 *   3. 送信時は Workers の POST /push/send が VAPID署名＋aes128gcm暗号化して
 *      プッシュサーバーへ配信（秘密鍵はWorkersのシークレットのみ）
 *
 * ■ iPhone条件: iOS 16.4+ / Safariから「ホーム画面に追加」したPWAで開くこと。
 *   Safariタブ内では購読不可。その場合は案内メッセージを表示する。
 */
import { db } from './firebase.js'
import {
  doc, setDoc, getDoc, updateDoc, getDocs, deleteDoc, collection, serverTimestamp,
} from 'firebase/firestore'

// VAPID公開鍵（Workersの VAPID_PRIVATE_KEY とペア。公開情報なのでコミット可）
export const VAPID_PUBLIC_KEY =
  'BKkk44MwpNWv4Mo66MvsEGTC08FmqU6EYOpdGExqhZ9Dl90ZylQgQhlVHZwqBmbqYQ4NgKND6LgwFW-meoVs7HE'

// Workers のベースURL（line.js / cases.js と同じデプロイ先）
export const WORKERS_URL = 'https://mito1-hundbook.asanuma-ryuto.workers.dev'

// =============================================
// 通知種別（受け取る通知の選択肢）
// 将来Push/LINEで別の通知を配信する場合は、ここに1件追加するだけで
// 設定シートのチェックボックス・送信側の判定・デフォルトが揃う。
// =============================================
export const NOTIFICATION_TYPES = {
  approval: {
    key: 'approval',
    label: '公欠申請の承認完了',
    default: true,
  },
}

export const DEFAULT_NOTIFICATION_PREFS = Object.fromEntries(
  Object.entries(NOTIFICATION_TYPES).map(([key, t]) => [key, t.default])
)

/**
 * 保存されたプレファレンスを正規化する（未知のキーはデフォルト値へ）。
 * Firestoreに壊れた値が入っていても安全に扱えるようにする。
 */
export function normalizeNotificationPrefs(raw) {
  const out = { ...DEFAULT_NOTIFICATION_PREFS }
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(NOTIFICATION_TYPES)) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key]
    }
  }
  return out
}

/**
 * ユーザーの通知受け取り設定を取得（未保存ならデフォルト）
 */
export async function getNotificationPrefs(uid) {
  if (!uid) return { ...DEFAULT_NOTIFICATION_PREFS }
  try {
    const snap = await getDoc(doc(db, 'users', uid))
    if (snap.exists()) return normalizeNotificationPrefs(snap.data().notificationPrefs)
  } catch { /* ignore */ }
  return { ...DEFAULT_NOTIFICATION_PREFS }
}

/**
 * ユーザーの通知受け取り設定を保存（マイページの設定シートから）
 */
export async function setNotificationPrefs(uid, prefs) {
  if (!uid) throw new Error('ログインが必要です')
  const clean = normalizeNotificationPrefs(prefs)
  await updateDoc(doc(db, 'users', uid), { notificationPrefs: clean })
  return clean
}

// =============================================
// 対応判定
// =============================================
export function isPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

function isIos() {
  const ua = navigator.userAgent || ''
  return /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

/** ホーム画面追加のPWA（standalone）として開かれているか */
export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  )
}

/**
 * 購読可否の判定結果を返す（UI表示用）
 *   { supported, isIos, standalone, reason }
 *   reason: 'ok' | 'unsupported' | 'ios-browser'
 */
export function pushAvailability() {
  const ios = isIos()
  const standalone = isStandalone()
  // iPhoneはPWA（ホーム画面追加）でのみWeb Push可。
  // 非PWAのSafariでは PushManager 自体が存在しないことがあるため、
  // iOS判定を先に行い、ブラウザ表示時は必ず案内を出す。
  if (ios && !standalone) {
    return { supported: false, isIos: true, standalone, reason: 'ios-browser' }
  }
  if (!isPushSupported()) {
    return { supported: false, reason: 'unsupported' }
  }
  return { supported: true, isIos: ios, standalone, reason: 'ok' }
}

// =============================================
// 購読状態
// =============================================
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function bytesToBase64Url(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 既存のPushSubscriptionが、指定したVAPID公開鍵で作成されたものか判定する。
 * 鍵をローテーションすると古い購読は無効（403 VapidPkHashMismatch）になるので、
 * 一致しない場合は購読を作り直す必要がある。
 */
export function subscriptionMatchesKey(sub, publicKey) {
  try {
    const applied = sub.options && sub.options.applicationServerKey
    if (!applied) return true // 判定不能なら既存を尊重する
    return bytesToBase64Url(applied) === publicKey.replace(/=+$/, '')
  } catch {
    return true
  }
}

async function swRegistration() {
  // index.html側ですでに /sw.js を登録済み。readyで取得する
  let reg = await navigator.serviceWorker.ready.catch(() => null)
  if (!reg) {
    reg = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
  }
  return reg
}

function subIdFor(endpoint) {
  // endpointは長いURLなのでハッシュ化してドキュメントIDにする（非同期不要の簡易ハッシュ）
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < endpoint.length; i++) {
    const c = endpoint.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x811c9dc5) >>> 0
  }
  return `s${h1.toString(36)}${h2.toString(36)}`
}

/**
 * 現在の購読状態を取得
 * → { permission, subscribed, endpoint }
 */
export async function getPushState() {
  const permission = ('Notification' in window) ? Notification.permission : 'unsupported'
  if (!isPushSupported()) return { permission, subscribed: false, endpoint: null }
  try {
    const reg = await swRegistration()
    const sub = await reg.pushManager.getSubscription()
    return { permission, subscribed: !!sub, endpoint: sub ? sub.endpoint : null }
  } catch {
    return { permission, subscribed: false, endpoint: null }
  }
}

// =============================================
// 購読ON（必ずタップ等のユーザー操作内から呼ぶこと）
// =============================================
export async function subscribePush(uid) {
  if (!uid) throw new Error('ログインが必要です')
  const avail = pushAvailability()
  if (!avail.supported) {
    if (avail.reason === 'ios-browser') {
      throw new Error('iPhoneでは「共有→ホーム画面に追加」して追加したアプリアイコンから開いてください')
    }
    throw new Error('このブラウザはプッシュ通知に対応していません')
  }

  // 1. 通知許可（ユーザー操作内で呼ぶ）
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('通知が許可されませんでした')

  // 2. プッシュサーバーへ購読登録
  const reg = await swRegistration()

  // 既存購読があっても、それが「今のVAPID公開鍵」で作られたものとは限らない。
  // 鍵をローテーションした場合、古い購読のままだとApple/Googleが
  // 403 VapidPkHashMismatch を返し通知が届かないため、鍵が違えば作り直す。
  let sub = await reg.pushManager.getSubscription().catch(() => null)
  if (sub && !subscriptionMatchesKey(sub, VAPID_PUBLIC_KEY)) {
    await sub.unsubscribe().catch(() => {})
    sub = null
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })
  }
  const json = sub.toJSON()

  // 3. Firestoreに保存（本人専用サブコレクション）
  const id = subIdFor(sub.endpoint)
  await setDoc(doc(db, 'users', uid, 'pushSubscriptions', id), {
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    userAgent: navigator.userAgent || '',
    standalone: isStandalone(),
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  }, { merge: true })

  // Push利用フラグを更新し、通知受け取り設定が未保存ならデフォルトで初期化
  // （管理画面での「Push利用状況」確認用の冗長フィールド）
  try {
    const userSnap = await getDoc(doc(db, 'users', uid))
    const data = userSnap.exists() ? userSnap.data() : {}
    const patch = { pushEnabled: true }
    if (!data.notificationPrefs) patch.notificationPrefs = DEFAULT_NOTIFICATION_PREFS
    await updateDoc(doc(db, 'users', uid), patch)
  } catch { /* ignore */ }

  // 通知をONにした直後に一度だけテスト通知を送る。
  // （テスト送信ボタンはサーバー負荷を増やすため設けない — Issue #21）
  try {
    await postPush(sub.endpoint, json.keys, {
      title: 'テスト通知',
      body: 'プッシュ通知は正常に届いています',
      url: '/#mypage',
      tag: 'mito1-test',
    })
  } catch (e) {
    console.warn('[push] test send failed:', e?.message || String(e))
  }

  return { endpoint: sub.endpoint }
}

// =============================================
// 購読OFF
// =============================================
export async function unsubscribePush(uid) {
  try {
    const reg = await swRegistration()
    const sub = await reg.pushManager.getSubscription().catch(() => null)
    if (sub) {
      const endpoint = sub.endpoint
      await sub.unsubscribe().catch(() => {})
      // Firestore側も削除（best-effort）
      if (uid) {
        try {
          await deleteDoc(doc(db, 'users', uid, 'pushSubscriptions', subIdFor(endpoint)))
        } catch { /* ignore */ }
      }
    } else if (uid) {
      // SW側に購読が無い場合もFirestore側を全掃除
      try {
        const snap = await getDocs(collection(db, 'users', uid, 'pushSubscriptions'))
        await Promise.all(snap.docs.map(d =>
          deleteDoc(doc(db, 'users', uid, 'pushSubscriptions', d.id)).catch(() => {})
        ))
      } catch { /* ignore */ }
    }
    // Push未利用フラグを更新（管理画面のPush利用状況表示用）
    if (uid) {
      try { await updateDoc(doc(db, 'users', uid), { pushEnabled: false }) } catch { /* ignore */ }
    }
  } catch (e) {
    throw new Error('通知OFFに失敗しました: ' + (e?.message || String(e)))
  }
}

// =============================================
// 送信（テスト・承認完了通知用）
// =============================================

/**
 * 1つの購読へ Workers 経由でプッシュ送信する。
 * @returns {{ok:boolean, gone?:boolean, detail?:string}}
 */
async function postPush(endpoint, keys, payload) {
  const res = await fetch(`${WORKERS_URL}/push/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
      payload,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok !== true) {
    return { ok: false, gone: data.gone === true, detail: data?.detail || data?.error || `送信失敗 (${res.status})` }
  }
  return { ok: true }
}

/**
 * 指定生徒の全購読へ通知を送る。
 * 呼び出し側（先生・管理者）の権限で購読一覧を読み、Workersへ1件ずつ送信する。
 * Workersは秘密鍵を持ちFirestoreを読まない設計のため、この方式にしている。
 * 生徒の「受け取る通知」設定（users.notificationPrefs）を尊重する。
 * @param {string} type 通知種別（NOTIFICATION_TYPES の key。既定: approval）
 */
export async function notifyStudentPush(studentId, payload, type = 'approval') {
  if (!studentId) return { sent: 0 }

  // 通知を受け取らない設定の場合は送信しない
  const prefs = await getNotificationPrefs(studentId)
  if (prefs[type] === false) return { sent: 0, disabled: true }

  let subs = []
  try {
    const snap = await getDocs(collection(db, 'users', studentId, 'pushSubscriptions'))
    subs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s?.endpoint && s?.keys?.p256dh)
  } catch {
    return { sent: 0, skipped: true }
  }

  let sent = 0
  for (const s of subs) {
    try {
      const result = await postPush(s.endpoint, s.keys, payload)
      if (result.ok) {
        sent++
      } else if (result.gone) {
        // 購読切れ（404/410）→ Firestoreから掃除
        await deleteDoc(doc(db, 'users', studentId, 'pushSubscriptions', s.id)).catch(() => {})
      }
    } catch { /* 次の購読へ */ }
  }
  return { sent, total: subs.length }
}
