/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { RGBA, type BoxRenderable } from "@opentui/core"
import { accountWarnings, compact, providerName, quotaBar, resets, visibleWindows, windowLabel } from "./display.ts"
import { rpc, type Snapshot } from "./rpc.ts"

export default Plugin.define({
  id: "opencode-cpa-quota.tui",
  setup(ctx) {
    const client = ctx.client.rpc(rpc)
    const [snapshot, setSnapshot] = createSignal<Snapshot>()
    const [unavailable, setUnavailable] = createSignal(false)
    const [now, setNow] = createSignal(Date.now()/1000)
    const [expanded, setExpanded] = createSignal(true)
    const [focused, setFocused] = createSignal(false)
    const [columns, setColumns] = createSignal(24)
    let header: BoxRenderable | undefined
    const theme = ctx.theme
    const soft = (colour: RGBA) => {
      const bg = theme.background.base
      return RGBA.fromValues(bg.r*0.4+colour.r*0.6, bg.g*0.4+colour.g*0.6, bg.b*0.4+colour.b*0.6)
    }
    const labelWidth = () => Math.min(22, Math.max(6, Math.floor(columns()*0.35)))
    ctx.keymap.layer(() => ({ commands: [{ id: "opencode-cpa-quota.toggle", title: "Toggle CPA accounts", group: "CPA", palette: true, run: () => { setExpanded(v=>!v); header?.focus() } }] }))
    const controller = new AbortController()
    let stopped = false, busy = false, timer: ReturnType<typeof setTimeout> | undefined
    // One loop, at most six completion reads over 70s (the server batch is bounded to 65s).
    const followups = [1000, 4000, 10000, 15000, 20000, 20000]
    async function poll(followup = 0, retry = false) {
      if (stopped || busy) return
      busy = true
      let failed = false
      let refreshing = false
      try {
        const value = await client.snapshot({}, { location: ctx.location ?? ctx.data.location.default(), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
        refreshing = (value as Snapshot).refreshing
        if (!stopped) { setSnapshot(value as Snapshot); setUnavailable(false) }
      } catch { failed = true; if (!stopped) setUnavailable(true) }
      finally {
        busy = false
        if (!stopped) {
          setNow(Date.now()/1000)
          if (failed && !retry) timer = setTimeout(() => { void poll(followup, true) }, 5000)
          else if (!failed && refreshing && followup < followups.length) timer = setTimeout(() => { void poll(followup + 1) }, followups[followup])
          else timer = setTimeout(() => { void poll() }, 60000)
        }
      }
    }
    ctx.ui.slot({ append: "sidebar.content", render: () => <box width="100%" minWidth={0} flexDirection="column" flexShrink={1} onSizeChange={function () { setColumns(this.width) }}>
      <box id="cpa-quota-header" flexDirection="row" gap={1} focusable
        ref={node => { header=node; node.on("focused",()=>setFocused(true)); node.on("blurred",()=>setFocused(false)) }}
        onMouseDown={function () { this.focus(); setExpanded(v=>!v) }}
        onKeyDown={key => {
          if (key.ctrl || key.meta || key.option || !["return", "space", "left", "right"].includes(key.name)) return
          if (key.name === "left") setExpanded(false)
          else if (key.name === "right") setExpanded(true)
          else setExpanded(v=>!v)
          key.preventDefault(); key.stopPropagation()
        }}>
        <text fg={focused() ? theme.text.feedback.warning.base : theme.text.muted}>{expanded() ? "▼" : "▶"}</text>
        <text fg={focused() ? theme.text.feedback.warning.base : theme.text.base} wrapMode="none" truncate><b>CPA accounts</b>{!expanded() && snapshot() ? ` (${snapshot()!.accounts.length})` : ""}</text>
      </box>
      <Show when={expanded()}>
        <Show when={unavailable() && snapshot()}><text fg={theme.text.feedback.warning.base} wrapMode="word">Last known data (connection unavailable)</text></Show>
        <Show when={snapshot()?.error}><text fg={theme.text.feedback.error.base} wrapMode="word">{compact(snapshot(),now())}</text></Show>
        <Show when={!snapshot()}><text fg={theme.text.muted}>CPA unavailable</text></Show>
        <Show when={snapshot() && !snapshot()!.accounts.length}><text fg={theme.text.muted}>{snapshot()!.refreshing ? "Updating CPA accounts…" : "No auth-file accounts"}</text></Show>
        <For each={snapshot()?.accounts ?? []}>{account => {
          const windows = () => visibleWindows(account,now())
          const reset = () => resets(windows(),now())
          const warnings = () => accountWarnings(account,now(),unavailable())
          return <box flexDirection="column" minWidth={0} width="100%" marginTop={1}>
            <text fg={theme.text.base} wrapMode="word"><b>{providerName(account.provider)} #{account.id}</b><span style={{fg:theme.text.muted}}>{reset() ? `, resets in ${reset()}` : ""}</span></text>
            <For each={windows()}>{window => {
              const bar = () => quotaBar(window.remaining,columns()-labelWidth()-6)
              return <box flexDirection="row" gap={1} minWidth={0} width="100%">
                <text fg={theme.text.muted} width={labelWidth()} flexShrink={0} truncate wrapMode="none">{windowLabel(window)}</text>
                <text flexShrink={0} wrapMode="none"><span style={{fg:soft(theme.text.feedback.success.base)}}>{bar().fill}</span><span style={{fg:soft(theme.text.feedback.error.base)}}>{bar().track}</span></text>
                <text fg={theme.text.feedback[bar().tone].base} width={4} flexShrink={0} wrapMode="none">{`${bar().percent}%`.padStart(4)}</text>
              </box>
            }}</For>
            <Show when={!windows().length}><text fg={theme.text.muted}>Awaiting quota update</text></Show>
            <For each={warnings()}>{warning => <text fg={account.activeError === "credentials" ? theme.text.feedback.error.base : theme.text.feedback.warning.base} wrapMode="word">{warning}</text>}</For>
          </box>
        }}</For>
      </Show>
    </box> })
    ctx.ui.slot({ append: "prompt.footer.status", render: () => <text fg={ctx.theme.text.base} flexShrink={1} minWidth={0} wrapMode="none" truncate>{unavailable() ? `CPA unavailable${snapshot() ? " · last known data" : ""}` : compact(snapshot(),now())}</text> })
    void poll()
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer) }
  },
})
