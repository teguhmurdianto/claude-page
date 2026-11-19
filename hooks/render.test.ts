import { expect, test } from 'claude-code/testing'

import { imageSrc, MERMAID_FILE, MERMAID_INIT, MERMAID_MARK, renderBody, renderMarkdown, renderPage, renderSide, safeHref, PAGE_JS, sha256Csp, stripInjected, userView } from './render'

test('raw HTML in session text is escaped, not rendered', async () => {
  const body = renderBody([
    { role: 'assistant', text: '<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)> <iframe src=//x>', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool: '<b>Bash</b>', input: { command: '</pre><script>x</script>' }, text: '<iframe>' }] },
  ]).thread
  for (const tag of ['<script', '<img', '<iframe', '<b>']) expect(body.includes(tag)).toBe(false)
  expect(body.includes('&lt;script&gt;')).toBe(true)
})

test('markdown renders: headings, code, tables, lists', async () => {
  const html = renderMarkdown('# Title\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1 < 2\n```')
  expect(html.includes('<h1>Title</h1>')).toBe(true)
  expect(html.includes('<li>a</li>')).toBe(true)
  expect(html.includes('<table>')).toBe(true)
  expect(html.includes('class="hljs language-ts"')).toBe(true)
  expect(html.includes('<span class="hljs-number">1</span> &lt; <span class="hljs-number">2</span>')).toBe(true)
})

test('only safe link schemes survive', async () => {
  expect(safeHref('https://x.dev')).toBe(true)
  expect(safeHref('#end')).toBe(true)
  expect(safeHref('docs/a.md')).toBe(true)
  expect(safeHref('javascript:alert(1)')).toBe(false)
  expect(safeHref('java\tscript:alert(1)')).toBe(false)
  expect(safeHref(' JAVASCRIPT:alert(1)')).toBe(false)
  expect(safeHref('data:text/html,x')).toBe(false)
  const html = renderMarkdown('[a](javascript:alert(1)) [b](https://x.dev "t\\"x")')
  expect(html.includes('javascript:')).toBe(false)
  expect(html.includes('href="https://x.dev"')).toBe(true)
  expect(html.includes('rel="noopener noreferrer"')).toBe(true)
})

test('remote images never auto-load: they become a click-to-open link', async () => {
  const html = renderMarkdown('![<b>x</b>](https://evil.dev/p.png?d=SECRET)')
  expect(html.includes('<img')).toBe(false)
  expect(html.includes('<b>')).toBe(false)
  expect(html.includes('class="img" href="https://evil.dev/p.png?d=SECRET" rel="noopener noreferrer"')).toBe(true)
})

test('local and data images show inline; relative paths resolve from the session cwd', async () => {
  expect(renderMarkdown('![a](./shots/a b.png)', '/Users/me/repo').includes('<img src="file:///Users/me/repo/./shots/a%20b.png"')).toBe(false) // spaces end a Markdown URL
  expect(renderMarkdown('![a](<shots/a b.png>)', '/Users/me/repo').includes('<img src="file:///Users/me/repo/shots/a%20b.png" alt="a"')).toBe(true)
  expect(renderMarkdown('![a](/tmp/x.png)').includes('<img src="file:///tmp/x.png"')).toBe(true)
  expect(renderMarkdown('![a](data:image/png;base64,AAAA)').includes('<img src="data:image/png;base64,AAAA"')).toBe(true)
})

test('other image schemes are refused', async () => {
  expect(imageSrc('javascript:alert(1)', '/')).toBe(undefined)
  expect(imageSrc('data:text/html,<script>', '/')).toBe(undefined)
  expect(imageSrc('data:image/svg+xml;base64,AAAA', '/')).toBe(undefined)
  expect(imageSrc('//evil.dev/x.png', '/')).toBe(undefined)
  expect(imageSrc('HTTPS://evil.dev/x.png', '/')).toEqual({ remote: 'HTTPS://evil.dev/x.png' })
})

