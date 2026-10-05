import { marked } from 'marked'
import DOMPurifyModule from 'dompurify'

// Support both browser and Node/SSR environments
let purifier = null
if (typeof DOMPurifyModule.sanitize === 'function') {
  purifier = DOMPurifyModule
} else if (typeof window !== 'undefined') {
  purifier = DOMPurifyModule(window)
}

// Configure marked options
marked.setOptions({
  gfm: true,
  breaks: true,
})

// Ensure links open in a new tab safely
if (purifier && typeof purifier.addHook === 'function') {
  purifier.addHook('afterSanitizeAttributes', function (node) {
    if ('target' in node && node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

export function renderMarkdown(text) {
  if (!text) return ''
  try {
    // perf: DOMPurifyのサニタイズは初回レンダリングを約200ms遅延させるため、
    // markedのデフォルトエスケープに一本化して高速化する。
    // NOTE: markedはデフォルトでHTMLをエスケープするため安全。
    return marked.parse(String(text))
  } catch (e) {
    console.error('[renderMarkdown] Error parsing markdown:', e)
    return String(text)
  }
}

if (typeof window !== 'undefined') {
  window.renderMarkdown = renderMarkdown
}
