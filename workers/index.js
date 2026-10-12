/**
 * mito1-hundbook Cloudflare Workers (ES Module)
 *
 * wrangler.toml or Cloudflare Dashboard:
 *   "Module Worker" -> "Module: ES Modules"
 *
 * Secrets (Settings > Variables and Secrets):
 *   GEMINI_API_KEY  -- Gemini API key (Secret)
 *   GEMINI_MODEL    -- 使用するモデル名（Plain text / 任意・カンマ区切りで優先順に複数可）
 *                      未設定なら GEMINI_MODEL_CANDIDATES を上から順に自動フォールバック。
 *                      GET /ai/diag でこのキーが使えるモデル一覧を確認できる。
 *   RESEND_API_KEY  -- Resend API key (Secret)
 *   APP_BASE_URL    -- https://mito1-tetyo.tech (Plain text)
 *   RESEND_FROM     -- Verified sender (Plain text, e.g. "mito1-handbook <noreply@yourdomain.com>")
 *                      If not set, falls back to "mito1-handbook <onboarding@resend.dev>"
 *                      NOTE: onboarding@resend.dev can ONLY deliver to the Resend account owner's email.
 *                      To send to any recipient, you MUST verify your own domain in the Resend dashboard
 *                      and set this variable to an address on that domain.
 *   FIREBASE_PROJECT_ID -- Firebase project ID (Plain text, e.g. "mito1-digital-handbook")
 *   FIREBASE_API_KEY    -- Firebase Web API Key (Plain text, for Firestore REST API)
 *
 * LINE Login channel (account linking):
 *   LINE_client_id     -- LINE Login channel ID     (Secret)
 *   LINE_client_secret -- LINE Login channel secret (Secret)
 *
 * LINE Messaging API channel (push notifications):
 *   LINE_Channel_ID     -- Messaging API channel ID     (Secret)
 *   LINE_Channel_secret -- Messaging API channel secret (Secret)
 *
 * Web Push (PWA push notifications):
 *   VAPID_PUBLIC_KEY  -- VAPID public key, base64url (Secret or Plain text)
 *   VAPID_PRIVATE_KEY -- VAPID private key, base64url (Secret)
 *   VAPID_SUBJECT     -- contact, e.g. "mailto:noreply@mito1-tetyo.tech" (Plain text)
 *   Key generation (run once locally, never commit the private key):
 *     node -e "const c=require('crypto');const e=c.createECDH('prime256v1');e.generateKeys();const b=(x)=>Buffer.from(x).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');console.log('PUBLIC:'+b(e.getPublicKey()));console.log('PRIVATE:'+b(e.getPrivateKey()))"
 *   Registration:
 *     npx wrangler secret put VAPID_PRIVATE_KEY --config workers/wrangler.toml
 *     npx wrangler secret put VAPID_PUBLIC_KEY  --config workers/wrangler.toml
 *
 * =====================================================================
 * LINE Developers Console — LINE Login チャネルに登録するコールバックURL
 * =====================================================================
 *   https://mito1-tetyo.tech/line-callback.html
 *   （ローカル開発用に追加する場合）
 *   http://localhost:5173/line-callback.html
 *
 * 認可リクエストは Workers の GET /line/authorize が組み立てて
 * https://access.line.me/oauth2/v2.1/authorize へ 302 リダイレクトする。
 * （client_id を露出させないため、フロントは Workers を経由する）
 */

// LINE endpoints
const LINE_AUTHORIZE_URL = 'https://access.line.me/oauth2/v2.1/authorize'
const LINE_TOKEN_URL     = 'https://api.line.me/oauth2/v2.1/token'
const LINE_PROFILE_URL   = 'https://api.line.me/v2/profile'
// Messaging API
const LINE_STATELESS_TOKEN_URL = 'https://api.line.me/oauth2/v3/token'
const LINE_PUSH_URL            = 'https://api.line.me/v2/bot/message/push'

// LINE Login のコールバックURLとして許可するオリジン（オープンリダイレクト対策）
const ALLOWED_REDIRECT_ORIGINS = [
  'https://mito1-tetyo.tech',
  'https://www.mito1-tetyo.tech',
  'https://ryuto-dev.github.io',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
]

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
}

export default {
  // Cron Trigger（wrangler.toml [triggers]）→ GitHubへdispatch。
  // GitHubのscheduleが発火しない場合の迂回路（10分おき）。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(githubDispatch(env))
  },
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS })
    }

    const url = new URL(request.url)

    // 時間割API（外部提供・Key制限・imgタグ対応）— GET のみ
    //   GET /api/v1/timetable/list?key=...  → 直近7件の一覧JSON（画像URLはAPI相対パスのみ）
    //   GET /api/v1/timetable/image?date=YYYY-MM-DD&slot=0&key=... → 画像バイナリ（<img src>に直接指定可）
    if (request.method === 'GET' && url.pathname === '/api/v1/timetable/list') {
      return timetableListApi(request, url, env, ctx)
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/timetable/image') {
      return timetableImageApi(request, url, env, ctx)
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/timetable/diag') {
      return timetableDiagApi(request, url, env)
    }

    // GET /approve -> redirect to approve.html
    if (request.method === 'GET' && url.pathname === '/approve') {
      const caseId = url.searchParams.get('caseId')
      const token  = url.searchParams.get('token')
      const action = url.searchParams.get('action') || 'approve'
      const base   = env.APP_BASE_URL || 'https://mito1-tetyo.tech'
      if (!token) return new Response('Token is invalid', { status: 400 })

      let redirectUrl = `${base}/approve.html?token=${encodeURIComponent(token)}&action=${action}`
      if (caseId) redirectUrl += `&caseId=${encodeURIComponent(caseId)}`

      return Response.redirect(redirectUrl, 302)
    }

    // GET /resolve-token?token=xxx -> resolve token to caseId via Firestore REST API
    if (request.method === 'GET' && url.pathname === '/resolve-token') {
      return resolveToken(url.searchParams.get('token'), env)
    }

    // GET /line/authorize -> redirect to the LINE authorization endpoint
    if (request.method === 'GET' && url.pathname === '/line/authorize') {
      return lineAuthorize(url, env)
    }

    // GET /ai/diag -> Gemini の疎通診断（キーの有無・利用可能モデル一覧）
    if (request.method === 'GET' && url.pathname === '/ai/diag') {
      return geminiDiag(env)
    }

    // GET /mail/diag -> メール設定の疎通診断
    //   ?to=<アドレス> を付けると実際にテスト送信する。
    //   「メールが送れない」と言われたら、まずここを開けば原因が分かる。
    if (request.method === 'GET' && url.pathname === '/mail/diag') {
      return mailDiag(url, env)
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405)
    }

    // LINE Webhook は署名検証に生ボディが必要なため、JSONパースより先に処理する
    // （パース→再シリアライズでは署名が一致しなくなる）
    if (url.pathname === '/line/webhook') return lineWebhook(request, env)

    let body
    try { body = await request.json() }
    catch { return json({ error: 'Invalid JSON' }, 400) }

    if (url.pathname === '/send-approval') return sendApproval(body, env)
    if (url.pathname === '/send-complete')  return sendComplete(body, env)
    if (url.pathname === '/send-reply')     return sendReply(body, env)
    if (url.pathname === '/send-custom')    return sendCustom(body, env)

    // LINE account linking / notifications
    if (url.pathname === '/line/exchange')  return lineExchange(body, env)
    if (url.pathname === '/line/notify-complete') return lineNotifyComplete(body, env)

    // Web Push (PWA push notifications)
    if (url.pathname === '/push/send') return pushSend(body, env)

    // Default -> Gemini proxy
    return gemini(body, env)
  }
}

