import type { Account } from "./parse.ts"
export type Snapshot = { accounts: Account[]; refreshing: boolean; observed: number | null; error: "configuration" | "credentials" | "management" | "rate-limited" | "invalid-response" | "truncated" | null }
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] })
const bounded = { type: "number", minimum: 0, maximum: 1e6 }
const time = nullable({ type: "number", minimum: 1577836800, maximum: 4102444800 })
const record = (properties: Record<string, unknown>, optional: string[] = []) => ({ type: "object", properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false })
export const rpc = {
  id: "opencode-cpa-quota",
  methods: { snapshot: { input: record({}), output: record({
    accounts: { type: "array", maxItems: 200, items: record({
      id: { type: "string", minLength: 4, maxLength: 64 },
      provider: { type: "string", maxLength: 32 },
      status: { enum: ["active", "disabled", "error", "pending", "unknown"] }, unavailable: { type: "boolean" }, cooling: { type: "boolean" }, retry: time,
      modelCooldowns: bounded, activeError: { enum: [null, "unavailable", "failed", "credentials", "rate-limited"] },
      windows: { type: "array", maxItems: 24, items: record({ name: { type: "string", maxLength: 48 }, used: bounded, remaining: bounded, reset: time, observed: time, source: { enum: ["active", "passive"] }, duration: { type: "integer", minimum: 1, maximum: 31536000 } }, ["duration"]) },
    }) }, refreshing: { type: "boolean" }, observed: time,
    error: { enum: [null, "configuration", "credentials", "management", "rate-limited", "invalid-response", "truncated"] },
  }) } }, events: {},
} as const
