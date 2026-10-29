import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { active, hash, inventory, mergeWindows, object, type InventoryAccount } from "./parse.ts"
import type { Snapshot } from "./rpc.ts"

// Exactly one key source: a key file named in plugin options, or the CLIPROXY_MANAGEMENT_KEY environment variable.
export type Options = { url: string; keyFile?: string; key?: string }
export function options(raw: Record<string, unknown>, env: Record<string, string | undefined> = process.env): Options {
  const origin = typeof raw.url === "string" ? raw.url : env.CLIPROXY_URL
  if (!origin) throw new Error("CLIProxy URL not configured")
  const url = new URL(origin)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid CLIProxy origin")
  if (url.protocol === "http:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new Error("Remote CLIProxy requires HTTPS")
  if (typeof raw.keyFile === "string") {
    if (!isAbsolute(raw.keyFile)) throw new Error("keyFile must be absolute")
    return { url: url.origin, keyFile: raw.keyFile }
  }
  const key = env.CLIPROXY_MANAGEMENT_KEY?.trim()
  if (!key || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) throw new Error("CLIProxy management key not configured")
  return { url: url.origin, key }
}
async function readKey(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 4096) throw new Error("key permissions")
    const data = Buffer.alloc(4097)
    const { bytesRead } = await file.read(data, 0, data.length, 0)
    const key = data.subarray(0, bytesRead).toString("utf8").trim()
    if (!key || bytesRead > 4096 || !/^[\x21-\x7e]+$/.test(key)) throw new Error("invalid key")
    return key
  } finally { await file.close() }
}
export async function jsonBounded(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error("missing body")
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) throw new Error("body limit")
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}
type Entry = InventoryAccount & { due: number; failures: number }
type State = { version: 1; config: string; accounts: Entry[]; observed: number | null; next: number; managementDue: number; failures: number; rejected?: string; error: Snapshot["error"]; flight?: Promise<void> }
const singleton = Symbol.for("opencode-cpa-quota/server-state")
type Globals = typeof globalThis & { [singleton]?: State }
const minute = 60_000
const USER_AGENT = "opencode-cpa-quota/0.1.0"
function retryAfter(value: unknown, now: number, min: number, max: number): number {
  const scalar = Array.isArray(value) ? value[0] : value
  if (typeof scalar !== "string" || scalar.length > 128) return min
  const milliseconds = /^\d+$/.test(scalar) ? Number(scalar) * 1000 : Date.parse(scalar) - now
  return Number.isFinite(milliseconds) ? Math.min(max, Math.max(min, milliseconds)) : min
}
class Failure extends Error {
  constructor(readonly code: Snapshot["error"], readonly status = 0, readonly delay = 0) { super(code ?? "management") }
}

