# Windows / WSL2 Codex shared-session requirements

Document version: 1.0 — 2026-10-11

Status: requirements version 1.0 confirmed by the user's “确认，请继续” on 2026-10-11. Architecture design follows; no implementation, deployment, or Windows/WSL acceptance verification is recorded by this document.

## Request and existing behavior

The user requested Windows/WSL adaptation after discussing the current platform support limits. Earlier requests in this conversation establish the expected shared-session behavior: keep the desktop application open, submit into the same PC conversation, synchronize visible replies to WeChat, and explicitly enter/exit sharing.

Those existing behavior requirements are retained. This document makes the new platform scope explicit. Confirmation comes from the user's response to this scope, separately from the initial request to develop the feature.

## Confirmed scope

| Bridge runtime | Target conversation | Intended support |
| --- | --- | --- |
| Native Windows | Existing conversation owned by the Windows Codex desktop app | Included |
| WSL2 | Existing Windows-local conversation owned by the Windows Codex desktop app | Included |
| WSL2 | Existing WSL-backed conversation opened and owned by the Windows Codex desktop app | Included, with explicit host and storage identity |
| macOS | Existing desktop sharing | Preserve current behavior |
| WSL2 | Codex CLI conversation not owned by the desktop app | Transparent attachment is outside this iteration |

The shared desktop application remains the sole execution owner. This feature does not promise transparent attachment to an ordinary Codex CLI process. Claude sharing is not expanded by this iteration.

## Requirements and acceptance

### WINWSL-001 — Keep the existing WeChat workflow

- `/enter` lists selectable conversations, ten per page; `/next` and `/prev` retain their meaning.
- `/enter <index>` enters only the selected desktop conversation.
- `/status` identifies shared versus independent mode and provides enough host information to distinguish Windows-local from WSL-backed sharing.
- `/exit` detaches without interrupting or modifying the desktop task, and restores the independent WeChat conversation used before sharing.
- Merely listing conversations or using `/open` must not silently enable sharing.

Acceptance: command regression checks cover entry, paging, status, exit while a reply is running, and restoration of the earlier independent binding.

### WINWSL-002 — Submit to the existing owner

- A WeChat message entered while shared appears in the selected PC conversation and executes through its existing owner.
- Preserve the desktop conversation's model, permissions, workspace, and history.
- Permit plain text and existing voice-transcript inputs. Retain explicit rejection of unsupported binary inputs.
- Do not activate a window or simulate keystrokes in the Windows/WSL background path.
- Do not create a second app-server writer, fork/resume the thread in another process, or silently fall back to independent execution.
- A busy conversation receives no second submitted prompt.

Acceptance: local transport contract checks verify owner targeting and inherited settings; real Windows/WSL acceptance must verify that the PC view and WeChat show the same submitted turn.

### WINWSL-003 — Use one consistent host and storage identity

- Conversation listing, owner discovery, submission, and output observation must identify the same desktop host and conversation.
- Account for Windows and WSL using different Codex home directories by default.
- Do not assume a Windows path is a Linux path, or that every WSL-backed thread uses the `local` desktop host identifier.
- Missing/mismatched host or session storage returns an actionable error before submission rather than selecting another conversation.
- Do not copy authentication files or rewrite global `CODEX_HOME` settings automatically.

Acceptance: cover distinct Windows/WSL homes, paths containing spaces/non-ASCII characters, multiple distributions, wrong host identifiers, unavailable storage, and thread-ID isolation.

### WINWSL-004 — Preserve output and completion behavior

- Synchronize visible assistant segments from an unfinished desktop turn and subsequent desktop-started turns while entered.
- Exclude completed history, reasoning, and tool logs.
- Preserve segment boundaries, final-result deduplication, completion status, and duration based on recorded turn timing.
- Reuse delivery acknowledgements across restart/reconnection. Do not claim exactly-once delivery across a crash between remote acceptance and local acknowledgement.
- Exiting or switching binding stops observation; an already in-flight send may still arrive.

Acceptance: regression coverage includes restart checkpoints, duplicate segments/finals/notices, mid-turn entry, interrupted/failed turns, recorded/missing duration, and exit/switch cancellation.

### WINWSL-005 — Keep the connection local and fail safely

- Use the existing desktop coordination protocol through an appropriate local Windows/WSL transport.
- Verify the local endpoint and relevant OS-user boundary; reject an endpoint whose ownership cannot be established.
- Do not introduce a public TCP listener or disable permission checks.
- Bound input/output frames, request duration, and any helper-process lifetime; release resources on cancellation/shutdown.
- Discover the owner and verify the required protocol before submitting.
- If submission might have succeeded but acknowledgement is missing, report uncertainty and observe the possible turn; never automatically resubmit.

Acceptance: cover unavailable/untrusted endpoints, invalid or oversized frames, incompatible protocol, fragmented responses, disconnects/timeouts before and after submission, cancellation, and helper cleanup.

### WINWSL-006 — Document and distinguish verification levels

- Update both root README languages with Windows/WSL setup, host/storage selection, support limits, and diagnostics.
- Preserve the upstream repository attribution.
- Keep macOS and independent-session regression checks passing.
- Record a product version increment when implementation is delivered.
- Separate simulated transport checks from real Windows/WSL end-to-end evidence; missing platform access must remain an explicit verification gap.
- Do not deploy or restart the user's current Mac service as part of this platform development request.

Acceptance: typecheck, focused regression tests, documentation links, and an explicit platform verification record.

## Findings and constraints

- Current `src/providers/codex/desktop_thread_relay.ts` rejects shared submissions on platforms other than macOS.
- Current `desktop_ipc_client.ts` assumes a local Unix socket, checks Unix UID/permissions, and hardcodes owner discovery to `hostId: local`.
- Read-only inspection of the installed desktop application's common bundle found a Windows named-pipe branch for `\\.\pipe\codex-ipc`, versioned owner discovery/follower requests, and non-local host routing. This is evidence from the installed macOS bundle's shared code, not a test of a running Windows desktop app. Windows availability and compatibility still require a real probe.
- WSL-backed desktop hosts are distinct from the Windows-local host. Existing output discovery must be checked against the selected host's actual storage.
- The public App Server API and desktop coordination IPC are different protocols. Starting a new App Server listener does not establish attachment to the existing desktop owner.
- The available development machine is macOS; no Windows/WSL machine is currently attached to this task.
- This requirement phase does not select new infrastructure, modify runtime data, or change executable code.

Official references:

- [Windows desktop app: share config, auth, and sessions with WSL](https://learn.chatgpt.com/docs/windows/windows-app#share-config-auth-and-sessions-with-wsl)
- [Codex on WSL](https://learn.chatgpt.com/docs/windows/wsl)
- [App Server transports and lifecycle](https://learn.chatgpt.com/docs/app-server)

## Confirmation

- Feature-development authorization: user's request “好的 那你开发适配一下吧”.
- This requirement document version and platform scope: confirmed by the user's “确认，请继续” on 2026-10-11.
- Architecture for the new cross-system transport: see [the architecture design](windows-wsl-sharing-architecture.md); its confirmation is separate from requirement confirmation.
- Reconfirmation is needed if the target expands to ordinary CLI-session ownership, remote machines, public network access, or changed permission/data rules.