test('pasted images render as local files with escaped paths', async () => {
  const body = renderBody([{ role: 'user', text: 'see this', toolUses: [], images: ['/Users/me/.page/img/ab"c.png'] }]).thread
  expect(body.includes('<a class="pasted" href="file:///Users/me/.page/img/ab%22c.png"')).toBe(true)
  expect(renderBody([{ role: 'user', text: '', toolUses: [], images: ['/x.png'] }]).thread.includes('a class="pasted"')).toBe(true)
})

test('CSP lets images come only from data: and local files', async () => {
  const css = 'body{}'
  const page = renderPage({ title: 't', meta: 'm', cwd: '/', body: { thread: '', outline: '', prompts: 0, title: 't', steps: [], tools: [], files: [] }, css, hashes: { style: await sha256Csp(css), page: 'sha256-SSS' } })
  expect(page.includes(`img-src data: file:;`)).toBe(true)
})

test('mermaid blocks become escaped <pre class="mermaid">, other code stays code', async () => {
  const html = renderMarkdown('```mermaid\nflowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B\n```\n\n```js\nx\n```')
  expect(html.includes(MERMAID_MARK)).toBe(true)
  expect(html.includes('<img')).toBe(false)
  expect(html.includes('class="hljs language-js"')).toBe(true)
})

test('a diagram page loads only the local library and the hashed init', async () => {
  const css = 'body{}'
  const page = renderPage({ title: 't', meta: 'm', cwd: '/', body: { thread: '', outline: '', prompts: 0, title: 't', steps: [], tools: [], files: [] }, css, hashes: { style: await sha256Csp(css), page: 'sha256-SSS', init: 'sha256-AAA' } })
  expect(page.includes(`script-src 'self' 'sha256-AAA' 'sha256-SSS';`)).toBe(true)
  expect(page.includes(`default-src 'none'`)).toBe(true)
  expect(page.includes(`<script src="${MERMAID_FILE}"></script><script>${MERMAID_INIT}</script>`)).toBe(true)
  expect(page.includes('unsafe-eval')).toBe(false)
  expect(/https?:/.test(page)).toBe(false)
})

test('mermaid init runs in strict mode', async () => {
  expect(MERMAID_INIT.includes(`securityLevel:'strict'`)).toBe(true)
})

test('harness reminders are dropped and empty turns skipped', async () => {
  expect(stripInjected('hi <system-reminder>secret context</system-reminder>')).toBe('hi')
  expect(renderBody([{ role: 'user', text: '<system-reminder>only this</system-reminder>', toolUses: [] }]).thread).toBe('')
})

test('CSP hash matches the standard SHA-256 base64 vector', async () => {
  expect(await sha256Csp('abc')).toBe('sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=')
})

test('a page without diagrams runs only the hashed scroll and loads nothing', async () => {
  const css = 'body{}'
  const hash = await sha256Csp(css)
  const page = renderPage({ title: 't', meta: 'm', cwd: '/', body: { thread: '', outline: '', prompts: 0, title: 't', steps: [], tools: [], files: [] }, css, hashes: { style: hash, page: 'sha256-SSS' } })
  expect(page.includes(`default-src 'none'; style-src '${hash}'; script-src 'sha256-SSS'; font-src data:;`)).toBe(true)
  expect(page.includes(`<script>${PAGE_JS}</script>`)).toBe(true)
  expect(page.includes('<script src')).toBe(false)
  expect(page.includes("'self'")).toBe(false)
  expect(/https?:/.test(page)).toBe(false)
})

