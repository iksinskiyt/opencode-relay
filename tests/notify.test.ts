import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { configSchema } from "../src/config.js"
import { identity, notifiable, reduce } from "../src/notify.js"

const example = JSON.parse(await readFile(new URL("../examples/config.example.json", import.meta.url), "utf8"))
const config = configSchema.parse(example)
const withPreset = (preset: "all" | "important" | "completion") =>
  configSchema.parse({ ...example, notifications: { ...example.notifications, preset } })
const withOrchestratorOnly = (orchestratorOnly: boolean) =>
  configSchema.parse({ ...example, notifications: { ...example.notifications, orchestratorOnly } })
const everything = configSchema.parse({
  ...example,
  notifications: {
    ...example.notifications,
    preset: "all",
    categories: { ...example.notifications.categories, sessionStarted: true },
  },
})

describe("notify reducer", () => {
  it("maps a pass completion to an envelope", () => {
    const envelope = reduce({ type: "session.step.ended", data: { sessionID: "ses_1" } }, config)
    expect(envelope?.category).toBe("passCompleted")
    expect(envelope?.sessionID).toBe("ses_1")
  })

  it("drops disabled categories and unknown events", () => {
    expect(reduce({ type: "session.created", data: {} }, config)).toBeNull()
    expect(reduce({ type: "session.text.delta", data: {} }, config)).toBeNull()
  })

  it("completion preset keeps only questions, permissions, errors and task completion", () => {
    const completion = withPreset("completion")
    expect(reduce({ type: "session.idle", data: { sessionID: "s" } }, completion)?.category).toBe("taskCompleted")
    expect(reduce({ type: "form.created", data: {} }, completion)?.category).toBe("questions")
    expect(reduce({ type: "permission.asked", data: {} }, completion)?.category).toBe("permissions")
    expect(reduce({ type: "session.execution.failed", data: {} }, completion)?.category).toBe("errors")
    expect(reduce({ type: "session.step.ended", data: { sessionID: "s" } }, completion)).toBeNull()
    expect(reduce({ type: "session.execution.interrupted", data: {} }, completion)).toBeNull()
    expect(reduce({ type: "session.created", data: {} }, completion)).toBeNull()
  })

  it("important preset is the completion set plus an interrupted session", () => {
    const important = withPreset("important")
    expect(reduce({ type: "session.execution.interrupted", data: {} }, important)?.category).toBe(
      "sessionInterrupted",
    )
    expect(reduce({ type: "session.step.ended", data: { sessionID: "s" } }, important)).toBeNull()
    expect(reduce({ type: "session.created", data: {} }, important)).toBeNull()
  })

  it("never falls back to the raw event type for a known category", () => {
    const events: Array<[string, string]> = [
      ["session.step.ended", "finished a pass"],
      ["session.idle", "finished its task"],
      ["form.created", "has a question"],
      ["permission.asked", "needs your permission"],
      ["session.execution.failed", "hit an error"],
      ["session.step.failed", "hit an error"],
      ["session.created", "started"],
      ["session.execution.interrupted", "was interrupted"],
    ]
    for (const [type, happened] of events) {
      const text = reduce({ type, data: { sessionID: "ses_1" } }, everything)?.text
      expect(text).toBe(`Session ses_1 ${happened}`)
      expect(text).not.toBe(type)
    }
  })

  it("names the session by its title when the host knows one", () => {
    expect(reduce({ type: "session.step.ended", data: { sessionID: "ses_1" } }, config, "fix the router")?.text).toBe(
      "Session 'fix the router' finished a pass",
    )
  })

  it("keeps the error message in the error one-liner", () => {
    expect(
      reduce(
        { type: "session.execution.failed", data: { sessionID: "ses_1", error: { message: "provider down" } } },
        config,
      )?.text,
    ).toBe("Session ses_1 hit an error: provider down")
  })

  it("carries the assistant's own text for a pass", () => {
    const envelope = reduce(
      { type: "session.text.ended", data: { sessionID: "ses_1", text: "Renamed the router and ran `bun run test`." } },
      config,
    )

    expect(envelope?.category).toBe("passCompleted")
    expect(envelope?.text).toBe("Session ses_1 finished a pass\n\nRenamed the router and ran `bun run test`.")
  })

  it("sends the whole response text unfenced, so emphasis and headings render", () => {
    const text = `## Result\n\n${"a".repeat(2_000)} **bold** and _italic_ and \`code\``
    const body = reduce({ type: "session.text.ended", data: { sessionID: "s", text } }, config)?.text ?? ""

    // the transports split a long message themselves: the relay must not shorten or fence the answer
    expect(body).toBe(`Session s finished a pass\n\n${text}`)
  })

  it("stays a one-liner when the event carries no response text", () => {
    expect(reduce({ type: "session.text.ended", data: { sessionID: "s" } }, config)?.text).toBe(
      "Session s finished a pass",
    )
  })

  it("carries the form and permission IDs a reply needs", () => {
    const form = reduce(
      { type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_1", title: "Pick a branch" } } },
      config,
    )
    expect(form?.text).toBe("Pick a branch")
    expect(form?.sessionID).toBe("ses_1")
    expect(form?.interaction).toEqual({ type: "form", formID: "frm_1" })

    const permission = reduce(
      { type: "permission.asked", data: { id: "per_1", sessionID: "ses_2", action: "bash: rm -rf dist" } },
      config,
    )
    expect(permission?.text).toBe("bash: rm -rf dist")
    expect(permission?.sessionID).toBe("ses_2")
    expect(permission?.interaction).toEqual({ type: "permission", permissionID: "per_1" })
  })

  it("relays every field and its options in the form's own order", () => {
    const envelope = reduce(
      {
        type: "form.created",
        data: {
          form: {
            id: "frm_1",
            sessionID: "ses_1",
            title: "Deploy",
            fields: [
              {
                key: "branch",
                type: "string",
                title: "Branch",
                options: [
                  { value: "release", label: "Release" },
                  { value: "feature", label: "Feature" },
                ],
              },
              { key: "note", type: "string", title: "Note" },
              { key: "internal", type: "string", hidden: true },
            ],
          },
        },
      },
      config,
    )
    const text = envelope?.text ?? ""

    expect(text.startsWith("Deploy\n")).toBe(true)
    expect(text).toContain("1. Branch")
    expect(text).toContain("a) Release b) Feature")
    expect(text).toContain("2. Note")
    expect(text).not.toContain("internal")
    expect(text).toContain('"1: <answer>"')
    // native option order, not alphabetical or value order
    expect(text.indexOf("Release")).toBeLessThan(text.indexOf("Feature"))
  })

  it("threads each field's options, letter, required and multi flag for a native renderer", () => {
    const envelope = reduce(
      {
        type: "form.created",
        data: {
          form: {
            id: "frm_1",
            sessionID: "ses_1",
            title: "Deploy",
            fields: [
              {
                key: "branch",
                type: "string",
                title: "Branch",
                required: true,
                options: [
                  { value: "release", label: "Release" },
                  { value: "feature", label: "Feature" },
                ],
              },
              { key: "tags", type: "multiselect", options: [{ value: "a", label: "A" }] },
              { key: "note", type: "string" },
            ],
          },
        },
      },
      config,
    )

    expect(envelope?.question?.formID).toBe("frm_1")
    expect(envelope?.question?.fields).toEqual([
      {
        key: "branch",
        label: "Branch",
        required: true,
        multi: false,
        options: [
          { letter: "a", label: "Release", value: "release" },
          { letter: "b", label: "Feature", value: "feature" },
        ],
      },
      { key: "tags", label: "tags", required: false, multi: true, options: [{ letter: "a", label: "A", value: "a" }] },
      { key: "note", label: "note", required: false, multi: false, options: [] },
    ])
  })

  it("keeps a one-field form short and says how to answer it", () => {
    const text =
      reduce(
        {
          type: "form.created",
          data: {
            form: {
              id: "frm_1",
              sessionID: "ses_1",
              title: "Pick a branch",
              fields: [{ key: "branch", type: "string", options: [{ value: "main", label: "main" }] }],
            },
          },
        },
        config,
      )?.text ?? ""

    expect(text.startsWith("Pick a branch\n")).toBe(true)
    expect(text).not.toContain("1. branch")
    expect(text).toContain("reply with the answer")
    expect(text).toContain("a) main")
  })

  it("keeps a subagent's child session quiet unless orchestratorOnly is off", () => {
    const idle = { type: "session.idle", data: { sessionID: "ses_child" } }

    expect(notifiable(idle, config, "ses_parent")).toBe(false)
    expect(reduce(idle, config, undefined, "ses_parent")).toBeNull()
    expect(reduce(idle, withOrchestratorOnly(false), undefined, "ses_parent")?.category).toBe("taskCompleted")
  })

  it("always relays the root session", () => {
    const idle = { type: "session.idle", data: { sessionID: "ses_root" } }

    expect(notifiable(idle, config, null)).toBe(true)
    expect(reduce(idle, config, undefined, null)?.category).toBe("taskCompleted")
    // unknown parentage relays rather than swallowing the orchestrator's own notice
    expect(reduce(idle, config)?.category).toBe("taskCompleted")
  })

  it("names the sending session on the first line of every notice", () => {
    expect(identity("fix the router")).toBe("🤖 Relay · *fix the router*")
    expect(identity()).toBe("🤖 Relay")
  })
})