// -- Resolve token to caseId via Firestore REST API -------------------------
async function resolveToken(token, env) {
  if (!token) return json({ error: 'token required' }, 400)

  const projectId = env.FIREBASE_PROJECT_ID
  if (!projectId) {
    return json({ error: 'FIREBASE_PROJECT_ID not set' }, 500)
  }

  const tokenFields = ['approveToken', 'rejectToken', 'homeRoomApproveToken', 'homeRoomRejectToken']

  for (const field of tokenFields) {
    try {
      const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`
      const queryBody = {
        structuredQuery: {
          from: [{ collectionId: 'cases' }],
          where: {
            fieldFilter: {
              field: { fieldPath: field },
              op: 'EQUAL',
              value: { stringValue: token }
            }
          },
          limit: 1
        }
      }

      const res = await firestoreFetch(env, firestoreUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(queryBody)
      })

      if (res.ok) {
        const results = await res.json()
        if (results && results.length > 0 && results[0].document) {
          // Extract document ID from the name path
          const docName = results[0].document.name
          const caseId = docName.split('/').pop()
          return json({ caseId, field })
        }
      }
    } catch (e) {
      console.error(`[resolve-token] Error querying field ${field}:`, e)
    }
  }

  return json({ error: 'token not found' }, 404)
}

// -- Gemini proxy -------------------------------------------------------
/**
 * 404 の主因は「モデル名の綴り」ではなく、
 *   ① API キーを作り直した Google Cloud プロジェクトで
 *      そのモデルが有効化されていない／"no longer available to new users" 扱いになる
 *   ② コードを直しても Worker を再デプロイしていないため旧モデル名が生きている
 * の2点。そこで
 *   - 候補モデルを順に試し、404/NOT_FOUND なら次の候補へフォールバック
 *   - 成功したモデル名を isolate 内にキャッシュして以降の待ち時間をゼロにする
 *   - どれも駄目なら ListModels の結果を添えて返す（原因が一目で分かる）
 * という実装にする。
 */
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// 上から順に試す。env.GEMINI_MODEL があればそれが最優先。
const GEMINI_MODEL_CANDIDATES = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-2.5-flash',
]

// isolate 単位のキャッシュ（この Worker インスタンスで確実に動いたモデル名）
let _resolvedGeminiModel = null

function geminiApiKey(env) {
  // Support both GEMINI_KEY and GEMINI_API_KEY for backwards compatibility
  return env.GEMINI_API_KEY || env.GEMINI_KEY || env.GOOGLE_API_KEY || ''
}

function geminiModelCandidates(env) {
  const configured = (env.GEMINI_MODEL || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const list = [
    ...(_resolvedGeminiModel ? [_resolvedGeminiModel] : []),
    ...configured,
    ...GEMINI_MODEL_CANDIDATES,
  ]
  // 重複排除（順序維持）
  return [...new Set(list)]
}

/** そのエラーが「モデルが使えない」系かどうか */
function isModelUnavailable(status, data) {
  if (status === 404) return true
  const msg = String(data?.error?.message || '')
  if (status === 400 && /not (found|supported)|is not available|no longer available/i.test(msg)) return true
  if (status === 403 && /not (supported|available)|does not have access/i.test(msg)) return true
  return false
}

async function callGeminiModel(model, body, apiKey) {
  const res = await fetch(
    `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  )
  let data
  try { data = await res.json() }
  catch { data = { error: { code: res.status, message: 'Invalid JSON from Gemini API' } } }
  return { status: res.status, data }
}

/** API キーで実際に generateContent が使えるモデル一覧を取得（診断用） */
async function listGeminiModels(apiKey) {
  try {
    const res = await fetch(`${GEMINI_API_BASE}/models?key=${apiKey}&pageSize=200`)
    if (!res.ok) {
      return { ok: false, status: res.status, error: (await res.text()).slice(0, 500) }
    }
    const data = await res.json()
    const models = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
    return { ok: true, models }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  }
}

async function gemini(body, env) {
  const apiKey = geminiApiKey(env)
  if (!apiKey) {
    return json({ error: { code: 500, message: 'GEMINI_API_KEY not set in Workers secrets' } }, 500)
  }

  const candidates = geminiModelCandidates(env)
  const attempts = []

  for (const model of candidates) {
    const { status, data } = await callGeminiModel(model, body, apiKey)

    if (status >= 200 && status < 300) {
      _resolvedGeminiModel = model            // 次回以降はこのモデルを最優先
      return json(data, status)
    }

    attempts.push({ model, status, message: String(data?.error?.message || '').slice(0, 200) })

    if (isModelUnavailable(status, data)) {
      if (_resolvedGeminiModel === model) _resolvedGeminiModel = null
      console.warn(`[gemini] model "${model}" unavailable (${status}) -> try next`)
      continue                                 // 次の候補モデルへ
    }

    // モデル以外の理由（キー無効・レート制限・入力不正など）はそのまま返す
    console.error(`[gemini] non-model error on "${model}" (${status})`, data?.error)
    return json(data, status)
  }

  // すべての候補が駄目 → このキーで本当に使えるモデルを添えて返す
  const available = await listGeminiModels(apiKey)
  console.error('[gemini] all candidates failed', JSON.stringify({ attempts, available }).slice(0, 800))

  return json({
    error: {
      code: 502,
      status: 'MODEL_UNAVAILABLE',
      message:
        'このGemini APIキーでは候補モデルがいずれも利用できませんでした。' +
        'Google AI Studio で新しいキーを発行したプロジェクトの有効モデルを確認し、' +
        'Workers の環境変数 GEMINI_MODEL に設定してください。',
      attempts,
      availableModels: available.ok ? available.models.slice(0, 40) : undefined,
      listModelsError: available.ok ? undefined : available,
    },
  }, 502)
}

/**
 * GET /ai/diag
 *   キーの有無・候補モデル・実際に使えるモデル一覧を返す診断用エンドポイント。
 *   API キーそのものは絶対に返さない（長さと先頭数文字のみ）。
 */
async function geminiDiag(env) {
  const apiKey = geminiApiKey(env)
  if (!apiKey) {
    return json({ ok: false, hasKey: false, message: 'GEMINI_API_KEY not set in Workers secrets' }, 500)
  }

  const available = await listGeminiModels(apiKey)
  const candidates = geminiModelCandidates(env)
  const usable = available.ok ? candidates.filter(m => available.models.includes(m)) : []

  return json({
    ok: available.ok && usable.length > 0,
    hasKey: true,
    keyPreview: `${apiKey.slice(0, 6)}...(${apiKey.length} chars)`,
    configuredModel: env.GEMINI_MODEL || null,
    cachedModel: _resolvedGeminiModel,
    candidates,
    usableCandidates: usable,
    availableModels: available.ok ? available.models : undefined,
    listModelsError: available.ok ? undefined : available,
  }, available.ok ? 200 : 502)
}

// -- Approval request email ---------------------------------------------
async function sendApproval(body, env) {
  const {
    studentName, title, dates, reason, reasonDetail,
    step, recipientEmail, recipientRole,
    supervisorEmail, supervisorName, approveToken, rejectToken, appBaseUrl,
  } = body

  // Validate required fields
  if (!recipientEmail) {
    return json({ error: 'recipientEmail is required' }, 400)
  }

  const base     = appBaseUrl || env.APP_BASE_URL || 'https://mito1-tetyo.tech'
  const datesStr = (dates || []).join(', ')
  const roleName = recipientRole === 'supervisor' ? '顧問' : '担任'
  const reasonDisplay = reasonDetail ? `${reason}（${reasonDetail}）` : (reason || '部活動')
  // Always include caseId in approve/reject URLs
  const approveUrl = `${base}/approve.html?caseId=${body.caseId}&token=${approveToken}&action=approve`
  const rejectUrl  = `${base}/approve.html?caseId=${body.caseId}&token=${rejectToken}&action=reject`
  // Issue #61: 担任向けメールでは顧問の氏名も表示（登録がある場合）。未登録時はメールのみ
  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const supLabel = (supervisorName || '').trim()
    ? `${escH(supervisorName)}先生（${escH(supervisorEmail)}）`
    : escH(supervisorEmail)
  const supNote    = step === 'homeroom'
    ? `<p style="color:#27ae60;background:#eafaf1;padding:10px 14px;border-radius:6px;font-size:13px;margin:12px 0">顧問（${supLabel}）が承認済みです。</p>`
    : ''

  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:'Helvetica Neue',Arial,'Noto Sans JP',sans-serif;background:#f5f5f5;padding:24px;margin:0">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
  <div style="background:#1a2744;padding:20px 28px;display:flex;align-items:center;gap:14px">
    <img src="${base}/icons/icon-192.png" alt="" style="width:40px;height:40px;border-radius:8px" />
    <div><div style="color:#fff;font-size:18px;font-weight:700">水戸第一高等学校</div><div style="color:#a0b0cc;font-size:12px;margin-top:2px">デジタル生徒手帳 公欠申請システム</div></div>
  </div>
  <div style="padding:28px">
    <p style="color:#333;font-size:15px;margin:0 0 16px">${roleName}の先生<br><br>以下の公欠申請の承認をお願いいたします。</p>
    ${supNote}
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0">
      <tr style="background:#f8f9fa"><td style="padding:10px 14px;border:1px solid #e0e0e0;font-weight:600;width:30%">申請者</td><td style="padding:10px 14px;border:1px solid #e0e0e0">${studentName}</td></tr>
      <tr><td style="padding:10px 14px;border:1px solid #e0e0e0;font-weight:600">件名</td><td style="padding:10px 14px;border:1px solid #e0e0e0">${title}</td></tr>
      <tr style="background:#f8f9fa"><td style="padding:10px 14px;border:1px solid #e0e0e0;font-weight:600">事由</td><td style="padding:10px 14px;border:1px solid #e0e0e0">${reasonDisplay}</td></tr>
      <tr><td style="padding:10px 14px;border:1px solid #e0e0e0;font-weight:600">公欠日</td><td style="padding:10px 14px;border:1px solid #e0e0e0">${datesStr}</td></tr>
    </table>
    <div style="display:flex;gap:12px;margin-top:24px">
      <a href="${approveUrl}" style="flex:1;display:block;text-align:center;background:#1a2744;color:#fff;padding:14px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700">承認する</a>
      <a href="${rejectUrl}" style="flex:1;display:block;text-align:center;background:#fff;color:#e74c3c;border:1.5px solid #e74c3c;padding:14px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700">差し戻す</a>
    </div>
    <p style="font-size:11px;color:#999;margin-top:20px">このリンクの有効期限は7日間です。<a href="${base}/teacher.html" style="color:#1a2744">先生用ダッシュボード</a>からも操作できます。</p>
  </div>
</div></body></html>`

  const r = await sendMail(env, { to: recipientEmail, subject: `【公欠申請】${studentName} - ${title}（${datesStr}）`, html })
  if (!r.ok) {
    console.error('[send-approval] mail failed:', r.status, r.detail)
    return json({ error: 'Email send failed', detail: r.detail, hint: r.hint, status: r.status }, 500)
  }
  return json({ ok: true })
}

// -- Completion notification email --------------------------------------
async function sendComplete(body, env) {
  const { studentEmail, studentName, title, dates, appBaseUrl } = body

  if (!studentEmail) {
    return json({ error: 'studentEmail is required' }, 400)
  }

  const base     = appBaseUrl || env.APP_BASE_URL || ''
  const datesStr = (dates || []).join(', ')

  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:'Helvetica Neue',Arial,'Noto Sans JP',sans-serif;background:#f5f5f5;padding:24px;margin:0">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
  <div style="background:#1a2744;padding:20px 28px;display:flex;align-items:center;gap:14px">
    <img src="${base}/icons/icon-192.png" alt="" style="width:40px;height:40px;border-radius:8px" />
    <div><div style="color:#fff;font-size:18px;font-weight:700">水戸第一高等学校</div><div style="color:#a0b0cc;font-size:12px;margin-top:2px">デジタル生徒手帳 公欠申請システム</div></div>
  </div>
  <div style="padding:28px;text-align:center">
    <div style="font-size:48px;margin-bottom:12px">&#10004;</div>
    <div style="font-size:18px;font-weight:700;color:#1a2744;margin-bottom:8px">公欠申請が承認されました</div>
    <p style="color:#333;font-size:14px;margin-bottom:16px">${studentName} さんの公欠申請が顧問・担任の両方に承認されました。</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;text-align:left">
      <tr style="background:#f8f9fa"><td style="padding:10px 14px;border:1px solid #e0e0e0;font-weight:600;width:30%">件名</td><td style="padding:10px 14px;border:1px solid #e0e0e0">${title}</td></tr>
      <tr><td style="padding:10px 14px;border:1px solid #e0e0e0;font-weight:600">公欠日</td><td style="padding:10px 14px;border:1px solid #e0e0e0">${datesStr}</td></tr>
    </table>
    <a href="${base}/#mypage" style="display:inline-block;background:#1a2744;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700;margin-top:8px">手帳を開く（マイページ）</a>
  </div>
</div></body></html>`

  const r = await sendMail(env, { to: studentEmail, subject: `【承認完了】公欠申請「${title}」（${datesStr}）`, html })
  if (!r.ok) {
    console.error('[send-complete] mail failed:', r.status, r.detail)
    return json({ error: 'Email send failed', detail: r.detail, hint: r.hint, status: r.status }, 500)
  }
  return json({ ok: true })
}

// -- Inquiry reply email ------------------------------------------------
async function sendReply(body, env) {
  const { recipientEmail, recipientName, subject, replyBody, appBaseUrl } = body

  if (!recipientEmail) {
    return json({ error: 'recipientEmail is required' }, 400)
  }
  if (!replyBody) {
    return json({ error: 'replyBody is required' }, 400)
  }

  const base = appBaseUrl || env.APP_BASE_URL || ''
  const replyText = (replyBody || '').replace(/\n/g, '<br>')
  const iconUrl = base ? `${base}/icons/icon-192.png` : ''

  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:'Helvetica Neue',Arial,'Noto Sans JP',sans-serif;background:#f5f5f5;padding:24px;margin:0">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
  <div style="background:#1a2744;padding:20px 28px;display:flex;align-items:center;gap:14px">
    ${iconUrl ? `<img src="${iconUrl}" alt="" style="width:40px;height:40px;border-radius:8px" />` : ''}
    <div><div style="color:#fff;font-size:18px;font-weight:700">水戸第一高等学校</div><div style="color:#a0b0cc;font-size:12px;margin-top:2px">デジタル生徒手帳 お問い合わせ回答</div></div>
  </div>
  <div style="padding:28px">
    <p style="color:#333;font-size:15px;margin:0 0 16px">${recipientName || ''} 様<br><br>お問い合わせいただきありがとうございます。<br>以下の通り回答いたします。</p>
    <div style="background:#f8f9fa;border-radius:8px;padding:16px 18px;margin:16px 0;font-size:14px;color:#333;line-height:1.8;border-left:4px solid #1a2744">
      ${replyText}
    </div>
    <p style="font-size:12px;color:#999;margin-top:20px">このメールはデジタル生徒手帳のお問い合わせシステムから自動送信されています。<br>ご不明な点がございましたら、再度お問い合わせフォームよりご連絡ください。</p>
    <a href="${base}" style="display:inline-block;background:#1a2744;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;margin-top:8px">デジタル生徒手帳を開く</a>
  </div>
</div></body></html>`

  const r = await sendMail(env, { to: recipientEmail, subject: `【回答】${subject || 'お問い合わせ'}`, html })
  if (!r.ok) {
    console.error('[send-reply] mail failed:', r.status, r.detail)
    return json({ error: 'Email send failed', detail: r.detail, hint: r.hint, status: r.status }, 500)
  }
  return json({ ok: true })
}

// -- Custom bulk-capable email (admin "メール送信") --------------------------
// お問い合わせ返信と同じ手帳デザインで、任意の件名・本文を送る。
// 差込印刷: subject / title / badge / bodyText / buttonLabel / buttonUrl 内の
//   {{変数名}} を vars の値で置換する（例: {{お名前}}）。
// 一斉送信はフロントが宛先ごとに本エンドポイントを1通ずつ呼ぶ
// （Workers の30秒タイムアウトを避けるため。Resend 側のレート制限にもかかりにくい）。
function applyMergeVars(template, vars) {
  const map = (vars && typeof vars === 'object') ? vars : {}
  return String(template ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, key) => {
    const k = String(key).trim()
    if (Object.prototype.hasOwnProperty.call(map, k)) return String(map[k] ?? '')
    return m
  })
}

function escMailHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function mailBodyToHtml(text) {
  const esc = escMailHtml(text).replace(/\n/g, '<br>')
  return esc.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" style="color:#1a2744">$1</a>')
}

function buildHandbookMail({ badge, title, greetingHtml, bodyHtml, buttonLabel, buttonUrl, footerNote, base, subtitle }) {
  const iconUrl = base ? `${base}/icons/icon-192.png` : ''
  const btn = (buttonLabel && buttonUrl)
    ? `<div style="text-align:center;margin:20px 0 6px"><a href="${escMailHtml(buttonUrl)}" style="display:inline-block;background:#1a2744;color:#fff;padding:13px 30px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700">${escMailHtml(buttonLabel)}</a></div>
       <div style="font-size:11px;color:#999;text-align:center;margin-bottom:6px;word-break:break-all">ボタンが開けない場合はURLをコピーしてください:<br>${escMailHtml(buttonUrl)}</div>`
    : ''
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:'Helvetica Neue',Arial,'Noto Sans JP',sans-serif;background:#f5f5f5;padding:24px;margin:0">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
  <div style="background:#1a2744;padding:20px 28px;display:flex;align-items:center;gap:14px">
    ${iconUrl ? `<img src="${escMailHtml(iconUrl)}" alt="" style="width:40px;height:40px;border-radius:8px" />` : ''}
    <div><div style="color:#fff;font-size:18px;font-weight:700">水戸第一高等学校</div><div style="color:#a0b0cc;font-size:12px;margin-top:2px">${escMailHtml(subtitle || 'デジタル生徒手帳')}</div></div>
  </div>
  <div style="padding:28px">
    ${badge ? `<div style="margin-bottom:12px"><span style="display:inline-block;font-size:12px;font-weight:600;color:#1a2744;background:rgba(26,39,68,.07);border:1px solid #e0e0e0;border-radius:999px;padding:4px 12px">${escMailHtml(badge)}</span></div>` : ''}
    ${title ? `<div style="font-size:18px;font-weight:700;color:#1a2744;margin:0 0 14px">${escMailHtml(title)}</div>` : ''}
    ${greetingHtml ? `<p style="color:#333;font-size:15px;margin:0 0 14px">${greetingHtml}</p>` : ''}
    <div style="background:#f8f9fa;border-radius:8px;padding:16px 18px;margin:0 0 8px;font-size:14px;color:#333;line-height:1.9;border-left:4px solid #1a2744">
      ${bodyHtml}
    </div>
    ${btn}
    <p style="font-size:12px;color:#999;margin-top:18px">${escMailHtml(footerNote || 'このメールはデジタル生徒手帳から送信されています。心当たりがない場合は破棄してください。')}</p>
    <a href="${escMailHtml(base || 'https://mito1-tetyo.tech')}" style="display:inline-block;background:#1a2744;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;margin-top:8px">デジタル生徒手帳を開く</a>
  </div>
</div></body></html>`
}

async function sendCustom(body, env) {
  const { to, subject, title, badge, greetingName, bodyText, buttonLabel, buttonUrl, footerNote, vars, appBaseUrl } = body || {}

  if (!to || !String(to).includes('@')) {
    return json({ error: 'to is required' }, 400)
  }
  if (!subject || !String(subject).trim()) {
    return json({ error: 'subject is required' }, 400)
  }
  if (!bodyText || !String(bodyText).trim()) {
    return json({ error: 'bodyText is required' }, 400)
  }
  if (buttonUrl && !/^https?:\/\//.test(String(buttonUrl).trim()) && /\{\{/.test(String(buttonUrl))) {
    // 差込前のプレースホルダーは許可（vars 適用後に再検査する）
  } else if (buttonUrl && !/^https?:\/\//.test(String(applyMergeVars(buttonUrl, vars)).trim())) {
    return json({ error: 'buttonUrl must start with http(s)://' }, 400)
  }

  const base = appBaseUrl || env.APP_BASE_URL || 'https://mito1-tetyo.tech'
  const mergedSubject = applyMergeVars(subject, vars)
  const mergedBody    = applyMergeVars(bodyText, vars)
  const mergedTitle   = applyMergeVars(title || '', vars)
  const mergedBadge   = applyMergeVars(badge || '', vars)
  const mergedBtnLbl  = applyMergeVars(buttonLabel || '', vars)
  const mergedBtnUrl  = applyMergeVars(buttonUrl || '', vars).trim()
  const name          = applyMergeVars(greetingName || '', vars).trim()

  const greetingHtml = name ? `${escMailHtml(name)} 様<br><br>お世話になっております。` : ''
  const html = buildHandbookMail({
    badge: mergedBadge, title: mergedTitle, greetingHtml,
    bodyHtml: mailBodyToHtml(mergedBody),
    buttonLabel: mergedBtnLbl, buttonUrl: mergedBtnUrl,
    footerNote: applyMergeVars(footerNote || '', vars),
    base, subtitle: 'デジタル生徒手帳',
  })

  const r = await sendMail(env, { to: String(to).trim(), subject: mergedSubject, html })
  if (!r.ok) {
    console.error('[send-custom] mail failed:', r.status, r.detail)
    return json({ error: 'Email send failed', detail: r.detail, hint: r.hint, status: r.status }, 500)
  }
  return json({ ok: true })
}

// =======================================================================
// LINE アカウント連携（LINE Login チャネル・認可コードフロー）
// =======================================================================

function isAllowedRedirect(redirectUri) {
  try {
    const u = new URL(redirectUri)
    if (!ALLOWED_REDIRECT_ORIGINS.includes(u.origin)) return false
    // コールバックページ以外へは飛ばさない
    return u.pathname === '/line-callback.html'
  } catch {
    return false
  }
}

/**
 * GET /line/authorize?state=xxx&redirect_uri=https://.../line-callback.html
 *
 * https://developers.line.biz/ja/docs/line-login/integrate-line-login/#making-an-authorization-request
 *   response_type = code       (必須)
 *   client_id     = チャネルID  (必須・シークレット LINE_client_id)
 *   redirect_uri  = コールバックURL（URLエンコード・必須）
 *   state         = CSRF対策のランダム文字列（必須）
 *   scope         = profile openid
 *   bot_prompt    = normal     （公式アカウントの友だち追加オプションを表示）
 */
function lineAuthorize(url, env) {
  const clientId = env.LINE_client_id || env.LINE_CLIENT_ID
  if (!clientId) {
    return json({ error: 'LINE_client_id not set in Workers secrets' }, 500)
  }

  const state       = url.searchParams.get('state')
  const redirectUri = url.searchParams.get('redirect_uri')

  if (!state)       return json({ error: 'state required' }, 400)
  if (!redirectUri) return json({ error: 'redirect_uri required' }, 400)
  if (!isAllowedRedirect(redirectUri)) {
    return json({ error: 'redirect_uri not allowed' }, 400)
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    state,
    scope:         'profile openid',
    bot_prompt:    'normal',
    ui_locales:    'ja-JP',
  })

  return Response.redirect(`${LINE_AUTHORIZE_URL}?${params.toString()}`, 302)
}

