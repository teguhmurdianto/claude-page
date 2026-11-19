// Pure page building: no engine calls, so tests cover it whole.
// Everything from the session is untrusted: Markdown is rendered with raw HTML
// escaped and links limited to safe schemes; images show only from local files
// or data: URIs, a remote one is a link that loads nothing until clicked (an
// auto-loaded URL could carry session text out); the page's CSP enforces it.

import hljs from './vendor/highlight.esm.js'
import { Marked } from './vendor/marked.esm.js'
import type { TurnMark } from '../types'

export type Msg = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool: string; input: Record<string, unknown>; text?: string; isError?: true }[]
  /** Absolute paths of images pasted into this message, saved beside the page. */
  images?: readonly string[]
}

export type ImageSrc = { local: string } | { remote: string } | undefined

/** Where a Markdown image may come from: local file or data: image inline, http(s) as a link, nothing else. */
export function imageSrc(href: string, cwd: string): ImageSrc {
  // The scheme is judged with control characters and spaces removed (`java\tscript:`);
  // a path keeps its own spaces.
  const h = href.replace(/[\u0000- \u007f]/g, '')
  if (/^https?:/i.test(h)) return { remote: h }
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(h)) return { local: h }
  if (/^file:\/\//i.test(h)) return { local: h }
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return undefined
  const path = href.trim()
  return { local: fileUrl(path.startsWith('/') ? path : `${cwd}/${path}`) }
}

export function fileUrl(path: string): string {
  return `file://${encodeURI(path)}`
}

const TOOL_TEXT_MAX = 4000

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** http(s), mailto and scheme-less (relative, #anchor) links; everything else is dropped. */
export function safeHref(href: string): boolean {
  const h = href.replace(/[\u0000- \u007f]/g, '')
  return /^(https?:|mailto:)/i.test(h) || !/^[a-z][a-z0-9+.-]*:/i.test(h)
}

const markdown = (cwd: string) => new Marked({
  gfm: true,
  async: false,
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens)
      if (!safeHref(href)) return inner
      const t = title ? ` title="${escapeHtml(title)}"` : ''
      return `<a href="${escapeHtml(href)}"${t} rel="noopener noreferrer">${inner}</a>`
    },
    image({ href, text }) {
      const src = imageSrc(href, cwd)
      const alt = escapeHtml(text)
      if (src === undefined) return `<span class="img">[image: ${alt}]</span>`
      if ('remote' in src) return `<a class="img" href="${escapeHtml(src.remote)}" rel="noopener noreferrer">🖼 image: ${alt || 'remote'} (open)</a>`
      return `<img src="${escapeHtml(src.local)}" alt="${alt}" loading="lazy">`
    },
    code({ text, lang }) {
      const name = (lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      // Mermaid reads the block's text, so the escaped source draws as written.
      if (name === 'mermaid') return `<pre class="mermaid">${escapeHtml(text)}</pre>`
      return codeBlock(text, name)
    },
  },
})

/**
 * highlight.js output is the code escaped, inside <span class="hljs-…"> only.
 * Anything else would mean the highlighter let markup through, so the block
 * falls back to plain escaped text.
 */
function highlight(text: string, lang: string): string | undefined {
  if (lang === '' || hljs.getLanguage(lang) === undefined) return undefined
  try {
    const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
    return html.replace(/<span class="hljs-[\w. -]+">|<\/span>/g, '').includes('<') ? undefined : html
  } catch {
    return undefined
  }
}

/** A fenced block as chat apps show it: a bar naming the language (Copy joins it there), then the code, coloured. */
export function codeBlock(text: string, lang: string): string {
  const coloured = highlight(text, lang)
  const label = (lang && hljs.getLanguage(lang)?.name) || lang || 'text'
  const cls = lang ? ` class="hljs language-${escapeHtml(lang)}"` : ' class="hljs"'
  return `<div class="code"><div class="code-head"><span class="code-lang">${escapeHtml(label)}</span></div><pre><code${cls}>${coloured ?? escapeHtml(text)}</code></pre></div>\n`
}

export const MERMAID_MARK = '<pre class="mermaid">'

/**
 * Draws every Mermaid block: strict mode (no clicks, sanitised labels), theme
 * follows the system, and each diagram at its natural size (a wide one scrolls
 * in its block instead of shrinking its text to fit the column).
 */
const NATURAL = ['flowchart', 'sequence', 'class', 'state', 'er', 'gantt', 'journey', 'timeline', 'mindmap', 'gitGraph', 'pie', 'quadrantChart', 'xyChart', 'block', 'architecture']
  .map(d => `${d}:{useMaxWidth:false}`).join(',')
export const MERMAID_INIT = `mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'neutral',fontFamily:'Geist,sans-serif',${NATURAL}});mermaid.run({querySelector:'pre.mermaid',suppressErrors:true}).then(()=>{const t=document.getElementById(document.documentElement.dataset.at||'');t&&t.scrollIntoView({block:'start'})});`

/** `cwd` anchors relative image paths: the session's directory, not the page's. */
export function renderMarkdown(text: string, cwd = '/'): string {
  return markdown(cwd).parse(text, { async: false })
}

