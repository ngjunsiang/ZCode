# Spec: Terminal output replay before first subscriber (`onDynamicData` buffering)

Status: approved (2026-10-14 — diagnosis user-confirmed on device: Enter in the
blank terminal produces a fresh prompt).
Owner: fork-local.
Follows AGENTS.md spec-first rule. Bug diagnosed 2026-10-14 (see
`decisions.md` ADR-023 for the race evidence chain).
PATCHES IDs U49 / N15 are reserved for this spec.

## Product rules

1. **No terminal output may be lost between PTY spawn and the first
   `onDynamicData(id)` subscription.** The shell starts inside the `create()`
   RPC; over remote links (SSH workspace host, `zcode.z.ai` relay for
   phone/web remote control) the prompt is emitted while the create
   roundtrip and the follow-up `EventListen` roundtrip are still in flight.
   Symptom: blank terminal with only xterm's block cursor; pressing Enter
   shows a fresh prompt (input path is a separate `write` RPC and works).
2. **Replay is server-side and per-terminal-instance.** The buffer owner is
   the `TerminalInstance` inside `createTerminalService`
   (`packages/services/src/terminal/terminalService.ts`). No RPC protocol
   change; every client (desktop local MessagePort, remote workspace host,
   web remote relay) inherits the fix through the same service.
3. **Delivery semantics (explicit time):**

```text
pty.onData(chunk)
  ├─ listeners > 0 → dataEmitter.fire(chunk)          (live mode)
  └─ listeners = 0 → pendingData.push(chunk)          (buffer mode)
first listener subscribes  → flush pendingData (single joined fire) → live mode
last listener unsubscribes → re-enter buffer mode     (reconnect gap replay)
```

- Flush happens in the Emitter's `onWillAddFirstListener` hook, after the
  first listener is registered (foundation.ts adds the listener before
  invoking the hook), so the joined replay is delivered synchronously to
  that listener, in order, before any subsequent live chunk.
- Buffer mode resumes when the last listener detaches (`onDidRemoveLastListener`):
  output produced during a client disconnect/reconnect gap is replayed to
  the next subscriber instead of being dropped.
- Ordering invariant: a subscriber observes either buffered-then-live
  chunks or nothing; it can never observe a duplicate (chunks buffered
  exactly when no listener exists) or a reordering (single emitter, FIFO).

4. **Failure semantics (documented, out of scope):**
   - Fast-exit edge: if the shell exits before any subscriber, the terminal
     is removed from the map (`onExit` deletes it); a later
     `onDynamicData(id)` throws `Terminal not found` inside
     `ChannelServer.onEventListen` (no try/catch upstream). Pre-existing
     upstream behavior, unchanged by this fix — no new fallback branch
     (AGENTS.md: 不不断增加兜底分支).
   - `exitEmitter` has the same first-subscriber race (exit code dropped if
     the shell exits before subscribe). Also pre-existing, out of scope.
   - Unbounded growth risk: buffer mode only spans create→subscribe
     (normally < 1 RTT) or disconnect gaps; a terminal with no subscriber
     producing output indefinitely is bounded in practice by shell startup
     output. No cap added; revisit only if a real leak is observed.

5. **Acceptance scenarios:**
   - S1 (the reported bug): create → PTY emits prompt chunks before any
     subscriber → first subscriber receives the joined prompt, then live
     chunks in order.
   - S2 (no race): subscriber attaches before any output → receives live
     chunks only, no empty replay artifacts.
   - S3 (reconnect gap): subscriber detaches → output accumulates → new
     subscriber receives the gap replay, then live chunks.
   - S4 (multiple chunks, ordering): several pre-subscription chunks replay
     joined in emission order.
   - S5 (regression guard): `write`/`resize`/`dispose` behavior unchanged.

## Implementation boundary

- Single file change: `packages/services/src/terminal/terminalService.ts`
  (U49). New fork-new test `packages/services/test/terminalOutputReplay.test.ts`
  (N15, vitest per ADR-011 root-package rule) with a node-pty stub injected
  through the existing lazy `loadNodePtyModule` seam.
- No changes to: RPC protocol (`packages/rpc`), renderer terminal components
  (`packages/ui`), remote/web plumbing. The Emitter hook contract used is
  public `@zcode/rpc` foundation API (`onWillAddFirstListener` /
  `onDidRemoveLastListener`).
- Portability: identical patch applies to `patch/3.15.1` (terminal data path
  is unchanged between the two vendor bases).