/**
 * POST /line/exchange  { code, redirectUri }
 *
 * 1. 認可コード → アクセストークン
 *    POST https://api.line.me/oauth2/v2.1/token
 * 2. アクセストークン → LINEプロフィール（userId）
 *    GET https://api.line.me/v2/profile
 *
 * userId のみをクライアントへ返す（アクセストークンは返さない）。
 */
async function lineExchange(body, env) {
  const clientId     = env.LINE_client_id || env.LINE_CLIENT_ID
  const clientSecret = env.LINE_client_secret || env.LINE_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    return json({ error: 'LINE_client_id / LINE_client_secret not set in Workers secrets' }, 500)
  }

  const { code, redirectUri } = body || {}
  if (!code)        return json({ error: 'code required' }, 400)
  if (!redirectUri) return json({ error: 'redirectUri required' }, 400)
  if (!isAllowedRedirect(redirectUri)) {
    return json({ error: 'redirectUri not allowed' }, 400)
  }

  // --- 1. アクセストークン取得 ---
  let tokenData
  try {
    const tokenRes = await fetch(LINE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
        client_id:     clientId,
        client_secret: clientSecret,
      }).toString(),
    })
    tokenData = await tokenRes.json().catch(() => ({}))
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[line/exchange] token error:', tokenRes.status, JSON.stringify(tokenData))
      return json({
        error: 'line_token_failed',
        error_description: tokenData?.error_description || 'アクセストークンの取得に失敗しました（認可コードの有効期限は10分・1回のみ有効です）',
      }, 400)
    }
  } catch (e) {
    console.error('[line/exchange] token network error:', e)
    return json({ error: 'line_token_network_error', error_description: e.message }, 502)
  }

  // --- 2. プロフィール取得（userId） ---
  try {
    const profRes = await fetch(LINE_PROFILE_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const prof = await profRes.json().catch(() => ({}))
    if (!profRes.ok || !prof.userId) {
      console.error('[line/exchange] profile error:', profRes.status, JSON.stringify(prof))
      return json({
        error: 'line_profile_failed',
        error_description: prof?.message || 'LINEプロフィールの取得に失敗しました',
      }, 400)
    }

    return json({
      userId:      prof.userId,
      displayName: prof.displayName || '',
      pictureUrl:  prof.pictureUrl  || '',
    })
  } catch (e) {
    console.error('[line/exchange] profile network error:', e)
    return json({ error: 'line_profile_network_error', error_description: e.message }, 502)
  }
}

// =======================================================================
// LINE Messaging API（プッシュ通知）
// =======================================================================

/**
 * ステートレスチャネルアクセストークンを発行する（15分間有効・発行数無制限）
 * POST https://api.line.me/oauth2/v3/token
 *   grant_type=client_credentials & client_id & client_secret
 * https://developers.line.biz/ja/reference/messaging-api/#issue-stateless-channel-access-token
 */
async function issueMessagingToken(env) {
  const clientId     = env.LINE_Channel_ID || env.LINE_CHANNEL_ID || env.LINE_client_id || env.LINE_CLIENT_ID
  const clientSecret = env.LINE_Channel_secret || env.LINE_CHANNEL_SECRET || env.LINE_client_secret || env.LINE_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('LINE_Channel_ID / LINE_Channel_secret not set in Workers secrets')
  }

  const res = await fetch(LINE_STATELESS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    }).toString(),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) {
    throw new Error(`channel access token failed (${res.status}): ${data?.error_description || data?.error || 'unknown'}`)
  }
  return data.access_token
}

/**
 * プッシュメッセージ送信
 * POST https://api.line.me/v2/bot/message/push
 */
async function linePush(env, to, messages) {
  let accessToken = env.LINE_CHANNEL_ACCESS_TOKEN || env.LINE_CHANNEL_TOKEN || env.LINE_MESSAGING_ACCESS_TOKEN || env.LINE_ACCESS_TOKEN
  if (!accessToken) {
    accessToken = await issueMessagingToken(env)
  }

  const res = await fetch(LINE_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${accessToken}`,
      // 同じ内容の再送による重複配信を防ぐ
      'X-Line-Retry-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ to, messages }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`push failed (${res.status}): ${detail}`)
  }
  return true
}

/**
 * 承認完了通知の Flex Message を組み立てる（モダンなカードデザイン）
 * https://developers.line.biz/ja/docs/messaging-api/using-flex-messages/
 */
function buildApprovalFlex({ studentName, title, dates, reason, reasonDetail, base }) {
  const datesArr = Array.isArray(dates) ? dates : (dates ? [dates] : [])
  const datesStr = datesArr.join('、') || '—'
  const reasonDisplay = reasonDetail ? `${reason}（${reasonDetail}）` : (reason || '—')

  const row = (label, value) => ({
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, color: '#9aa4b8', size: 'sm', flex: 2, weight: 'bold' },
      { type: 'text', text: value, color: '#333333', size: 'sm', flex: 5, wrap: true },
    ],
  })

  return {
    type: 'flex',
    altText: `【承認完了】公欠申請「${title}」が承認されました`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1A2744',
        paddingAll: '20px',
        spacing: 'xs',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'md',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                width: '36px',
                height: '36px',
                cornerRadius: '18px',
                backgroundColor: '#27AE60',
                justifyContent: 'center',
                alignItems: 'center',
                contents: [
                  { type: 'text', text: '✓', color: '#FFFFFF', size: 'lg', weight: 'bold', align: 'center' },
                ],
              },
              {
                type: 'box',
                layout: 'vertical',
                spacing: 'none',
                justifyContent: 'center',
                contents: [
                  { type: 'text', text: '公欠申請が承認されました', color: '#FFFFFF', size: 'md', weight: 'bold', wrap: true },
                  { type: 'text', text: '顧問・担任の承認が完了しました', color: '#A0B0CC', size: 'xxs', margin: 'xs', wrap: true },
                ],
              },
            ],
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '20px',
        contents: [
          { type: 'text', text: title || '公欠申請', weight: 'bold', size: 'lg', color: '#111111', wrap: true },
          { type: 'separator', color: '#EEEEE9' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              row('申請者', studentName || '—'),
              row('事由',   reasonDisplay),
              row('公欠日', datesStr),
            ],
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#EAFAF1',
            cornerRadius: '8px',
            paddingAll: '12px',
            contents: [
              {
                type: 'text',
                text: '担任の先生の承認をもって手続きが完了しました。当日は担任の指示に従ってください。',
                size: 'xxs',
                color: '#1E8449',
                wrap: true,
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#1A2744',
            height: 'sm',
            action: {
              type: 'uri',
              label: 'マイページで確認',
              uri: `${base || 'https://mito1-tetyo.tech'}/#mypage`,
            },
          },
          {
            type: 'text',
            text: 'デジタル生徒手帳 公欠申請システム',
            size: 'xxs',
            color: '#AAAAAA',
            align: 'center',
          },
        ],
      },
      styles: {
        header: { separator: false },
        footer: { separator: true, separatorColor: '#EEEEE9' },
      },
    },
  }
}

