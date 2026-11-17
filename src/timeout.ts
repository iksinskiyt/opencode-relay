/** One network call on the relay loop may not hold it longer than this. */
export const NETWORK_TIMEOUT_MS = 10_000

/**
 * A deadline for work that has no signal of its own (Baileys socket calls). The loser of the race
 * keeps running, so the only cleanup needed is its timer.
 */
export function withDeadline<T>(work: Promise<T>, label: string, ms = NETWORK_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/**
 * fetch that cannot hang the loop: an abort deadline on the socket, plus a race for an
 * implementation that ignores the signal (a stub, or a connect stuck before headers).
 */
export function boundedFetch(impl: typeof fetch, ms = NETWORK_TIMEOUT_MS): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    withDeadline(
      impl(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) }),
      `fetch ${String(input)}`,
      ms,
    )) as typeof fetch
}
