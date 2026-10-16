# Desktop background sharing

## Scope and requirements

The user selected option 1 in this conversation: WeChat sends to the backend already owned by the desktop, preserving the same PC thread while the screen is locked. This extends the previously approved shared-thread design using the existing TypeScript stack, bindings, rollout observer and delivery checkpoints. No database, additional model credentials, desktop application patch, or new dependency is required.

- `/enter`, `/exit` and `/status` retain their current meaning. Standalone execution remains separate.
- Shared submission must reach the desktop owner through a local background connection. It must not simulate keystrokes, create another app-server writer, change permissions/model/workspace, or unlock the computer.
- Reject a busy thread; serialize WeChat submissions and correlate successful replies by the desktop's returned turn ID.
- A definitely missing desktop owner may be recovered through the existing desktop app as described below. Incompatible protocol, disconnect, invalid response and exhausted recovery fail explicitly. Never automatically retry a dispatched turn or fall back to another writer. An ambiguous acknowledgement is reported as possibly submitted.
- Keep existing visible-output forwarding, completion timing, restart checkpoints and voice-transcript behavior.
- Screen lock is supported by the transport; sleep, logout, quitting the desktop, and operations requiring an unlocked GUI remain limitations.

Authorization source: the user's “好的，帮我按照第 1 种方式修改”, following the proposed shared-backend architecture. The IPC adapter is the implementation detail used to reach that existing backend. Desktop-owned execution and existing provider/runtime boundaries remain intact.

## Architecture and contracts

`desktop_ipc_client.ts` connects only to the existing desktop coordination socket, normally `$CODEX_HOME/ipc/ipc.sock`. It checks socket/directory ownership and writable permissions, implements bounded length-prefixed JSON framing, initializes as `codexbridge`, discovers the local thread owner, and targets that owner with `thread-follower-start-turn`. Requests inherit desktop thread settings. It does not start a router, claim thread ownership or serve follower requests.

`desktop_thread_relay.ts` owns submission serialization and rollout correlation. IPC is the default transport; the old GUI transport remains an explicit compatibility option. Output is read through the existing rollout reader, retaining WeChat delivery checkpoints. A successful IPC response supplies the exact turn ID before output polling begins.

```mermaid
flowchart LR
  W[WeChat inbound] --> R[Existing desktop relay]
  R --> I[Local IPC client]
  I --> C[Desktop coordination router]
  C --> D[Existing desktop thread owner]
  D --> A[Desktop-owned app-server]
  A --> L[Thread rollout]
  L --> R
  R --> Q[Existing delivery and checkpoint queue]
  Q --> W
  D --> P[PC conversation view]
```

```mermaid
flowchart TD
  M[Shared message] --> B{Thread busy?}
  B -->|yes| E[Explicit busy error]
  B -->|no| C[Connect and initialize existing IPC]
  C --> O[Discover desktop owner]
  O --> S[Submit once to that owner]
  S --> T[Capture returned turn ID]
  T --> P[Poll visible output for that turn]
  P --> F[Final result and existing duration notice]
  C -->|unavailable| X[Explicit error]
  O -->|no compatible owner| X
  S -->|ambiguous acknowledgement| U[Possibly submitted error; no retry]
```

The coordination protocol is internal and versioned, not a public third-party API. Inspection of the installed desktop bundle established owner-discovery version 1 and start-turn version 2. The actual running desktop accepted initialization and owner discovery for the current shared thread. Public App Server transport documentation alone does not establish this IPC contract. A desktop update may require adapting the client; mismatches must fail closed.

Validation plan: local socket fixture tests for framing, exact owner targeting, inherited settings, fragmentation, malformed/oversized responses, disconnect/timeouts and cleanup; relay tests for no GUI calls, exact turn association, busy rejection and unchanged output behavior. Only targeted tests and type checks run on this machine. Actual lock-screen execution must be distinguished from socket/mock verification. No test sends a WeChat message or modifies a user's active task.

## Implementation and verification

Implemented in `src/providers/codex/desktop_ipc_client.ts` (239 lines) and the existing desktop relay (748 lines). The relay now defaults to IPC, captures the acknowledged turn ID and holds the observer cursor while ownership is uncertain; a possibly accepted turn can still be observed after an acknowledgement is lost. Explicit GUI compatibility remains available. Version advances from 0.1.11 to 0.1.12 in package.json, package-lock.json and Codex app-client metadata.