/**
 * 申請状況をプログレスバー付きのカードで返すための Flex Message を組み立てる。
 * 「申請完了カード」と同じデザイン言語（ネイビー＋アイコン）を使い、
 * 進行状況（申請 → 顧問承認 → 担任承認 → 完了）をバーで示す。
 */
function buildStatusFlex({ caseData, studentName, base }) {
  const datesArr = Array.isArray(caseData.dates) ? caseData.dates : (caseData.dates ? [caseData.dates] : [])
  const datesStr = datesArr.join('、') || '—'
  const reasonDisplay = caseData.reasonDetail ? `${caseData.reason}（${caseData.reasonDetail}）` : (caseData.reason || '—')
  const st = caseData.status || ''

  const STATUS = {
    pending_supervisor: { label: '顧問承認待ち', color: '#B8860B', bg: '#FFF8E1', icon: '⏳', iconBg: '#E8A33D' },
    pending_homeroom:   { label: '担任承認待ち', color: '#1A5276', bg: '#EAF4FB', icon: '⏳', iconBg: '#2980B9' },
    approved:           { label: '承認完了',     color: '#1E8449', bg: '#EAFAF1', icon: '✓', iconBg: '#27AE60' },
    rejected:           { label: '差し戻し',     color: '#C0392B', bg: '#FDEDEC', icon: '✗', iconBg: '#E74C3C' },
  }
  const meta = STATUS[st] || STATUS.pending_supervisor

  const steps = [
    { label: '申請',     done: true,                                                active: false },
    { label: '顧問承認', done: ['pending_homeroom', 'approved'].includes(st),       active: st === 'pending_supervisor' },
    { label: '担任承認', done: st === 'approved',                                   active: st === 'pending_homeroom' },
    { label: '完了',     done: st === 'approved',                                   active: false },
  ]

  const row = (label, value) => ({
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, color: '#9aa4b8', size: 'sm', flex: 2, weight: 'bold' },
      { type: 'text', text: value, color: '#333333', size: 'sm', flex: 5, wrap: true },
    ],
  })

  const progressBar = {
    type: 'box',
    layout: 'horizontal',
    spacing: 'none',
    margin: 'md',
    contents: steps.map(s => ({
      type: 'box',
      layout: 'vertical',
      flex: 1,
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          height: '4px',
          cornerRadius: '2px',
          backgroundColor: s.done ? '#1A2744' : (s.active ? '#E8A33D' : '#EEEEE9'),
          contents: [],
        },
        {
          type: 'text',
          text: s.label,
          size: 'xxs',
          align: 'center',
          margin: 'xs',
          color: s.done ? '#1A2744' : (s.active ? '#B8860B' : '#AAAAAA'),
          weight: (s.done || s.active) ? 'bold' : 'regular',
        },
      ],
    })),
  }

  const rejectedNote = st === 'rejected'
    ? {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FDEDEC',
        cornerRadius: '8px',
        paddingAll: '12px',
        contents: [{
          type: 'text',
          text: caseData.rejectedReason
            ? `差し戻し理由: ${caseData.rejectedReason}`
            : '申請内容が差し戻されました。マイページで内容を確認し、必要に応じて再申請してください。',
          size: 'xxs',
          color: '#C0392B',
          wrap: true,
        }],
      }
    : null

  const note = rejectedNote || {
    type: 'box',
    layout: 'vertical',
    backgroundColor: meta.bg,
    cornerRadius: '8px',
    paddingAll: '12px',
    contents: [{
      type: 'text',
      text: st === 'approved'
        ? '顧問・担任の承認が完了しました。当日は担任の指示に従ってください。'
        : '承認が完了するとLINEでお知らせが届きます。',
      size: 'xxs',
      color: meta.color,
      wrap: true,
    }],
  }

  return {
    type: 'flex',
    altText: `【申請状況】${meta.label}「${caseData.title || '公欠申請'}」`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'md',
        backgroundColor: '#1A2744',
        paddingAll: '20px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            width: '36px',
            height: '36px',
            cornerRadius: '18px',
            backgroundColor: meta.iconBg,
            justifyContent: 'center',
            alignItems: 'center',
            contents: [
              { type: 'text', text: meta.icon, color: '#FFFFFF', size: 'lg', weight: 'bold', align: 'center' },
            ],
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'none',
            justifyContent: 'center',
            contents: [
              { type: 'text', text: '公欠申請の状況', color: '#FFFFFF', size: 'md', weight: 'bold', wrap: true },
              { type: 'text', text: meta.label, color: '#A0B0CC', size: 'xxs', margin: 'xs', wrap: true },
            ],
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '20px',
        contents: [
          { type: 'text', text: caseData.title || '公欠申請', weight: 'bold', size: 'lg', color: '#111111', wrap: true },
          { type: 'separator', color: '#EEEEE9' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              row('申請者', studentName || '—'),
              row('事由',   reasonDisplay),
              row('公欠日', datesStr),
            ],
          },
          progressBar,
          note,
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#1A2744',
            height: 'sm',
            action: {
              type: 'uri',
              label: 'マイページで確認',
              uri: `${base || 'https://mito1-tetyo.tech'}/#mypage`,
            },
          },
          {
            type: 'text',
            text: 'デジタル生徒手帳 公欠申請システム',
            size: 'xxs',
            color: '#AAAAAA',
            align: 'center',
          },
        ],
      },
      styles: {
        header: { separator: false },
        footer: { separator: true, separatorColor: '#EEEEE9' },
      },
    },
  }
}

// =======================================================================
// Firestore 管理者アクセス（サービスアカウント OAuth2）
// =======================================================================
//
// Worker から Firestore REST API を呼ぶには認証が必要。
// （firestore.rules では users の get/list は認証必須のため、
//   未認証のままでは 403 で拒否され「未連携」扱いになる — #31）
// ここではサービスアカウントの秘密鍵で JWT(RS256) を組み立て、
// OAuth2 トークンに交換して Firestore REST の Authorization ヘッダに付与する。
//
// 必要なシークレット: FIREBASE_SERVICE_ACCOUNT_JSON
//   - サービスアカウントの JSON をそのまま登録する（GitHub Actions の
//     FIREBASE_SERVICE_ACCOUNT_JSON と同じ形式・同じ鍵）
//   - npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON --config workers/wrangler.toml
//   未設定の場合は従来どおり認証なしで呼ぶ（＝ルールに許容される範囲のみ）

const FIRESTORE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FIRESTORE_SCOPE     = 'https://www.googleapis.com/auth/datastore'

let _firestoreToken = { token: '', expiresAt: 0 }

/** PEM (PKCS#8) の秘密鍵を DER バイト列へ変換する */
function pemToDer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '')
  const bin = atob(b64)
  const der = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i)
  return der
}

/** サービスアカウント秘密鍵で RS256 署名した JWT を生成する */
async function buildServiceAccountJwt(sa, nowSec) {
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const claims = bytesToB64url(new TextEncoder().encode(JSON.stringify({
    iss:   sa.client_email,
    scope: FIRESTORE_SCOPE,
    aud:   FIRESTORE_TOKEN_URL,
    iat:   nowSec,
    exp:   nowSec + 3600,
  })))
  const signingInput = `${header}.${claims}`

  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key).buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  )
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(signingInput)
  ))
  return `${signingInput}.${bytesToB64url(sig)}`
}

/** OAuth2 アクセストークンを取得（isolate 内キャッシュ付き） */
async function getFirestoreAccessToken(env) {
  const now = Date.now()
  if (_firestoreToken.token && _firestoreToken.expiresAt > now + 60_000) {
    return _firestoreToken.token
  }
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (!raw) return ''
  let sa
  try { sa = JSON.parse(raw) } catch (e) {
    console.error('[firestore-auth] FIREBASE_SERVICE_ACCOUNT_JSON をパースできません:', e)
    return ''
  }
  if (!sa.client_email || !sa.private_key) return ''

  try {
    const assertion = await buildServiceAccountJwt(sa, Math.floor(now / 1000))
    const res = await fetch(FIRESTORE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.access_token) {
      console.error('[firestore-auth] token exchange failed:', res.status, data.error_description || data.error)
      return ''
    }
    _firestoreToken = { token: data.access_token, expiresAt: now + (data.expires_in || 3600) * 1000 }
    return data.access_token
  } catch (e) {
    console.error('[firestore-auth] token exchange error:', e)
    return ''
  }
}

/** Firestore REST API を認証付きで呼ぶ（トークン未設定時は従来どおり） */
async function firestoreFetch(env, url, init = {}) {
  const token = await getFirestoreAccessToken(env)
  const headers = { ...(init.headers || {}) }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return fetch(url, { ...init, headers })
}

/**
 * Firestore REST API 経由で生徒の lineUserId を取得する
 */
async function getLineUserIdByStudentId(studentId, env) {
  if (!studentId) return null
  const projectId = env.FIREBASE_PROJECT_ID
  if (!projectId) return null

  try {
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${studentId}`
    const res = await firestoreFetch(env, url)
    if (res.ok) {
      const docData = await res.json()
      const lineUserId = docData.fields?.lineUserId?.stringValue
      return lineUserId || null
    } else {
      console.error(`[getLineUserIdByStudentId] Firestore REST error (${res.status}):`, await res.text())
    }
  } catch (e) {
    console.error('[getLineUserIdByStudentId] error:', e)
  }
  return null
}

/**
 * Firestore REST API 経由で lineUserId から users ドキュメントを検索する。
 * LINE Webhook の source.userId から、連携済みの生徒を特定するために使う。
 * 見つからない（未連携）場合は null を返す。
 */
async function findUserByLineUserId(lineUserId, env) {
  if (!lineUserId) return null
  const projectId = env.FIREBASE_PROJECT_ID
  if (!projectId) return null

  try {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`
    const queryBody = {
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'lineUserId' },
            op: 'EQUAL',
            value: { stringValue: lineUserId }
          }
        },
        limit: 1
      }
    }
    const res = await firestoreFetch(env, firestoreUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody)
    })
    if (!res.ok) {
      console.error(`[findUserByLineUserId] Firestore REST error (${res.status}):`, await res.text())
      return null
    }
    const results = await res.json()
    const doc = results && results[0] && results[0].document
    if (!doc) return null
    const fields = doc.fields || {}
    return {
      uid: doc.name.split('/').pop(),
      name: fields.name?.stringValue || '',
    }
  } catch (e) {
    console.error('[findUserByLineUserId] error:', e)
    return null
  }
}

/**
 * Firestore REST API 経由で、特定の生徒 uid の公欠申請ケース一覧を取得する。
 * createdAt 降順（新しい順）にソートして返す。
 */
