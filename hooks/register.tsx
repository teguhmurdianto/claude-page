import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import { MERMAID_FILE, MERMAID_INIT, MERMAID_MARK, PAGE_JS, renderBody, renderPage, sha256Csp, stripInjected, STYLE } from './render'
import type { Msg, Usage } from './render'
import type { TurnMark } from '../types'

const COMMAND = 'page'
const FOLDER = '.page'
const TTL_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 5000
const TURNS_KEPT = 500

const LIVE = { plugin: 'page', key: 'live' } as const
/** Read while drawing the link band, so turning the page on or off redraws it. */
const liveAtom = atom(LIVE, false)
const OPENED = { plugin: 'page', key: 'opened' } as const
const TURNS = { plugin: 'page', key: 'turns' } as const

/**
 * ~/.page, made owner-only. Refuses a folder that is a link or resolves
 * anywhere else, so a planted symlink cannot redirect session text.
 */
async function pageDir($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  if (home === undefined || !home.startsWith('/')) throw new Error('HOME is not an absolute path')
  const dir = `${home}/${FOLDER}`
  if (!(await $.fs.exists(dir))) await $.fs.write(`${dir}/.keep`, '')
  const [st, homeSt] = [await $.fs.stat(dir, { resolve: true }), await $.fs.stat(home, { resolve: true })]
  if (st.isLink || st.kind !== 'dir' || st.realPath !== `${homeSt.realPath}/${FOLDER}`) {
    throw new Error(`${dir} is not a plain folder in your home; left alone`)
  }
  await run($, ['chmod', '700', dir])
  return dir
}

