import { afterEach, beforeEach, expect, test, setSystemTime } from "bun:test"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { active, epoch, hash, inventory, mergeWindows, passive } from "../src/parse.ts"
import { accountWarnings, compact, countdown, providerName, quotaBar, resets, visibleWindows, windowLabel } from "../src/display.ts"
import { jsonBounded, options, shared } from "../src/server.ts"
import { rpc } from "../src/rpc.ts"

const root = resolve(import.meta.dir, "../.fixture")
const keyFile = root + "/management-key"
const symbol = Symbol.for("opencode-cpa-quota/server-state")
const globals = globalThis as typeof globalThis & { [symbol]?: { flight?: Promise<void> } }
const now = 1792854000
let clock = now * 1000
let server: ReturnType<typeof Bun.serve> | undefined
const row = (n = 1, provider = "claude") => ({ auth_index: n.toString(16).padStart(16,"0"), provider, status: "active", id_token: { chatgpt_account_id: "fixture-account" } })
const quota = { observed_at: new Date(now*1000).toISOString(), signals: { "Anthropic-Ratelimit-Unified-5h-Utilization": "0.4", "Anthropic-Ratelimit-Unified-5h-Reset": String(now + 3600) } }
const usage = { five_hour: { utilization: 20, resets_at: new Date((now+3600)*1000).toISOString() } }
beforeEach(async () => { delete globals[symbol]; clock = now*1000; setSystemTime(clock); await mkdir(root,{recursive:true}); await writeFile(keyFile,"fixture-key",{mode:0o600}); await chmod(keyFile,0o600) })
afterEach(async () => { await globals[symbol]?.flight; server?.stop(true); server = undefined; delete globals[symbol]; setSystemTime(); await rm(root,{recursive:true,force:true}) })
const advance = (ms: number) => { clock += ms; setSystemTime(clock) }
const settle = async () => { await globals[symbol]?.flight }
function start(handler: (request: Request) => Response | Promise<Response>) {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  return { url: `http://127.0.0.1:${server.port}`, keyFile }
}

