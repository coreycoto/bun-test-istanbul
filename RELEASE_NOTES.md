# bun-test-istanbul v0.1.0-beta.2

Reuse prepared Istanbul instrumentation across separate Bun test invocations with
`forkCoverage()`.

- Verify source files, prepared artifacts, seeds and the Bun version before reuse.
- Give each invocation a fresh run ID, manifest and capture directory while
  sharing the verified preparation lineage.
- Continue using fresh v1 manifests; forked manifests use schema v2.

## Installation

```sh
bun add --dev bun-test-istanbul@https://github.com/coreycoto/bun-test-istanbul/releases/download/v0.1.0-beta.2/bun-test-istanbul-0.1.0-beta.2.tgz
```

## Compatibility

Targets Bun 1.4.3 and ESM JavaScript/TypeScript, including JSX/TSX. Prepared reuse
requires separate fresh Bun contexts and the matching collector/preload. Custom
manifest readers must support schema v2 to read forks; fresh v1 manifests remain
supported.
