/**
 * Fix for @types/node v24+ AbortController conditional type conflict with Bun.
 *
 * @types/node v24 defers AbortController to the DOM lib when `onmessage` exists
 * on globalThis. Bun adds `onmessage` (for Workers) without providing DOM types,
 * causing AbortController to resolve to an empty interface `{}`.
 *
 * This augmentation restores the correct AbortController shape.
 */
declare global {
  interface AbortController {
    readonly signal: AbortSignal
    abort(reason?: unknown): void
  }

  interface AbortSignal extends EventTarget {
    readonly aborted: boolean
    readonly reason: unknown
    onabort: ((this: AbortSignal, ev: Event) => unknown) | null
    throwIfAborted(): void
  }
}

export {}