test('turns: a prompt and everything after it; tool-only messages merge into one collapsed row', async () => {
  const body = renderBody([
    { role: 'user', text: 'fix the bug', toolUses: [] },
    { role: 'assistant', text: 'Looking.', toolUses: [{ tool: 'Bash', input: { command: 'ls', description: 'List files' }, text: 'a' }] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'pwd' } }, { tool: 'Read', input: { file_path: '/x' }, text: 'no', isError: true }] },
    { role: 'assistant', text: '## Done\n\nok', toolUses: [] },
    { role: 'user', text: 'thanks', toolUses: [] },
  ])
  expect(body.prompts).toBe(2)
  expect(body.title).toBe('fix the bug')
  expect(body.thread.match(/<section class="turn"/g)?.length).toBe(2)
  expect(body.thread.match(/<details class="tools" id="g\d+">/g)?.length).toBe(1)
  expect(body.thread.includes('3 tool calls')).toBe(true)
  expect(body.thread.includes('Bash ×2 · Read')).toBe(true)
  expect(body.thread.includes('1 failed')).toBe(true)
  expect(body.thread.includes('<span class="tool-hint">List files</span>')).toBe(true)
  expect(body.thread.includes('<h2>Done</h2>')).toBe(true)
  expect(body.outline.includes('<a href="#t2">')).toBe(true)
  expect(body.steps).toEqual([{ id: 'g1', turn: 1, calls: 3, failed: 1, kinds: 'Bash ×2, Read' }])
})

test('slash commands and shell runs show as chips, not raw tags', async () => {
  const v = userView('<command-message>page</command-message><command-name>/page</command-name><command-args>clear</command-args>')
  expect(v.prose).toBe('')
  expect(v.label).toBe('/page')
  expect(v.events[0]?.includes('<span class="ev-cmd">/page</span> <span class="ev-args">clear</span>')).toBe(true)
  const b = userView('<bash-input>echo <hi></bash-input><bash-stdout>x</bash-stdout><bash-stderr></bash-stderr>')
  expect(b.events[0]?.includes('$</span> echo &lt;hi&gt;')).toBe(true)
})

test('an interrupt marker closes the turn as a note, not a new prompt', async () => {
  const body = renderBody([
    { role: 'user', text: 'go', toolUses: [] },
    { role: 'user', text: '[Request interrupted by user for tool use]', toolUses: [] },
  ])
  expect(body.prompts).toBe(1)
  expect(body.thread.includes('<p class="note">Request interrupted by user for tool use</p>')).toBe(true)
})

test('a compaction summary folds away and is neither a prompt nor the title', async () => {
  const body = renderBody([
    { role: 'user', text: 'This session is being continued from a previous conversation that ran out of context.\n\n# Summary', toolUses: [] },
    { role: 'user', text: 'next step', toolUses: [] },
  ])
  expect(body.prompts).toBe(1)
  expect(body.title).toBe('next step')
  expect(body.thread.includes('<details class="summary">')).toBe(true)
})

