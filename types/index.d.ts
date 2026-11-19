/** One finished turn of the main conversation, as `turn.complete` reported it. */
export type TurnMark = {
  /** When it ended, in `$.clock.now()` milliseconds. */
  at: number
  /** How long it ran. */
  ms: number
  /** Tokens it read (uncached, cache-read and cache-written together) and wrote; absent when nothing counted. */
  tokensIn?: number
  tokensOut?: number
}

declare module 'claude-code' {
  interface PluginState {
    page: {
      /** The page is rebuilt after every turn: set by the first /page of the session. */
      live: boolean
      /** A browser tab was opened on this session's page. */
      opened: boolean
      /** The newest turns, oldest first. */
      turns: TurnMark[]
    }
  }
}
