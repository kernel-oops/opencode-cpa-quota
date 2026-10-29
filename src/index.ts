import { Plugin } from "@opencode/plugin"
import { options, shared } from "./server.ts"
import { rpc, type Snapshot } from "./rpc.ts"

export default Plugin.define({
  id: "opencode-cpa-quota.server",
  async setup(ctx) {
    let snapshot: () => Snapshot
    try { snapshot = shared(options(ctx.options)).snapshot }
    catch { snapshot = () => ({ accounts: [], observed: null, refreshing: false, error: "configuration" }) }
    await ctx.rpc.register(rpc, { snapshot: async () => snapshot() })
  },
})
