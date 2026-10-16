# Changelog

## 0.1.0-beta.1

Initial beta for ESM JavaScript/TypeScript and JSX/TSX on Bun 1.4.3.

- Original-source Istanbul instrumentation, prepared once per run.
- Unloaded-file accounting and separate cumulative captures for isolated files,
  awaited Bun scripts, and nested Bun tests.
- JSON, LCOV, HTML and text reports, plus a preload/plugin API and CLI.
- Source and artifact identity checks, explicit failure receipts, and cancellation
  of the owned test process group.
- GitHub Release tarball distribution, checksums, source metadata, and fresh
  installed-consumer verification.

CommonJS, Windows, browser/Workerd/Worker-thread adapters and reciprocal
test-file/case attribution are not qualified. Coverage reports do not establish
execution completeness, assertion effectiveness, or a consumer's release gate.
