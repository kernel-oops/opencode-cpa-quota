// OpenTUI runtime support owns TSX compilation, exactly as it does for loaded plugins.
import "@opentui/solid/runtime-plugin-support"
import assert from "node:assert/strict"
import type { Plugin } from "@opencode/plugin/tui"
import { inventory } from "../src/parse.ts"
import { createComputed, createRoot, createSignal } from "solid-js"
import { RGBA } from "@opentui/core"

let reactive=false
createRoot(dispose=>{const [n,set]=createSignal(0);createComputed(()=>{if(n()===1)reactive=true});set(1);dispose()})
assert.ok(reactive,"Run with --conditions=browser; OpenTUI components require reactive Solid")

const {default:plugin}=await import("../src/tui.tsx")
const slots: {append:string;render:()=>unknown}[]=[]
let calls=0, aborted=false
const context={
  location:{directory:"/fixture-remote-location"},
  renderer:{widthMethod:"unicode"},
  theme:{background:{base:RGBA.fromHex("#101010")},text:{base:"#ffffff",muted:"#777777",feedback:{success:{base:RGBA.fromHex("#00ff00")},warning:{base:RGBA.fromHex("#ffaa00")},error:{base:RGBA.fromHex("#ff0000")}}}},
  keymap:{layer:()=>{}},
  data:{location:{default:()=>{throw new Error("explicit location ignored")}}},
  client:{rpc:()=>({snapshot:async (_:unknown,options:{location:{directory:string};signal:AbortSignal})=>{
    calls++; assert.equal(options.location.directory,"/fixture-remote-location")
    options.signal.addEventListener("abort",()=>{aborted=true})
    return {accounts:inventory({files:[{auth_index:"0123456789abcdef",provider:"future-provider",status:"active"}]},Date.now()/1000).accounts.map(a=>a.view),observed:null,refreshing:false,error:null}
  }})},
  ui:{slot:(slot:{append:string;render:()=>unknown})=>{slots.push(slot)}},
} as unknown as Plugin.Context
const cleanup=await plugin.setup(context)
await Promise.resolve()
assert.equal(calls,1)
assert.deepEqual(slots.map(s=>s.append),["sidebar.content","prompt.footer.status"])
assert.equal(typeof cleanup,"function")
const {testRender}=await import("@opentui/solid")
for (const width of [24,80]) {
  const screen=await testRender(slots[0]!.render as Parameters<typeof testRender>[0],{width,height:24})
  try {
    await screen.renderOnce()
    const frame=screen.captureCharFrame()
    assert.ok(frame.includes("CPA accounts"))
    assert.ok(frame.includes("Awaiting quota update"))
  } finally { await screen.dispose() }
}
await cleanup?.()
assert.equal(aborted,true)
console.log("TUI TSX runtime import, 24/80-column render, remote location, shared poll and unload cleanup passed")
