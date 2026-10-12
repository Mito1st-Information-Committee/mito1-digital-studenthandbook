/**
 * src/cases.js
 * 公欠申請（ケース）の作成・取得・承認・削除ロジック
 */
import { db } from './firebase.js'
import {
  collection, doc, addDoc, updateDoc, getDoc, getDocs, deleteDoc,
  query, where, orderBy, serverTimestamp,
} from 'firebase/firestore'
import { notifyStudentPush, getNotificationPrefs } from './push.js'

// 承認完了時のPWAプッシュ通知（購読済み端末へ。失敗しても承認処理は止めない）
async function notifyApprovedPush(caseId, caseData) {
  try {
    const datesStr = (caseData.dates || []).join('、')
    await notifyStudentPush(caseData.studentId, {
      title: '公欠申請が承認されました',
      body: `${caseData.title || ''}（${datesStr}）`,
      url: '/#mypage',
      tag: `case-approved-${caseId}`,
    }, 'approval')
  } catch (e) {
    console.warn('[push-notify] failed:', e)
  }
}

// LINE通知を送るか（生徒の「受け取る通知」設定で承認完了OFFの場合は送らない）
async function shouldNotifyLine(studentId) {
  if (!studentId) return false
  try {
    const prefs = await getNotificationPrefs(studentId)
    return prefs.approval !== false
  } catch { /* 取得失敗時は送信する（従来動作を維持） */ }
  return true
}

// NOTE: "hundbook" might be a typo for "handbook". Please verify against the Worker deployment.
const WORKERS_URL = 'https://mito1-hundbook.asanuma-ryuto.workers.dev'
const APP_BASE    = window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, '')

// =============================================
// エラーメッセージのマッピング
// =============================================
function friendlyError(e) {
  const msg = e?.message || String(e)
  if (msg.includes('Missing or insufficient permissions')) {
    return 'Firestoreのセキュリティルールで操作が拒否されました。Firebase Console でルールを更新してください（firestore.rules を参照）。'
  }
  return msg
}

// =============================================
// ランダムトークン生成
// =============================================
function genToken() {
  const arr = new Uint8Array(24)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => b.toString(16).padStart(2,'0')).join('')
}

