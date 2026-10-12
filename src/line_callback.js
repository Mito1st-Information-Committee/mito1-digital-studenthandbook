/**
 * src/line_callback.js
 * LINE Login チャネルのコールバック処理
 *
 * どのブラウザ/タブ/アプリで開かれてもよい（PWA/別タブ分断対応）:
 *   - ログイン不要（Firebase Auth を待たない）
 *   - sessionStorage 不要（state 照合はしない）
 *   - やることは「LINE の userId を取得して lineLinkSessions/{state} に
 *     status:'done' とプロフィールを書き込む」だけ。
 *   users/{uid} への保存（連携確定）は元のタブ/PWA側が行うため、
 *   ここでユーザーを特定する必要がない。
 *
 * 流れ:
 *   1. クエリの error / code & state を確認
 *   2. Workers /line/exchange に code を渡して LINE の userId を取得
 *   3. lineLinkSessions/{state} を done に更新
 *   4. 完了表示してウィンドウを閉じる
 */
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore'
import { db } from './firebase.js'
import { exchangeCodeForProfile } from './line.js'

const card = document.getElementById('card')

const LINE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M24 10.3C24 5 18.6.7 12 .7S0 5 0 10.3c0 4.8 4.3 8.8 10 9.5.4.1.9.3 1.1.6.1.3.1.7.1 1l-.2 1.1c0 .3-.2 1.2 1.1.7 1.3-.6 7.2-4.2 9.7-7.2 1.7-1.9 2.2-3.8 2.2-5.7z"/></svg>`

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderError(title, detail, showRetry = true) {
  card.innerHTML = `
    <div class="line-mark" style="background:var(--enjii)">${LINE_ICON}</div>
    <div class="ttl">${esc(title)}</div>
    <div class="err">${detail}</div>
    ${showRetry ? `<a class="btn btn-primary" href="/#mypage">マイページへ戻る</a>` : ''}
    <a class="btn btn-ghost" href="/">ホームへ</a>
  `
}

function renderDone() {
  card.innerHTML = `
    <div class="line-mark">${LINE_ICON}</div>
    <div class="badge-ok">✓ 連携完了</div>
    <div class="ttl">LINE連携が完了しました</div>
    <div class="sub">
      この画面は閉じてかまいません。<br>
      生徒手帳アプリの画面で連携完了の確認ができます。
    </div>
  `
}

/**
 * 再読み込み（リトライ）等で「すでに処理済み」と判別できるケースを扱う。
 * - Firestore の権限エラー: セッションが consumed/cancelled 済み
 * - LINE 側 invalid_grant: 認可コードが使い回し
 */
function renderAlreadyProcessed() {
  card.innerHTML = `
    <div class="line-mark">${LINE_ICON}</div>
    <div class="badge-ok">✓ 連携済み</div>
    <div class="ttl">この連携はすでに処理されています</div>
    <div class="sub">
      アプリの画面に戻って、マイページの連携状況を確認してください。<br>
      この画面は閉じてかまいません。
    </div>
  `
}

function isAlreadyProcessedError(e) {
  const code = e?.code || ''
  const msg  = String(e?.message || '')
  return code === 'permission-denied'
    || /permission|denied/i.test(msg)
    || /invalid_grant|already used|使われ/i.test(msg)
}

async function main() {
  const params = new URLSearchParams(location.search)
  const error  = params.get('error')
  const code   = params.get('code')
  const state  = params.get('state')

  // --- ユーザーが認可をキャンセルした / LINE 側エラー ---
  if (error) {
    const desc = params.get('error_description') || ''
    if (error === 'ACCESS_DENIED') {
      renderError('LINE連携をキャンセルしました',
        'LINEの同意画面でキャンセルされました。<br>連携する場合はマイページからもう一度お試しください。')
    } else {
      renderError('LINE連携に失敗しました',
        `エラーコード: ${esc(error)}<br>${esc(desc)}`)
    }
    return
  }

  if (!code || !state) {
    renderError('リンクが無効です',
      '認可コードが見つかりません。マイページの連携バナーから改めてお試しください。')
    return
  }

  // --- 認可コード → アクセストークン → LINEプロフィール（Workers 経由） ---
  // ログイン不要。state はセッションdocのIDとして使うだけ（capability方式）。
  try {
    const profile = await exchangeCodeForProfile(code)
    await updateDoc(doc(db, 'lineLinkSessions', state), {
      status:      'done',
      lineUserId:  profile.userId,
      displayName: profile.displayName || '',
      pictureUrl:  profile.pictureUrl  || '',
      completedAt: serverTimestamp(),
    })
    // 認可コードを URL から消す（再読み込みでの二重使用を防ぐ）
    history.replaceState(null, '', location.pathname)
    renderDone()
    // ウィンドウを閉じられる（popup等）なら閉じる。閉じられない場合は手動でOK。
    try { setTimeout(() => window.close(), 1500) } catch { /* noop */ }
  } catch (e) {
    console.error('[line_callback] failed:', e)
    if (isAlreadyProcessedError(e)) {
      renderAlreadyProcessed()
    } else {
      renderError('LINE連携に失敗しました', esc(e?.message || String(e)))
    }
  }
}

main()