/** Drops the harness's injected blocks so only what people wrote remains. */
export function stripInjected(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim()
}

function clip(s: string): string {
  return s.length > TOOL_TEXT_MAX ? `${s.slice(0, TOOL_TEXT_MAX)}\n… (${s.length - TOOL_TEXT_MAX} more characters)` : s
}

/** The terminal's stand-in for a pasted image: `[Image #2]`. */
const IMAGE_REF = /^\[Image #\d+\]$/

/** A user message split into what was typed and the terminal events around it (slash commands, `!` shell runs). */
export type UserView = { prose: string; events: string[]; label: string }

const tag = (text: string, name: string) => [...text.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map(m => m[1] ?? '')

export function userView(raw: string): UserView {
  const text = stripInjected(raw)
  const events: string[] = []
  const names = tag(text, 'command-name')
  const args = tag(text, 'command-args')
  names.forEach((n, i) => {
    const a = (args[i] ?? '').trim()
    events.push(`<div class="ev"><span class="ev-cmd">${escapeHtml(n.trim())}</span>${a ? ` <span class="ev-args">${escapeHtml(a)}</span>` : ''}</div>`)
  })
  const bash = tag(text, 'bash-input')
  const outs = [...tag(text, 'bash-stdout'), ...tag(text, 'bash-stderr')].map(s => s.trim()).filter(Boolean)
  for (const b of bash) events.push(`<pre class="ev-out"><span class="ev-prompt">$</span> ${escapeHtml(b.trim())}${outs.length ? `\n${escapeHtml(clip(outs.join('\n')))}` : ''}</pre>`)
  if (bash.length === 0) for (const o of tag(text, 'local-command-stdout').map(s => s.trim()).filter(Boolean)) events.push(`<pre class="ev-out">${escapeHtml(clip(o))}</pre>`)
  const prose = text
    .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g, '')
    .trim()
  const first = (prose.split('\n').find(l => l.trim() !== '' && !IMAGE_REF.test(l.trim())) ?? names[0] ?? (bash[0] ? `! ${bash[0]}` : '')).trim()
  return { prose, events, label: first.length > 72 ? `${first.slice(0, 71)}…` : first }
}

type Use = Msg['toolUses'][number]

/** One line saying what a tool call was about: its description, command, path, pattern or query. */
function hint(use: Use): string {
  const i = use.input
  for (const k of ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'skill']) {
    const v = i[k]
    if (typeof v === 'string' && v.trim() !== '') {
      const line = v.trim().split('\n')[0] ?? ''
      return line.length > 90 ? `${line.slice(0, 89)}…` : line
    }
  }
  return ''
}

function toolRow(use: Use): string {
  const input = clip(JSON.stringify(use.input, null, 2))
  const text = use.text ?? ''
  const output = text.trim() === '' ? '' : `<pre class="${use.isError ? 'err' : ''}">${escapeHtml(clip(text))}</pre>`
  const h = hint(use)
  const state = use.isError ? '<span class="tool-err">failed</span>' : ''
  return `<details class="tool"><summary><span class="tool-name">${escapeHtml(use.tool)}</span>${h ? `<span class="tool-hint">${escapeHtml(h)}</span>` : ''}${state}</summary><pre>${escapeHtml(input)}</pre>${output}</details>`
}

/** A run of tool calls as one collapsed row: "5 tool calls · Bash ×3 · Read ×2". */
function toolGroup(id: string, uses: readonly Use[]): string {
  const counts = new Map<string, number>()
  for (const u of uses) counts.set(u.tool, (counts.get(u.tool) ?? 0) + 1)
  const kinds = [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(' · ')
  const failed = uses.filter(u => u.isError).length
  const head = `${uses.length} tool call${uses.length > 1 ? 's' : ''}`
  return `<details class="tools" id="${id}"><summary><span class="tools-head">${head}</span><span class="tools-kinds">${escapeHtml(kinds)}</span>${failed ? `<span class="tool-err">${failed} failed</span>` : ''}</summary><div class="tools-list">${uses.map(toolRow).join('')}</div></details>`
}

const INTERRUPT = /^\[Request interrupted by user[^\]]*\]$/
/** How the harness opens the summary it writes when it compacts a session. */
const SUMMARY = /^This session is being continued from a previous conversation/

type Item = { kind: 'text'; html: string } | { kind: 'tools'; id: string; uses: Use[] }
type Turn = { user?: { view: UserView; images: readonly string[] }; summary?: string; items: Item[] }

