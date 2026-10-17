# bun-test-istanbul

Original-source [Istanbul](https://istanbul.js.org/) coverage for `bun test`.
Instrument ESM JavaScript and TypeScript before Bun loads them, retain separate
counters for isolated contexts and awaited Bun subprocesses, and generate
standard Istanbul JSON, LCOV, HTML, or text reports.

This beta targets **Bun 1.4.3** on macOS and Linux. It is
distributed through GitHub Releases under the MIT license.

## Install a released version

For the `v0.1.0-beta.2` release, once published:

```sh
bun add --dev \
  bun-test-istanbul@https://github.com/coreycoto/bun-test-istanbul/releases/download/v0.1.0-beta.2/bun-test-istanbul-0.1.0-beta.2.tgz
```

This installs the CLI and API as a normal development dependency. No registry
configuration, npm publication, build step, or install script is required.
The asset must be a published release in a public repository for anonymous
installation. The versioned URL pins the release; change it to upgrade.

Each release includes `SHA256SUMS`, source identity in `release.json`, release
notes, and the tested package tarball. See [release procedures](RELEASING.md).

## Install from source

```sh
git clone git@github.com:coreycoto/bun-test-istanbul.git
cd bun-test-istanbul
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run pack:check
bun pm pack --destination .tmp
```

In a consuming project, install the resulting local tarball:

```sh
bun add --dev /absolute/path/to/bun-test-istanbul-0.1.0-beta.2.tgz
```

## Run coverage

Add a package script:

```json
{
  "scripts": {
    "test:coverage": "bun-test-istanbul --reporter=text --reporter=json --reporter=lcovonly -- ./tests --parallel=2"
  }
}
```

Then run `bun run test:coverage`. Options before `--` belong to this package;
arguments after it are forwarded to `bun test`.

| Option | Default |
| --- | --- |
| `--include=<glob>` (repeatable) | `src/**/*.{js,jsx,ts,tsx,mjs,mts}` |
| `--exclude=<glob>` (repeatable) | Additional exclusions |
| `--out-dir=<path>` | `coverage/istanbul` |
| `--reporter=<name>` (repeatable) | `text`, `json`, `lcovonly` |

Other reporters are `text-summary`, `json-summary`, and `html`. Patterns are
relative to the current directory. Tests named `*.test.*` or `*.spec.*`,
declaration files, `.git`, `node_modules`, and this invocation's output directory
are excluded. Supply explicit exclusions for other test naming conventions or
generated sources. Source symlinks are not supported.

Every invocation creates a fresh UUID directory and preserves:

```text
coverage/istanbul/<run-id>/
  manifest.json          source hashes, loader, generator, runtime, artifact hashes
  seed.json              zero-hit maps, including unloaded sources
  prepared/              instrumented source text, prepared once per run
  raw/                   one cumulative capture per isolated context
  execution.json         test exit/signal status, interruption and report errors
  reports/
    coverage-final.json  when the json reporter is selected
    lcov.info            when lcovonly is selected
    index.html           when html is selected
    capture-summary.json
```

The CLI preserves a failing test exit and can still render diagnostic coverage.
A collection/report failure makes an otherwise successful invocation fail too.
It never overwrites a previous run or automatically deletes retained evidence.
Scratch preload aliases are removed when the CLI settles.

## Programmatic API

The parent prepares a run and passes its manifest and hash to a Bun test process:

```ts
import {
  MANIFEST_ENV,
  MANIFEST_HASH_ENV,
  prepareCoverage,
  reportCoverage,
} from "bun-test-istanbul";

const run = prepareCoverage({
  root: process.cwd(),
  include: ["src/**/*.ts"],
  exclude: ["src/generated/**"],
});

const child = Bun.spawnSync(
  [process.execPath, "--no-env-file", "test", "--preload", "bun-test-istanbul/preload", "./tests"],
  {
    env: {
      ...process.env,
      [MANIFEST_ENV]: run.manifestPath,
      [MANIFEST_HASH_ENV]: run.manifestSha256,
    },
    stdout: "inherit",
    stderr: "inherit",
  },
);

if (child.exitCode !== 0) throw new Error("Tests failed; retain the run artifacts");
reportCoverage({ manifestPath: run.manifestPath, reporters: ["json", "lcovonly"] });
```

This example instruments the explicitly preloaded process. Use the CLI for its
automatic awaited-child preload inheritance, or supply your own bounded child
launch policy. The CLI reserves `BUN_OPTIONS` for that purpose and refuses an
already configured value; use the API when composing other preloads.

For a custom preload, `registerCoverage(manifestPath, hash)` installs the hook
and returns `{ run, plugin, flush }`. Call `flush()` from `afterAll`. The lower
level `createCoverageCollector()` exposes a `BunPlugin` without registering it.
Register before importing covered code. Repeated flushes replace that context's
cumulative row instead of adding the same hits twice. `readCoverageRun()` and
`verifySources()` are also exported. `reportCoverage()` accepts an optional fresh
`reportDir`; an existing report directory is refused.

## Measurement and lifecycle boundaries

- Statements, functions, branches and derived executable-line summaries come
  from Istanbul 6.0.3 instrumentation of original source. These are not Bun's
  native coverage counters. Erased TypeScript types are not executable lines.
- Included but unloaded files contribute zero-hit maps. Choosing an honest
  source inventory is the consumer's responsibility.
- Source, prepared-text, seed and manifest hashes are checked. Foreign runs,
  changed maps, invalid counters and incomplete raw writes refuse merging.
- Parallel isolated test files retain separate context IDs. Awaited Bun child
  scripts inherit the CLI preload and flush on normal exit; nested Bun tests
  use `afterAll`. Child processes that strip the preload are not covered.
- Coverage reports alone cannot prove full test discovery, successful tests,
  or completion of unobserved children. The CLI records its directly observed
  child outcome separately; `qualificationEstablished` remains false. A killed
  process may supply no counters. Consumers must retain their execution and
  process-completion checks.
- The CLI rejects explicit watch, rerun, retry and Bun-native coverage flags.
  Disable their equivalents in ambient Bun configuration as well; this version
  does not normalize configuration supplied outside the CLI.
- CommonJS instrumentation is unsupported, including CommonJS stored in `.js`.
  Explicit `.cjs`/`.cts` inventory entries are rejected before execution. An actual
  `.cjs` require passed without instrumentation but lost its exports through the
  runtime hook in local testing. ESM imports and JSX/TSX evaluation are tested.
- Windows, Worker threads, browsers, Workerd and other runtimes are not
  qualified in this version. Async work must settle before its owning process
  exits. No collection happens in production.
- Captures do **not** identify individual test cases or map context IDs back to
  test files. Coverage overlap does not establish test redundancy or assertion
  effectiveness. Per-file attribution and test-smell analysis are separate work.
- This package does not impose coverage thresholds or replace a consumer's
  release gate. Measure overhead on your own suite before adopting it.

## Development

`bun run check` runs formatting/lint checks, TypeScript compilation, and real Bun
subprocess integration tests. `bun run pack:check` packs the allowlisted package,
installs it into a fresh consumer with a spaced path, then runs its installed CLI.
Test artifacts remain under `.tmp/` for diagnosis.

Related prior art: [bun-plugin-istanbul](https://github.com/hedaukartik/bun-plugin-istanbul)
documents build-time instrumentation and a Playwright workflow. This project
focuses on the `bun test` runtime and capture lifecycle; it does not claim to be
the first Bun/Istanbul integration.

### Reuse prepared instrumentation (beta.2)

Beta.2 adds `forkCoverage({ manifestPath, expectedHash, outputDir })`.
Prepare once with `prepareCoverage`, then fork another invocation from its exact
manifest hash. This API is not included in the published `0.1.0-beta.1` archive.

A fork copies only verified immutable prepared text and the zero-counter seed,
using filesystem copy-on-write when available and a byte-copy fallback. It never
copies raw captures, reports, or a prior test outcome. Each fork has a fresh run
ID, manifest hash and raw directory. Schema v2 binds its shared preparation ID
and donor manifest hash; the loader still accepts v1 fresh preparations. Existing
v1-only loaders reject the new manifest, so use a matching collector and preload.

Counter namespaces may be shared only across separate fresh Bun contexts. The
registration guard refuses switching invocations within an already registered
global. Run each selected test file in its own process, preserve awaited-child
ownership, and let the consumer verify discovery, outcomes and child completeness.
Forking does not establish test success or qualify missing/crashed captures.
Changed source bytes, preparation, seeds, manifests or Bun versions refuse reuse.
Preparation files have separate inodes; changing one fork cannot change another.
No persistent cross-checkout cache, eviction policy or automatic retry is added.
