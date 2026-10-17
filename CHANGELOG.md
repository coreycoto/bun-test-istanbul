# Changelog

## 0.1.0-beta.2

- Add `forkCoverage()` to reuse verified prepared instrumentation across fresh
  invocations without copying raw captures, reports or prior outcomes.
- Bind forked manifests to the original preparation and donor manifest hash.
  Every invocation keeps its own run ID, manifest hash and raw directory.
- Refuse sharing a preparation namespace across invocations in the same global
  context. Changed source, prepared artifacts, seeds and Bun versions refuse reuse.

Fresh v1 manifests remain supported. Forks use schema v2 and require the matching
collector/preload; v1-only readers reject them. Prepared reuse requires separate
fresh Bun contexts and does not establish execution completeness or test success.

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