/** Groups the transcript into turns: a prompt of yours and everything Claude did until the next one. */
export function toTurns(messages: readonly Msg[], cwd = '/'): Turn[] {
  const turns: Turn[] = []
  let group = 0
  for (const m of messages) {
    if (m.role === 'user') {
      const images = m.images ?? []
      // With the image itself shown, its "[Image #N]" stand-in is noise.
      const view = userView(images.length > 0 ? m.text.replace(/\[Image #\d+\]/g, '') : m.text)
      if (view.prose === '' && view.events.length === 0 && images.length === 0) continue
      // A compaction summary is the harness's, not a prompt: it opens a turn of its own, folded.
      if (SUMMARY.test(view.prose)) {
        turns.push({ summary: renderMarkdown(view.prose, cwd), items: [] })
        continue
      }
      // The harness's own "[Request interrupted by user…]" ends the turn; it is not a prompt.
      if (INTERRUPT.test(view.prose) && view.events.length === 0 && images.length === 0) {
        if (turns.length === 0) turns.push({ items: [] })
        turns[turns.length - 1]!.items.push({ kind: 'text', html: `<p class="note">${escapeHtml(view.prose.slice(1, -1))}</p>` })
        continue
      }
      turns.push({ user: { view, images }, items: [] })
      continue
    }
    if (turns.length === 0) turns.push({ items: [] })
    const turn = turns[turns.length - 1]!
    const text = m.text.trim()
    if (text !== '') turn.items.push({ kind: 'text', html: renderMarkdown(text, cwd) })
    if (m.toolUses.length > 0) {
      const last = turn.items[turn.items.length - 1]
      if (last?.kind === 'tools') last.uses.push(...m.toolUses)
      else turn.items.push({ kind: 'tools', id: `g${++group}`, uses: [...m.toolUses] })
    }
  }
  return turns
}

function turnHtml(turn: Turn, n: number, cwd: string): string {
  const u = turn.user
  const images = (u?.images ?? []).map(p => {
    const src = escapeHtml(fileUrl(p))
    return `<a class="pasted" href="${src}" target="_blank" rel="noopener noreferrer" title="Open full size"><img src="${src}" alt="Pasted image" loading="lazy"></a>`
  }).join('')
  const you = u === undefined ? '' : `<div class="you"><div class="bubble">${u.view.events.join('')}${u.view.prose ? `<div class="markdown-body">${renderMarkdown(u.view.prose, cwd)}</div>` : ''}${images}</div></div>`
  const items = turn.items.map(i => (i.kind === 'text' ? `<div class="markdown-body">${i.html}</div>` : toolGroup(i.id, i.uses))).join('')
  const claude = items === '' ? '' : `<div class="claude"><div class="who"><span class="dot" aria-hidden="true"></span>Claude</div>${items}</div>`
  const summary = turn.summary === undefined ? '' : `<details class="summary"><summary>Earlier conversation, summarized when the session was compacted</summary><div class="markdown-body">${turn.summary}</div></details>`
  return `<section class="turn" id="t${n}" aria-label="Turn ${n}">${summary}${you}${claude}</section>`
}

/** One run of tool calls, in order: the activity chart plots these. */
export type Step = { id: string; turn: number; calls: number; failed: number; kinds: string }

export type Body = {
  thread: string
  outline: string
  prompts: number
  title: string
  steps: Step[]
  /** Calls per tool, most used first. */
  tools: [string, number][]
  /** Files written or edited, most recent first. */
  files: string[]
}

const WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function renderBody(messages: readonly Msg[], cwd = '/'): Body {
  const turns = toTurns(messages, cwd)
  const thread = turns.map((t, i) => turnHtml(t, i + 1, cwd)).join('\n')
  let n = 0
  const outline = turns
    .map((t, i) => (t.user ? `<li><a href="#t${i + 1}"><span class="n">${++n}</span><span class="q">${escapeHtml(t.user.view.label || 'Image')}</span></a></li>` : ''))
    .join('')
  const firstPrompt = turns.find(t => t.user && t.user.view.prose !== '')?.user?.view.label
  const steps: Step[] = []
  const tools = new Map<string, number>()
  const files: string[] = []
  turns.forEach((t, i) => {
    for (const item of t.items) {
      if (item.kind !== 'tools') continue
      const kinds = new Map<string, number>()
      for (const u of item.uses) {
        kinds.set(u.tool, (kinds.get(u.tool) ?? 0) + 1)
        tools.set(u.tool, (tools.get(u.tool) ?? 0) + 1)
        const f = u.input.file_path ?? u.input.notebook_path
        if (WRITES.has(u.tool) && typeof f === 'string' && f !== '') {
          const at = files.indexOf(f)
          if (at >= 0) files.splice(at, 1)
          files.unshift(f)
        }
      }
      const failed = item.uses.filter(u => u.isError).length
      steps.push({ id: item.id, turn: i + 1, calls: item.uses.length, failed, kinds: [...kinds].map(([k, c]) => (c > 1 ? `${k} ×${c}` : k)).join(', ') })
    }
  })
  return {
    thread,
    outline,
    prompts: turns.filter(t => t.user).length,
    title: firstPrompt || 'Claude Code session',
    steps,
    tools: [...tools].sort((a, b) => b[1] - a[1]),
    files,
  }
}

/** What the engine reports about the session: `$.session.usage()` and the clock. */
export type Usage = {
  now: number
  startedAt?: number
  context?: { tokens?: number; window: number; percent?: number }
  costUsd?: number
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  /** Main-loop turns the mod has timed, oldest first. */
  turns?: readonly TurnMark[]
  /** The page is rebuilt after every turn. */
  live?: boolean
}

const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n))

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)

