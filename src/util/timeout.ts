// Bounded waits for SDK calls. The plugin SDK client disables fetch timeouts, so every request
// the plugin makes must carry its own deadline; the AbortSignal is passed to the request so a hung
// connection is actually torn down instead of leaking.

export class TimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`${what} timed out after ${timeoutMs}ms`)
    this.name = "TimeoutError"
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error()), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// Runs `call` with a fresh AbortSignal that fires when the deadline passes. The SDK request
// options extend `RequestInit`, so the signal cancels the underlying fetch.
export function withDeadline<T>(
  what: string,
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let invoked: Promise<T>
  try {
    invoked = Promise.resolve(call(controller.signal))
  } catch (error) {
    return Promise.reject(error)
  }
  return withTimeout(invoked, timeoutMs, () => {
    controller.abort()
    return new TimeoutError(what, timeoutMs)
  })
}
