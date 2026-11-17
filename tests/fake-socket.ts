import type { GatewaySocket } from "../src/providers/discord-gateway.js"

/** A socket that records what the gateway sent and lets the test play Discord's part. */
export class FakeSocket implements GatewaySocket {
  readonly sent: string[] = []
  closed: number | undefined
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closed = code ?? 1000
    this.onclose?.({ code: this.closed, ...(reason === undefined ? {} : { reason }) })
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  payloads(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
  }

  /** HELLO then READY, the two frames a fresh identify expects. */
  open(applicationID = "app1"): void {
    this.emit({ op: 10, d: { heartbeat_interval: 600_000 } })
    this.emit({
      op: 0,
      s: 1,
      t: "READY",
      d: {
        session_id: "sess1",
        resume_gateway_url: "wss://resume.test",
        application: { id: applicationID },
        user: { username: "relay" },
      },
    })
  }
}

/** Sockets handed out in creation order; `last()` is the newest connection. */
export const sockets = () => {
  const made: FakeSocket[] = []
  return {
    made,
    factory: (url: string) => {
      const socket = new FakeSocket(url)
      made.push(socket)
      return socket
    },
    last: () => made[made.length - 1] as FakeSocket,
  }
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 5))
