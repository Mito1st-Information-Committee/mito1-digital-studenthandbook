import './markdown.js'
import { db } from './firebase.js'
import {
  collection, doc,
  getDocs, getDoc,
  orderBy, query
} from 'firebase/firestore'

// =============================================
// Firestoreから全データを取得してページを更新
// =============================================

async function fetchOrdered(col) {
  try {
    const q = query(collection(db, col), orderBy('order', 'asc'))
    const snap = await getDocs(q)
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch {
    // orderフィールドがない場合はそのまま取得
    const snap = await getDocs(collection(db, col))
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  }
}

async function fetchDoc(col, docId) {
  try {
    const snap = await getDoc(doc(db, col, docId))
    return snap.exists() ? snap.data() : null
  } catch {
    return null
  }
}

// =============================================
// 沿革
// =============================================
async function loadHistory() {
  const items = await fetchOrdered('history')
  if (!items.length) return

  const el = document.getElementById('historyListFront')
  if (!el) return

  el.innerHTML = items.map(item => `
    <li class="history-item">
      <span class="history-year">${item.year || ''}</span>
      <span class="history-event">${item.event || ''}</span>
    </li>
  `).join('')
}

// =============================================
// 歴代校長
// =============================================
async function loadPrincipals() {
  const items = await fetchOrdered('principals')
  if (!items.length) return

  items
    .sort((a, b) => {
      const toNumber = (value) => {
        const s = String(value ?? "")
          .trim()
          .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
        if (s.startsWith("初")) return 1;
        const m = s.match(/\d+/);
        return m ? Number.parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER;
      };

      return toNumber(a.gen) - toNumber(b.gen)
    })

  const el = document.getElementById('principalsListFront')
  if (!el) return

  el.innerHTML = items.map(item => `
    <li class="principal-item">
      <span class="principal-gen">${item.gen || ''}</span>
      <span class="principal-name">${item.name || ''}</span>
      <span class="principal-term">${item.term || ''}</span>
    </li>
  `).join('')
}

// =============================================
// 就学の目標
// =============================================
async function loadGoals() {
  const data = await fetchDoc('content', 'goals')
  if (!data) return

  const imgEl  = document.getElementById('goalsImageFront')
  const textEl = document.getElementById('goalsTextFront')

  if (imgEl && data.imageUrl) {
    imgEl.innerHTML = `<img src="${data.imageUrl}" alt="校是" style="max-width:100%;border-radius:var(--r)">`
  }
  if (textEl && data.text) {
    textEl.innerHTML = data.text
      .split('\n')
      .filter(Boolean)
      .map(line => `<p>${line}</p>`)
      .join('')
  }
}

// =============================================
// 歌詞（Issue #87: 音声URLが設定されていれば試聴プレイヤーを表示）
// audioUrl が無い旧データでも従来どおり歌詞のみ表示（後方互換）
// =============================================
function escAttrSong(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 音声URLとして利用できるのは絶対URLの http(s) のみ。
 * javascript:/data: 等は再生しない。相対パスも対象外（管理画面の保存時
 * バリデーション `^https?://` と一致させるため）。
 */
function isSafeSongAudioUrl(u) {
  if (typeof u !== 'string') return false
  const t = u.trim()
  if (!/^https?:\/\/.+/i.test(t)) return false
  try {
    const parsed = new URL(t)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

async function loadSongs() {
  const items = await fetchOrdered('songs')
  if (!items.length) return

  const el = document.getElementById('songsListFront')
  if (!el) return

  el.innerHTML = items.map(item => {
    const rawAudio = typeof item.audioUrl === 'string' ? item.audioUrl.trim() : ''
    const audioUrl = isSafeSongAudioUrl(rawAudio) ? rawAudio : ''
    const ttl = item.title || item.type || '歌詞'
    return `
    <div class="song-card">
      <div class="song-hdr">
        <div class="song-hdr-ttl">${ttl}</div>
        <div class="song-hdr-badge">
          ${[item.lyricist && `作詞：${item.lyricist}`, item.composer && `作曲：${item.composer}`]
            .filter(Boolean).join('　／　')}
        </div>
      </div>
      ${audioUrl ? `
      <div class="song-audio">
        <div class="song-audio-lbl">
          <span class="song-audio-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          </span>
          試聴する
        </div>
        <audio class="song-player" controls preload="none" src="${escAttrSong(audioUrl)}" aria-label="${escAttrSong(ttl)}の音声"></audio>
      </div>` : ''}
      <div class="song-verses">
        ${(item.verses || []).map((v, i) => `
          <div>
            <div class="verse-num">${i + 1}番</div>
            <div class="verse-text">${v.replace(/\n/g, '<br>')}</div>
          </div>
        `).join('')}
      </div>
    </div>
    `
  }).join('')

  // 複数の曲を同時再生しない（1つ再生したら他を止める）
  el.querySelectorAll('audio.song-player').forEach(a => {
    a.addEventListener('play', () => {
      el.querySelectorAll('audio.song-player').forEach(o => { if (o !== a) o.pause() })
    })
  })
}

// =============================================
// 項目のサブアイテム対応レンダリング
// 行頭がスペース/タブで始まる行 or ア〜ン で始まる行はサブアイテム
// 構造: 章 > 条 > (1) > ア, イ
// =============================================
function renderItemsWithSubItems(items) {
  if (!items || !items.length) return ''

  // Parse items into groups: main items with optional sub-items
  const groups = []
  let mainIdx = 0

  for (let i = 0; i < items.length; i++) {
    const line = items[i]
    const isSubItem = /^[\s\t　]+/.test(line) || /^[ア-ン][\s　.]/.test(line.trim())

    if (isSubItem && groups.length > 0) {
      // Attach as sub-item to the last main item
      groups[groups.length - 1].subs.push(line.trim())
    } else {
      mainIdx++
      groups.push({ idx: mainIdx, text: line, subs: [] })
    }
  }

  return groups.map(g => `
    <li class="item-row">
      <span class="item-idx">${g.idx}</span>
      <span>
        ${g.text}
        ${g.subs.length ? `
          <ul class="sub-list">
            ${g.subs.map(sub => {
              // Extract label (ア, イ, etc.) if present
              const match = sub.match(/^([ア-ン])\s*(.*)$/)
              if (match) {
                return `<li class="sub-row"><span class="sub-idx">${match[1]}</span><span>${match[2]}</span></li>`
              }
              return `<li class="sub-row"><span class="sub-idx">・</span><span>${sub}</span></li>`
            }).join('')}
          </ul>
        ` : ''}
      </span>
    </li>
  `).join('')
}

// =============================================
// 条文（諸規定・特別教育活動・生徒会憲章・生徒会関係諸規定）
// description（説明文/前文）やsection（総則/細則）にも対応
// =============================================
function renderArticles(items, containerId, tocId, options = {}) {
  const el  = document.getElementById(containerId)
  const toc = document.getElementById(tocId)
  if (!el) return

  let html     = ''
  let tocHtml  = ''
  let prevChapter = ''
  let prevSection = ''

  // description（説明文/前文）がある場合はページ冒頭に表示
  if (options.description) {
    html += `<div class="card" style="margin-bottom:18px">
      <div class="card-body" style="font-size:14px;color:var(--text-2);line-height:2.0;white-space:pre-wrap">${options.description}</div>
    </div>`
    tocHtml += `<a class="toc-lnk sub" style="font-style:italic;color:var(--text-3)">説明・前文</a>`
  }

  // preamble（前文テキスト — 憲章用）
  if (options.preamble) {
    html += `<div class="card" style="margin-bottom:18px">
      <div class="card-h2">前文</div>
      <div class="card-body" style="font-size:14px;color:var(--text-2);line-height:2.0;white-space:pre-wrap">${options.preamble}</div>
    </div>`
    tocHtml += `<a class="toc-lnk sub" style="font-weight:600">前文</a>`
  }

  items.forEach(item => {
    // セクション見出し（総則/細則）
    if (item.section && item.section !== prevSection) {
      html += `<div class="chapter-div" style="background:rgba(139,26,44,.06);border-left-color:var(--enjii);font-size:15px;margin-top:28px">${item.section}</div>`
      tocHtml += `<a class="toc-lnk sub" style="font-weight:700;color:var(--enjii)">${item.section}</a>`
      prevSection = item.section
    }

    // 章見出し
    if (item.chapter && item.chapter !== prevChapter) {
      html += `<div class="chapter-div">${item.chapter}</div>`
      tocHtml += `<a class="toc-lnk sub">${item.chapter}</a>`
      prevChapter = item.chapter
    }

    // 条文本体
    const artId = `${containerId}-${item.id}`
    html += `
      <div class="article" id="${artId}">
        <div class="art-hdr">
          <span class="art-num">${item.number || ''}</span>
          ${item.title ? `<span class="art-title">${item.title}</span>` : ''}
        </div>
        <div class="art-body">
          ${item.body ? `<div class="art-main">${item.body}</div>` : ''}
          ${(item.items || []).length ? `
            <ol class="items-list">
              ${renderItemsWithSubItems(item.items)}
            </ol>
          ` : ''}
        </div>
      </div>
    `

    tocHtml += `
      <a class="toc-lnk" onclick="scrollArt('${artId}')">
        ${item.number}${item.title ? `　${item.title}` : ''}
      </a>
    `
  })

  el.innerHTML = html
  if (toc) toc.innerHTML = tocHtml
}

async function loadArticles(col, containerId, tocId) {
  const items = await fetchOrdered(col)

  // コンテンツドキュメントから description / preamble を取得
  const contentDoc = await fetchDoc('content', col)
  const options = {}
  if (contentDoc) {
    if (contentDoc.description) options.description = contentDoc.description
    if (contentDoc.preamble) options.preamble = contentDoc.preamble
  }

  if (!items.length && !options.description && !options.preamble) return
  renderArticles(items, containerId, tocId, options)

  const label = `全${items.length}条`

  // サイドバーバッジ
  const badgeIds = {
    'rules':          'sbBadgeRules',
    'special':        'sbBadgeSpecial',
    'council-charter':'sbBadgeCharter',
    'council-rules':  'sbBadgeCouncilRules',
  }
  const bid = badgeIds[col]
  if (bid) {
    const el = document.getElementById(bid)
    if (el) { el.textContent = label; el.style.display = '' }
  }

  // ページのpg-meta
  const metaIds = {
    'rules':          'rulesMetaCount',
    'special':        'specialMetaCount',
    'council-charter':'charterMetaCount',
    'council-rules':  'councilRulesMetaCount',
  }
  const mid = metaIds[col]
  if (mid) {
    const el = document.getElementById(mid)
    if (el) el.textContent = label
  }

  // ホームカード（rulesのみ）
  if (col === 'rules') {
    const ce = document.getElementById('rulesCardCount')
    if (ce) ce.textContent = `条文検索・${label}`
  }
}

// =============================================
// 年間主要行事
// =============================================
async function loadEvents() {
  const items = await fetchOrdered('events')
  if (!items.length) return

  const el = document.getElementById('eventsListFront')
  if (!el) return

  // 月ごとにグループ化
  const byMonth = {}
  items.forEach(item => {
    const m = String(item.month || 1)
    if (!byMonth[m]) byMonth[m] = []
    byMonth[m].push(item)
  })

  const months = ['1','2','3','4','5','6','7','8','9','10','11','12']
  el.innerHTML = months
    .filter(m => byMonth[m])
    .map(m => `
      <div class="ev-month">
        <div class="ev-month-hdr">
          <span class="ev-month-name">${m}月</span>
          <span class="ev-month-num">${m}</span>
        </div>
        <div class="ev-items">
          ${byMonth[m].map(item => `
            <div class="ev-item">
              <div class="ev-bullet"></div>
              <div class="ev-name">${item.name || ''}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('')
}

// =============================================
// 教育課程
// =============================================
async function loadCurriculum() {
  const items = await fetchOrdered('curriculum')
  if (!items.length) return

  const el = document.getElementById('curriculumTableFront')
  if (!el) return

  // 入学年度ごとにグループ化
  const byYear = {}
  items.forEach(item => {
    const y = item.year || '2024'
    if (!byYear[y]) byYear[y] = []
    byYear[y].push(item)
  })

  const years = Object.keys(byYear).sort().reverse()

  // タブHTML
  const tabsEl = document.getElementById('curriculumTabsFront')
  if (tabsEl) {
    tabsEl.innerHTML = years.map((y, i) => `
      <button class="year-tab ${i === 0 ? 'on' : ''}"
        onclick="switchCurriculumYear('${y}', this)">
        ${y}年度入学
      </button>
    `).join('')
  }

  // テーブルHTML（年度ごと）
  el.innerHTML = years.map((y, i) => `
    <div class="curriculum-year-table ${i === 0 ? '' : 'hidden-yr'}" data-year="${y}">
      <div class="table-outer">
        <table>
          <thead>
            <tr>
              <th>教科</th><th>科目</th>
              <th>1年</th><th>2年</th><th>3年</th><th>必選</th>
            </tr>
          </thead>
          <tbody>
            ${byYear[y].map(r => `
              <tr>
                <td>${r.subject || ''}</td>
                <td>${r.course  || ''}</td>
                <td style="text-align:center">${r.y1 || '—'}</td>
                <td style="text-align:center">${r.y2 || '—'}</td>
                <td style="text-align:center">${r.y3 || '—'}</td>
                <td style="text-align:center">${r.required || ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `).join('')
}

// 年度タブ切り替え（グローバルに公開）
window.switchCurriculumYear = (year, btn) => {
  document.querySelectorAll('.curriculum-year-table').forEach(el => {
    el.classList.toggle('hidden-yr', el.dataset.year !== year)
  })
  document.querySelectorAll('#curriculumTabsFront .year-tab').forEach(t => t.classList.remove('on'))
  btn.classList.add('on')
}

// =============================================
// 生徒会活動（1枠統合）
// =============================================
async function loadCouncilActivities() {
  const data = await fetchDoc('content', 'council-activities')
  const el = document.getElementById('councilActivitiesFront')
  if (!el) return

  // overview を1枠で表示（committees は legacy フィールド）
  const text = [data?.overview, data?.committees].filter(Boolean).join('\n\n')
  if (!text) {
    el.innerHTML = '<p style="color:var(--text-3)">データがありません</p>'
    return
  }
  el.innerHTML = text.split('\n').filter(l => l !== undefined).map(line =>
    line.trim() === '' ? '<br>' : `<p>${line}</p>`
  ).join('')
}

// =============================================
// 検索インデックスをFirestoreから動的生成
// 全条文・説明文・前文を完全に格納
// =============================================
async function buildSearchIndex() {
  const [rules, special, events, history, principals, charter, councilRules, songs, goals] = await Promise.all([
    fetchOrdered('rules'),
    fetchOrdered('special'),
    fetchOrdered('events'),
    fetchOrdered('history'),
    fetchOrdered('principals'),
    fetchOrdered('council-charter'),
    fetchOrdered('council-rules'),
    fetchOrdered('songs'),
    fetchDoc('content', 'goals'),
  ])

  // コンテンツドキュメント（description/preamble）を取得
  const [specialContent, charterContent, councilRulesContent, councilActivitiesContent] = await Promise.all([
    fetchDoc('content', 'special'),
    fetchDoc('content', 'council-charter'),
    fetchDoc('content', 'council-rules'),
    fetchDoc('content', 'council-activities'),
  ])

  const index = []

  rules.forEach(item => {
    const fullText = [item.body || '', ...(item.items || [])].join(' ')
    index.push({
      path: `諸規定 › ${item.number}`,
      title: item.title || item.number,
      snip: fullText,
      page: 'rules',
      id: `rulesContentFront-${item.id}`,
      tags: [item.title || '', item.chapter || ''].join(' '),
    })
  })

  special.forEach(item => {
    const fullText = [item.body || '', ...(item.items || [])].join(' ')
    index.push({
      path: `特別教育活動 › ${item.number}`,
      title: item.title || item.number,
      snip: fullText,
      page: 'special',
      id: `specialContentFront-${item.id}`,
      tags: [item.title || '', item.chapter || ''].join(' '),
    })
  })

  // 特別教育活動の説明文
  if (specialContent?.description) {
    index.push({
      path: '特別教育活動 › 説明',
      title: '特別教育活動について',
      snip: specialContent.description,
      page: 'special',
      tags: '特別教育活動 目的 説明',
    })
  }

  events.forEach(item => {
    index.push({
      path: `年間主要行事 › ${item.month}月`,
      title: `${item.month}月 — ${item.name}`,
      snip: item.name || '',
      page: 'events',
      tags: `${item.month}月 行事`,
    })
  })

  history.forEach(item => {
    index.push({
      path: '本校の沿革',
      title: item.year || '',
      snip: item.event || '',
      page: 'about',
      tags: '沿革 歴史',
    })
  })

  principals.forEach(item => {
    index.push({
      path: '歴代校長一覧',
      title: `${item.gen || ''} ${item.name || ''}`,
      snip: `${item.name || ''} ${item.term || ''}`,
      page: 'principals',
      tags: '歴代校長 校長',
    })
  })

  charter.forEach(item => {
    const fullText = [item.body || '', ...(item.items || [])].join(' ')
    index.push({
      path: `知道生徒会憲章 › ${item.number}`,
      title: item.title || item.number,
      snip: fullText,
      page: 'council-charter',
      id: `charterContentFront-${item.id}`,
      tags: [item.title || '', item.chapter || '', item.section || ''].join(' '),
    })
  })

  // 憲章の前文
  if (charterContent?.preamble) {
    index.push({
      path: '知道生徒会憲章 › 前文',
      title: '知道生徒会憲章 前文',
      snip: charterContent.preamble,
      page: 'council-charter',
      tags: '憲章 前文',
    })
  }

  councilRules.forEach(item => {
    const fullText = [item.body || '', ...(item.items || [])].join(' ')
    index.push({
      path: `生徒会関係諸規定 › ${item.number}`,
      title: item.title || item.number,
      snip: fullText,
      page: 'council-rules',
      id: `councilRulesContentFront-${item.id}`,
      tags: [item.title || '', item.chapter || ''].join(' '),
    })
  })

  // 歌詞
  songs.forEach(item => {
    index.push({
      path: `歌詞 › ${item.type || ''}`,
      title: item.title || item.type || '',
      snip: (item.verses || []).join('\n'),
      page: 'songs',
      tags: '歌詞 校歌 応援歌',
    })
  })

  // 就学の目標
  if (goals?.text) {
    index.push({
      path: '就学の目標',
      title: '就学の目標',
      snip: goals.text,
      page: 'goals',
      tags: '就学 目標 校是',
    })
  }

  // 生徒会活動
  if (councilActivitiesContent?.overview) {
    index.push({
      path: '生徒会活動',
      title: '生徒会活動',
      snip: councilActivitiesContent.overview,
      page: 'council-activities',
      tags: '生徒会 活動',
    })
  }

  // グローバルの検索インデックスを動的データで更新
  window.DYNAMIC_SEARCH_INDEX = index

  // 全データをキャッシュ（AI用）
  window._allArticleData = { rules, special, charter, councilRules, principals, songs, history, specialContent, charterContent, councilRulesContent }
}

// =============================================
// 全データ一括ロード
// =============================================
export async function loadAllData() {
  await Promise.all([
    loadHistory(),
    loadPrincipals(),
    loadGoals(),
    loadSongs(),
    loadEvents(),
    loadCurriculum(),
    loadTimetable(),
    loadCouncilActivities(),
    loadArticles('rules',           'rulesContentFront',   'rulesTocFront'),
    loadArticles('special',         'specialContentFront', 'specialTocFront'),
    loadArticles('council-charter', 'charterContentFront', 'charterTocFront'),
    loadArticles('council-rules',   'councilRulesContentFront', 'councilRulesTocFront'),
    buildSearchIndex(),
  ])
  // AIコンテキスト生成（Firestoreデータの完全サマリー）
  buildAIContext()
}

// =============================================
// AIコンテキスト生成
// 全条文の完全なテキストをAIに送れるようにキャッシュ
// =============================================
function buildAIContext() {
  if (!window.DYNAMIC_SEARCH_INDEX || !window.DYNAMIC_SEARCH_INDEX.length) return

  const data = window._allArticleData || {}

  const lines = []

  // 諸規定（全文）
  if (data.rules?.length) {
    lines.push('========== 諸規定（本則） ==========')
    data.rules.forEach(r => {
      let text = `${r.number}`
      if (r.title) text += `（${r.title}）`
      if (r.chapter) text += ` [${r.chapter}]`
      if (r.body) text += `\n${r.body}`
      if (r.items?.length) text += '\n' + r.items.map(it => {
        const isSubItem = /^[\s\t　]+/.test(it) || /^[ア-ン][\s　.]/.test(it.trim())
        return isSubItem ? `      ${it.trim()}` : `  ${it}`
      }).join('\n')
      lines.push(text)
    })
  }

  // 特別教育活動（説明文＋全文）
  if (data.specialContent?.description || data.special?.length) {
    lines.push('\n========== 特別教育活動 ==========')
    if (data.specialContent?.description) {
      lines.push('[説明文]\n' + data.specialContent.description)
    }
    data.special?.forEach(r => {
      let text = `${r.number}`
      if (r.title) text += `（${r.title}）`
      if (r.chapter) text += ` [${r.chapter}]`
      if (r.body) text += `\n${r.body}`
      if (r.items?.length) text += '\n' + r.items.map((it, i) => `  ${i + 1}. ${it}`).join('\n')
      lines.push(text)
    })
  }

  // 知道生徒会憲章（前文＋全文）
  if (data.charterContent?.preamble || data.charter?.length) {
    lines.push('\n========== 知道生徒会憲章 ==========')
    if (data.charterContent?.preamble) {
      lines.push('[前文]\n' + data.charterContent.preamble)
    }
    data.charter?.forEach(r => {
      let text = `${r.number}`
      if (r.title) text += `（${r.title}）`
      if (r.section) text += ` {${r.section}}`
      if (r.chapter) text += ` [${r.chapter}]`
      if (r.body) text += `\n${r.body}`
      if (r.items?.length) text += '\n' + r.items.map((it, i) => `  ${i + 1}. ${it}`).join('\n')
      lines.push(text)
    })
  }

  // 生徒会関係諸規定（全文）
  if (data.councilRules?.length) {
    lines.push('\n========== 生徒会関係諸規定 ==========')
    data.councilRules.forEach(r => {
      let text = `${r.number}`
      if (r.title) text += `（${r.title}）`
      if (r.chapter) text += ` [${r.chapter}]`
      if (r.body) text += `\n${r.body}`
      if (r.items?.length) text += '\n' + r.items.map((it, i) => `  ${i + 1}. ${it}`).join('\n')
      lines.push(text)
    })
  }

  // 歴代校長
  if (data.principals?.length) {
    lines.push('\n========== 歴代校長一覧 ==========')
    data.principals.forEach(p => {
      lines.push(`${p.gen || ''} ${p.name || ''} （${p.term || ''}）`)
    })
  }

  // 歌詞
  if (data.songs?.length) {
    lines.push('\n========== 歌詞 ==========')
    data.songs.forEach(s => {
      lines.push(`[${s.type || ''}] ${s.title || ''}`)
      if (s.lyricist) lines.push(`作詞：${s.lyricist}`)
      if (s.composer) lines.push(`作曲：${s.composer}`)
      ;(s.verses || []).forEach((v, i) => {
        lines.push(`${i + 1}番\n${v}`)
      })
    })
  }

  // 沿革
  if (data.history?.length) {
    lines.push('\n========== 本校の沿革 ==========')
    data.history.forEach(h => {
      lines.push(`${h.year || ''} ${h.event || ''}`)
    })
  }

  window._aiContext = lines.join('\n')
    // トークン節約: 行末空白の除去・3連以上の改行を2つに圧縮（内容は不変）
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// =============================================
// 時間割（Actionsが5分おきに同期する静的ファイル）
// public/timetable/manifest.json + slot-*
//   loadTimetable: マニフェスト取得＋文言＋NEWバッジ（軽量・無条件）
//   renderTimetableImages: 画像バイトの取得・描画はβ通過時とページ表示時のみ。
//     β対象外のユーザーに画像を取得させないための分離。
//
// PWAのService WorkerがGETをネットワーク優先→失敗時キャッシュで扱うため、
// 通常は古い画像が出続けることはない。ただし前日14時ごろの更新直後に
// 端末側の一時的なキャッシュ/オフラインで古い表示が残るケースに備え、
// manifest.json は常に cache:'no-store' で取得し、更新ボタン・通知経由の
// 遷移時は window._timetableManifest のキャッシュを使わず強制再取得する。
// =============================================
// フローティングウィジェット用の短い更新日時「D日 H時更新」
function shortTimetableLabel(updatedAt) {
  if (!updatedAt) return ''
  const m = String(updatedAt).match(/^\d{4}-\d{2}-(\d{2})T(\d{2}):\d{2}/)
  if (!m) return ''
  const day = Number(m[1])
  const hour = Number(m[2])
  return `${day}日 ${hour}時更新`
}

async function loadTimetable(force) {
  let manifest = null
  try {
    const res = await fetch(`timetable/manifest.json?_=${Date.now()}`, { cache: 'no-store' })
    if (res.ok) manifest = await res.json()
  } catch {
    // まだ初回同期前
  }

  const meta = document.getElementById('timetableMeta')
  const widgetSub = document.getElementById('ttWidgetSub')

  if (!manifest?.images?.length) {
    if (meta) meta.textContent = '準備中'
    if (widgetSub) widgetSub.textContent = '準備中'
    return null
  }

  window._timetableManifest = manifest
  window._timetableUpdatedAt = manifest.updatedAt || ''
  if (meta) meta.textContent = manifest.updatedAtLabel || ''
  // ウィジェットは横幅が限られるため「M月D日 H時更新」の短い表記にする
  if (widgetSub) widgetSub.textContent = shortTimetableLabel(manifest.updatedAt) || '自動更新'

  // NEWバッジ（開いたら既読になる。既読処理はnavラッパー側）
  try {
    const seen = localStorage.getItem('timetableSeenAt')
    const isNew = !!manifest.updatedAt && seen !== manifest.updatedAt
    ;['sbBadgeTimetable', 'ttWidgetBadge'].forEach(id => {
      const badge = document.getElementById(id)
      if (badge) {
        badge.textContent = isNew ? 'NEW' : ''
        badge.style.display = isNew ? '' : 'none'
      }
    })
  } catch { /* ignore */ }
  return manifest
}

/**
 * 時間割画像の描画。
 * force=true のときは同一updatedAtでも再取得・再描画する
 * （更新ボタン・通知からの遷移時に古いDOMが残らないようにするため）。
 * manifest.json は外部同期由来なので、file名はエンコードして埋め込む。
 */
window.renderTimetableImages = async function(force) {
  const el = document.getElementById('timetableImagesFront')
  if (!el) return
  if (!window._timetableManifest || force) {
    await loadTimetable(force)
  }
  const manifest = window._timetableManifest
  if (!manifest?.images?.length) {
    el.innerHTML = '<p style="padding:40px;text-align:center;color:var(--text-3);font-size:13px">時間割はまだ登録されていません</p>'
    el.dataset.renderedAt = ''
    return
  }
  if (!force && el.dataset.renderedAt === manifest.updatedAt) return
  const v = encodeURIComponent(`${manifest.updatedAt || ''}-${Date.now()}`)
  el.innerHTML = manifest.images.map((im, i) => `
    <div style="margin-bottom:12px">
      <img src="timetable/${encodeURIComponent(im.file)}?v=${v}" alt="時間割${i + 1}" loading="lazy"
        style="width:100%;border-radius:var(--r);display:block"
        onerror="this.style.display='none';document.getElementById('ttImgErr${i}').style.display=''">
      <p id="ttImgErr${i}" style="display:none;padding:24px;text-align:center;color:var(--text-3);font-size:13px">画像を読み込めませんでした</p>
    </div>
  `).join('')
  el.dataset.renderedAt = manifest.updatedAt
}

/**
 * 過去1週間分の時間割（折りたたみ内に表示）。
 * timetable/history.json を取得し、最新と同一updatedAtの entry は
 * 上の最新表示と重複するため除外する。画像は <details> を開いた初回のみ
 * 取得する（閉じている間の通信量を抑えるため）。
 */
function formatHistoryDate(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return dateStr || ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()] || ''
  return `${Number(m[2])}月${Number(m[3])}日（${wd}）`
}

window.renderTimetableHistory = async function(force) {
  const wrap = document.getElementById('timetableHistoryWrap')
  const listEl = document.getElementById('timetableHistoryList')
  const summaryEl = document.getElementById('timetableHistorySummary')
  if (!wrap || !listEl) return
  if (!force && listEl.dataset.rendered === '1') return
  listEl.dataset.rendered = ''
  listEl.innerHTML = '<p style="font-size:12px;color:var(--text-3)">読み込み中...</p>'
  let items = []
  try {
    const res = await fetch(`timetable/history.json?_=${Date.now()}`, { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json()
      items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [])
    }
  } catch {
    // 導入直後など history.json 未生成時は空扱い
  }
  // 最新表示と重複する当日分を除外（updatedAt一致 or 最新manifestと同ハッシュ集合）
  const latestAt = window._timetableUpdatedAt || window._timetableManifest?.updatedAt || ''
  const latestHashes = new Set((window._timetableManifest?.images || []).map(im => im.hash).filter(Boolean))
  const past = items.filter(it => {
    if (!it || !it.date) return false
    if (latestAt && it.updatedAt && it.updatedAt === latestAt) return false
    if (latestHashes.size && Array.isArray(it.images) && it.images.length) {
      const hs = it.images.map(im => im.hash).filter(Boolean)
      if (hs.length && hs.every(h => latestHashes.has(h)) && hs.length === latestHashes.size) return false
    }
    return true
  })
  if (summaryEl) summaryEl.textContent = past.length ? `過去1週間分の時間割を見る（${past.length}件）` : '過去1週間分の時間割を見る'
  if (!past.length) {
    listEl.innerHTML = '<p style="font-size:12px;color:var(--text-3)">まだ過去の時間割はありません（導入後の更新分から蓄積されます）</p>'
    listEl.dataset.rendered = '1'
    return
  }
  listEl.innerHTML = past.map(entry => {
    // dir は history.json 由来のためセグメントごとにエンコードする
    // （dir 全体を encodeURIComponent すると / が %2F になり404になる）
    const dir = String(entry.dir || `history/${entry.date}`).replace(/^\/+/, '')
      .split('/').map(s => encodeURIComponent(s)).join('/')
    const label = entry.updatedAtLabel || formatHistoryDate(entry.date)
    const imgs = (entry.images || []).map((im, i) => `
      <div style="margin-top:8px">
        <img src="timetable/${dir}/${encodeURIComponent(im.file)}" alt="過去の時間割 ${entry.date} ${i + 1}" loading="lazy"
          style="width:100%;border-radius:var(--r);display:block"
          onerror="this.style.display='none'">
      </div>`).join('')
    return `
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
        <div style="font-size:13px;font-weight:700">${formatHistoryDate(entry.date)}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">${label}</div>
        ${imgs}
      </div>`
  }).join('')
  listEl.dataset.rendered = '1'
}

function setupTimetableHistoryToggle() {
  if (window._timetableHistorySetup) return
  const wrap = document.getElementById('timetableHistoryWrap')
  if (!wrap) return
  window._timetableHistorySetup = true
  wrap.addEventListener('toggle', () => {
    if (wrap.open) window.renderTimetableHistory()
  })
}
// DOM構築前(モジュール実行時)に存在しない場合に備え、初回描画時にもbindする
setupTimetableHistoryToggle()
const _origRenderTimetableImages = window.renderTimetableImages
window.renderTimetableImages = async function(force) {
  setupTimetableHistoryToggle()
  if (force) {
    const hist = document.getElementById('timetableHistoryList')
    if (hist) hist.dataset.rendered = ''
  }
  const r = await _origRenderTimetableImages(force)
  // 開いている最中の再取得なら履歴も更新する
  const wrap = document.getElementById('timetableHistoryWrap')
  if (force && wrap && wrap.open) await window.renderTimetableHistory(true)
  return r
}

/**
 * 「更新」ボタン・通知経由の遷移から呼ばれる強制再取得。
 * PWAキャッシュ問題（Issue #85）対策: manifest.jsonをキャッシュ無視で
 * 取り直し、画像タグのクエリ文字列も毎回変えてブラウザ内キャッシュを回避する。
 */
window.refreshTimetable = async function() {
  const btn = document.getElementById('timetableRefreshBtn')
  const meta = document.getElementById('timetableMeta')
  if (btn) { btn.disabled = true; btn.classList.add('loading') }
  if (meta) meta.textContent = '更新中...'
  try {
    await window.renderTimetableImages(true)
    if (window._timetableUpdatedAt) {
      try { localStorage.setItem('timetableSeenAt', window._timetableUpdatedAt) } catch { /* ignore */ }
    }
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('loading') }
  }
}

// =============================================
// お問い合わせ送信（Firestoreへ保存）
// =============================================
export async function submitContactToFirestore(data) {
  const { addDoc, serverTimestamp } = await import('firebase/firestore')
  await addDoc(collection(db, 'contacts'), {
    name:     data.name     || '',
    email:    data.email    || '',
    category: data.category || 'other',
    subject:  data.subject  || '',
    body:     data.body     || '',
    status:   'new',
    reply:    '',
    createdAt: serverTimestamp(),
  })
}
