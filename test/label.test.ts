import { expect, test } from "bun:test"
import { emailLabel, inventory } from "../src/parse.ts"
import { compact } from "../src/display.ts"

const file = (auth_index: string, email: unknown, provider = "claude") => ({ auth_index, email, provider, status: "active" })
const labels = (files: unknown[]) => inventory({ files }, 1_800_000_000).accounts.map(a => a.view.label)

test("email label: normal, malformed and missing", () => {
  expect(emailLabel("marc@kernel-panic.im")).toBe("ma@ke")
  expect(emailLabel("Admin@Bigcorp.example")).toBe("ad@bi")
  expect(emailLabel("j.smith@x.io")).toBe("js@xi")
  for (const bad of [undefined, 42, "", "no-at-sign", "a@b@c", "a b@c.d", "@x.com", "x@", "..@--", "é@ü", "x".repeat(250) + "@a.bc"]) expect(emailLabel(bad)).toBeUndefined()
})

test("labels replace #id, fall back to it and disambiguate clashes per provider", () => {
  const [a, b, c, d, e] = labels([
    file("0000000000000001", "marc@kernel-panic.im"),
    file("0000000000000002", "admin@bigcorp.example"),
    file("0000000000000003", "admin@bigcorp.example", "codex"),
    file("0000000000000004", "adam@bigcorp.example"),
    file("0000000000000005", "<script>"),
  ])
  expect(a).toBe("ma@ke")
  expect(c).toBe("ad@bi") // same label, different provider: no suffix
  expect(b).toMatch(/^ad@bi·[0-9a-f]+$/)
  expect(d).toMatch(/^ad@bi·[0-9a-f]+$/)
  expect(b).not.toBe(d)
  expect(e).toMatch(/^#[0-9a-f]{4,}$/)
  const accounts = inventory({ files: [file("0000000000000001", "marc@kernel-panic.im")] }, 1_800_000_000).accounts.map(a => a.view)
  expect(compact({ accounts: [{ ...accounts[0]!, status: "disabled" }], refreshing: false, observed: null, error: null }, 1_800_000_000)).toBe("CPA Claude ma@ke · Disabled")
})