async function getCasesByStudentId(studentId, env) {
  if (!studentId) return []
  const projectId = env.FIREBASE_PROJECT_ID
  if (!projectId) return []

  try {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`
    const queryBody = {
      structuredQuery: {
        from: [{ collectionId: 'cases' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'studentId' },
            op: 'EQUAL',
            value: { stringValue: studentId }
          }
        }
      }
    }
    const res = await firestoreFetch(env, firestoreUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody)
    })
    if (!res.ok) {
      console.error(`[getCasesByStudentId] Firestore REST error (${res.status}):`, await res.text())
      return []
    }
    const results = await res.json()
    const docs = Array.isArray(results) ? results.filter(r => r.document).map(r => r.document) : []
    return docs.map(d => {
      const f = d.fields || {}
      return {
        id:         d.name.split('/').pop(),
        title:      f.title?.stringValue || '',
        reason:     f.reason?.stringValue || '',
        reasonDetail: f.reasonDetail?.stringValue || '',
        status:     f.status?.stringValue || '',
        dates:      Array.isArray(f.dates?.arrayValue?.values)
                      ? f.dates.arrayValue.values.map(v => v.stringValue || '').filter(Boolean)
                      : [],
        rejectedReason: f.rejectedReason?.stringValue || '',
        createdAt:  f.createdAt?.timestampValue || '',
      }
    }).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  } catch (e) {
    console.error('[getCasesByStudentId] error:', e)
    return []
  }
}

/**
 * POST /line/notify-complete
 *   { lineUserId, studentId, studentName, title, dates, reason, reasonDetail, appBaseUrl }
 *
 * 担任承認完了時に生徒の LINE へ完了通知（Flex Message）を送る。
 * lineUserId が無い（未連携）場合は skipped を返すだけで、呼び出し側の処理は止めない。
 */
async function lineNotifyComplete(body, env) {
  const { lineUserId, studentId, studentName, title, dates, reason, reasonDetail, appBaseUrl } = body || {}

  let targetLineUserId = lineUserId
  if (!targetLineUserId && studentId) {
    targetLineUserId = await getLineUserIdByStudentId(studentId, env)
  }

  if (!targetLineUserId) {
    return json({ ok: true, skipped: true, reason: 'not_linked' })
  }

  const base = appBaseUrl || env.APP_BASE_URL || 'https://mito1-tetyo.tech'
  const flex = buildApprovalFlex({ studentName, title, dates, reason, reasonDetail, base })

  try {
    await linePush(env, targetLineUserId, [flex])
    return json({ ok: true })
  } catch (e) {
    console.error('[line/notify-complete] flex push failed, trying text fallback:', e)
    try {
      const datesArr = Array.isArray(dates) ? dates : (dates ? [dates] : [])
      const datesStr = datesArr.join('、') || '—'
      const textMsg = {
        type: 'text',
        text: `【公欠申請 承認完了】\n${studentName || ''} さんの公欠申請「${title || ''}」（${datesStr}）が顧問・担任の両方に承認されました。\n\n詳細: ${base}/#mypage`
      }
      await linePush(env, targetLineUserId, [textMsg])
      return json({ ok: true, fallback: true })
    } catch (fallbackErr) {
      console.error('[line/notify-complete] text fallback push failed:', fallbackErr)
      return json({ error: 'line_push_failed', detail: e.message }, 500)
    }
  }
}

// =======================================================================
// LINE Webhook（Reply API による時間割・申請状況の問い合わせ応答）
// =======================================================================
//
// フロー:
//   1. ユーザーが公式アカウントに「>時間割」または「>申請状況」と送る
//   2. LINEプラットフォームが POST /line/webhook にイベントを送る
//   3. x-line-signature をチャネルシークレットで検証（改ざん・なりすまし対策）
//   4. 「>時間割」: 公開マニフェスト（APP_BASE_URL/timetable/manifest.json）を読んで
//      画像メッセージを Reply API で返す（replyToken消費＝Push通数を使わない）
//      「>申請状況」: source.userId から連携済み生徒を特定し、申請状況を
//      Flex Message（プログレスバー付きカード）で返す。未連携なら
//      マイページからの連携を促すメッセージを返す（Reply API なので通数は消費しない）
//
// LINE Developers Console での手動設定（コードではできない部分）:
//   Messaging APIチャネル → Webhook設定 → Webhook URL に
//     https://<worker>.workers.dev/line/webhook
//   を登録し、「Webhookの利用」をON、「応答メッセージ」はOFFにすること。

const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply'

// 時間割の問い合わせとみなすメッセージ。
// 誤送信での誤爆を防ぐため、完全一致（前後の空白のみ許容）とする。
// 半角「>」・全角「＞」のどちらも受け付ける。
function isTimetableQuery(text) {
  if (typeof text !== 'string' || !text) return false
  return /^[>＞]時間割$/.test(text.trim())
}

// 申請状況の問い合わせとみなすメッセージ。
// 「>申請状況」「＞申請状況」の完全一致（前後の空白のみ許容）とする。
// LINE連携していないユーザーにも「連携してね」と案内するため、
// 未連携でも無反応にならない（Reply API はメッセージ通数を消費しない）。
function isStatusQuery(text) {
  if (typeof text !== 'string' || !text) return false
  return /^[>＞]申請状況$/.test(text.trim())
}

/**
 * x-line-signature（bodyのHMAC-SHA256、Base64）を検証する。
 * 比較は定数時間で行う。
 */
async function verifyLineSignature(bodyText, signatureB64, channelSecret) {
  try {
    if (!signatureB64 || !channelSecret) return false
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(channelSecret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const mac = new Uint8Array(await crypto.subtle.sign(
      'HMAC', key, new TextEncoder().encode(bodyText)
    ))
    const bin = atob(signatureB64)
    if (bin.length !== mac.length) return false
    const sig = Uint8Array.from(bin, c => c.charCodeAt(0))
    let diff = 0
    for (let i = 0; i < mac.length; i++) diff |= mac[i] ^ sig[i]
    return diff === 0
  } catch {
    return false
  }
}

/**
 * マニフェストからReply API用の画像メッセージを組み立てる（純粋関数）。
 * Replyは最大5件/回のため、画像4枚＋案内テキスト1件に収める。
 */
function buildTimetableReplyMessages(manifest, base) {
  const images = manifest && Array.isArray(manifest.images) ? manifest.images : []
  if (!images.length) {
    return [{
      type: 'text',
      text: '時間割はまだ登録されていません。しばらくしてからもう一度「>時間割」と送ってください。',
    }]
  }
  const label = manifest.updatedAtLabel ? `（${manifest.updatedAtLabel}）` : ''
  // 画像は最大4枚＋案内テキスト1件＝Reply上限5件に収める
  const msgs = images.slice(0, 4).map(im => {
    const url = `${base}/timetable/${encodeURIComponent(im.file)}`
    return { type: 'image', originalContentUrl: url, previewImageUrl: url }
  })
  msgs.push({ type: 'text', text: `時間割です${label}\n詳しくは手帳アプリでも確認できます：${base}/#timetable` })
  return msgs
}

/** Reply API 呼び出し（アクセストークンはMessaging APIチャネルのもの） */
async function lineReply(env, replyToken, messages) {
  let accessToken = env.LINE_CHANNEL_ACCESS_TOKEN || env.LINE_CHANNEL_TOKEN
    || env.LINE_MESSAGING_ACCESS_TOKEN || env.LINE_ACCESS_TOKEN
  if (!accessToken) {
    accessToken = await issueMessagingToken(env)
  }
  const res = await fetch(LINE_REPLY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`reply failed (${res.status}): ${detail.slice(0, 200)}`)
  }
  return true
}

/** POST /line/webhook */
async function lineWebhook(request, env) {
  const channelSecret = env.LINE_Channel_secret || env.LINE_CHANNEL_SECRET
  if (!channelSecret) {
    return json({ error: 'LINE_Channel_secret not set in Workers secrets' }, 500)
  }

  const bodyText = await request.text()
  const signature = request.headers.get('x-line-signature') || ''
  if (!await verifyLineSignature(bodyText, signature, channelSecret)) {
    return json({ error: 'invalid signature' }, 403)
  }

  let body
  try { body = JSON.parse(bodyText) }
  catch { return json({ error: 'Invalid JSON' }, 400) }

  const events = Array.isArray(body.events) ? body.events : []
  const base = env.APP_BASE_URL || 'https://mito1-tetyo.tech'
  let replied = 0

  for (const ev of events) {
    try {
      // 時間割・申請状況の問い合わせ（テキストメッセージ）にのみ応答する
      if (ev.type !== 'message' || ev.message?.type !== 'text') continue
      if (!ev.replyToken) continue

      // ---- 時間割の問い合わせ ----
      if (isTimetableQuery(ev.message.text)) {
        // 公開マニフェストから最新の画像一覧を取得する
        let manifest = null
        try {
          const mres = await fetch(`${base}/timetable/manifest.json?webhook=1`)
          if (mres.ok) manifest = await mres.json()
        } catch (e) {
          console.error('[line/webhook] manifest fetch failed:', e)
        }

        const messages = buildTimetableReplyMessages(manifest, base)
        await lineReply(env, ev.replyToken, messages)
        replied++
        continue
      }

      // ---- 申請状況の問い合わせ ----
      if (isStatusQuery(ev.message.text)) {
        const lineUserId = ev.source?.userId || ''
        const user = lineUserId ? await findUserByLineUserId(lineUserId, env) : null
        // 未連携ならマイページへの連携を促す（無反応にしない）
        if (!user) {
          await lineReply(env, ev.replyToken, [
            {
              type: 'text',
              text: 'このLINEアカウントは生徒手帳とまだ連携されていません。\n\n'
                + '連携すると、公欠申請の承認完了などのお知らせや、申請状況の確認がLINEでできるようになります。\n'
                + `マイページ（ ${base}/#mypage ）から「LINEで通知を受け取る」をタップして連携してください。`,
            },
          ])
          replied++
          continue
        }

        const cases = await getCasesByStudentId(user.uid, env)

        if (!cases.length) {
          await lineReply(env, ev.replyToken, [
            { type: 'text', text: 'まだ申請した公欠申請はありません。\n\nマイページ（ ' + base + '/#mypage ）から新しい申請を作成できます。' },
          ])
          replied++
          continue
        }

        // 進行中の申請を優先し、最大3件をカードで返す（Reply上限5件以内）
        const active = cases.filter(c => ['pending_supervisor', 'pending_homeroom'].includes(c.status))
        const visible = (active.length ? active : cases).slice(0, 3)
        const messages = visible.map(c => buildStatusFlex({ caseData: c, studentName: user.name, base }))
        await lineReply(env, ev.replyToken, messages)
        replied++
        continue
      }
    } catch (e) {
      // 1イベントの失敗で全体を道連れにしない。
      // LINEは非2xxでリトライしてくるため、処理済み分は200で返す。
      console.error('[line/webhook] event handling failed:', e)
    }
  }

  return json({ ok: true, replied })
}

// =======================================================================
// Web Push（PWAプッシュ通知送信・依存なしWebCrypto実装）
// =======================================================================
//
// フロー:
//   1. クライアント(src/push.js)がPush APIで購読し、購読情報{endpoint,keys}を
//      Firestore users/{uid}/pushSubscriptions に保存（クライアントSDK経由）
//   2. 承認完了時などに先生側クライアントが購読情報を読み、
//      POST /push/send { subscription, payload } で本エンドポイントを呼ぶ
//      （Workersは秘密鍵のみ保持し、Firestoreを読まない設計）
//   3. VAPID署名＋aes128gcm暗号化（RFC8292/RFC8188）してpush endpointへPOST
//
// 404/410応答時は購読切れ → { ok:false, gone:true } を返すので、
// 呼び出し側は該当購読をFirestoreから削除すること。

