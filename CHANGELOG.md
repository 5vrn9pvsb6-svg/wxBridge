# Changelog

All notable changes to CodexBridge are documented here.

## 0.1.16 - 2026-10-11

- Add explicit Codex desktop-thread entry and exit from WeChat, including output synchronization, restart checkpoints, duplicate suppression, and completion duration notices.
- Add Claude Code shared-session support through a local development channel.
- Make new WeChat service installations fail closed with a direct-message allowlist; unsupported `pairing` configuration also fails closed.
- Fix relative-date normalization so an explicitly selected timezone is independent of the host process timezone.
- Restore the root TypeScript validation gate and add macOS to the CI matrix.
- Upgrade the Model Context Protocol SDK to a patched release.

## 0.1.15 - 2026-10-11

- Internal development version used while desktop shared-session support was being integrated.
