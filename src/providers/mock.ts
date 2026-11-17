import pino from "pino"
import type { Logger } from "pino"
import type { Provider } from "../envelope.js"

/** Local sink: logs envelopes instead of talking to WhatsApp/Discord. */
export function mockProvider(log: Logger = pino()): Provider {
  return {
    async send(envelope) {
      log.info({ envelope }, "relay envelope")
      return `mock-${envelope.id}`
    },
  }
}