/** POST /push/send */
async function pushSend(body, env) {
  const { subscription, payload } = body || {}
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return json({ error: 'subscription required (endpoint, keys.p256dh, keys.auth)' }, 400)
  }

  const vapidPublic  = env.VAPID_PUBLIC_KEY
  const vapidPrivate = env.VAPID_PRIVATE_KEY
  const subject = env.VAPID_SUBJECT || 'mailto:noreply@mito1-tetyo.tech'
  if (!vapidPublic || !vapidPrivate) {
    return json({ error: 'VAPID keys not set in Workers secrets' }, 500)
  }

  try {
    const message = JSON.stringify({
      title: payload?.title || '水一手帳',
      body:  payload?.body  || '',
      url:   payload?.url   || '/',
      tag:   payload?.tag   || 'mito1-notify',
    })
    const status = await webPushSend(subscription, message, { vapidPublic, vapidPrivate, subject })
    console.log(`[push/send] delivered: appleStatus=${status} host=${new URL(subscription.endpoint).host}`)
    return json({ ok: true, status })
  } catch (e) {
    const msg = String((e && e.message) || e)
    // 購読切れ（ブラウザ側で削除済み等）
    if (/\(410\)|\(404\)/.test(msg)) {
      return json({ ok: false, gone: true, detail: msg }, 410)
    }
    console.error('[push/send] failed:', msg)
    return json({ error: 'push_failed', detail: msg }, 502)
  }
}

async function webPushSend(subscription, message, { vapidPublic, vapidPrivate, subject }) {
  const endpoint = new URL(subscription.endpoint)
  const audience = `${endpoint.protocol}//${endpoint.host}`
  const jwt = await vapidJwt(audience, subject, vapidPublic, vapidPrivate)
  const { body } = await encryptAes128gcm(
    subscription.keys.p256dh,
    subscription.keys.auth,
    new TextEncoder().encode(message)
  )

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '86400',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Authorization': `vapid t=${jwt}, k=${vapidPublic}`,
    },
    body,
  })

  if (res.status === 404 || res.status === 410) {
    throw new Error(`subscription gone (${res.status})`)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // 403 は VAPID鍵の不一致（購読時の鍵とサーバー鍵が別物）が典型。
    // フロントの VAPID_PUBLIC_KEY と Workers の鍵ペアが揃っているか確認すること。
    throw new Error(`push endpoint error (${res.status}): ${detail.slice(0, 200)}`)
  }
  // Apple/Google は成功時 201 Created を返す。200 や 2xx でも受理扱いにする。
  return res.status
}

// ---- VAPID JWT (ES256) ----
async function vapidJwt(audience, subject, vapidPublicB64, vapidPrivateB64) {
  const pubBytes = b64urlToBytes(vapidPublicB64) // 65B uncompressed: 0x04 || X(32) || Y(32)
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error('invalid VAPID_PUBLIC_KEY')
  }
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(pubBytes.slice(1, 33)),
    y: bytesToB64url(pubBytes.slice(33, 65)),
    d: vapidPrivateB64,
    ext: true,
  }
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  )
  const header  = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600
  const payload = bytesToB64url(new TextEncoder().encode(JSON.stringify({ aud: audience, exp, sub: subject })))
  const unsignedToken = `${header}.${payload}`
  // WebCryptoのECDSA署名はJWS用の生R||S形式（64B）で返る
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsignedToken)
  ))
  return `${unsignedToken}.${bytesToB64url(sig)}`
}

// ---- WebCrypto の型ゆらぎを吸収するヘルパー ----
//
// crypto.subtle.generateKey / exportKey はユニオン型を返すため、
// 呼び出し側でそのまま .publicKey / new Uint8Array() を使うと型エラーになる。
// ここで一度だけ「実行時チェック＋型の絞り込み」を行い、以降は素直に扱えるようにする。
// （runtime の想定外レスポンスも早期に検知できるので、単なる型キャストより安全）

/**
 * ECDH P-256 の一時鍵ペアを生成する。
 * @returns {Promise<CryptoKeyPair>}
 */
async function generateEcdhKeyPair() {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  )
  // ECDH は必ず鍵ペアを返す。万一 CryptoKey 単体なら実装側の異常なので落とす。
  if (!('publicKey' in keys) || !('privateKey' in keys)) {
    throw new Error('ECDH generateKey did not return a CryptoKeyPair')
  }
  return /** @type {CryptoKeyPair} */ (keys)
}

/**
 * 公開鍵を非圧縮形式(0x04 || X || Y, 65バイト)のバイト列として取り出す。
 * @param {CryptoKey} publicKey
 * @returns {Promise<Uint8Array>}
 */
async function exportRawPublicKey(publicKey) {
  const raw = await crypto.subtle.exportKey('raw', publicKey)
  // 'raw' 指定なので ArrayBuffer が返る（JsonWebKey は 'jwk' 指定時のみ）。
  if (!(raw instanceof ArrayBuffer)) {
    throw new Error('exportKey("raw") did not return an ArrayBuffer')
  }
  return new Uint8Array(raw)
}

// ---- aes128gcm 本文暗号化 (RFC8188 §4.3) ----
async function encryptAes128gcm(clientP256dhB64, clientAuthB64, plaintextBytes) {
  const te = new TextEncoder()
  const clientPub  = b64urlToBytes(clientP256dhB64)
  const authSecret = b64urlToBytes(clientAuthB64)

  // サーバー側エフェメラル鍵
  //
  // ★エディタの赤線について
  //   crypto.subtle.generateKey() の型定義は戻り値が `CryptoKey | CryptoKeyPair` の
  //   ユニオン型になっている。ECDH/ECDSA では実際には必ず CryptoKeyPair が返るが、
  //   TypeScript(JSの型チェック)は実行時のアルゴリズム名まで見てくれないので
  //   `serverKeys.publicKey` が「CryptoKey に publicKey は存在しない」と警告される。
  //   同様に exportKey() の戻り値も `ArrayBuffer | JsonWebKey` のユニオンなので、
  //   'raw' 指定でも JsonWebKey の可能性が残り new Uint8Array() に渡せないと言われる。
  //   実行時の挙動は正しいので「型だけの問題」だが、赤線を放置すると
  //   本物のエラーが埋もれるため、下のヘルパーで明示的に絞り込む。
  const serverKeys = await generateEcdhKeyPair()
  const serverPubRaw = await exportRawPublicKey(serverKeys.publicKey)
  const clientPubKey = await crypto.subtle.importKey(
    'raw', clientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  )
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    /** @type {any} */ ({ name: 'ECDH', public: clientPubKey }), serverKeys.privateKey, 256
  ))

  const prkKey = await hkdfExtract(authSecret, shared)
  const keyInfo = concatBytes(
    te.encode('WebPush: info'), new Uint8Array([0]), clientPub, serverPubRaw
  )
  const ikm = await hkdfExpand(prkKey, keyInfo, 32)

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const prk = await hkdfExtract(salt, ikm)
  const cek   = await hkdfExpand(prk, concatBytes(te.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16)
  const nonce = await hkdfExpand(prk, concatBytes(te.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12)

  // 単一レコード（RFC8188 §2）: 平文 + パディングデリミタ。
  //
  // ★ここが「200が返るのに通知が出ない」原因だった。
  //   aes128gcm(RFC8188)のレコードは「平文 || デリミタ(1B) || パディング(0x00...)」で、
  //   最終レコードのデリミタは 0x02、非最終レコードは 0x01 と決まっている。
  //   旧実装は aesgcm(draft-04)形式の「2Bパディング長を先頭に付ける」レイアウトを
  //   使っていたため、復号自体は成功する（AES-GCM認証タグは正しい＝Appleは201を返す）
  //   一方で、ブラウザ側のRFC8188デコーダがレコード末尾にデリミタを見つけられず
  //   パースに失敗し、pushイベントが配送されずに黙って捨てられていた。
  //   さらに先頭2バイトのゴミにより e.data.json() も壊れる。
  const plain = concatBytes(plaintextBytes, new Uint8Array([0x02]))
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, plain))

  // ヘッダ: salt(16) + rs(4B BE) + idlen(1B) + keyid(serverPub=65B)
  const rs = 4096
  const header = concatBytes(
    salt,
    new Uint8Array([(rs >>> 24) & 0xff, (rs >>> 16) & 0xff, (rs >>> 8) & 0xff, rs & 0xff]),
    new Uint8Array([serverPubRaw.length]), serverPubRaw
  )
  return { body: concatBytes(header, ct) }
}

// ---- Web Push用バイト列ユーティリティ ----
function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64url(bytes) {
  const arr = new Uint8Array(bytes)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < arr.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) { out.set(a, off); off += a.length }
  return out
}

async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm))
}

async function hkdfExpand(prk, info, len) {
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const input = concatBytes(info, new Uint8Array([1]))
  const out = new Uint8Array(await crypto.subtle.sign('HMAC', key, input))
  return out.slice(0, len)
}

// -- Resend API ---------------------------------------------------------
//
// ■ RESEND_FROM 未設定で「送信そのものを諦めていた」問題について
//   以前の実装は RESEND_FROM が無いと Resend を一切呼ばずに 403 を返していた。
//   これは「ドメイン認証していないと誰にも送れない」という前提だったが、
//   実際には Resend のサンドボックス送信元 onboarding@resend.dev でも
//   「Resend アカウント所有者のアドレス宛」なら正常に届く。
//   つまり未設定時は *必ず* 失敗させるのではなく、
//   とりあえず送ってみて Resend の返す本当のエラーを見せるほうが正しい。
//
//   さらに重要なのは、この 403 が「RESEND_FROM が無い」としか言わないため、
//   本当の原因（APIキー失効・ドメイン未認証・宛先制限など）が
//   まったく切り分けできなくなっていたこと。
//   そこで下記のように、
//     1. RESEND_FROM が無ければサンドボックス送信元にフォールバックする
//     2. Resend からのエラーはそのまま利用者に見せる
//     3. 典型的な失敗には日本語の対処法を添える
//   という方針に変更する。

/** RESEND_FROM 未設定時のフォールバック送信元（所有者宛にのみ届く） */
const RESEND_SANDBOX_FROM = 'mito1-handbook <onboarding@resend.dev>'

/**
 * メールを1通送る。
 * 例外を投げず、常に { ok, status, detail, hint } を返す。
 * @returns {Promise<{ok: boolean, status: number, detail: string, hint: string}>}
 */
async function sendMail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) {
    console.error('[resend] RESEND_API_KEY is not set in Workers secrets')
    return {
      ok: false,
      status: 500,
      detail: 'RESEND_API_KEY not configured in Workers secrets',
      hint: 'Workers のシークレットに RESEND_API_KEY が登録されていません。'
        + '`npx wrangler secret put RESEND_API_KEY --config workers/wrangler.toml` で登録してください。',
    }
  }

  if (!to || !String(to).includes('@')) {
    return { ok: false, status: 400, detail: `invalid recipient: ${to}`, hint: '宛先メールアドレスが正しくありません。' }
  }

  const usingSandbox = !env.RESEND_FROM
  const from = env.RESEND_FROM || RESEND_SANDBOX_FROM

  let res
  try {
    res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
      body:    JSON.stringify({ from, to: [to], subject, html }),
    })
  } catch (e) {
    const detail = String((e && e.message) || e)
    console.error('[resend] network error:', detail)
    return { ok: false, status: 0, detail, hint: 'Resend API に接続できませんでした。時間をおいて再試行してください。' }
  }

  if (res.ok) {
    if (usingSandbox) {
      // 届いてはいるが、所有者以外には送れない状態。運用上は必ず直すべきなのでログに残す。
      console.warn('[resend] sent using sandbox sender. Set RESEND_FROM to deliver to arbitrary recipients.')
    }
    return { ok: true, status: res.status, detail: '', hint: '' }
  }

  const detail = await res.text().catch(() => '')
  console.error(`[resend] API error (${res.status}):`, detail.slice(0, 500))
  return { ok: false, status: res.status, detail: detail.slice(0, 500), hint: resendHint(res.status, detail, usingSandbox) }
}

