# claude-page

`/page` is a Claude Code mod that renders the current session as a local, offline HTML page you can keep open in a browser tab.

- One file per session, `~/.page/<session id>.html`, rebuilt after every turn. Reload the tab to see the newest turn.
- `/page` builds the page and opens it the first time. `/page open` opens another tab. `/page clear` deletes every page and stops rebuilding.
- While a page is live, a `page ↗` link sits above the prompt; ⌘-click it to open the page.
- `~/.page` is readable only by you (directory 700, files 600). Pages and saved images are deleted 24 hours after their last write.
- The page loads nothing from the network. It has a strict Content Security Policy, uses vendored, checksummed copies of marked, highlight.js, mermaid and the Geist font, and shows remote images as links only.

## What it does on your computer

`/page` is a mod: code that Claude Code loads and runs inside itself. It needs macOS, because it opens pages with `/usr/bin/open` and decodes images with the macOS `base64`.

**Reads**, through Claude Code: the session's messages (including pasted images), its working directory, model name, usage and rate-limit figures, and `HOME`.

**Writes**, nowhere but these:

- `~/.page/`, created owner-only (700). The mod refuses to use it if it is a link or resolves anywhere other than your home folder. Inside it:
  - `<session id>.html`, one page per session (600);
  - `img/`, images pasted into the session, decoded to files (600);
  - `mermaid.min.js`, the bundled diagram library, copied in only when a page has a diagram;
  - `.keep`, an empty marker file.
- Its own state inside Claude Code: whether the page is live and the timing of the last 500 turns, for the page's sidebar.

It does not edit any build, settings, start-up or instructions file.

**Runs** these programs, each with fixed arguments and no shell:

| Program | Why |
|---|---|
| `chmod` | Make `~/.page` and every file in it owner-only |
| `cp`, `gunzip` | Copy the bundled mermaid library next to the page and decompress it (it ships gzipped to keep every file under 5 MiB) |
| `base64` | Decode a pasted image into a file |
| `rm` | Delete pages and images 24 hours after their last write, all of them on `/page clear`, and the library copy with the last page |
| `/usr/bin/open` | Open the page in your default browser on `/page` and `/page open` |

**Sends** nothing. The mod makes no network requests. The page's Content Security Policy (`default-src 'none'`, images only from `data:` and `file:`) keeps it from loading anything remote, and remote images in the session appear as links.

**Hooks:**

- `session.start` registers `/page` and deletes pages older than 24 hours.
- `command.run` handles `/page`, `/page open` and `/page clear`.
- `turn.complete` records the turn's timing and, while the page is live, rebuilds it.
- `ui.render` draws the `page ↗` link above the prompt.

## Install

```sh
claude plugin marketplace add teguhmurdianto/claude-page
claude plugin install page@claude-page --scope user
```

Then run `/page` in any session.

## Develop

Clone the repo and install it from the folder as a local marketplace. After an edit, `/reload-plugins` loads the new code without a reinstall.

```sh
claude plugin marketplace add ./claude-page
claude plugin install page@claude-page --scope user

claude plugin validate . --profile directory
claude plugin test .
```

## License

MIT. Vendored libraries keep their own licenses; see the `*.LICENSE` files in `assets/` and `hooks/vendor/`.
