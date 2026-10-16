# Changelog

All notable changes to wxBridage are documented here.

## Unreleased

- Rename the project to wxBridage in current documentation while retaining original upstream attribution and existing configuration identifiers.
- Lead both README languages with desktop session sharing, covering Codex and Claude Code, explicit entry/exit, synchronized output and completion/duration notices.

## 0.1.28 - 2026-10-16

- Recover macOS desktop sessions released after prolonged inactivity: on a definite missing-owner response, open the original thread with a prompt-free background link, then recheck its owner before entry or a single IPC submission.
- Keep diagnostic probes read-only and never recover by creating a second writer, simulating Return, retrying dispatched input, or changing thread settings. Windows/WSL retain explicit manual-open recovery.
- Return a localized `/enter` failure response without changing either the current binding or its remembered standalone session.

## 0.1.27 - 2026-10-16

- Exclude reply-budget sidecar files from saved WeChat account discovery, restoring automatic selection of a single account after service restart without changing credentials, cursors or reply counters.
- Apply the same exclusion to Linux/WSL service installation and verify restart discovery, orphaned sidecars and explicit selection with multiple real accounts.

## 0.1.26 - 2026-10-12

- Fix the shared linked-report regression test to require completion and elapsed-time notices before attachment failure notices, matching the reserved reply-budget behavior introduced in 0.1.25.

## 0.1.25 - 2026-10-12

- Batch shared progress for 30 seconds and budget against the locally observed ten replies per WeChat context, including command, media and caption acknowledgements.
- Reserve three sends from progress, append a one-time `/status` reminder near the limit, and prioritize final results and completion/duration notices over unsent interim progress.
- Keep long final results queued across context renewal and restart; reserve the last send for a completion notice that explicitly identifies pending result content.
- Persist hashed per-context counters and freeze unacknowledged progress batches to prevent changing or replaying their contents during retries.
- This mitigates the observed server limit; it does not promise unlimited unsolicited delivery or renewal when the phone returns to the foreground.

## 0.1.24 - 2026-10-12

- Retry pending shared output five seconds after each failure without a retry-count limit or dependence on inbound/foreground/context events.
- Let the durable outbox own shared-text retry scheduling; remove stacked transport backoff from that path while preserving standalone-message retries.
- Verify repeated rejection followed by recovery with unchanged context and no user input, plus cancellation and successful-delivery deduplication.

## 0.1.23 - 2026-10-12

- Refresh allowed inbound context before filtering empty or unsupported message content, and wake the shared outbox on context changes without creating an AI turn.
- Add timestamped delivery diagnostics with hashed identifiers, server result codes and safe error categories; no message bodies or raw context tokens are included.
- Clarify that retry recovery depends on server acceptance; returning the phone app to the foreground is not a documented context-refresh guarantee.

## 0.1.22 - 2026-10-12

- Keep Codex and Claude shared output subscribed after WeChat send failures; queue visible output, final results and elapsed-time notices for automatic delivery recovery without new inbound messages.
- Persist a bounded private outbox, restore collected output after restart and cancel pending output when the user exits or changes the shared binding.
- Reconnect failed output readers with backoff, retain existing chunk acknowledgements, reuse stable text delivery IDs and refresh the WeChat context token for each send attempt.
- Deliver completion notices after final text succeeds; retain failed notices for retry rather than silently dropping them.

## 0.1.21 - 2026-10-11

- Send linked Markdown reports as their original `.md` / `.markdown` files, preserving exact contents and encoding instead of creating TXT copies.
- Update attachment captions, both README languages, and regression checks for independent and shared replies.

## 0.1.20 - 2026-10-11

- Send documents explicitly linked in completed assistant replies as WeChat attachments, including independent replies and both desktop- and WeChat-started shared turns for Codex and Claude Code.
- Create UTF-8 TXT reading copies of Markdown reports, preserving their complete contents and the original files; forward PDFs, Office documents, CSVs and supported images unchanged.
- Restrict automatic delivery to readable documents inside the current session workspace, with file size/count limits, protected-path checks, temporary snapshot cleanup and persistent shared-turn attachment acknowledgements.
- Preserve text deduplication and completion/duration notices; report missing, blocked or failed attachments separately.

## 0.1.19 - 2026-10-11

- Fix Windows test portability: check POSIX checkpoint file modes only on Unix platforms and use a Windows temporary directory for portable Claude session tests.
- Limit Claude channel integration tests to platforms supporting their Unix sockets and ownership checks; retain transcript, session catalog and launcher checks on Windows.
- Clarify that the current Claude sharing channel requires macOS, Linux or WSL; native Windows Claude channels are not implemented.

## 0.1.18 - 2026-10-11

- Extract macOS, Windows and Linux/WSL host implementations into separate provider-local adapters; keep desktop sharing, target identity, errors and IPC contracts unchanged.
- Move macOS GUI/Unix socket handling, Windows named pipes and CLI/process handling, WSL path conversion, and the Linux secret-tool backend out of common provider flows.
- Split service environment setup by OS and document the platform boundary.

## 0.1.17 - 2026-10-11

- Add native Windows and WSL2 Codex desktop sharing adapters using a local named pipe and a packaged PowerShell helper with Windows-user verification.
- Make desktop thread browsing, submission, observation, and persisted bindings use an explicit desktop host/storage identity; keep independent sessions separate.
- Preserve entry/exit, visible-output deduplication, restart checkpoints, and completion/duration notices. Desktop browsing supports read-only selection, preview, search, and pagination.
- Document Windows-local and desktop-owned WSL-agent setup in both README languages. Windows/WSL end-to-end acceptance remains pending; the development environment is macOS.
- Synchronize the Codex client metadata version with the product version.

## 0.1.16 - 2026-10-11

- Add explicit Codex desktop-thread entry and exit from WeChat, including output synchronization, restart checkpoints, duplicate suppression, and completion duration notices.
- Add Claude Code shared-session support through a local development channel.
- Make new WeChat service installations fail closed with a direct-message allowlist; unsupported `pairing` configuration also fails closed.
- Fix relative-date normalization so an explicitly selected timezone is independent of the host process timezone.
- Restore the root TypeScript validation gate and add macOS to the CI matrix.
- Upgrade the Model Context Protocol SDK to a patched release.

## 0.1.15 - 2026-10-11

- Internal development version used while desktop shared-session support was being integrated.