test("tolerant account inventory ignores secrets/extras and keeps malformed siblings", () => {
  const parsed = inventory({ extra: true, files: [{ ...row(), quota, email: "SECRET", path: "SECRET", quota_probe: "SECRET", label: "SECRET", cooldowns: [{scope:"model",retry_at:now+60},{scope:"credential",retry_at:now+60}] }, { ...row(2,"future-provider"), provider: "evil\u202eSECRET" }, { auth_index: "SECRET", provider: "devin", status: "SECRET" }, null] }, now)
  expect(parsed.accounts.length).toBe(4)
  expect(parsed.accounts[0]!.view.windows[0]!.used).toBe(40)
  expect(parsed.accounts[0]!.view.modelCooldowns).toBe(1)
  expect(parsed.accounts[1]!.view.provider).toBe("unknown")
  expect(parsed.accounts[2]!.index).toBeUndefined()
  expect(JSON.stringify(parsed.accounts.map(a=>a.view))).not.toContain("SECRET")
  expect(parsed.accounts[0]!.view.id.length).toBeGreaterThanOrEqual(4)
  expect(inventory({files:Array.from({length:201},(_,i)=>row(i))},now).truncated).toBe(true)
  expect(()=>inventory({ files:"changed",extra:[] },now)).toThrow()
})
test("duplicate indices coalesce, distinct hashes use unique shortest prefixes", () => {
  const rows = Array.from({length:200},(_,i)=>row(i))
  const parsed = inventory({files:[rows[0],...rows.slice(0,199)]},now)
  expect(new Set(parsed.accounts.map(a=>a.view.id)).size).toBe(parsed.accounts.length)
  expect(parsed.accounts[0]!.view.id).toBe(hash(rows[0]!.auth_index).slice(0,4))
})
test("active parsers preserve valid windows, accept extras, reject nonfinite and changed types", () => {
  expect(active("claude",{...usage,seven_day:{utilization:"bad"},extra:{token:"SECRET"}},now)).toHaveLength(1)
  expect(active("codex",{rate_limit:{primary_window:{used_percent:120,reset_at:now+60},secondary_window:{used_percent:NaN}}},now)).toEqual([{name:"primary",used:120,remaining:0,reset:now+60,observed:now,source:"active"}])
  expect(active("claude",{five_hour:{utilization:Infinity}},now)).toEqual([])
  expect(active("unknown",usage,now)).toEqual([])
  expect(epoch("not a date")).toBeNull()
})
test("passive Codex namespaces, reset-after and strict numeric parsing", () => {
  const windows = passive({observed_at: now,signals:{"x-codex-primary-used-percent":"99", "x-codex-primary-reset-after-seconds":"60", "x-codex-additional-foo-secondary-used-percent":"35", "anthropic-ratelimit-unified-7d-utilization":"\u001b[31m"}},now)
  expect(windows).toHaveLength(2)
  expect(windows[0]!.reset).toBe(now+60)
  expect(passive({observed_at:now+301,signals:quota.signals},now)).toEqual([])
})
test("newest matching source wins; expired reset never claims full quota", () => {
  const p = passive(quota,now), a = active("claude",usage,now-1)
  expect(mergeWindows(p,a)[0]!.source).toBe("passive")
  expect(mergeWindows(p,active("claude",usage,now+1))[0]!.source).toBe("active")
  const account=inventory({files:[{...row(),quota}]},now).accounts[0]!.view
  expect(visibleWindows({...account,windows:[{...p[0]!,reset:now-1}]},now)).toEqual([])
  expect(compact({accounts:[account],refreshing:false,observed:now,error:null},now+700)).toBe("CPA quota stale")
})
test("stream byte limits enforced before JSON parsing", async () => {
  let cancelled = false
  const stream = new ReadableStream({pull(c){c.enqueue(new Uint8Array(40))},cancel(){cancelled=true}})
  await expect(jsonBounded(new Response(stream),32)).rejects.toThrow("body limit")
  expect(cancelled).toBe(true)
  await expect(jsonBounded(new Response('{"ok":true}'),32)).resolves.toEqual({ok:true})
})
test("management options need a URL and one key source, never a default", () => {
  const env = { CLIPROXY_MANAGEMENT_KEY: "env-key" }
  expect(()=>options({}, env)).toThrow("URL")
  expect(()=>options({url:"http://127.0.0.1:1"}, {})).toThrow("key")
  expect(()=>options({url:"http://127.0.0.1:1"}, {CLIPROXY_MANAGEMENT_KEY:"has space"})).toThrow("key")
  expect(options({}, {...env, CLIPROXY_URL:"http://localhost:9"})).toEqual({url:"http://localhost:9", key:"env-key"})
  expect(options({url:"https://example.test", keyFile:"/k"}, env)).toEqual({url:"https://example.test", keyFile:"/k"})
  for (const url of ["http://remote.test", "file:///x", "https://user:pass@test", "https://test/path", "https://test?token=secret"]) expect(()=>options({url}, env)).toThrow()
  expect(()=>options({url:"https://example.test", keyFile:"relative"}, env)).toThrow()
})
test("an environment key is used without any key file", async () => {
  let auth=""
  const { url }=start(request=>{auth=request.headers.get("authorization") ?? "";return Response.json({files:[]})})
  const owner=shared(options({url}, {CLIPROXY_MANAGEMENT_KEY:"env-key"})); owner.snapshot(); await settle()
  expect(auth).toBe("Bearer env-key"); expect(owner.snapshot().error).toBe(null)
})
test("many callers share inventory/active reads and reload evaluation retains the owner", async () => {
  let inventories=0, reads=0
  const config = start(async request => {
    expect(request.headers.get("authorization")).toBe("Bearer fixture-key")
    if (new URL(request.url).pathname.endsWith("auth-files")) { inventories++; return Response.json({files:[row(),row(2,"codex"),row(3,"devin")]}) }
    reads++
    const body = await request.json()
    expect(body.method).toBe("GET")
    expect(body.header.Authorization).toBe("Bearer $TOKEN$")
    expect(body.header["User-Agent"]).toBe("opencode-cpa-quota/0.1.0")
    return Response.json({status_code:200,header:{},body:JSON.stringify(body.url.includes("anthropic") ? usage : {rate_limit:{primary_window:{used_percent:30}}})})
  })
  const owners=Array.from({length:20},()=>shared(config))
  owners.forEach(o=>expect(o.snapshot().refreshing).toBe(true))
  await settle()
  expect(inventories).toBe(1); expect(reads).toBe(2)
  const reloaded = await import("../src/server.ts" + "?fixture-reload") as typeof import("../src/server.ts")
  reloaded.shared(config).snapshot(); await settle()
  expect(inventories).toBe(1)
  expect(owners[0]!.snapshot().accounts).toHaveLength(3)
  advance(60000); owners[1]!.snapshot(); await settle()
  expect(inventories).toBe(2); expect(reads).toBe(2)
  expect(JSON.stringify(owners[0]!.snapshot())).not.toContain("fixture-key")
  expect(JSON.stringify(owners[0]!.snapshot())).not.toContain("fixture-account")
})
test("401 on inventory latches unchanged key; rotation clears without restart", async () => {
  let calls=0
  const config = start(request=>{calls++; return request.headers.get("authorization")==="Bearer rotated" ? Response.json({files:[]}) : new Response("SECRET",{status:401})})
  const owner=shared(config)
  owner.snapshot(); await settle(); expect(calls).toBe(1)
  advance(60000); owner.snapshot(); await settle(); expect(calls).toBe(1)
  await writeFile(keyFile,"rotated"); advance(60000); owner.snapshot(); await settle()
  expect(calls).toBe(2); expect(owner.snapshot().error).toBeNull()
})
test("bad management key on api-call halts remaining accounts", async () => {
  let activeCalls=0
  const config=start(request=>new URL(request.url).pathname.endsWith("auth-files") ? Response.json({files:[row(),row(2),row(3)]}) : (activeCalls++,new Response("SECRET",{status:403})))
  const owner=shared(config); owner.snapshot(); await settle()
  expect(activeCalls).toBe(1); expect(owner.snapshot().error).toBe("credentials")
  advance(60000); owner.snapshot(); await settle(); expect(activeCalls).toBe(1)
})
test("429/invalid inventory preserve last known and use bounded backoff", async () => {
  let mode=0, calls=0
  const config=start(()=>{calls++; return mode===0 ? Response.json({files:[{...row(1,"future"),quota}]}) : mode===1 ? new Response("SECRET",{status:429,headers:{"retry-after":"999999"}}) : Response.json({files:"changed"}) })
  const owner=shared(config); owner.snapshot(); await settle()
  mode=1; advance(60000); owner.snapshot(); await settle(); expect(owner.snapshot().error).toBe("rate-limited")
  expect(owner.snapshot().accounts[0]!.windows).toHaveLength(1)
  advance(60000); owner.snapshot(); await settle(); expect(calls).toBe(2)
  mode=2; advance(15*60000); owner.snapshot(); await settle(); expect(calls).toBe(3)
  expect(owner.snapshot().error).toBe("invalid-response"); expect(owner.snapshot().accounts).toHaveLength(1)
})
test("provider error preserves passive; disabled/unknown accounts never probed; fair bounded batches", async () => {
  const requested: string[]=[]
  let files: unknown[] = [...Array.from({length:8},(_,i)=>({...row(i+1),quota})),{...row(9),disabled:true},row(10,"unknown")]
  const config=start(async request=>{
    if (new URL(request.url).pathname.endsWith("auth-files")) return Response.json({files})
    requested.push((await request.json()).auth_index)
    return Response.json({status_code:401,body:"SECRET",header:{}})
  })
  const owner=shared(config); owner.snapshot(); await settle(); expect(requested).toHaveLength(4)
  expect(owner.snapshot().accounts[0]!.windows).toHaveLength(1)
  expect(owner.snapshot().accounts[0]!.activeError).toBe("credentials")
  advance(60000); owner.snapshot(); await settle(); expect(requested).toHaveLength(8)
  expect(new Set(requested).size).toBe(8)
  advance(5*60000); owner.snapshot(); await settle(); expect(requested).toHaveLength(8)
  files=[row(20,"future")]; advance(60000); owner.snapshot(); await settle()
  expect(owner.snapshot().accounts).toHaveLength(1)
})
test("insecure/missing key fails closed without a management request", async () => {
  let calls=0
  const owner=shared(start(()=>{calls++;return Response.json({files:[]})}))
  await chmod(keyFile,0o644); owner.snapshot(); await settle()
  expect(calls).toBe(0); expect(owner.snapshot().error).toBe("configuration")
})
test("RPC shape has required strict input/output and top-level events", () => {
  expect(rpc.events).toEqual({})
  expect(rpc.methods.snapshot.input.additionalProperties).toBe(false)
  expect(rpc.methods.snapshot.output.additionalProperties).toBe(false)
  expect(rpc.methods.snapshot.output.required).toContain("accounts")
})
test("conflicting options fail closed without creating another owner", async () => {
  let calls=0
  const config=start(()=>{calls++;return Response.json({files:[]})})
  const first=shared(config), conflict=shared({...config,keyFile:root+"/other-key"})
  expect(conflict.snapshot().error).toBe("configuration")
  first.snapshot(); await settle(); expect(calls).toBe(1)
})
test("many unknown accounts cannot starve the known adapter", async () => {
  let reads=0
  const config=start(request=>new URL(request.url).pathname.endsWith("auth-files") ? Response.json({files:[...Array.from({length:199},(_,i)=>row(i,"future")),row(200)]}) : (reads++,Response.json({status_code:200,body:JSON.stringify(usage),header:{}})))
  const owner=shared(config); owner.snapshot(); await settle()
  expect(reads).toBe(1); expect(owner.snapshot().accounts).toHaveLength(200)
})
test("redirects are rejected, failure consumes interval and does not expose raw errors", async () => {
  let calls=0
  const config=start(()=>{calls++;return new Response("SECRET-BODY",{status:302,headers:{location:"http://127.0.0.1:1/SECRET"}})})
  const owner=shared(config); owner.snapshot(); await settle()
  expect(calls).toBe(1); expect(owner.snapshot().error).toBe("management")
  owner.snapshot(); await settle(); expect(calls).toBe(1)
  expect(JSON.stringify(owner.snapshot())).not.toContain("SECRET")
})
test("passive model-specific Claude windows merge with their active counterparts", () => {
  const p=passive({observed_at:now,signals:{"anthropic-ratelimit-unified-7d-opus-utilization":"0.3"}},now)
  const a=active("claude",{seven_day_opus:{utilization:50}},now+1)
  expect(mergeWindows(p,a)).toHaveLength(1)
  expect(mergeWindows(p,a)[0]!.used).toBe(50)
})
test("new active arrivals do not starve older overdue accounts", async () => {
  let generation=0
  const reads:string[]=[]
  const config=start(async request=>{
    if(new URL(request.url).pathname.endsWith("auth-files")) return Response.json({files:[...Array.from({length:4},(_,i)=>row(i+1)),...Array.from({length:4},(_,i)=>row(10+generation*4+i))]})
    reads.push((await request.json()).auth_index)
    return Response.json({status_code:200,body:JSON.stringify(usage),header:{}})
  })
  const owner=shared(config); owner.snapshot(); await settle()
  expect(reads).toHaveLength(4)
  generation++; advance(6*60000); owner.snapshot(); await settle()
  expect(reads.slice(4)).toEqual(Array.from({length:4},(_,i)=>row(i+1).auth_index))
})
test("both providers retain absolute reset epochs and become unknown after reset", () => {
  const reset=1792854060
  const claude=passive({observed_at:now,signals:{"anthropic-ratelimit-unified-5h-utilization":"0.1","anthropic-ratelimit-unified-5h-reset":String(reset)}},now)
  const codex=passive({observed_at:now,signals:{"x-codex-primary-used-percent":"10","x-codex-primary-reset-at":String(reset)}},now)
  for(const windows of [claude,codex]) {
    expect(windows[0]!.reset).toBe(reset)
    const account=inventory({files:[row()]},now).accounts[0]!.view
    expect(visibleWindows({...account,windows},reset+1)).toEqual([])
  }
  expect(passive({observed_at:now,signals:{"x-codex-primary-used-percent":"10","x-codex-primary-reset-at":"9999999999"}},now)[0]!.reset).toBeNull()
})
test("unindexed rows never inherit quota or scheduling across replacement/reordering", async () => {
  const missing={provider:"claude",status:"active",quota}
  const invalid={...missing,auth_index:"invalid-index"}
  let files:unknown[]=[missing,invalid,{...row(3,"future"),quota}]
  const owner=shared(start(()=>Response.json({files})))
  owner.snapshot(); await settle()
  expect(owner.snapshot().accounts.map(a=>a.windows.length)).toEqual([1,1,1])
  files=[{provider:"claude",status:"active"},{provider:"claude",status:"active",auth_index:"different-invalid"},row(3,"future")]
  advance(60000); owner.snapshot(); await settle()
  expect(owner.snapshot().accounts.map(a=>a.windows.length)).toEqual([0,0,1])
  files=[invalid,{provider:"claude",status:"active"},row(3,"future")]
  advance(60000); owner.snapshot(); await settle()
  expect(owner.snapshot().accounts.map(a=>a.windows.length)).toEqual([1,0,1])
  expect(owner.snapshot().accounts[0]!.activeError).toBe("unavailable")
})
test("friendly duration labels use Codex limits, never remaining reset time or primary position", () => {
  const windows=active("codex",{rate_limit:{primary_window:{used_percent:20,reset_at:now+60,limit_window_seconds:604800},secondary_window:{used_percent:10,window_minutes:300}}},now)
  expect(windows[0]!.duration).toBe(604800)
  expect(windowLabel(windows[0]!)).toBe("7 day")
  expect(windowLabel(windows[1]!)).toBe("5 hour")
  expect(windowLabel({...windows[0]!,duration:undefined})).toBe("Quota window")
  expect(windowLabel({...windows[1]!,duration:undefined})).toBe("Other quota")
  expect(active("codex",{rate_limit:{primary_window:{used_percent:10,limit_window_seconds:"changed"}}},now)[0]!.duration).toBeUndefined()
  const p=passive({observed_at:now,signals:{"x-codex-primary-used-percent":"20","x-codex-primary-window-minutes":"10080"}},now)
  expect(p[0]!.duration).toBe(604800);expect(windowLabel(p[0]!)).toBe("7 day")
  expect(windowLabel(active("claude",{seven_day_opus:{utilization:10}},now)[0]!)).toBe("7 day Opus")
  const account=inventory({files:[row()]},now).accounts[0]!.view
  expect(visibleWindows({...account,windows},now).map(windowLabel)).toEqual(["5 hour","7 day"])
  expect(providerName("claude")).toBe("Claude");expect(providerName("codex")).toBe("Codex")
})
test("remaining fractions and percentage-health thresholds stay bounded", () => {
  expect(quotaBar(90,10)).toEqual({percent:90,fill:"▒▒▒▒▒▒▒▒▒",track:"▒",tone:"success"})
  expect(quotaBar(20,10).tone).toBe("success")
  expect(quotaBar(19,10).tone).toBe("warning")
  expect(quotaBar(10,10).tone).toBe("error")
  expect(quotaBar(0,10).fill).toBe("")
  expect(quotaBar(0,10).track).toBe("▒".repeat(10))
  expect(quotaBar(100,10).fill).toBe("▒".repeat(10))
  expect(quotaBar(100,10).track).toBe("")
  expect(quotaBar(120,10).percent).toBe(100)
  expect(quotaBar(-5,10).percent).toBe(0)
})
test("expired passive windows do not produce bars, resets or vague footer warnings", () => {
  const account=inventory({files:[row(1,"codex")]},now).accounts[0]!.view
  const fresh=active("codex",{rate_limit:{primary_window:{used_percent:20,limit_window_seconds:604800,reset_at:now+5*86400+12*3600}}},now)[0]!
  const expired={...fresh,name:"secondary",source:"passive" as const,reset:now-1,used:100,remaining:0}
  account.windows=[expired,fresh]
  const snapshot={accounts:[account],observed:now,error:null,refreshing:false}
  expect(visibleWindows(account,now)).toEqual([fresh])
  expect(resets(visibleWindows(account,now),now)).toBe("5d 12h")
  expect(compact(snapshot,now)).toBe("CPA 1 account")
  expect(countdown(now+24*60,now)).toBe("24m")
  expect(accountWarnings(account,now)).toEqual([])
  account.windows=[expired]
  expect(visibleWindows(account,now)).toEqual([])
  expect(compact(snapshot,now)).toBe("CPA 1 account · awaiting quota")
  account.windows=[fresh];account.activeError="credentials"
  expect(compact(snapshot,now)).toContain("Usage authentication failed")
  expect(accountWarnings(account,now)).toContain("Last known quota · 0m old")
  account.activeError=null;account.cooling=true;account.retry=now+60
  expect(compact(snapshot,now)).toContain("Cooling")
})
test("prototype-like upstream provider/window names remain unknown string labels", () => {
  const names=["constructor","__proto__","toString","valueOf","hasOwnProperty"]
  const accounts=inventory({files:names.map((provider,i)=>row(i+1,provider))},now).accounts
  expect(accounts).toHaveLength(names.length)
  for(const [i,account] of accounts.entries()) {
    expect(account.view.provider).toBe(names[i]!.toLowerCase())
    expect(typeof providerName(account.view.provider)).toBe("string")
    const window={name:names[i]!,used:20,remaining:80,reset:now+60,observed:now,source:"passive" as const,duration:3600}
    expect(typeof windowLabel(window)).toBe("string")
    expect(windowLabel(window).startsWith("1 hour ")).toBe(true)
    expect(visibleWindows({...account.view,windows:[window]},now)).toEqual([window])
  }
  expect(providerName("constructor")).toBe("Constructor")
  expect(providerName("__proto__")).toBe("__proto__")
})
test("passive constructor window is retained as a string alongside known aliases", () => {
  const windows=passive({observed_at:now,signals:{
    "anthropic-ratelimit-unified-constructor-utilization":"0.2",
    "anthropic-ratelimit-unified-5h-utilization":"0.3",
    "anthropic-ratelimit-unified-7d-utilization":"0.35",
    "anthropic-ratelimit-unified-7d-opus-utilization":"0.4",
    "anthropic-ratelimit-unified-7d-sonnet-utilization":"0.45",
  }},now)
  expect(windows.map(w=>w.name)).toEqual(["constructor","five_hour","seven_day","seven_day_opus","seven_day_sonnet"])
  expect(windows.map(w=>w.used)).toEqual([20,30,35,40,45])
  expect(windows.map(windowLabel)).toEqual(["Quota constructor","5 hour","7 day","7 day Opus","7 day Sonnet"])
})