// =============================================
// メール送信ヘルパー（エラーをキャッチして返す）
// =============================================
async function sendEmail(endpoint, payload) {
  try {
    const res = await fetch(`${WORKERS_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      // Workers は { error, detail, hint } を返す。
      // hint は「利用者が次に何をすればよいか」を日本語で書いたもの（あれば最優先で表示）。
      const raw = await res.text().catch(() => '')
      let hint = ''
      let detail = raw
      try {
        const parsed = JSON.parse(raw)
        hint = parsed.hint || ''
        detail = parsed.detail || parsed.error || raw
      } catch {
        // JSON でなければ本文をそのまま detail として扱う
      }
      console.warn(`[email] ${endpoint} failed (${res.status}):`, raw)
      return { ok: false, status: res.status, detail, hint }
    }
    return { ok: true, status: res.status, detail: '', hint: '' }
  } catch (e) {
    console.warn(`[email] ${endpoint} network error:`, e.message)
    return {
      ok: false,
      status: 0,
      detail: e.message,
      hint: 'ネットワークに接続できませんでした。通信環境を確認して、マイページから再度お試しください。',
    }
  }
}

// =============================================
// ケース作成 + 顧問へ承認依頼メール送信
// =============================================
export async function createCase({ studentId, studentName, studentEmail, title, reason, reasonDetail, dates, supervisorEmail, homeRoomEmail, supervisorName = '', homeRoomName = '' }) {
  const approveToken = genToken()
  const rejectToken  = genToken()

  // 生徒のLINE連携IDを事前に取得（ケースに保持）
  let studentLineUserId = ''
  try {
    const userSnap = await getDoc(doc(db, 'users', studentId))
    if (userSnap.exists()) {
      studentLineUserId = userSnap.data().lineUserId || ''
    }
  } catch (e) {
    console.warn('[createCase] lineUserId fetch failed:', e)
  }

  // Firestoreに保存
  const ref = await addDoc(collection(db, 'cases'), {
    studentId,
    studentName,
    studentEmail,
    studentLineUserId,
    title,
    reason,
    reasonDetail: reasonDetail || '',
    dates,                    // ["2025-06-14", "2025-06-15"]
    supervisorEmail,
    homeRoomEmail,
    supervisorName: supervisorName || '',
    homeRoomName: homeRoomName || '',
    status: 'pending_supervisor',
    approveToken,             // 顧問用承認トークン
    rejectToken,              // 顧問用差し戻しトークン
    homeRoomApproveToken: '', // 担任用（顧問承認後に生成）
    homeRoomRejectToken:  '',
    supervisorApprovedAt: null,
    homeRoomApprovedAt:   null,
    rejectedReason: '',
    rejectedBy: '',
    createdAt: serverTimestamp(),
  })

  // 顧問へ承認依頼メール送信
  const emailResult = await sendEmail('/send-approval', {
    caseId: ref.id,
    studentName, title, dates, reason, reasonDetail: reasonDetail || '',
    step: 'supervisor',
    recipientEmail: supervisorEmail,
    recipientRole: 'supervisor',
    approveToken,
    rejectToken,
    appBaseUrl: APP_BASE,
  })

  return {
    caseId: ref.id,
    emailSent: emailResult.ok,
    emailError: emailResult.detail,
    emailHint:  emailResult.hint,
  }
}

// =============================================
// トークンで承認・差し戻し処理
// =============================================
// =============================================
// トークンからcaseIdを検索（認証済みユーザー用）
// list権限が必要なため、ログイン中のみ使用可
// =============================================
export async function findCaseIdByToken(token) {
  const tokenFields = ['approveToken', 'rejectToken', 'homeRoomApproveToken', 'homeRoomRejectToken']
  for (const field of tokenFields) {
    const q = query(collection(db, 'cases'), where(field, '==', token))
    const snap = await getDocs(q)
    if (!snap.empty) return snap.docs[0].id
  }
  return null
}

// =============================================
// IDで単一ケース取得（承認画面用）
// =============================================
export async function getCaseById(caseId) {
  const docRef = doc(db, 'cases', caseId)
  const snap = await getDoc(docRef)
  if (!snap.exists()) return null
  return { id: snap.id, ...snap.data() }
}

// =============================================
// トークンで承認・差し戻し処理
// =============================================
export async function processToken(token, action, caseIdFromUrl = null) {
  // 顧問トークン or 担任トークンを検索
  const fields = [
    { field: 'approveToken',          step: 'supervisor', act: 'approve' },
    { field: 'rejectToken',           step: 'supervisor', act: 'reject'  },
    { field: 'homeRoomApproveToken',  step: 'homeroom',   act: 'approve' },
    { field: 'homeRoomRejectToken',   step: 'homeroom',   act: 'reject'  },
  ]

  let caseDoc, caseId, caseData, step, act

  if (caseIdFromUrl) {
    // caseIdがある場合は直接取得（get は認証不要）
    const docRef = doc(db, 'cases', caseIdFromUrl)
    const snap = await getDoc(docRef)
    if (!snap.exists()) return { ok: false, reason: 'token_not_found' }

    caseDoc = snap
    caseId = snap.id
    caseData = snap.data()

    const match = fields.find(f => caseData[f.field] === token)
    if (!match) return { ok: false, reason: 'token_not_found' }
    step = match.step
    act = match.act
  } else {
    // caseId がない場合 — リスト権限不要の方法でトークン照合は不可能
    // エラーメッセージで caseId 付きリンクの使用を促す
    return { ok: false, reason: 'token_not_found' }
  }

  if (!caseDoc) return { ok: false, reason: 'token_not_found' }

    // 既に使用済みトークン（ステータスが進んでいる）はエラー
    if (step === 'supervisor' && caseData.status !== 'pending_supervisor') {
      return { ok: false, reason: 'already_processed', caseId }
    }
    if (step === 'homeroom' && caseData.status !== 'pending_homeroom') {
      return { ok: false, reason: 'already_processed', caseId }
    }

    if (act === 'reject' && action === 'reject') {
      // 差し戻し
      await updateDoc(doc(db, 'cases', caseId), {
        status: 'rejected',
        rejectedBy: step,
        [`${step === 'supervisor' ? 'approveToken' : 'homeRoomApproveToken'}`]: '', // トークン無効化
        [`${step === 'supervisor' ? 'rejectToken'  : 'homeRoomRejectToken'}`]:  '',
        providedToken: token, // セキュリティルールでの検証用
      })
      return { ok: true, result: 'rejected', step, caseData }
    }

    if (act === 'approve' && action === 'approve') {
      if (step === 'supervisor') {
        // 顧問承認 → 担任への依頼へ進む
        const hrApproveToken = genToken()
        const hrRejectToken  = genToken()
        await updateDoc(doc(db, 'cases', caseId), {
          status: 'pending_homeroom',
          supervisorApprovedAt: serverTimestamp(),
          approveToken: '', // 使用済み無効化
          rejectToken:  '',
          homeRoomApproveToken: hrApproveToken,
          homeRoomRejectToken:  hrRejectToken,
          providedToken: token, // セキュリティルールでの検証用
        })
        // 担任へ承認依頼メール
        await sendEmail('/send-approval', {
          caseId,
          studentName: caseData.studentName,
          title: caseData.title,
          dates: caseData.dates,
          reason: caseData.reason,
          step: 'homeroom',
          recipientEmail: caseData.homeRoomEmail,
          recipientRole: 'homeroom',
          supervisorEmail: caseData.supervisorEmail,
          supervisorName: caseData.supervisorName || '',
          approveToken: hrApproveToken,
          rejectToken:  hrRejectToken,
          appBaseUrl: APP_BASE,
        })
        return { ok: true, result: 'supervisor_approved', caseData }

      } else {
        // 担任承認 → 完了
        await updateDoc(doc(db, 'cases', caseId), {
          status: 'approved',
          homeRoomApprovedAt: serverTimestamp(),
          homeRoomApproveToken: '',
          homeRoomRejectToken:  '',
          providedToken: token, // セキュリティルールでの検証用
        })
        // 生徒へ完了通知メール
        await sendEmail('/send-complete', {
          studentEmail: caseData.studentEmail,
          studentName:  caseData.studentName,
          title: caseData.title,
          dates: caseData.dates,
          appBaseUrl: APP_BASE,
        })
        // LINEプッシュ通知（担任承認完了時、Messaging API経由）
        if (await shouldNotifyLine(caseData.studentId)) {
        try {
          let lineUserId = caseData.studentLineUserId || caseData.lineUserId || ''
          if (!lineUserId) {
            try {
              const userSnap = await getDoc(doc(db, 'users', caseData.studentId))
              if (userSnap.exists()) {
                lineUserId = userSnap.data().lineUserId || ''
              }
            } catch (err) {
              console.warn('[line-notify] client getDoc user failed:', err)
            }
          }
          await sendEmail('/line/notify-complete', {
            lineUserId: lineUserId || undefined,
            studentId:  caseData.studentId,
            studentName: caseData.studentName,
            title: caseData.title,
            dates: caseData.dates,
            reason: caseData.reason,
            reasonDetail: caseData.reasonDetail || '',
            appBaseUrl: APP_BASE,
          })
        } catch (e) {
          console.warn('[line-notify] failed:', e)
        }
        }
        // PWAプッシュ通知（購読済み端末へ）
        await notifyApprovedPush(caseId, caseData)
        return { ok: true, result: 'approved', caseData }
      }
    }

  return { ok: false, reason: 'token_not_found' }
}

// =============================================
// ダッシュボード承認（先生がログイン状態で承認）
// =============================================
export async function approveByTeacher(caseId, step, teacherUid) {
  const caseRef  = doc(db, 'cases', caseId)
  const caseSnap = await getDoc(caseRef)
  if (!caseSnap.exists()) throw new Error('ケースが見つかりません')
  const caseData = caseSnap.data()

  if (step === 'supervisor') {
    const hrApproveToken = genToken()
    const hrRejectToken  = genToken()
    // 承認した顧問の氏名を取得（担任向けメール・履歴表示用。取得失敗時は申請時の保存名、なければ空文字でフォールバック）
    // 実際に承認操作した先生を優先し、取得できない場合のみ申請時の保存名を使う
    let supervisorName = ''
    try {
      if (teacherUid) {
        const teacherSnap = await getDoc(doc(db, 'users', teacherUid))
        if (teacherSnap.exists()) supervisorName = teacherSnap.data().name || ''
      }
    } catch (e) {
      console.warn('[approveByTeacher] teacher name fetch failed:', e)
    }
    if (!supervisorName) supervisorName = caseData.supervisorName || ''
    await updateDoc(caseRef, {
      status: 'pending_homeroom',
      supervisorApprovedAt: serverTimestamp(),
      supervisorUid: teacherUid,
      supervisorName,
      approveToken: '',
      rejectToken:  '',
      homeRoomApproveToken: hrApproveToken,
      homeRoomRejectToken:  hrRejectToken,
    })
    await sendEmail('/send-approval', {
      caseId,
      studentName: caseData.studentName,
      title: caseData.title,
      dates: caseData.dates,
      reason: caseData.reason,
      step: 'homeroom',
      recipientEmail: caseData.homeRoomEmail,
      recipientRole: 'homeroom',
      supervisorEmail: caseData.supervisorEmail,
      supervisorName,
      approveToken: hrApproveToken,
      rejectToken:  hrRejectToken,
      appBaseUrl: APP_BASE,
    })
  } else {
    await updateDoc(caseRef, {
      status: 'approved',
      homeRoomApprovedAt: serverTimestamp(),
      homeRoomUid: teacherUid,
      homeRoomApproveToken: '',
      homeRoomRejectToken:  '',
    })
    await sendEmail('/send-complete', {
      studentEmail: caseData.studentEmail,
      studentName:  caseData.studentName,
      title: caseData.title,
      dates: caseData.dates,
      appBaseUrl: APP_BASE,
    })
    // LINEプッシュ通知（ダッシュボード承認完了時も）
    if (await shouldNotifyLine(caseData.studentId)) {
    try {
      let lineUserId = caseData.studentLineUserId || caseData.lineUserId || ''
      if (!lineUserId) {
        try {
          const userSnap = await getDoc(doc(db, 'users', caseData.studentId))
          if (userSnap.exists()) {
            lineUserId = userSnap.data().lineUserId || ''
          }
        } catch (err) {
          console.warn('[line-notify] dashboard getDoc user failed:', err)
        }
      }
      await sendEmail('/line/notify-complete', {
        lineUserId: lineUserId || undefined,
        studentId:  caseData.studentId,
        studentName: caseData.studentName,
        title: caseData.title,
        dates: caseData.dates,
        reason: caseData.reason,
        reasonDetail: caseData.reasonDetail || '',
        appBaseUrl: APP_BASE,
      })
    } catch (e) {
      console.warn('[line-notify] dashboard approve failed:', e)
    }
    }
    // PWAプッシュ通知（購読済み端末へ）
    await notifyApprovedPush(caseId, caseData)
  }
}

export async function rejectByTeacher(caseId, step, reason, teacherUid) {
  await updateDoc(doc(db, 'cases', caseId), {
    status: 'rejected',
    rejectedBy: step,
    rejectedReason: reason || '',
    rejectedByUid: teacherUid,
  })
}

// =============================================
// ケース削除（生徒がマイページから取り下げ）
// 顧問承認前（pending_supervisor）のみ許可
// =============================================
export async function deleteCaseByStudent(caseId, studentId) {
  const caseRef  = doc(db, 'cases', caseId)
  const caseSnap = await getDoc(caseRef)
  if (!caseSnap.exists()) throw new Error('申請が見つかりません')

  const caseData = caseSnap.data()
  if (caseData.studentId !== studentId) {
    throw new Error('この申請を削除する権限がありません')
  }
  if (caseData.status !== 'pending_supervisor') {
    throw new Error('顧問承認後の申請は取り下げできません')
  }

  try {
    await deleteDoc(caseRef)
  } catch (e) {
    throw new Error(friendlyError(e))
  }
}

// =============================================
// ケース削除（管理者用 — ステータス制限なし）
// =============================================
export async function deleteCaseByAdmin(caseId) {
  const caseRef = doc(db, 'cases', caseId)
  const caseSnap = await getDoc(caseRef)
  if (!caseSnap.exists()) throw new Error('ケースが見つかりません')
  try {
    await deleteDoc(caseRef)
  } catch (e) {
    throw new Error(friendlyError(e))
  }
}

// =============================================
// 生徒の自分のケース一覧取得
// =============================================
export async function getMyCases(studentId) {
  const q = query(
    collection(db, 'cases'),
    where('studentId', '==', studentId),
    orderBy('createdAt', 'desc')
  )
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

// =============================================
// 先生の担当ケース一覧（自分のメール宛）
// =============================================
export async function getTeacherCases(teacherEmail) {
  // composite index 不要: where のみでクエリし、JS側でソート
  // （orderBy + where の組み合わせは Firestore composite index が必要なため）
  const [asSupervisor, asHomeRoom] = await Promise.all([
    getDocs(query(collection(db, 'cases'), where('supervisorEmail', '==', teacherEmail))),
    getDocs(query(collection(db, 'cases'), where('homeRoomEmail',   '==', teacherEmail))),
  ])
  const map = new Map()
  ;[...asSupervisor.docs, ...asHomeRoom.docs].forEach(d => map.set(d.id, { id: d.id, ...d.data() }))
  return [...map.values()].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
}

// =============================================
// 管理者：全ケース取得
// =============================================
export async function getAllCases() {
  const snap = await getDocs(query(collection(db, 'cases'), orderBy('createdAt', 'desc')))
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}