/** Resend のエラーレスポンスから、利用者が取るべき対処を日本語で返す */
function resendHint(status, detail, usingSandbox) {
  const msg = String(detail || '')

  // 送信元ドメインが未認証 / 宛先が所有者以外
  if (/domain is not verified|not verified/i.test(msg)) {
    return '送信元ドメインが Resend で認証されていません。Resend のダッシュボードでドメインを認証し、'
      + '環境変数 RESEND_FROM にそのドメインのアドレスを設定してください。'
  }
  if (usingSandbox && (status === 403 || /you can only send testing emails to your own email/i.test(msg))) {
    return 'RESEND_FROM が未設定のため、テスト用送信元 onboarding@resend.dev を使用しました。'
      + 'この送信元では Resend アカウント所有者のアドレスにしか届きません。'
      + 'Resend でドメイン認証を行い、環境変数 RESEND_FROM を設定してください。'
  }
  if (status === 401 || status === 403) {
    return 'Resend の API キーが無効か、権限が不足しています。RESEND_API_KEY を再発行して登録し直してください。'
  }
  if (status === 422) {
    return '送信内容が Resend に拒否されました（宛先や送信元の形式を確認してください）。'
  }
  if (status === 429) {
    return 'Resend の送信レート制限に達しました。少し時間をおいて再試行してください。'
  }
  return 'メールの送信に失敗しました。Workers のログと Resend のダッシュボードを確認してください。'
}

/**
 * GET /mail/diag
 *   メール設定の自己診断。?to=xxx@example.com を付けるとテスト送信も行う。
 *   APIキーそのものは絶対に返さない（長さと先頭数文字のみ）。
 */
async function mailDiag(url, env) {
  const hasKey = Boolean(env.RESEND_API_KEY)
  const from   = env.RESEND_FROM || null

  const info = {
    ok: hasKey && Boolean(from),
    hasResendApiKey: hasKey,
    keyPreview: hasKey ? `${env.RESEND_API_KEY.slice(0, 5)}...(${env.RESEND_API_KEY.length} chars)` : null,
    resendFrom: from,
    effectiveFrom: from || RESEND_SANDBOX_FROM,
    usingSandboxSender: !from,
    appBaseUrl: env.APP_BASE_URL || null,
  }

  if (!hasKey) {
    info.message = 'RESEND_API_KEY が未設定です。これが設定されるまでメールは一切送信されません。'
  } else if (!from) {
    info.message = 'RESEND_FROM が未設定のため onboarding@resend.dev で送信します。'
      + 'この送信元は Resend アカウント所有者のアドレスにしか届きません。'
      + 'Resend でドメイン認証を行い RESEND_FROM を設定してください。'
  } else {
    info.message = 'メール設定は正常です。?to=<アドレス> を付けるとテスト送信できます。'
  }

  // 実際に1通送ってみる（設定が生きているかを最終確認する用途）
  const to = url.searchParams.get('to')
  if (to) {
    const r = await sendMail(env, {
      to,
      subject: '【テスト送信】デジタル生徒手帳 メール設定の確認',
      html: '<p>このメールが届いていれば、Workers からのメール送信は正常に動作しています。</p>',
    })
    info.testSend = { to, ok: r.ok, status: r.status, detail: r.detail, hint: r.hint }
    info.ok = info.ok && r.ok
  }

  return json(info, info.ok ? 200 : 500)
}

// =======================================================================
// 時間割API（外部提供・Key制限・imgタグ対応）
// =======================================================================
//
// ■ 提供するもの（過去1週間＝直近7件）
//   GET /api/v1/timetable/list
//     → { ok, latest: {...}, history: [...] } のJSON。一覧の把握用。
//        画像の直リンク（origin URL）は一切返さない。API相対パスのみ。
//   GET /api/v1/timetable/image?date=YYYY-MM-DD&slot=0
//     → 画像バイナリそのもの。<img src=".../image?date=...&slot=0&key=..."> に直接指定できる。
//        origin のファイル配置はクライアントに漏らさず、Worker が代理取得して返す。
//
// ■ 認証（Key式・有料提供前提）
//   - リクエスト毎に APIキー必須。ヘッダ `X-API-Key: mt1_...` を推奨。
//     <img> タグからはヘッダを付けられないため `?key=...`（別名 ?api_key= / ?apiKey=）も受ける。
//     `Authorization: Bearer mt1_...` も可。
//   - キー形式: `mt1_<keyId:12hex>_<secret:48hex>`
//     Firestore `timetableApiKeys/{keyId}` に { keyHash(sha256hex), revoked, quotaDaily, ... } を保持し、
//     平文キーは保存しない（発行時に一度だけ表示）。管理画面から発行・無効化する。
//   - Worker はサービスアカウント（FIREBASE_SERVICE_ACCOUNT_JSON）で Firestore REST を
//     管理者権限で読む。未設定時は 503（API利用不可）を返す。
//
// ■ 秘匿の限界（重要）
//   現行の public/timetable/ は Pages の静的公開のため、URL を知る者は認証なしで取得できる。
//   本APIは「正規の取得手段をKey制限にする＋origin URLを外部に漏らさない」ことで推測取得を
//   難しくするが、完全秘匿には R2 等プライベート配置への移行が必要（docs 側に移行メモ）。
//   そのため画像は302リダイレクトではなく必ずバイトプロキシで返す。
//
// ■ レート制限
//   キー毎に JST日次 quotaDaily（既定 1000）。超過時は 429。

const TIMETABLE_API_KEY_RE = /^mt1_[0-9a-f]{12}_[0-9a-f]{48}$/
const TIMETABLE_API_COLLECTION = 'timetableApiKeys'
const TIMETABLE_API_DEFAULT_QUOTA = 1000
const TIMETABLE_API_KEEP = 7

/** Key文字列から keyId を取り出す（形式不正なら ''） */
function timetableKeyIdFromKey(key) {
  if (typeof key !== 'string') return ''
  const m = key.match(/^mt1_([0-9a-f]{12})_[0-9a-f]{48}$/)
  return m ? m[1] : ''
}

/** キー形式の検証（純粋関数・テスト用） */
function isValidTimetableKeyFormat(key) {
  return TIMETABLE_API_KEY_RE.test(String(key || ''))
}

/**
 * リクエスト各所からAPIキーを取り出す（純粋関数・テスト用）。
 * parts: { xApiKey, authorization, queryKey }
 */
function parseTimetableApiKeyFromParts(parts) {
  const p = parts || {}
  const headerKey = String(p.xApiKey || '').trim()
  if (headerKey) return headerKey
  const auth = String(p.authorization || '').trim()
  const bearer = auth.match(/^Bearer\s+(.+)$/i)
  if (bearer) return bearer[1].trim()
  const q = String(p.queryKey || '').trim()
  return q
}

/** Request/URL からAPIキーを取り出す */
function extractTimetableApiKey(request, url) {
  return parseTimetableApiKeyFromParts({
    xApiKey: request.headers.get('x-api-key') || '',
    authorization: request.headers.get('authorization') || '',
    queryKey: url.searchParams.get('key') || url.searchParams.get('api_key') || url.searchParams.get('apiKey') || '',
  })
}

/** SHA-256 hex（Workers/Node 両対応） */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '')))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 定数時間の文字列比較（タイミング攻撃で有効/無効が漏れないように） */
function timetableTimingSafeEqual(a, b) {
  const sa = String(a || '')
  const sb = String(b || '')
  if (sa.length !== sb.length) return false
  let diff = 0
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i)
  return diff === 0
}

/** JSTの YYYY-MM-DD（quotaの日次リセット用） */
function timetableTodayJst(d = new Date()) {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const y = jst.getUTCFullYear()
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const day = String(jst.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** YYYY-MM-DD の厳密検証（パストラバーサル対策の第一関門） */
function sanitizeTimetableDate(v) {
  const s = String(v || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return ''
  const [y, m, d] = s.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return ''
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return ''
  return s
}

/** slot パラメータの検証（0〜9） */
function sanitizeTimetableSlot(v) {
  if (v === null || v === undefined || v === '') return 0
  const n = Number(String(v).trim())
  if (!Number.isInteger(n) || n < 0 || n > 9) return -1
  return n
}

/** 拡張子→Content-Type */
function timetableContentType(file) {
  const ext = String(file || '').split('.').pop().toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'application/octet-stream'
}

/** Firestore REST の値形式をプレーン値へ（apiKeys doc用・最小限） */
function timetableRestToPlain(fields) {
  const out = {}
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null || typeof v !== 'object') continue
    if ('stringValue' in v) out[k] = v.stringValue
    else if ('integerValue' in v) out[k] = Number(v.integerValue)
    else if ('booleanValue' in v) out[k] = !!v.booleanValue
    else if ('timestampValue' in v) out[k] = v.timestampValue
  }
  return out
}

/**
 * manifest + history から「直近7件」を組み立てる（純粋関数・テスト用）。
 * history.json は日付降順・最大7件で来る想定。latest と updatedAt が同一の
 * entry は重複のため除外し、latest1件＋過去6件＝合計7件に丸める。
 */
function filterTimetableList(manifest, history) {
  const items = Array.isArray(history) ? history : []
  const latestAt = (manifest && manifest.updatedAt) || ''
  const filtered = items.filter(it => {
    if (!it || !it.date) return false
    if (latestAt && it.updatedAt && it.updatedAt === latestAt) return false
    return true
  }).slice(0, TIMETABLE_API_KEEP - 1)
  return { latest: manifest || null, history: filtered }
}

/**
 * 公開JSONからAPI向け一覧JSONを組み立てる（純粋関数・テスト用）。
 * origin のファイル配置（dir/file）はクライアントに渡さず、API相対パスのみ返す。
 */
function buildTimetableListResponse(manifest, history, workerOrigin) {
  const origin = String(workerOrigin || '').replace(/\/$/, '')
  const toEntry = (entry, isLatest) => {
    const date = entry && entry.date
      ? entry.date
      : (() => { try { return String(entry.updatedAt || '').slice(0, 10) } catch { return '' } })()
    const images = Array.isArray(entry && entry.images) ? entry.images : []
    return {
      date: date || '',
      updatedAt: entry.updatedAt || '',
      updatedAtLabel: entry.updatedAtLabel || '',
      slots: images.length,
      images: images.map((_, i) => ({
        slot: i,
        url: `${origin}/api/v1/timetable/image?date=${encodeURIComponent(date || '')}&slot=${i}`,
      })),
      _latest: undefined,
      isLatest: !!isLatest,
    }
  }
  const { latest, history: past } = filterTimetableList(manifest, history)
  // latest の date が取れない場合は history 先頭の日付で補完しない（空のまま 404 誘導）
  const latestEntry = latest ? toEntry({ ...latest, date: latestDateOfManifest(latest, past) }, true) : null
  return {
    ok: true,
    keep: TIMETABLE_API_KEEP,
    latest: latestEntry,
    history: past.map(e => toEntry(e, false)),
  }
}

function latestDateOfManifest(manifest, past) {
  try {
    const s = String((manifest && manifest.updatedAt) || '').slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  } catch { /* ignore */ }
  return ''
}

/**
 * date/slot → origin 上の画像パスを解決する（純粋関数・テスト用）。
 * 成功: { dir, file, date, updatedAt } / 失敗: { error, availableDates? }
 * dir は `history/YYYY-MM-DD` のみ許可し、それ以外の値（history.json改ざん時）は拒否する。
 */
function resolveTimetableOrigin(manifest, history, dateStr, slot) {
  const items = Array.isArray(history) ? history : []
  // date 省略時は最新
  if (!dateStr) {
    const images = (manifest && Array.isArray(manifest.images)) ? manifest.images : []
    if (!images.length || slot >= images.length) {
      return { error: 'slot not found', status: 404 }
    }
    const file = String(images[slot].file || '')
    if (!/^slot-\d+\.(jpg|jpeg|png|webp|gif|bin)$/i.test(file)) return { error: 'invalid file entry', status: 500 }
    return { dir: '', file, date: latestDateOfManifest(manifest, items), updatedAt: manifest.updatedAt || '' }
  }
  const entry = items.find(e => e && e.date === dateStr)
  // history に無い日付でも manifest 当日と一致すれば最新として扱う
  if (!entry) {
    const manifestDate = latestDateOfManifest(manifest, items)
    if (manifestDate && manifestDate === dateStr) {
      return resolveTimetableOrigin(manifest, history, '', slot)
    }
    return { error: 'date not found', status: 404, availableDates: items.map(e => e.date).filter(Boolean) }
  }
  const images = Array.isArray(entry.images) ? entry.images : []
  if (!images.length || slot >= images.length) {
    return { error: 'slot not found', status: 404 }
  }
  const rawDir = String(entry.dir || `history/${entry.date}`)
  if (!/^history\/\d{4}-\d{2}-\d{2}$/.test(rawDir)) return { error: 'invalid dir entry', status: 500 }
  if (rawDir !== `history/${entry.date}`) return { error: 'invalid dir entry', status: 500 }
  const file = String(images[slot].file || '')
  if (!/^slot-\d+\.(jpg|jpeg|png|webp|gif|bin)$/i.test(file)) return { error: 'invalid file entry', status: 500 }
  return { dir: rawDir, file, date: entry.date, updatedAt: entry.updatedAt || '' }
}

/** Firestore からAPIキーのドキュメントを読む（管理者権限・サービスアカウント） */
async function fetchTimetableApiKeyDoc(keyId, env) {
  const projectId = env.FIREBASE_PROJECT_ID
  if (!projectId) return { ok: false, error: 'FIREBASE_PROJECT_ID not set' }
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return { ok: false, error: 'service account not set' }
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${TIMETABLE_API_COLLECTION}/${encodeURIComponent(keyId)}`
  const res = await firestoreFetch(env, url)
  if (res.status === 404) return { ok: false, notFound: true }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('[timetable-api] key doc fetch failed:', res.status, detail.slice(0, 200))
    return { ok: false, error: `key lookup failed (${res.status})` }
  }
  const doc = await res.json().catch(() => null)
  return { ok: true, fields: timetableRestToPlain(doc && doc.fields) }
}

/** APIキーを検証する。成功時は { ok:true, keyId, key }、失敗時は { ok:false, status, error } */
async function verifyTimetableApiKey(presentedKey, env) {
  if (!presentedKey) {
    return { ok: false, status: 401, error: 'api key required (X-API-Key header or ?key=)' }
  }
  if (!isValidTimetableKeyFormat(presentedKey)) {
    return { ok: false, status: 401, error: 'invalid api key' }
  }
  const keyId = timetableKeyIdFromKey(presentedKey)
  const fetched = await fetchTimetableApiKeyDoc(keyId, env)
  if (fetched.notFound) return { ok: false, status: 401, error: 'invalid api key' }
  if (!fetched.ok) {
    // 設定不備は 503（呼び出し側のリトライで直る類ではないことを明示）
    const status = /not set/.test(fetched.error || '') ? 503 : 500
    return { ok: false, status, error: fetched.error || 'key lookup failed' }
  }
  const f = fetched.fields || {}
  if (f.revoked === true) return { ok: false, status: 403, error: 'api key revoked' }
  const expected = String(f.keyHash || '')
  if (!expected) return { ok: false, status: 500, error: 'api key misconfigured' }
  const actual = await sha256Hex(presentedKey)
  if (!timetableTimingSafeEqual(actual, expected)) {
    return { ok: false, status: 401, error: 'invalid api key' }
  }
  // 日次 quota の判定（読み取った値で判定・更新は別途 best-effort）
  const quota = Number(f.quotaDaily || TIMETABLE_API_DEFAULT_QUOTA)
  const today = timetableTodayJst()
  const countToday = (f.dailyDate === today) ? Number(f.dailyCount || 0) : 0
  if (countToday >= quota) {
    return { ok: false, status: 429, error: 'daily quota exceeded' }
  }
  return { ok: true, keyId, key: f, today, countToday, quota }
}

/** 利用回数を best-effort で加算する（失敗しても本処理は止めない） */
async function touchTimetableApiKeyUsage(env, keyId, prev, today) {
  try {
    const projectId = env.FIREBASE_PROJECT_ID
    if (!projectId || !env.FIREBASE_SERVICE_ACCOUNT_JSON) return
    const sameDay = prev && prev.dailyDate === today
    const dailyCount = (sameDay ? Number(prev.dailyCount || 0) : 0) + 1
    const totalCount = Number(prev.totalCount || 0) + 1
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${TIMETABLE_API_COLLECTION}/${encodeURIComponent(keyId)}`
      + `?updateMask.fieldPaths=dailyDate&updateMask.fieldPaths=dailyCount&updateMask.fieldPaths=totalCount&updateMask.fieldPaths=lastUsedAt`
    await firestoreFetch(env, url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          dailyDate: { stringValue: today },
          dailyCount: { integerValue: String(dailyCount) },
          totalCount: { integerValue: String(totalCount) },
          lastUsedAt: { timestampValue: new Date().toISOString() },
        },
      }),
    })
  } catch (e) {
    console.error('[timetable-api] usage touch failed:', e && e.message || e)
  }
}