function seconds(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * The turns on a clock: each bar spans the time Claude worked on one turn and
 * stands as tall as what it wrote; the gaps are you reading and typing.
 */
function timeline(turns: readonly TurnMark[], now: number): string {
  if (turns.length === 0) return '<p class="empty">Timed from the next turn that ends.</p>'
  const t0 = Math.min(...turns.map(t => t.at - t.ms))
  const span = Math.max(1, now - t0)
  const top = Math.max(1, ...turns.map(t => t.tokensOut ?? 0))
  const bars = turns.map(t => {
    const x = ((t.at - t.ms - t0) / span) * 240
    const w = Math.max(1.5, (t.ms / span) * 240)
    const h = t.tokensOut === undefined ? 8 : Math.max(3, (t.tokensOut / top) * 56)
    const tokens = t.tokensIn === undefined ? '' : ` · ${kilo(t.tokensIn)} in · ${kilo(t.tokensOut ?? 0)} out`
    return `<g><title>${hhmm(t.at - t.ms)} UTC · ${seconds(t.ms)}${tokens}</title><rect class="col" x="${x.toFixed(2)}" y="${(60 - h).toFixed(1)}" width="${w.toFixed(2)}" height="${h.toFixed(1)}" rx="1"/></g>`
  }).join('')
  const working = turns.reduce((a, t) => a + t.ms, 0)
  return `<svg class="chart" viewBox="0 0 240 60" preserveAspectRatio="none" role="img" aria-label="Turns over time">${bars}</svg><div class="axis"><span>${hhmm(t0)}</span><span>${turns.length} turn${turns.length === 1 ? '' : 's'} · ${working < 3_600_000 ? seconds(working) : duration(working)} working</span><span>${hhmm(now)}</span></div>`
}

/** A thin bar for a 0–100 figure, drawn as SVG: the CSP allows no style attributes. */
function meter(percent: number, label: string): string {
  const w = Math.max(0, Math.min(100, percent)) * 2.4
  const level = percent >= 85 ? ' hot' : percent >= 60 ? ' warm' : ''
  return `<svg class="meter" viewBox="0 0 240 6" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)}"><rect class="track" width="240" height="6" rx="3"/><rect class="fill${level}" width="${w.toFixed(1)}" height="6" rx="3"/></svg>`
}

const LIMIT_NAMES: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit', spend_limit: 'Spend limit' }

/** Tool calls per step, oldest left; each bar links to its step and names it on hover. */
function activity(steps: readonly Step[]): string {
  if (steps.length === 0) return '<p class="empty">No tool calls yet.</p>'
  const max = Math.max(...steps.map(s => s.calls))
  const w = 240 / steps.length
  const bars = steps.map((s, i) => {
    const h = Math.max(2, (s.calls / max) * 56)
    const tip = `Step ${i + 1} · ${s.calls} call${s.calls > 1 ? 's' : ''}${s.failed ? `, ${s.failed} failed` : ''} · ${s.kinds}`
    return `<a href="#${s.id}"><title>${escapeHtml(tip)}</title><rect class="hit" x="${(i * w).toFixed(2)}" y="0" width="${w.toFixed(2)}" height="60"/><rect class="col${s.failed ? ' err' : ''}" x="${(i * w + w * 0.15).toFixed(2)}" y="${(60 - h).toFixed(1)}" width="${Math.max(0.8, w * 0.7).toFixed(2)}" height="${h.toFixed(1)}" rx="${Math.min(2, w * 0.3).toFixed(1)}"/></a>`
  }).join('')
  const total = steps.reduce((a, s) => a + s.calls, 0)
  const failed = steps.reduce((a, s) => a + s.failed, 0)
  return `<svg class="chart" viewBox="0 0 240 60" preserveAspectRatio="none" role="img" aria-label="Tool calls per step">${bars}</svg><div class="axis"><span>first</span><span>${steps.length} steps · ${total} calls${failed ? ` · <b class="bad">${failed} failed</b>` : ''}</span><span>latest</span></div>`
}

function fileList(files: readonly string[], cwd: string): string {
  if (files.length === 0) return '<p class="empty">No files changed.</p>'
  const shown = files.slice(0, 12).map(f => {
    const rel = f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f.replace(/^\/Users\/[^/]+/, '~')
    const cut = rel.lastIndexOf('/')
    return `<li title="${escapeHtml(f)}"><span class="fname">${escapeHtml(rel.slice(cut + 1))}</span>${cut > 0 ? `<span class="fdir">${escapeHtml(rel.slice(0, cut))}</span>` : ''}</li>`
  })
  return `<ul class="files">${shown.join('')}</ul>${files.length > 12 ? `<p class="empty">and ${files.length - 12} more</p>` : ''}`
}

/** The sidebar: session figures, activity, tools, files changed, and the prompts when there is more than one. */
export function renderSide(body: Body, usage: Usage | undefined, cwd: string): string {
  const stats: string[] = []
  if (usage?.startedAt !== undefined) stats.push(`<div class="stat"><dt>Running</dt><dd>${duration(usage.now - usage.startedAt)}<small>since ${hhmm(usage.startedAt)} UTC</small></dd></div>`)
  if (usage?.costUsd !== undefined) stats.push(`<div class="stat"><dt>Cost</dt><dd>$${usage.costUsd.toFixed(2)}</dd></div>`)
  stats.push(`<div class="stat"><dt>Prompts</dt><dd>${body.prompts}</dd></div>`)
  stats.push(`<div class="stat"><dt>Tool calls</dt><dd>${body.steps.reduce((a, s) => a + s.calls, 0)}</dd></div>`)
  const gauges: string[] = []
  const ctx = usage?.context
  if (ctx?.percent !== undefined) {
    gauges.push(`<div class="gauge"><div class="gl"><span>Context</span><span>${ctx.tokens !== undefined ? `${kilo(ctx.tokens)} / ` : ''}${kilo(ctx.window)} · ${ctx.percent}%</span></div>${meter(ctx.percent, `Context ${ctx.percent}% full`)}</div>`)
  }
  for (const l of usage?.limits ?? []) {
    const name = LIMIT_NAMES[l.kind] ?? l.kind
    const reset = l.resetsAt && !Number.isNaN(Date.parse(l.resetsAt)) ? ` · resets ${hhmm(Date.parse(l.resetsAt))}` : ''
    gauges.push(`<div class="gauge"><div class="gl"><span>${escapeHtml(name)}</span><span>${l.percentUsed}%${reset}</span></div>${meter(l.percentUsed, `${name} ${l.percentUsed}% used`)}</div>`)
  }
  const top = body.tools.slice(0, 8)
  const max = top[0]?.[1] ?? 1
  const tools = top.length === 0 ? '' : `<section class="panel"><h2>Tools</h2><ul class="tools-used">${top.map(([t, c]) => `<li><span class="tname">${escapeHtml(t.replace(/^mcp__(.+?)__/, '$1 · '))}</span><span class="tcount">${c}</span><svg class="tbar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect width="${((c / max) * 100).toFixed(1)}" height="4" rx="2"/></svg></li>`).join('')}</ul></section>`
  const prompts = body.prompts > 1 ? `<section class="panel"><h2>Prompts</h2><nav aria-label="Prompts"><ol class="outline">${body.outline}</ol></nav></section>` : ''
  const now = usage?.now
  const state = now === undefined ? '' : `<span class="state${usage?.live ? ' live' : ''}" title="${usage?.live ? 'Rebuilt after every turn: reload to see the newest' : 'A snapshot: run /page to rebuild'}">${usage?.live ? 'Live' : 'Snapshot'} · built ${hhmm(now)} UTC</span>`
  const turns = usage === undefined ? '' : `<section class="panel"><h2>Turns</h2>${timeline(usage.turns ?? [], usage.now)}</section>`
  return `<div class="side-head"><span class="brand">/page</span>${state}</div>
<section class="panel"><h2>Session</h2><dl class="stats">${stats.join('')}</dl>${gauges.join('')}</section>
${turns}
<section class="panel"><h2>Tool calls</h2>${activity(body.steps)}</section>
${tools}
<section class="panel"><h2>Files changed</h2>${fileList(body.files, cwd)}</section>
${prompts}`
}

/**
 * The page's own rules, over the vendored fonts.css and github-markdown.css.
 * Colours follow Geist: two backgrounds, a gray scale for surfaces, borders and
 * text, blue only for links and focus.
 */
export const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--bg2:#fafafa;--surface:#f2f2f2;--code:#f7f7f7;--line:#ebebeb;--line2:#e0e0e0;--fg:#171717;--muted:#666;--faint:#8f8f8f;--link:#0068d6;--err:#da2f35;--focus:#0068d6;--bar:rgba(255,255,255,.82)}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--bg2:#0f0f0f;--surface:#1f1f1f;--code:#141414;--line:#1f1f1f;--line2:#2e2e2e;--fg:#ededed;--muted:#a1a1a1;--faint:#707070;--link:#52a8ff;--err:#ff6166;--focus:#52a8ff;--bar:rgba(10,10,10,.8)}}
html{scroll-padding-top:72px;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 Geist,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;font-feature-settings:"liga","calt"}
code,pre,kbd,samp,.mono{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:var(--link)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:4px}
.skip{position:absolute;left:-9999px;top:8px;z-index:9;background:var(--fg);color:var(--bg);padding:8px 12px;border-radius:6px}
.skip:focus{left:8px}
.app{display:grid;grid-template-columns:300px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;border-right:1px solid var(--line2);background:var(--bg2);padding:0 18px 32px;overscroll-behavior:contain;font-size:13px;scrollbar-width:none}
.side::-webkit-scrollbar{display:none}
.side-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:10px;height:56px;margin:0 -18px;padding:0 18px;box-sizing:border-box;background:var(--bg2);border-bottom:1px solid var(--line2)}
.brand{font-family:"Geist Mono",ui-monospace,Menlo,monospace;font-size:13px;font-weight:600}
.state{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.state.live{color:var(--muted)}
.state.live::before{content:"";display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:50%;background:#2fb344;vertical-align:1px}
html{scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
*{scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--line2);border-radius:4px}::-webkit-scrollbar-thumb:hover{background:var(--faint)}
.panel{padding:18px 0 16px;border-bottom:1px solid var(--line2)}
.panel:last-child{border-bottom:none}
.side h2{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);margin:0 0 12px}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:14px 16px;margin:0 0 6px}
.stat dt{font-size:12px;color:var(--muted)}
.stat dd{margin:2px 0 0;font-size:20px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.stat small{display:block;font-size:11px;font-weight:400;letter-spacing:0;color:var(--faint)}
.gauge{margin:12px 0 0}
.gl{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted);margin:0 0 5px;font-variant-numeric:tabular-nums}
.meter{display:block;width:100%;height:6px}
.meter .track{fill:var(--surface)}.meter .fill{fill:var(--fg)}.meter .fill.warm{fill:#f5a623}.meter .fill.hot{fill:var(--err)}
.chart{display:block;width:100%;height:64px}
.chart .hit{fill:transparent}.chart .col{fill:var(--faint)}.chart .col.err{fill:var(--err)}
.chart a:hover .col,.chart a:focus .col{fill:var(--link)}
.axis{display:flex;justify-content:space-between;gap:6px;font-size:11px;color:var(--faint);margin-top:6px;font-variant-numeric:tabular-nums}
.axis .bad{color:var(--err);font-weight:500}
.tools-used,.files,.outline{list-style:none;margin:0;padding:0}
.tools-used li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px;margin:0 0 9px}
.tname{font-family:"Geist Mono",ui-monospace,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tcount{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.tbar{grid-column:1/-1;display:block;width:100%;height:4px}.tbar rect{fill:var(--faint)}
.files li{display:flex;flex-direction:column;padding:3px 0 5px;min-width:0}
.fname{font-family:"Geist Mono",ui-monospace,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fdir{font-size:11px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{margin:0;color:var(--faint);font-size:12px}
.outline a{display:flex;gap:10px;align-items:baseline;padding:6px 8px;margin:0 -8px;border-radius:6px;color:var(--muted);text-decoration:none;font-size:13px;line-height:1.45}
.outline a:hover{background:var(--surface);color:var(--fg)}
.outline .n{flex:none;min-width:18px;font-variant-numeric:tabular-nums;color:var(--faint);font-size:12px}
.outline .q{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.codebox{position:relative}
.copy{position:absolute;top:8px;right:8px;font:500 12px/1.4 Geist,-apple-system,sans-serif;color:var(--muted);background:var(--bg);border:1px solid var(--line2);border-radius:6px;padding:3px 9px;cursor:pointer;opacity:0;transition:opacity .15s}
.codebox:hover .copy,.copy:focus-visible{opacity:1}
.copy:hover{color:var(--fg)}
.tool .copy{top:10px;right:20px}
@media (hover:none){.copy{opacity:1}}
.thread .code{margin:0 0 16px;border:1px solid var(--line2);border-radius:10px;overflow:hidden;background:var(--code)}
.code-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:34px;padding:0 6px 0 14px;box-sizing:border-box;background:var(--surface);border-bottom:1px solid var(--line2)}
.code-lang{font-size:12px;font-weight:500;color:var(--muted)}
.code-head .copy{position:static;opacity:1;background:transparent;border:1px solid transparent;padding:2px 8px}
.code-head .copy:hover{background:var(--bg);border-color:var(--line2)}
.thread .markdown-body .code pre{margin:0;border:none;border-radius:0;background:transparent;padding:14px 16px}
.thread .markdown-body .code pre code{font-size:13px}
:root{--hk:#cf222e;--hs:#0a3069;--hc:#6e7781;--hn:#0550ae;--hf:#8250df;--hb:#953800;--ht:#116329}
@media (prefers-color-scheme:dark){:root{--hk:#ff7b72;--hs:#a5d6ff;--hc:#8b949e;--hn:#79c0ff;--hf:#d2a8ff;--hb:#ffa657;--ht:#7ee787}}
.hljs-keyword,.hljs-selector-tag,.hljs-doctag,.hljs-template-tag,.hljs-meta .hljs-keyword{color:var(--hk)}
.hljs-string,.hljs-regexp,.hljs-meta .hljs-string,.hljs-char.escape_{color:var(--hs)}
.hljs-comment,.hljs-quote,.hljs-meta{color:var(--hc)}
.hljs-comment{font-style:italic}
.hljs-number,.hljs-literal,.hljs-attr,.hljs-attribute,.hljs-symbol,.hljs-property,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-link{color:var(--hn)}
.hljs-title,.hljs-title.function_,.hljs-section{color:var(--hf)}
.hljs-built_in,.hljs-type,.hljs-title.class_,.hljs-variable,.hljs-params,.hljs-template-variable{color:var(--hb)}
.hljs-name,.hljs-tag,.hljs-selector-pseudo,.hljs-addition{color:var(--ht)}
.hljs-deletion{color:var(--hk)}
.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:600}
.main{min-width:0}
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:56px;padding:8px 32px;box-sizing:border-box;background:var(--bar);backdrop-filter:saturate(1.6) blur(10px);-webkit-backdrop-filter:saturate(1.6) blur(10px);border-bottom:1px solid var(--line2)}
.bar h1{font-size:14px;font-weight:600;margin:0;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar .meta{font-size:12px;color:var(--muted);margin:2px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar .meta code{font-size:12px}
.bar .titles{min-width:0}
.jump{display:flex;gap:6px;flex:none}
.jump a,.jump button{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;box-sizing:border-box;color:var(--fg);text-decoration:none;border:1px solid var(--line2);border-radius:6px;background:var(--bg);cursor:pointer;font:inherit}
.jump a:hover,.jump button:hover{background:var(--surface)}
.jump svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.thread{max-width:960px;margin:0 auto;padding:32px 32px 96px}
.turn{padding:8px 0 28px}
/* Room under a short last turn, so opening at it puts it at the top as chat apps do. */
.turn:last-of-type{min-height:calc(100vh - 160px)}
.you{display:flex;justify-content:flex-end;margin:0 0 20px}
.bubble{max-width:min(80%,720px);background:var(--surface);border-radius:18px;padding:10px 16px;box-sizing:border-box;overflow-wrap:anywhere}
.bubble .markdown-body p:last-child{margin-bottom:0}
.who{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--muted);margin:0 0 6px}
.dot{width:8px;height:8px;border-radius:50%;background:#d97757}
.claude>.markdown-body+.markdown-body,.claude>.tools+.markdown-body{margin-top:12px}
.thread .markdown-body{--fgColor-default:var(--fg);--fgColor-muted:var(--muted);--fgColor-accent:var(--link);--bgColor-default:transparent;--bgColor-muted:var(--code);--borderColor-default:var(--line2);--borderColor-muted:var(--line2);font-family:inherit;font-size:15px;line-height:1.7;background:transparent;color:var(--fg);overflow-wrap:anywhere}
.thread .markdown-body>:last-child{margin-bottom:0}
.thread .markdown-body>:first-child{margin-top:0}
.thread .markdown-body h1,.thread .markdown-body h2{border-bottom:none;padding-bottom:0}
.thread .markdown-body h1{font-size:1.5em}.thread .markdown-body h2{font-size:1.25em}.thread .markdown-body h3{font-size:1.05em}
.thread .markdown-body code{font-size:85%;border-radius:4px}
.thread .markdown-body pre{border:1px solid var(--line2);border-radius:8px;font-size:13px;line-height:1.55}
.thread .markdown-body table{display:table;width:auto;max-width:100%;font-size:14px}
.thread .markdown-body pre.mermaid{overflow-x:auto;background:transparent;border:none;padding:8px 0}
.img{color:var(--muted);font-style:italic}
.note{margin:12px 0 0;font-size:13px;color:var(--faint)}
details.summary{margin:0 0 24px;border:1px dashed var(--line2);border-radius:8px}
details.summary>summary{padding:10px 14px;cursor:pointer;font-size:13px;color:var(--muted)}
details.summary>summary:hover{color:var(--fg)}
details.summary>.markdown-body{padding:4px 16px 16px;font-size:14px}
.markdown-body img{max-width:100%;border-radius:8px}
a.pasted{display:inline-block;margin:8px 8px 0 0;line-height:0;vertical-align:top}
a.pasted img{max-width:min(100%,360px);max-height:240px;object-fit:contain;border-radius:10px;border:1px solid var(--line2)}
a.pasted:hover img{border-color:var(--faint)}
.ev{font-family:"Geist Mono",ui-monospace,Menlo,monospace;font-size:13px;margin:2px 0}
.ev-cmd{color:var(--fg);font-weight:500}
.ev-args{color:var(--muted)}
.ev-out{font-size:12.5px;line-height:1.5;color:var(--muted);background:transparent;border-left:2px solid var(--line2);margin:6px 0;padding:2px 0 2px 10px;white-space:pre-wrap;overflow-wrap:anywhere}
.ev-prompt{color:var(--faint)}
.bubble .ev+.markdown-body,.bubble .ev-out+.markdown-body{margin-top:8px}
.tools{margin:10px 0;border:1px solid var(--line2);border-radius:8px;background:var(--bg)}
.tools>summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:8px 12px;cursor:pointer;font-size:13px;color:var(--muted);list-style:none}
.tools>summary::-webkit-details-marker{display:none}
.tools>summary::before{content:"▸";color:var(--faint);font-size:11px}
.tools[open]>summary::before{content:"▾"}
.tools>summary:hover{color:var(--fg)}
.tools-head{color:var(--fg);font-weight:500}
.tools-kinds{font-family:"Geist Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--faint)}
.tools-list{border-top:1px solid var(--line2);padding:4px 0}
.tool>summary{display:flex;gap:10px;align-items:baseline;padding:5px 12px;cursor:pointer;font-size:13px;list-style:none;min-width:0}
.tool>summary::-webkit-details-marker{display:none}
.tool>summary:hover{background:var(--surface)}
.tool-name{font-family:"Geist Mono",ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--fg);flex:none}
.tool-hint{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.tool-err{color:var(--err);font-size:12px;flex:none}
.tool pre{margin:4px 12px 8px;padding:10px 12px;background:var(--code);border:1px solid var(--line2);border-radius:6px;font-size:12px;line-height:1.5;overflow:auto;max-height:360px;white-space:pre-wrap;overflow-wrap:anywhere}
.tool pre.err{color:var(--err)}
.end{height:1px}
@media (max-width:900px){.app{grid-template-columns:1fr}.side{display:none}.thread{padding:20px 16px 72px}.bar{padding:8px 16px}.bubble{max-width:90%}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`

export const MERMAID_FILE = 'mermaid.min.js'

/**
 * The page's one script: a Copy button on every code block, in its language bar
 * when it has one (the clipboard API,
 * or a selection and the copy command where a file:// page lacks it), then
 * open at the start of the newest turn, named in the address bar (#tN), and
 * again once fonts and images have settled. A reload lands there too, even from
 * an older turn's #tN: the page is rebuilt after every turn, so a reload means
 * "show me the newest". Any other anchor (#g3, #end) is left to the browser.
 * Runs by its hash.
 */
const icon = (d: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`
const ICON_TOP = icon('M5 4h14M12 20V9M6 14l6-6 6 6')
const ICON_LATEST = icon('M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12zM8.5 10.5l3.5 3.5 3.5-3.5')
const ICON_RELOAD = icon('M20 12a8 8 0 1 1-2.3-5.7M20 4v4.5h-4.5')

export const PAGE_JS = `for(const p of document.querySelectorAll('.thread pre:not(.mermaid)')){let w=p.parentElement.classList.contains('code')?p.previousElementSibling:null;if(!w){w=document.createElement('div');w.className='codebox';p.before(w);w.append(p)}const b=document.createElement('button');b.type='button';b.className='copy';b.textContent='Copy';b.setAttribute('aria-label','Copy code');b.addEventListener('click',async()=>{const t=p.innerText;let ok=false;try{await navigator.clipboard.writeText(t);ok=true}catch{const r=document.createRange();r.selectNodeContents(p);const s=getSelection();s.removeAllRanges();s.addRange(r);ok=document.execCommand('copy');s.removeAllRanges()}b.textContent=ok?'Copied':'Copy failed';setTimeout(()=>{b.textContent='Copy'},1500)});w.append(b)}const root=document.documentElement;const go=id=>{const t=document.getElementById(id);if(!t)return false;root.dataset.at=id;t.scrollIntoView({block:'start'});return true};history.scrollRestoration='manual';if(location.hash)history.replaceState(null,'',location.pathname+location.search);const last=document.querySelector('.turn:last-of-type');document.querySelector('.jump .reload')?.addEventListener('click',()=>location.reload());document.addEventListener('click',e=>{const a=e.target.closest('a[href^="#"]');if(!a||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;const id=a.classList.contains('latest')&&last?last.id:decodeURIComponent(a.getAttribute('href').slice(1));if(!go(id))return;e.preventDefault();if(a.classList.contains('skip')){const t=document.getElementById(id);t.tabIndex=-1;t.focus({preventScroll:true})}});if(last){go(last.id);const again=()=>go(root.dataset.at);addEventListener('load',again,{once:true});document.fonts&&document.fonts.ready.then(again)}`

/**
 * The whole page. `css` is inlined and `styleHash` must be its CSP hash; the
 * only script that always runs is PAGE_JS, by its hash. With a diagram
 * (`mermaid`), the library loads from the MERMAID_FILE beside the page ('self':
 * engine reads and writes stop at 4 MiB, and a file:// page cannot use an
 * integrity check), MERMAID_INIT runs by its hash, and inline styles are allowed
 * because Mermaid writes a <style> into each diagram; with nothing able to load,
 * a style cannot reach the network. Fonts arrive as data: inside the CSS.
 */
export function renderPage(opts: {
  title: string
  meta: string
  cwd: string
  body: Body
  usage?: Usage
  css: string
  hashes: { style: string; page: string; init?: string }
}): string {
  const mermaid = opts.hashes.init !== undefined
  const styleSrc = mermaid ? `'unsafe-inline'` : `'${opts.hashes.style}'`
  const scriptSrc = mermaid ? `'self' '${opts.hashes.init}' '${opts.hashes.page}'` : `'${opts.hashes.page}'`
  const csp = `default-src 'none'; style-src ${styleSrc}; script-src ${scriptSrc}; font-src data:; img-src data: file:; base-uri 'none'; form-action 'none'`
  const scripts = `<script>${PAGE_JS}</script>${mermaid ? `<script src="${MERMAID_FILE}"></script><script>${MERMAID_INIT}</script>` : ''}`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(opts.title)}</title>
<style>${opts.css}</style></head>
<body><a class="skip" href="#content">Skip to content</a>
<div class="app" id="top">
<aside class="side" aria-label="Session overview">${renderSide(opts.body, opts.usage, opts.cwd)}</aside>
<div class="main">
<header class="bar"><div class="titles"><h1>${escapeHtml(opts.title)}</h1><p class="meta">${escapeHtml(opts.meta)} · <code translate="no">${escapeHtml(opts.cwd)}</code></p></div>
<nav class="jump" aria-label="Jump"><a href="#top" title="Top" aria-label="Top">${ICON_TOP}</a><a class="latest" href="#end" title="Latest message" aria-label="Latest message">${ICON_LATEST}</a><button class="reload" type="button" title="Refresh" aria-label="Refresh">${ICON_RELOAD}</button></nav></header>
<main id="content"><div class="thread">
${opts.body.thread}
<div class="end" id="end"></div>
</div></main></div></div>
${scripts}</body></html>
`
}


export async function sha256Csp(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return `sha256-${base64(digest)}`
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : '='
  }
  return out
}
