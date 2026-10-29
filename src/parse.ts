import { createHash } from "node:crypto"

export type Window = { name: string; used: number; remaining: number; reset: number | null; observed: number; source: "passive" | "active"; duration?: number }
export type Account = { id: string; provider: string; status: "active" | "disabled" | "error" | "pending" | "unknown"; unavailable: boolean; cooling: boolean; retry: number | null; modelCooldowns: number; windows: Window[]; activeError: "unavailable" | "failed" | "credentials" | "rate-limited" | null }
export type InventoryAccount = { key: string; index?: string; accountID?: string; view: Account }
export const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}
export const hash = (v: string) => createHash("sha256").update(v).digest("hex")
export function text(v: unknown, fallback: string, max = 48): string {
  return typeof v === "string" && v.length > 0 && v.length <= max && /^[a-zA-Z0-9_. -]+$/.test(v) ? v : fallback
}
export function number(v: unknown, max = 1e6): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined
}
export function epoch(v: unknown): number | null {
  const n = typeof v === "string" ? Date.parse(v) / 1000 : v
  return typeof n === "number" && Number.isFinite(n) && n >= 1577836800 && n <= 4102444800 ? n : null
}
function numericHeader(v: unknown, max = 1e6): number | undefined {
  if (typeof v !== "string" || v.length > 32 || !/^\d+(\.\d+)?$/.test(v)) return undefined
  return number(Number(v), max)
}
function makeWindow(name: string, used: unknown, reset: unknown, observed: number, source: Window["source"]): Window | undefined {
  const n = number(used, 10000)
  if (n === undefined) return
  return { name, used: n, remaining: Math.max(0, 100 - n), reset: epoch(reset), observed, source }
}
function duration(seconds: unknown, minutes?: unknown): number | undefined {
  const value = number(seconds, 31536000) ?? (number(minutes, 525600) ?? 0) * 60
  return value > 0 && Number.isInteger(value) ? value : undefined
}
export function passive(raw: unknown, now: number): Window[] {
  const q = object(raw), observed = epoch(q.observed_at)
  if (observed === null || observed > now + 300) return []
  const headers = Object.fromEntries(Object.entries(object(q.signals)).slice(0, 128).map(([k,v]) => [k.toLowerCase(), v]))
  const result: Window[] = []
  for (const [key, value] of Object.entries(headers)) {
    let match = /^anthropic-ratelimit-unified-([a-z0-9-]{1,32})-utilization$/.exec(key)
    if (match) {
      const fraction = numericHeader(value)
      const reset = numericHeader(headers[`anthropic-ratelimit-unified-${match[1]}-reset`], 4102444800)
      const name = match[1] === "5h" ? "five_hour" : match[1] === "7d" ? "seven_day" : match[1] === "7d-opus" ? "seven_day_opus" : match[1] === "7d-sonnet" ? "seven_day_sonnet" : match[1]!
      const window = makeWindow(name, fraction === undefined ? undefined : fraction * 100, reset, observed, "passive")
      if (window) result.push(window)
      continue
    }
    match = /^x-codex-(?:([a-z0-9-]{1,32})-)?(primary|secondary)-used-percent$/.exec(key)
    if (!match) continue
    const stem = key.slice(0, -"used-percent".length)
    const resetAt = numericHeader(headers[stem + "reset-at"], 4102444800)
    const after = numericHeader(headers[stem + "reset-after-seconds"])
    const reset = resetAt ?? (after === undefined ? undefined : observed + after)
    const window = makeWindow((match[1] ? match[1] + "_" : "") + match[2], numericHeader(value), reset, observed, "passive")
    const period = duration(undefined, numericHeader(headers[stem + "window-minutes"]))
    if (window && period) window.duration = period
    if (window) result.push(window)
  }
  return result.slice(0, 24)
}
export function active(provider: string, raw: unknown, now: number): Window[] {
  const body = object(raw), result: Window[] = []
  if (provider === "claude") {
    for (const name of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]) {
      const item = object(body[name]), window = makeWindow(name, item.utilization, item.resets_at, now, "active")
      if (window) result.push(window)
    }
  } else if (provider === "codex") {
    for (const name of ["primary", "secondary"]) {
      const item = object(object(body.rate_limit)[name + "_window"])
      const after = number(item.reset_after_seconds)
      const window = makeWindow(name, item.used_percent, item.reset_at ?? (after === undefined ? undefined : now + after), now, "active")
      const period = duration(item.limit_window_seconds, item.window_minutes)
      if (window && period) window.duration = period
      if (window) result.push(window)
    }
  }
  return result
}
export function mergeWindows(a: Window[], b: Window[]): Window[] {
  const windows = new Map(a.map(w => [w.name, w]))
  for (const w of b) if (!windows.has(w.name) || windows.get(w.name)!.observed <= w.observed) windows.set(w.name, w)
  return [...windows.values()].slice(0,24)
}
export function inventory(raw: unknown, now: number): { accounts: InventoryAccount[]; truncated: boolean } {
  const files = object(raw).files
  if (!Array.isArray(files)) throw new Error("invalid inventory")
  const accounts: InventoryAccount[] = [], seen = new Set<string>()
  for (const [i, raw] of files.slice(0,200).entries()) {
    const item = object(raw)
    const index = typeof item.auth_index === "string" && /^[a-fA-F0-9]{16}$/.test(item.auth_index) ? item.auth_index : undefined
    const key = index ? hash(index) : `unknown-${i + 1}`
    if (seen.has(key)) continue
    seen.add(key)
    const provider = text(item.provider ?? item.type, "unknown", 32).toLowerCase()
    const status = ["active", "disabled", "error", "pending"].includes(String(item.status)) ? item.status as Account["status"] : "unknown"
    const retry = epoch(item.next_retry_after)
    const cooldowns = Array.isArray(item.cooldowns) ? item.cooldowns.slice(0,200).map(object) : []
    // The claim is retained only on the server for the fixed Codex usage endpoint.
    const accountID = object(item.id_token)["https://api.openai.com/auth"]
    const claim = object(accountID).chatgpt_account_id
    const directClaim = object(item.id_token).chatgpt_account_id
    const candidate = claim ?? directClaim
    accounts.push({ key, index, accountID: typeof candidate === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(candidate) ? candidate : undefined,
      view: { id: key, provider, status: item.disabled === true ? "disabled" : status, unavailable: item.unavailable === true, cooling: item.unavailable === true && retry !== null && retry > now, retry, modelCooldowns: cooldowns.filter(c => c.scope === "model" && (epoch(c.retry_at) ?? 0) > now).length, windows: passive(item.quota, now), activeError: index && (provider === "claude" || provider === "codex") ? null : "unavailable" } })
  }
  for (const account of accounts) {
    if (!account.index) continue
    let length = 4
    while (length < 64 && accounts.some(other => other !== account && other.key.startsWith(account.key.slice(0,length)))) length++
    account.view.id = account.key.slice(0,length)
  }
  return { accounts, truncated: files.length > 200 }
}