Verification: 28 IPC/relay tests passed, plus 11 selected provider/runtime tests covering text/voice routing, output checkpoints, notices, exit/switch behavior and observer errors. Scoped TypeScript validation and `git diff --check` passed. A real connection using the new client initialized and discovered the current desktop owner successfully. A targeted v2 request with a deliberately mismatched thread ID reached the desktop owner and returned the expected pre-submission validation error; no user prompt or model turn was submitted. This verifies the live routing/version boundary, not a complete task execution.

Actual locked-screen message submission and full WeChat round-trip have not been exercised automatically. No test locks the screen, sends a WeChat message, changes an existing task, or adjusts system settings. Mermaid diagrams are source only, not render-verified. The full suite is omitted because of this machine's earlier trouble with that workload.

## Idle owner recovery (0.1.28)

Authorization: the user's 2026-10-16 request to fix failed shared-session re-entry after overnight inactivity. Desktop logs recorded `thread/unsubscribe` and `inactive_thread_unsubscribed` approximately three hours after the last completed reply; failures preceded `/exit`. This repair preserves the existing desktop-owned execution boundary, provider/runtime responsibilities and binding format. No database is involved.

`probeThreadOwner` remains read-only. `ensureThreadOwner`, used during entry, and pre-submission owner discovery may recover only the exact `no-client-found` response. On macOS, `host/macos.ts` validates the thread ID and local host before `/usr/bin/open -g` opens a prompt-free thread URL. The existing desktop resumes its own thread. Discovery polls for up to ten seconds after the launcher returns; individual requests retain their IPC timeout. One operation opens the URL at most once. No input is attached to the URL, no Return key is sent, and no app-server is created. OS policy stays in its existing host adapter; Windows/WSL retain their existing manual-open error path. A future adapter must establish its own launcher safety and acceptance evidence rather than borrowing macOS commands.

Target identity and catalog existence are checked before recovery on entry. Bindings are written only after preparation succeeds. Preparation failure returns a localized, non-sensitive WeChat message and preserves both the old binding and remembered standalone session. Recovery failure before submission is definite non-submission; dispatch/acknowledgement failures remain uncertain and are never retried. Protocol incompatibility is not treated as a sleeping thread. Abort closes the connection and interrupts polling.

```mermaid
flowchart TD
  E[Entry or shared message] --> V[Validate target and discover owner]
  V -->|owner available| A[Bind on entry or submit once via IPC]
  V -->|no-client-found on macOS| W[Open original thread URL without input once]
  W --> P[Bounded owner discovery polling]
  P -->|owner available| A
  V -->|other errors| F[Explicit failure; no fallback writer]
  P -->|timeout or error| F
  F --> B[Failed entry keeps existing binding]
```

Regression coverage includes idle entry, shared submission after idle, failure/timeout/cancellation, read-only probes, protocol rejection, target validation, re-entry after exit, unchanged bindings, and no resubmission after a lost acknowledgement. Real overnight and locked-screen recovery are not replaced by local socket fixtures; those scenarios require user acceptance. The background-open request does not guarantee the desktop app will keep its current visible route.

Verification on 2026-10-16: nine new regressions failed against the old implementation, then passed after repair. The affected provider/transport/host suites passed 57 tests (one Windows-only live-pipe test skipped on macOS), eight selected coordinator entry/exit tests passed, and 26 adjacent runtime output/checkpoint/budget/linked-file tests passed: 91 passing tests overall. Full-project `tsc -p tsconfig.json --noEmit` with a 1 GiB heap limit and `git diff --check` passed. A live prompt-free background open of the user's selected thread followed by owner discovery succeeded without starting a turn; it was not a forced-unsubscribe, overnight, or locked-screen experiment. The full test suite was not run.

Self-review kept the existing wire protocol, standalone execution, credentials, and stored binding schema unchanged. The IPC client (291 lines), relay (776), macOS host adapter (84), and host contract (67) remain below the default file-size threshold. The pre-existing large coordinator, locale catalog, app client metadata and coordinator test files receive only local changes; splitting those unrelated modules would expand this repair's scope. No new dependency or desktop-app patch is introduced. Package and app-client metadata advance together from 0.1.27 to 0.1.28.
