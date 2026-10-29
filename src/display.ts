import type { Snapshot } from "./rpc.ts"
import type { Account, Window } from "./parse.ts"

const periods = new Map<string,number>([["five_hour",18000],["seven_day",604800],["seven_day_opus",604800],["seven_day_sonnet",604800]])
const labels = new Map<string,string>([["five_hour","5 hour"],["seven_day","7 day"],["seven_day_opus","7 day Opus"],["seven_day_sonnet","7 day Sonnet"]])
const usageErrors = new Map<string,string>([["credentials","Usage authentication failed"],["rate-limited","Usage rate-limited"],["failed","Usage refresh failed"]])
const managementErrors = new Map<string,string>([["configuration","configuration error"],["credentials","management authentication failed"],["management","management unavailable"],["rate-limited","management rate-limited"],["invalid-response","management response changed"],["truncated","inventory truncated"]])
export const providerName = (name: string) => name === "claude" ? "Claude" : name === "codex" ? "Codex" : name.charAt(0).toUpperCase() + name.slice(1)
const period = (w: Window) => periods.get(w.name) ?? w.duration
export function windowLabel(w: Window): string {
  const known = labels.get(w.name)
  if (known) return known
  const seconds = period(w)
  const label = seconds && seconds % 86400 === 0 ? `${seconds/86400} day` : seconds && seconds % 3600 === 0 ? `${seconds/3600} hour` : seconds && seconds % 60 === 0 ? `${seconds/60} min` : "Quota"
  if (w.name === "primary") return seconds ? label : "Quota window"
  if (w.name === "secondary") return seconds ? label : "Other quota"
  return `${label} ${w.name.replace(/^additional_/, "").replace(/_(primary|secondary)$/, "").replaceAll("_", " ")}`
}
export function visibleWindows(a: Account, now: number): Window[] {
  return a.windows.filter(w => w.reset === null || w.reset > now).sort((a,b) => (period(a) ?? Infinity) - (period(b) ?? Infinity) || a.name.localeCompare(b.name))
}
export function countdown(reset: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((reset-now)/60)), hours = Math.floor(minutes/60), days = Math.floor(hours/24)
  return days ? `${days}d ${hours%24}h` : hours ? `${hours}h ${minutes%60}m` : `${minutes}m`
}
export function resets(windows: Window[], now: number): string {
  return [...new Set(windows.map(w => w.reset).filter((r): r is number => r !== null && r > now))].map(r => countdown(r,now)).join(" / ")
}
export function quotaBar(remaining: number, width: number) {
  const percent = Math.round(Math.max(0, Math.min(100, remaining)))
  const cells = Math.max(1, Math.floor(width)), filled = Math.round(percent*cells/100)
  return { percent, fill: "▒".repeat(filled), track: "▒".repeat(cells-filled), tone: remaining <= 10 ? "error" as const : remaining < 20 ? "warning" as const : "success" as const }
}
export function accountWarnings(a: Account, now: number, connectionUnavailable = false): string[] {
  const warnings: string[] = [], windows = visibleWindows(a,now)
  if (a.status === "disabled") warnings.push("Disabled")
  else if (a.cooling && a.retry && a.retry > now) warnings.push(`Cooling · retry in ${countdown(a.retry,now)}`)
  else if (a.unavailable) warnings.push("Account unavailable")
  else if (a.status !== "active") warnings.push(a.status === "error" ? "Account error" : a.status === "pending" ? "Account pending" : "Status unknown")
  if (a.modelCooldowns) warnings.push(`${a.modelCooldowns} model cooldowns`)
  if (a.activeError && a.activeError !== "unavailable") warnings.push(usageErrors.get(a.activeError) ?? "Usage refresh failed")
  else if (a.activeError === "unavailable" && !windows.length) warnings.push("Active usage unavailable")
  if (windows.length && (connectionUnavailable || a.activeError && a.activeError !== "unavailable" || windows.some(w => now-w.observed > 600))) {
    const age = Math.max(0, Math.floor((now-Math.min(...windows.map(w=>w.observed)))/60))
    warnings.push(`Last known quota · ${age}m old`)
  }
  return warnings
}
export function compact(s: Snapshot | undefined, now: number): string {
  if (!s) return "CPA unavailable"
  if (s.error) return `CPA ${managementErrors.get(s.error) ?? "management unavailable"}`
  for (const a of s.accounts) {
    const warning = accountWarnings(a,now).find(w => !w.startsWith("Last known") && w !== "Active usage unavailable")
    if (warning) return `CPA ${providerName(a.provider)} #${a.id} · ${warning}`
  }
  const windows = s.accounts.flatMap(a=>visibleWindows(a,now))
  const low = s.accounts.find(a=>visibleWindows(a,now).some(w=>w.remaining<20))
  if (low) return `CPA ${providerName(low.provider)} #${low.id} · low quota`
  if (windows.length && windows.every(w=>now-w.observed>600)) return "CPA quota stale"
  return `CPA ${s.accounts.length} account${s.accounts.length===1 ? "" : "s"}${s.accounts.length && !windows.length ? " · awaiting quota" : ""}`
}
