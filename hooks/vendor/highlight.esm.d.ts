// Types for the part of highlight.js 11.12.0 (@highlightjs/cdn-assets, es/highlight.min.js) this mod uses.
declare const hljs: {
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string; language?: string }
  getLanguage(name: string): { name?: string } | undefined
}
export default hljs
