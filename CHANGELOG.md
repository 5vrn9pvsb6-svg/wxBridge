# Changelog

All notable changes to wxBridage are documented here.

## Unreleased

- Rename the project to wxBridage in current documentation while retaining original upstream attribution and existing configuration identifiers.
- Lead both README languages with desktop session sharing, covering Codex and Claude Code, explicit entry/exit, synchronized output and completion/duration notices.

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