function timetableApiError(status, error, extra) {
  return json({ ok: false, error, ...(extra || {}) }, status)
}

/** origin の manifest/history を取得する */
async function fetchTimetableOrigin(env) {
  const base = (env.APP_BASE_URL || 'https://mito1-tetyo.tech').replace(/\/$/, '')
  const fetchJson = async (path) => {
    const res = await fetch(`${base}${path}`, { headers: { 'User-Agent': 'mito1-timetable-api/1.0' } })
    if (!res.ok) throw new Error(`${path} fetch failed (${res.status})`)
    return res.json()
  }
  const [manifest, historyRaw] = await Promise.all([
    fetchJson('/timetable/manifest.json'),
    fetchJson('/timetable/history.json').catch(() => []),
  ])
  const history = Array.isArray(historyRaw) ? historyRaw : (Array.isArray(historyRaw && historyRaw.items) ? historyRaw.items : [])
  return { base, manifest, history }
}

/** GET /api/v1/timetable/list */
async function timetableListApi(request, url, env, ctx) {
  const key = extractTimetableApiKey(request, url)
  const auth = await verifyTimetableApiKey(key, env)
  if (!auth.ok) return timetableApiError(auth.status, auth.error)
  if (ctx && ctx.waitUntil) ctx.waitUntil(touchTimetableApiKeyUsage(env, auth.keyId, auth.key, auth.today))
  else await touchTimetableApiKeyUsage(env, auth.keyId, auth.key, auth.today)

  let origin
  try {
    origin = await fetchTimetableOrigin(env)
  } catch (e) {
    console.error('[timetable-api] origin fetch failed:', e)
    return timetableApiError(502, 'timetable origin unavailable')
  }
  // origin URL は一切含めない（API相対パスのみ）
  const workerOrigin = new URL(request.url).origin
  return json(buildTimetableListResponse(origin.manifest, origin.history, workerOrigin))
}

/** GET /api/v1/timetable/image?date=YYYY-MM-DD&slot=0 */
async function timetableImageApi(request, url, env, ctx) {
  const key = extractTimetableApiKey(request, url)
  const auth = await verifyTimetableApiKey(key, env)
  if (!auth.ok) return timetableApiError(auth.status, auth.error)

  const dateRaw = url.searchParams.get('date') || ''
  const slotRaw = url.searchParams.get('slot') ?? '0'
  let dateStr = ''
  if (dateRaw) {
    dateStr = sanitizeTimetableDate(dateRaw)
    if (!dateStr) return timetableApiError(400, 'invalid date (expected YYYY-MM-DD)')
  }
  const slot = sanitizeTimetableSlot(slotRaw)
  if (slot < 0) return timetableApiError(400, 'invalid slot (expected 0-9)')

  let origin
  try {
    origin = await fetchTimetableOrigin(env)
  } catch (e) {
    console.error('[timetable-api] origin fetch failed:', e)
    return timetableApiError(502, 'timetable origin unavailable')
  }
  // 直近7件の範囲外は 404（過去の蓄積は HISTORY_KEEP=7 のため）
  const resolved = resolveTimetableOrigin(origin.manifest, origin.history, dateStr, slot)
  if (resolved.error) {
    return timetableApiError(resolved.status || 404, resolved.error,
      resolved.availableDates ? { availableDates: resolved.availableDates.slice(0, TIMETABLE_API_KEEP) } : undefined)
  }
  // 7件ルール: history に無い古い日付は history.json 自体に残っていないため 404 になる。
  // 万一 history.json が7件超で返ってきた場合も直近7件に丸める。
  const { latest, history } = filterTimetableList(origin.manifest, origin.history)
  const inRange = !resolved.date
    || (latest && latestDateOfManifest(origin.manifest, origin.history) === resolved.date)
    || history.some(e => e && e.date === resolved.date)
  if (!inRange) {
    return timetableApiError(404, 'date out of range (last 7 only)',
      { availableDates: [latestDateOfManifest(origin.manifest, origin.history), ...history.map(e => e.date)].filter(Boolean).slice(0, TIMETABLE_API_KEEP) })
  }

  const originPath = resolved.dir ? `/timetable/${resolved.dir}/${resolved.file}` : `/timetable/${resolved.file}`
  let imgRes
  try {
    imgRes = await fetch(`${origin.base}${originPath}`, { headers: { 'User-Agent': 'mito1-timetable-api/1.0' } })
  } catch (e) {
    console.error('[timetable-api] image fetch failed:', e)
    return timetableApiError(502, 'timetable image unavailable')
  }
  if (!imgRes.ok) {
    console.error('[timetable-api] image origin status:', imgRes.status, originPath)
    return timetableApiError(502, 'timetable image unavailable')
  }
  const bytes = new Uint8Array(await imgRes.arrayBuffer())
  if (!bytes.length) return timetableApiError(502, 'timetable image unavailable')

  if (ctx && ctx.waitUntil) ctx.waitUntil(touchTimetableApiKeyUsage(env, auth.keyId, auth.key, auth.today))
  else await touchTimetableApiKeyUsage(env, auth.keyId, auth.key, auth.today)

  return new Response(bytes, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': timetableContentType(resolved.file),
      'Cache-Control': 'private, max-age=300',
      'Content-Disposition': 'inline',
      'X-Timetable-Date': resolved.date || '',
      'X-Timetable-Slot': String(slot),
    },
  })
}

/** GET /api/v1/timetable/diag（疎通確認・Key必須） */
async function timetableDiagApi(request, url, env) {
  const key = extractTimetableApiKey(request, url)
  const auth = await verifyTimetableApiKey(key, env)
  if (!auth.ok) return timetableApiError(auth.status, auth.error)
  try {
    const origin = await fetchTimetableOrigin(env)
    const { latest, history } = filterTimetableList(origin.manifest, origin.history)
    return json({
      ok: true,
      base: origin.base,
      latestDate: latestDateOfManifest(origin.manifest, origin.history),
      latestUpdatedAt: (origin.manifest && origin.manifest.updatedAt) || '',
      historyCount: history.length,
      keep: TIMETABLE_API_KEEP,
      quota: { today: auth.today, used: auth.countToday, daily: auth.quota },
    })
  } catch (e) {
    return timetableApiError(502, 'timetable origin unavailable')
  }
}

// -- JSON response helper -----------------------------------------------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// =======================================================================
// Cron Trigger → GitHub repository_dispatch（時間割ポーリングの迂回路）
// =======================================================================
//
// GitHubのscheduleが発火しない場合に、Workers Cron（10分おき）から
// repository_dispatchイベントを作って timetable.yml を起動する。
// 必要なsecret（Dashboard > Worker > Settings > Variables and Secrets）:
//   GH_DISPATCH_PAT -- Fine-grained PAT（対象リポジトリのみ、Actions: Read and write）
//                      または classic PAT（public_repo）。コードには書かないこと。

/** dispatchリクエストの組み立て（純粋関数・テスト用） */
function buildDispatchRequest(pat) {
  return {
    url: 'https://api.github.com/repos/Ryuto-dev/mito1-digital-studenthandbook/dispatches',
    init: {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${pat}`,
        'User-Agent': 'mito1-timetable-cron',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'timetable-poll' }),
    },
  }
}

async function githubDispatch(env) {
  const pat = env.GH_DISPATCH_PAT || ''
  if (!pat) {
    console.error('[cron] GH_DISPATCH_PAT not set in Workers secrets')
    return
  }
  try {
    const { url, init } = buildDispatchRequest(pat)
    const res = await fetch(url, init)
    if (res.status !== 204) {
      console.error('[cron] dispatch failed:', res.status, (await res.text()).slice(0, 200))
    } else {
      console.log('[cron] dispatch sent: timetable-poll')
    }
  } catch (e) {
    console.error('[cron] dispatch network error:', e)
  }
}
