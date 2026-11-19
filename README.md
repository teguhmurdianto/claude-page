# claude-page

`/page` is a Claude Code mod that renders the current session as a local, offline HTML page you can keep open in a browser tab.

- One file per session, `~/.page/<session id>.html`, rebuilt after every turn. Reload the tab to see the newest turn.
- `/page` builds the page and opens it the first time. `/page open` opens another tab. `/page clear` deletes every page and stops rebuilding.
- While a page is live, a `page ↗` link sits above the prompt; ⌘-click it to open the page.
- `~/.page` is readable only by you (directory 700, files 600). Pages and saved images are deleted 24 hours after their last write.
- The page loads nothing from the network. It has a strict Content Security Policy, uses vendored, checksummed copies of marked, highlight.js, mermaid and the Geist font, and shows remote images as links only.

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