async function run($: EngineInterface, argv: string[]): Promise<void> {
  const ran = await $.process.run(argv, { timeoutMs: TIMEOUT_MS })
  if (ran.exitCode !== 0) throw new Error(`${argv[0]} failed: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)
}

/** Deletes this mod's pages and saved images: all of them, or those older than the TTL. */
async function clean($: EngineInterface, dir: string, all: boolean): Promise<number> {
  const now = await $.clock.now()
  const stale = async (folder: string, ext: RegExp) => (await $.fs.exists(folder) ? await $.fs.list(folder) : [])
    .filter(f => f.kind === 'file' && !f.isLink && ext.test(f.name))
    .filter(f => all || now - f.mtimeMs > TTL_MS)
    .map(f => `${folder}/${f.name}`)
  const pages = await stale(dir, /\.html$/)
  const old = [...pages, ...(await stale(`${dir}/${IMG_FOLDER}`, /\.(png|jpg|gif|webp|b64)$/))]
  if (old.length > 0) await run($, ['rm', '-f', '--', ...old])
  // The diagram library copy is only there for pages; it goes with the last one.
  const lib = `${dir}/${MERMAID_FILE}`
  if (await $.fs.exists(lib) && !(await $.fs.list(dir)).some(f => f.kind === 'file' && f.name.endsWith('.html'))) await run($, ['rm', '-f', '--', lib])
  return pages.length
}

const IMG_FOLDER = 'img'
const IMG_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const IMG_MAX = 4 * 1024 * 1024

/** The text a message is matched on across the two message forms. */
const key = (text: string) => stripInjected(text).replace(/\s+/g, ' ')

async function hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...digest.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Images pasted into user messages, saved as files under ~/.page/img and
 * attached to the matching message. The plain message list carries no
 * images, so they come from the API form, matched on the message's text;
 * one it cannot match (compacted away) is left out.
 */
async function withPastedImages($: EngineInterface, dir: string, messages: readonly SessionMessage[]): Promise<Msg[]> {
  const out: Msg[] = messages.map(m => ({ ...m }))
  const imgDir = `${dir}/${IMG_FOLDER}`
  const used = new Set<number>()
  for (const m of await $.session.messages({ as: 'api' })) {
    if (m.role !== 'user') continue
    const blocks = m.content
    const images = blocks.filter(b => b.type === 'image')
    if (images.length === 0) continue
    // Normalization merges neighbouring user messages into one, so the images
    // belong to the text block nearest before them (after, if none), not to all
    // of the message's text.
    const first = blocks.indexOf(images[0]!)
    const texts = blocks.map((b, i) => ({ i, k: b.type === 'text' ? key(String(b.text ?? '')).trim() : '' })).filter(t => t.k !== '')
    const order = [...texts.filter(t => t.i < first).reverse(), ...texts.filter(t => t.i > first)]
    const whole = key(texts.map(t => t.k).join('\n')).trim()
    let at = -1
    for (const k of [...order.map(t => t.k), whole]) {
      at = out.findIndex((o, i) => !used.has(i) && o.role === 'user' && key(o.text).trim() === k)
      if (at >= 0) break
    }
    if (at < 0) continue
    used.add(at)
    const paths: string[] = []
    for (const img of images) {
      const source = img.source as { type?: string; media_type?: string; data?: string } | undefined
      const ext = IMG_TYPES[source?.media_type ?? '']
      if (source?.type !== 'base64' || ext === undefined || typeof source.data !== 'string' || source.data.length > IMG_MAX) continue
      if (!/^[A-Za-z0-9+/=\s]+$/.test(source.data)) continue
      const base = `${imgDir}/${await hex(source.data)}`
      // Named by content, so an image saved by an earlier build is reused.
      if (await $.fs.exists(`${base}.${ext}`)) {
        paths.push(`${base}.${ext}`)
        continue
      }
      await $.fs.write(`${base}.b64`, source.data)
      await run($, ['base64', '-d', '-i', `${base}.b64`, '-o', `${base}.${ext}`])
      await run($, ['rm', '-f', '--', `${base}.b64`])
      await run($, ['chmod', '600', `${base}.${ext}`])
      paths.push(`${base}.${ext}`)
    }
    out[at] = { ...out[at]!, images: paths }
  }
  return out
}

/** The session's figures for the sidebar; the plain call is free. Missing ones are left out. */
async function usage($: EngineInterface, now: number): Promise<Usage> {
  const { value: turns = [] } = await $.state.get(TURNS)
  const { value: live = false } = await $.state.get(LIVE)
  try {
    const u = await $.session.usage()
    return { now, startedAt: u.startedAt, context: u.context, costUsd: u.cost?.usd, limits: u.rateLimits, turns, live }
  } catch {
    return { now, limits: [], turns, live }
  }
}

/**
 * Builds this session's page, always to the same file (~/.page/<session id>.html),
 * so a tab already open on it shows the newest build on reload. `open` also
 * shows it in the browser. Returns the path and how many pasted images it holds.
 */
async function makePage($: EngineInterface, open: boolean): Promise<{ path: string; images: number }> {
  const dir = await pageDir($)
  const cwd = await $.session.cwd()
  const messages = await withPastedImages($, dir, await $.session.messages())
  const id = (await $.session.id()).replace(/[^A-Za-z0-9-]/g, '')
  const now = await $.clock.now()
  const iso = new Date(now).toISOString()
  const path = `${dir}/${id}.html`

  const asset = (name: string) => $.fs.read(`${$.plugin.root}/assets/${name}`)
  const css = `${await asset('fonts.css')}\n${await asset('github-markdown.css')}\n${STYLE}`
  const body = renderBody(messages, cwd)
  // Mermaid only when there is a diagram. Copied fresh each time, so the copy
  // beside the pages is always the vendored, checksummed one.
  const mermaid = body.thread.includes(MERMAID_MARK)
  if (mermaid) {
    const lib = `${dir}/${MERMAID_FILE}`
    await run($, ['cp', '-f', '--', `${$.plugin.root}/assets/${MERMAID_FILE}`, lib])
    await run($, ['chmod', '600', lib])
  }
  const html = renderPage({
    title: body.title,
    meta: `${iso.slice(0, 16).replace('T', ' ')} UTC · ${await $.session.model()} · ${body.prompts} prompt${body.prompts === 1 ? '' : 's'}`,
    cwd,
    body,
    usage: await usage($, now),
    css,
    hashes: {
      style: await sha256Csp(css),
      page: await sha256Csp(PAGE_JS),
      init: mermaid ? await sha256Csp(MERMAID_INIT) : undefined,
    },
  })
  await $.fs.write(path, html)
  await run($, ['chmod', '600', path])
  if (open) await run($, ['/usr/bin/open', path])
  return { path, images: messages.reduce((n, m) => n + (m.images?.length ?? 0), 0) }
}

const imagesNote = (n: number) => (n === 0 ? '' : ` (${n} pasted image${n === 1 ? '' : 's'})`)

/**
 * /page: builds the page and turns on rebuilding after every turn; opens a
 * tab the first time, after that a reload of that tab shows the newest.
 * /page open: builds and opens a tab regardless. /page clear: deletes every
 * page and stops the rebuilding.
 */
async function command($: EngineInterface, args: string): Promise<string> {
  if (args === 'clear') {
    await update($, liveAtom, () => false)
    await $.state.set(OPENED, false)
    return `Deleted ${await clean($, await pageDir($), true)} page(s). Rebuilding after each turn is off until the next /page.`
  }
  const { value: opened = false } = await $.state.get(OPENED)
  await update($, liveAtom, () => true)
  const open = args === 'open' || !opened
  const { path, images } = await makePage($, open)
  if (open) {
    await $.state.set(OPENED, true)
    return `Opened ${path}${imagesNote(images)}. It is rebuilt after every turn: reload the tab (⌘R) for the newest.`
  }
  return `Rebuilt ${path}${imagesNote(images)}. Reload its tab (⌘R); /page open opens a new one.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'This session as a local HTML page, rebuilt after every turn (deleted 24h after the last)',
      argumentHint: '[open|clear]',
    })
    const result = await next(e)
    try {
      if (await $.fs.exists(`${(await $.env.get('HOME')) ?? ''}/${FOLDER}`)) await clean($, await pageDir($), false)
    } catch (error) {
      $.ui.log(`page: cleanup skipped: ${String(error)}`, { to: 'debug' })
    }
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    try {
      return { text: await command($, e.args.trim()) }
    } catch (error) {
      return { text: `page: ${String(error)}` }
    }
  })

  // Every main-loop turn is noted for the sidebar's timeline; once /page has
  // run, the page is rebuilt too. Neither may disturb the turn itself.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    try {
      const u = e.usage
      const mark: TurnMark = {
        at: await $.clock.now(),
        ms: e.durationMs,
        ...(u === undefined ? {} : { tokensIn: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, tokensOut: u.output_tokens }),
      }
      const { value: turns = [] } = await $.state.get(TURNS)
      await $.state.set(TURNS, [...turns, mark].slice(-TURNS_KEPT))
      const { value: live = false } = await $.state.get(LIVE)
      if (live) await makePage($, false)
    } catch (error) {
      $.ui.log(`page: rebuild skipped: ${String(error)}`, { to: 'debug' })
    }
    return result
  })

  // A short link to the live page in the band above the prompt; ⌘-click opens it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, liveAtom))) return next(e)
    const home = await $.env.get('HOME')
    const path = `${home ?? ''}/${FOLDER}/${(await $.session.id()).replace(/[^A-Za-z0-9-]/g, '')}.html`
    if (home === undefined || !(await $.fs.exists(path))) return next(e)
    const { Box, Link, Text } = $.ui.resolve(e)
    return (
      <Box borderStyle="round" borderColor="subtle" marginTop={1} paddingX={1} columnGap={1} alignSelf="flex-start">
        <Text color="claude">●</Text>
        <Text bold>page</Text>
        <Text color="success">live</Text>
        <Text color="subtle">│</Text>
        <Link href={`file://${encodeURI(path)}`} label="open ↗" />
        <Text color="subtle">⌘-click</Text>
      </Box>
    )
  })
}