test('sidebar: session figures, activity per step, tools and files changed', async () => {
  const body = renderBody([
    { role: 'user', text: 'go', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Edit', input: { file_path: '/r/src/a.ts' } }, { tool: 'Bash', input: { command: 'x' }, isError: true }] },
    { role: 'assistant', text: 'ok', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Write', input: { file_path: '/r/<b>.ts' } }] },
  ], '/r')
  expect(body.steps.length).toBe(2)
  expect(body.files).toEqual(['/r/<b>.ts', '/r/src/a.ts'])
  const side = renderSide(body, { now: 3_600_000, startedAt: 0, context: { tokens: 50_000, window: 200_000, percent: 25 }, costUsd: 1.5, limits: [{ kind: 'five_hour', percentUsed: 90, resetsAt: '2026-10-24T17:00:00Z' }] }, '/r')
  expect(side.includes('1h 0m')).toBe(true)
  expect(side.includes('$1.50')).toBe(true)
  expect(side.includes('50.0k / 200k · 25%')).toBe(true)
  expect(side.includes('5-hour limit')).toBe(true)
  expect(side.includes('class="fill hot"')).toBe(true)
  expect(side.includes('<a href="#g1">')).toBe(true)
  expect(side.includes('class="col err"')).toBe(true)
  expect(side.includes('&lt;b&gt;.ts')).toBe(true)
  expect(side.includes('<b>.ts')).toBe(false)
  expect(side.includes('style=')).toBe(false)
  expect(side.includes('Prompts</h2>')).toBe(false)
})

test('every code block gets a copy button from the hashed page script', async () => {
  expect(PAGE_JS.includes("querySelectorAll('.thread pre:not(.mermaid)')")).toBe(true)
  expect(PAGE_JS.includes('navigator.clipboard.writeText')).toBe(true)
  expect(PAGE_JS.includes('innerHTML')).toBe(false)
})

test('a pasted image replaces its "[Image #N]" stand-in, in the bubble and the title', async () => {
  const body = renderBody([{ role: 'user', text: '[Image #1]\n\nhere is the result', toolUses: [], images: ['/x.png'] }])
  expect(body.title).toBe('here is the result')
  expect(body.thread.includes('[Image #1]')).toBe(false)
})

test('code blocks: a language bar and colours; the highlighter can only add hljs spans', async () => {
  const html = renderMarkdown('```ts\nconst a = "<b>" // hi\n```\n\n```\nplain <i>\n```\n\n```nosuchlang\nx < y\n```')
  expect(html.includes('<span class="code-lang">TypeScript</span>')).toBe(true)
  expect(html.includes('<span class="hljs-keyword">const</span>')).toBe(true)
  expect(html.includes('&lt;b&gt;')).toBe(true)
  expect(html.includes('<b>')).toBe(false)
  expect(html.includes('<span class="code-lang">text</span>')).toBe(true)
  expect(html.includes('plain &lt;i&gt;')).toBe(true)
  expect(html.includes('<span class="code-lang">nosuchlang</span>')).toBe(true)
  expect(html.includes('x &lt; y')).toBe(true)
  expect(html.replace(/<span class="(hljs-[\w. -]+|code-lang)">|<\/span>|<\/?(div|pre|code)[^>]*>/g, '').includes('<')).toBe(false)
})

test('header controls are icons: Top, Latest (start of the newest turn) and Refresh', () => {
  const page = renderPage({ title: 't', meta: 'm', cwd: '/', body: { thread: '', outline: '', prompts: 0, title: 't', steps: [], tools: [], files: [] }, css: '', hashes: { style: 'sha256-SSS', page: 'sha256-SSS' } })
  const nav = page.slice(page.indexOf('<nav class="jump"'), page.indexOf('</nav>'))
  expect(nav.includes('aria-label="Top"')).toBe(true)
  expect(nav.includes('class="latest"')).toBe(true)
  expect(nav.includes('<button class="reload" type="button"')).toBe(true)
  expect(nav.replace(/<[^>]*>/g, '').trim()).toBe('')
  expect(PAGE_JS.includes("a.classList.contains('latest')&&last?last.id")).toBe(true)
  expect(PAGE_JS.includes("location.reload()")).toBe(true)
})

test('the page opens, and reloads, at the start of the newest turn, with a plain address', async () => {
  expect(PAGE_JS.includes(".turn:last-of-type")).toBe(true)
  expect(PAGE_JS.includes("if(last){go(last.id)")).toBe(true)
  expect(PAGE_JS.includes("history.scrollRestoration='manual'")).toBe(true)
  expect(PAGE_JS.includes("history.replaceState(null,'',location.pathname+location.search)")).toBe(true)
  expect(PAGE_JS.includes("e.preventDefault()")).toBe(true)
  expect(PAGE_JS.includes("'#'+")).toBe(false)
  expect(PAGE_JS.includes("scrollIntoView({block:'start'})")).toBe(true)
})

test('sidebar: a pinned head says live or snapshot, and turns sit on a clock', async () => {
  const body = renderBody([{ role: 'user', text: 'go', toolUses: [] }])
  const turns = [{ at: 60_000, ms: 30_000, tokensIn: 1000, tokensOut: 200 }, { at: 300_000, ms: 60_000 }]
  const live = renderSide(body, { now: 360_000, limits: [], turns, live: true }, '/')
  expect(live.includes('<div class="side-head">')).toBe(true)
  expect(live.includes('Live · built 00:06 UTC')).toBe(true)
  expect(live.includes('2 turns · 1m 30s working')).toBe(true)
  expect(live.includes('00:00 UTC · 30s · 1.0k in · 200 out')).toBe(true)
  expect(live.includes('style=')).toBe(false)
  const snap = renderSide(body, { now: 0, limits: [] }, '/')
  expect(snap.includes('Snapshot · built')).toBe(true)
  expect(snap.includes('Timed from the next turn that ends.')).toBe(true)
})