export function shared(config: Options): { snapshot(): Snapshot } {
  const global = globalThis as Globals, signature = hash(JSON.stringify(config))
  let state = global[singleton]
  if (!state) global[singleton] = state = { version: 1, config: signature, accounts: [], observed: null, next: 0, managementDue: 0, failures: 0, error: null }
  // Never create a second owner for an incompatible hot reload or conflicting project options.
  if (state.version !== 1 || state.config !== signature) return { snapshot: () => ({ accounts: [], observed: null, refreshing: false, error: "configuration" }) }
  const s = state
  async function request(path: "auth-files" | "api-call", key: string, body?: unknown): Promise<unknown> {
    const now = Date.now()
    if (now < s.managementDue || s.rejected === hash(key)) throw new Failure(s.rejected ? "credentials" : "management")
    let response: Response
    try {
      response = await fetch(config.url + "/v0/management/" + path, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(body === undefined ? 5000 : 15000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch { s.managementDue = now + minute; throw new Failure("management") }
    if (response.status === 401 || response.status === 403) {
      // CPA bans can also return 403: halt unchanged credentials, never probe repeatedly to distinguish them.
      s.rejected = hash(key); s.error = "credentials"
      await response.body?.cancel().catch(() => {})
      throw new Failure("credentials", response.status)
    }
    if (!response.ok) {
      const delay = response.status === 429 ? retryAfter(response.headers.get("retry-after"), now, minute, 15 * minute) : minute
      s.managementDue = now + delay
      await response.body?.cancel().catch(() => {})
      throw new Failure(response.status === 429 ? "rate-limited" : "management", response.status, delay)
    }
    try { return await jsonBounded(response, body === undefined ? 1024 * 1024 : 256 * 1024) }
    catch { throw new Failure("invalid-response") }
  }
  async function refresh(): Promise<void> {
    const start = Date.now()
    // A failed key read or latched credential still consumes the inventory interval.
    s.next = start + minute
    let key: string
    try { key = config.key ?? await readKey(config.keyFile!) } catch { s.error = "configuration"; return }
    if (s.rejected && s.rejected !== hash(key)) { s.rejected = undefined; s.managementDue = 0; s.failures = 0 }
    if (s.rejected === hash(key)) { s.error = "credentials"; return }
    if (Date.now() < s.managementDue) return
    try {
      const raw = await request("auth-files", key)
      let parsed: ReturnType<typeof inventory>
      try { parsed = inventory(raw, Date.now()/1000) } catch { throw new Failure("invalid-response") }
      const old = new Map(s.accounts.map(a => [a.key, a]))
      s.accounts = parsed.accounts.map(account => {
        const candidate = account.index ? old.get(account.key) : undefined
        const prev = candidate?.view.provider === account.view.provider ? candidate : undefined
        if (prev) {
          account.view.windows = mergeWindows(prev.view.windows, account.view.windows)
          account.view.activeError = prev.view.activeError
        }
        return { ...account, due: prev?.due ?? start, failures: prev?.failures ?? 0 }
      })
      s.observed = Date.now()/1000; s.failures = 0; s.error = parsed.truncated ? "truncated" : null
    } catch (cause) {
      s.failures++
      const failure = cause instanceof Failure ? cause : new Failure("management")
      s.error = failure.code
      s.next = start + Math.max(failure.delay, Math.min(15 * minute, minute * 2 ** Math.min(4,s.failures - 1)))
      return
    }
    // At most four sequential reads per refresh; oldest due first prevents new accounts starving old ones.
    const due = s.accounts.filter(a => a.index && a.view.status !== "disabled" && !a.view.cooling && ["claude", "codex"].includes(a.view.provider) && a.due <= Date.now()).sort((a,b) => a.due - b.due).slice(0,4)
    for (const account of due) {
      if (s.rejected || Date.now() < s.managementDue) break
      account.due = Date.now() + 5 * minute
      const provider = account.view.provider
      if (provider === "codex" && !account.accountID) { account.view.activeError = "unavailable"; continue }
      const header: Record<string,string> = { Authorization: "Bearer $TOKEN$", "User-Agent": USER_AGENT }
      if (provider === "claude") header["anthropic-beta"] = "oauth-2025-04-20"
      else header["Chatgpt-Account-Id"] = account.accountID!
      try {
        const raw = object(await request("api-call", key, { auth_index: account.index, method: "GET", url: provider === "claude" ? "https://api.anthropic.com/api/oauth/usage" : "https://chatgpt.com/backend-api/wham/usage", header }))
        if (raw.status_code !== 200) {
          const status = typeof raw.status_code === "number" ? raw.status_code : 0
          throw new Failure(status === 429 ? "rate-limited" : "management", status, retryAfter(object(raw.header)["Retry-After"], Date.now(), 5*minute, 60*minute))
        }
        if (typeof raw.body !== "string") throw new Failure("invalid-response")
        const windows = active(provider, JSON.parse(raw.body), Date.now()/1000)
        if (!windows.length) throw new Failure("invalid-response")
        account.view.windows = mergeWindows(account.view.windows, windows)
        account.view.activeError = null; account.failures = 0
      } catch (cause) {
        account.failures++
        const f = cause instanceof Failure ? cause : new Failure("invalid-response")
        account.view.activeError = f.status === 401 || f.status === 403 ? "credentials" : f.status === 429 ? "rate-limited" : "failed"
        account.due = Date.now() + ((!s.rejected && (f.status === 401 || f.status === 403)) ? 60*minute : Math.max(f.delay, Math.min(60*minute, 5*minute * 2 ** Math.min(4,account.failures - 1))))
        if (s.rejected || Date.now() < s.managementDue) { s.error = f.code; break }
      }
    }
  }
  return { snapshot() {
    if (!s.flight && Date.now() >= s.next) {
      // Assign synchronously before any I/O; keep the shared owner independent of RPC cancellation/unload.
      // Leave completed batches observable before another lazy refresh becomes due.
      s.flight = Promise.resolve().then(refresh).catch(() => { s.error = "management"; s.next = Date.now() + minute }).finally(() => { s.next = Math.max(s.next, Date.now() + minute); s.flight = undefined })
    }
    return { accounts: s.accounts.map(a => ({ ...structuredClone(a.view), cooling: a.view.cooling && (a.view.retry ?? 0) > Date.now()/1000 })), observed: s.observed, error: s.error, refreshing: !!s.flight }
  } }
}
