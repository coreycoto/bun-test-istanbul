import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CoverageMapData } from "istanbul-lib-coverage";
import {
  type CoverageRun,
  forkCoverage,
  prepareCoverage,
  readCoverageRun,
  reportCoverage,
  verifySources,
} from "../src/index.ts";
import { sourceDigest } from "../src/run.ts";

const repo = resolve(import.meta.dir, "..");
const cli = join(repo, "src/cli.ts");
function fixture() {
  const root = join(repo, ".tmp", `test fixture ${randomUUID()}`);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(root, "src/logic.ts"),
    `export type Kind = "alpha" | "beta" | "other";
export function choose(kind: Kind): string {
  if (kind === "alpha") return "A";
  if (kind === "beta") return "B";
  return "C";
}
export function neverCalled() { return "unused"; }
`,
  );
  writeFileSync(
    join(root, "src/unloaded.ts"),
    "export function unloaded() { return 42; }\n",
  );
  writeFileSync(
    join(root, "src/contracts.d.ts"),
    "export type NotExecutable = string;\n",
  );
  writeFileSync(
    join(root, "tests/a.test.ts"),
    `import { expect, test } from "bun:test";
import { choose } from "../src/logic.ts";
test("alpha behavior", () => { expect(choose("alpha")).toBe("A"); });
`,
  );
  return root;
}
function run(root: string, args: string[] = []) {
  const env = { ...process.env };
  delete env.BUN_OPTIONS;
  delete env.NODE_OPTIONS;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      cli,
      "--reporter=json",
      "--reporter=lcovonly",
      ...args,
    ],
    {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 25000,
    },
  );
  writeFileSync(join(root, "stdout.log"), result.stdout);
  writeFileSync(join(root, "stderr.log"), result.stderr);
  const output = join(root, "coverage/istanbul");
  const directory = join(output, readdirSync(output)[0]);
  return {
    result,
    directory,
    manifest: readCoverageRun(join(directory, "manifest.json")),
    execution: JSON.parse(
      readFileSync(join(directory, "execution.json"), "utf8"),
    ),
  };
}
function coverage(directory: string): CoverageMapData {
  return JSON.parse(
    readFileSync(join(directory, "reports/coverage-final.json"), "utf8"),
  );
}
function syntheticCapture(run: CoverageRun) {
  const seed: CoverageMapData = JSON.parse(
    readFileSync(join(run.directory, "seed.json"), "utf8"),
  );
  const contextId = randomUUID();
  const capture = {
    schemaVersion: 1,
    runId: run.manifest.runId,
    manifestSha256: run.manifestSha256,
    contextId,
    pid: process.pid,
    loaded: Object.fromEntries(
      run.manifest.sources.map((source) => [
        resolve(run.manifest.root, source.path),
        source.sha256,
      ]),
    ),
    coverage: seed,
  };
  const path = join(
    run.directory,
    "raw",
    `bun-${process.pid}-${contextId}.json`,
  );
  return { capture, write: () => writeFileSync(path, JSON.stringify(capture)) };
}

test("CLI measures original TypeScript and unloaded files; exports LCOV and HTML", () => {
  const root = fixture();
  const { result, directory, execution } = run(root, [
    "--reporter=html",
    "--",
    "./tests/a.test.ts",
  ]);
  expect(result.exitCode).toBe(0);
  expect(execution.testsSucceeded).toBe(true);
  expect(execution.qualificationEstablished).toBe(false);
  const data = coverage(directory);
  const logic = data[join(root, "src/logic.ts")];
  const id = Object.keys(logic.fnMap).find(
    (key) => logic.fnMap[key].name === "choose",
  );
  expect(logic.f[id ?? "missing"]).toBe(1);
  expect(
    Object.values(logic.statementMap).map((location) => location.start.line),
  ).not.toContain(1);
  expect(
    Object.values(data[join(root, "src/unloaded.ts")].s).every(
      (count) => count === 0,
    ),
  ).toBe(true);
  expect(Object.keys(data)).toHaveLength(2);
  const lcov = readFileSync(join(directory, "reports/lcov.info"), "utf8");
  expect(lcov).toContain("SF:src/logic.ts");
  expect(lcov).toContain("FNDA:1,choose");
  expect(lcov).toContain("BRDA:");
  expect(readFileSync(join(directory, "reports/index.html"), "utf8")).toContain(
    "All files",
  );
});

test("isolated parallel files and an awaited Bun child merge distinct counters", () => {
  const root = fixture();
  writeFileSync(
    join(root, "tests/b.test.ts"),
    `import { expect, test } from "bun:test";
import { choose } from "../src/logic.ts";
test("beta and child behavior", () => {
 expect(choose("beta")).toBe("B");
 const child = Bun.spawnSync([process.execPath, "--no-env-file", "./child.ts"]);
 expect(child.exitCode).toBe(0);
 expect(child.stdout.toString().trim()).toBe("C");
});`,
  );
  writeFileSync(
    join(root, "child.ts"),
    'import { choose } from "./src/logic.ts"; console.log(choose("other"));',
  );
  const { result, directory } = run(root, ["--", "./tests", "--parallel=2"]);
  expect(result.exitCode).toBe(0);
  const logic = coverage(directory)[join(root, "src/logic.ts")];
  const id = Object.keys(logic.fnMap).find(
    (key) => logic.fnMap[key].name === "choose",
  );
  expect(logic.f[id ?? "missing"]).toBe(3);
  expect(
    Object.values(logic.b)
      .flat()
      .every((count) => count > 0),
  ).toBe(true);
  const captures = readdirSync(join(directory, "raw"));
  expect(captures.length).toBeGreaterThanOrEqual(3);
});

test("repeated cumulative flushes do not multiply hits", () => {
  const root = fixture();
  writeFileSync(
    join(root, "tests/a.test.ts"),
    `import { afterAll, expect, test } from "bun:test";
import { registerCoverageFromEnvironment } from ${JSON.stringify(join(repo, "src/index.ts"))};
import { choose } from "../src/logic.ts";
test("one call", () => expect(choose("alpha")).toBe("A"));
afterAll(() => { const capture = registerCoverageFromEnvironment(); capture.flush(); capture.flush(); });`,
  );
  const { result, directory } = run(root, ["--", "./tests"]);
  expect(result.exitCode).toBe(0);
  const data = coverage(directory)[join(root, "src/logic.ts")];
  const id = Object.keys(data.fnMap).find(
    (key) => data.fnMap[key].name === "choose",
  );
  expect(data.f[id ?? "missing"]).toBe(1);
});

test("an awaited nested bun test flushes its own isolated capture", () => {
  const root = fixture();
  mkdirSync(join(root, "nested"));
  writeFileSync(
    join(root, "nested/child.test.ts"),
    'import {expect,test} from "bun:test"; import {choose} from "../src/logic.ts"; test("nested beta",()=>expect(choose("beta")).toBe("B"));',
  );
  writeFileSync(
    join(root, "tests/a.test.ts"),
    `import {expect,test} from "bun:test";
import {choose} from "../src/logic.ts";
test("parent and nested test",()=>{
 expect(choose("alpha")).toBe("A");
 expect(Bun.spawnSync([process.execPath,"--no-env-file","test","./nested/child.test.ts"]).exitCode).toBe(0);
});`,
  );
  const { result, directory } = run(root, ["--", "./tests"]);
  expect(result.exitCode).toBe(0);
  const data = coverage(directory)[join(root, "src/logic.ts")];
  const id = Object.keys(data.fnMap).find(
    (key) => data.fnMap[key].name === "choose",
  );
  expect(data.f[id ?? "missing"]).toBe(2);
  expect(readdirSync(join(directory, "raw")).length).toBeGreaterThanOrEqual(2);
});

test("cancellation remains failed and terminates the owned test process group", async () => {
  if (process.platform === "win32") return;
  const root = fixture();
  writeFileSync(
    join(root, "hold.ts"),
    'import {writeFileSync} from "node:fs"; process.on("SIGTERM",()=>{}); writeFileSync("child.ready",String(process.pid)); setInterval(()=>{},1000);',
  );
  writeFileSync(
    join(root, "tests/a.test.ts"),
    `import {test} from "bun:test";
import {choose} from "../src/logic.ts";
test("interrupted work",async()=>{
 choose("alpha");
 Bun.spawn([process.execPath,"--no-env-file","./hold.ts"],{stdout:"ignore",stderr:"ignore"});
 await Bun.sleep(60000);
});`,
  );
  const env = { ...process.env };
  delete env.BUN_OPTIONS;
  delete env.NODE_OPTIONS;
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      cli,
      "--reporter=json",
      "--",
      "./tests",
      "--timeout=60000",
    ],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  let descendant: number | undefined;
  let cleanupError: unknown;
  try {
    for (
      let i = 0;
      i < 500 && !(await Bun.file(join(root, "child.ready")).exists());
      i++
    )
      await Bun.sleep(10);
    expect(await Bun.file(join(root, "child.ready")).exists()).toBe(true);
    descendant = Number(readFileSync(join(root, "child.ready"), "utf8"));
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    writeFileSync(
      join(root, "stdout.log"),
      await new Response(child.stdout).text(),
    );
    writeFileSync(
      join(root, "stderr.log"),
      await new Response(child.stderr).text(),
    );
    const output = join(root, "coverage/istanbul");
    const directory = join(output, readdirSync(output)[0]);
    const execution = JSON.parse(
      readFileSync(join(directory, "execution.json"), "utf8"),
    );
    expect(execution.interrupted).toBe(true);
    expect(execution.testsSucceeded).toBe(false);
    let exists = true;
    for (let i = 0; i < 100 && exists; i++) {
      try {
        process.kill(descendant, 0);
        await Bun.sleep(10);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        exists = false;
      }
    }
    expect(exists).toBe(false);
  } finally {
    child.kill("SIGTERM");
    if (descendant) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          cleanupError = error;
          console.error("Owned fixture cleanup failed", error);
        }
      }
    }
  }
  if (cleanupError) throw cleanupError;
});

test("test failures retain diagnostic coverage and a failed execution receipt", () => {
  const root = fixture();
  writeFileSync(
    join(root, "tests/a.test.ts"),
    'import { expect, test } from "bun:test"; import { choose } from "../src/logic.ts"; test("intentional failure", () => expect(choose("alpha")).toBe("wrong"));',
  );
  const { result, directory, execution } = run(root, ["--", "./tests"]);
  expect(result.exitCode).not.toBe(0);
  expect(execution.testsSucceeded).toBe(false);
  expect(execution.exitCode).not.toBe(0);
  expect(Object.keys(coverage(directory))).toHaveLength(2);
});

test("source drift, prepared-text drift, and missing captures refuse reporting", () => {
  for (const target of ["source", "prepared", "none"]) {
    const root = fixture();
    const run = prepareCoverage({ root });
    if (target === "source")
      writeFileSync(join(root, "src/logic.ts"), "export const changed = 1;");
    if (target === "prepared") {
      const path = join(run.directory, run.manifest.sources[0].artifact);
      // Replacement, rather than a write through the read-only preparation.
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      unlinkSync(path);
      writeFileSync(path, "changed");
    }
    expect(() =>
      reportCoverage({ manifestPath: run.manifestPath, reporters: ["json"] }),
    ).toThrow(
      target === "source"
        ? "source changed"
        : target === "prepared"
          ? "instrumentation changed"
          : "No coverage captures",
    );
  }
});

test("tampered seeds and manifests are rejected", () => {
  const seedRun = prepareCoverage({ root: fixture() });
  writeFileSync(join(seedRun.directory, "seed.json"), "{}");
  expect(() => readCoverageRun(seedRun.manifestPath)).toThrow("seed changed");
  const manifestRun = prepareCoverage({ root: fixture() });
  writeFileSync(manifestRun.manifestPath, "{}");
  expect(() =>
    readCoverageRun(manifestRun.manifestPath, manifestRun.manifestSha256),
  ).toThrow("manifest changed");
});

test("foreign captures, altered maps, negative counters, and incomplete writes refuse merging", () => {
  for (const fault of ["foreign", "map", "negative", "pending"]) {
    const run = prepareCoverage({ root: fixture() });
    const { capture, write } = syntheticCapture(run);
    const file = Object.values(capture.coverage)[0];
    if (fault === "foreign") capture.runId = randomUUID();
    if (fault === "map") Object.values(file.statementMap)[0].start.line += 100;
    if (fault === "negative") file.s[Object.keys(file.s)[0]] = -1;
    if (fault === "pending")
      writeFileSync(join(run.directory, "raw", "capture.pending"), "{}");
    write();
    expect(() =>
      reportCoverage({ manifestPath: run.manifestPath, reporters: ["json"] }),
    ).toThrow(
      fault === "foreign"
        ? "identity mismatch"
        : fault === "pending"
          ? "Incomplete"
          : "Invalid coverage counters",
    );
  }
});

test("unsupported or empty source inventories fail before execution", () => {
  expect(() => prepareCoverage({ root: fixture(), include: [] })).toThrow(
    "nonempty",
  );
  expect(() =>
    prepareCoverage({ root: fixture(), include: ["../outside.ts"] }),
  ).toThrow("relative");
  expect(() =>
    prepareCoverage({ root: fixture(), include: ["src/*.missing"] }),
  ).toThrow("No coverage sources");
});

test("JavaScript and TSX sources are instrumented with the appropriate parser", () => {
  const root = fixture();
  writeFileSync(
    join(root, "src/plain.mjs"),
    "export const add = (a, b) => a + b;",
  );
  writeFileSync(
    join(root, "src/view.tsx"),
    "export const View = () => <span>hello</span>;",
  );
  const run = prepareCoverage({ root });
  expect(
    run.manifest.sources.find((source) => source.path.endsWith("plain.mjs"))
      ?.loader,
  ).toBe("js");
  expect(
    run.manifest.sources.find((source) => source.path.endsWith("view.tsx"))
      ?.loader,
  ).toBe("tsx");
});

test("runtime hooks preserve ESM JavaScript and TSX evaluation", () => {
  const root = fixture();
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "h" } }),
  );
  writeFileSync(
    join(root, "src/plain.mjs"),
    "export const add = (a, b) => a + b;",
  );
  writeFileSync(
    join(root, "src/view.tsx"),
    "function h(tag: string, _props: unknown, ...children: string[]) { return {tag, children}; } export const View = () => <span>hello</span>;",
  );
  writeFileSync(
    join(root, "tests/a.test.ts"),
    'import {expect,test} from "bun:test"; import {View} from "../src/view.tsx"; import {add} from "../src/plain.mjs"; test("module behavior",()=>{expect(add(2,3)).toBe(5); expect(View()).toEqual({tag:"span",children:["hello"]});});',
  );
  const { result, directory } = run(root, ["--", "./tests"]);
  expect(result.exitCode).toBe(0);
  const data = coverage(directory);
  expect(Object.values(data[join(root, "src/plain.mjs")].f)).toEqual([1]);
  expect(Object.values(data[join(root, "src/view.tsx")].f)).toEqual([1, 1]);
});

test("explicit CommonJS inventories are rejected before execution", () => {
  const root = fixture();
  writeFileSync(join(root, "src/unsupported.cjs"), "module.exports = 42;");
  expect(() => prepareCoverage({ root, include: ["src/**/*.cjs"] })).toThrow(
    "CommonJS sources are not supported",
  );
});

function executePrepared(run: CoverageRun, testFile: string) {
  const config = join(run.directory, "bunfig.toml");
  writeFileSync(config, "# Explicit fixture configuration\n", { flag: "wx" });
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "test",
      `--config=${config}`,
      "--preload",
      join(repo, "src/preload.ts"),
      "--parallel=1",
      "--max-concurrency=1",
      testFile,
    ],
    {
      cwd: run.manifest.root,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        BUN_TEST_ISTANBUL_MANIFEST: run.manifestPath,
        BUN_TEST_ISTANBUL_MANIFEST_SHA256: run.manifestSha256,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    },
  );
  writeFileSync(join(run.directory, "stdout.log"), result.stdout);
  writeFileSync(join(run.directory, "stderr.log"), result.stderr);
  expect(result.exitCode).toBe(0);
  reportCoverage({ manifestPath: run.manifestPath, reporters: ["json"] });
  return coverage(run.directory);
}

test("forked preparation keeps fresh counters, maps, identities and independent raw directories", () => {
  const root = fixture();
  writeFileSync(
    join(root, "tests/b.test.ts"),
    'import {test,expect} from "bun:test"; import {choose} from "../src/logic.ts"; test("beta",()=>expect(choose("beta")).toBe("B"));',
  );
  const base = prepareCoverage({ root });
  const alpha = executePrepared(base, "./tests/a.test.ts");
  const fork = forkCoverage({
    manifestPath: base.manifestPath,
    expectedHash: base.manifestSha256,
  });
  expect(fork.manifest.schemaVersion).toBe(2);
  expect(fork.manifest.runId).not.toBe(base.manifest.runId);
  expect(fork.manifest.variable).toBe(base.manifest.variable);
  expect(readdirSync(join(fork.directory, "raw"))).toEqual([]);
  const beta = executePrepared(fork, "./tests/b.test.ts");
  const independent = executePrepared(
    prepareCoverage({ root }),
    "./tests/b.test.ts",
  );
  expect(beta).toEqual(independent);
  const logic = beta[join(root, "src/logic.ts")];
  const id = Object.keys(logic.fnMap).find(
    (key) => logic.fnMap[key].name === "choose",
  );
  expect(logic.f[id ?? "missing"]).toBe(1);
  expect(logic.b).not.toEqual(alpha[join(root, "src/logic.ts")].b);
  const nested = forkCoverage({
    manifestPath: fork.manifestPath,
    expectedHash: fork.manifestSha256,
  });
  expect(
    nested.manifest.schemaVersion === 2 && nested.manifest.preparationId,
  ).toBe(base.manifest.runId);
  expect(nested.manifest.runId).not.toBe(fork.manifest.runId);
  expect(executePrepared(nested, "./tests/a.test.ts")).toEqual(alpha);
  const raw = readdirSync(join(base.directory, "raw"))[0];
  writeFileSync(
    join(fork.directory, "raw", raw),
    readFileSync(join(base.directory, "raw", raw)),
  );
  expect(() =>
    reportCoverage({
      manifestPath: fork.manifestPath,
      reporters: ["json"],
      reportDir: join(fork.directory, "foreign-report"),
    }),
  ).toThrow("identity mismatch");
});

test("forking rejects changed preparation, source, seed, manifest and runtime before reuse", () => {
  for (const fault of ["source", "prepared", "seed", "manifest", "runtime"]) {
    const run = prepareCoverage({ root: fixture() });
    if (fault === "source")
      writeFileSync(
        join(run.manifest.root, "src/logic.ts"),
        "export const drift=1;",
      );
    if (fault === "prepared") {
      const path = join(run.directory, run.manifest.sources[0].artifact);
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      unlinkSync(path);
      writeFileSync(path, "bad");
    }
    if (fault === "seed") writeFileSync(join(run.directory, "seed.json"), "{}");
    if (fault === "manifest") writeFileSync(run.manifestPath, "{}");
    if (fault === "runtime") {
      run.manifest.bunVersion = "other";
      writeFileSync(run.manifestPath, JSON.stringify(run.manifest));
      run.manifestSha256 = sourceDigest(run.manifestPath);
    }
    expect(() =>
      forkCoverage({
        manifestPath: run.manifestPath,
        expectedHash: run.manifestSha256,
      }),
    ).toThrow();
  }
});

test("fork copies immutable preparation without sharing writable inodes or accepting malformed lineage", () => {
  const base = prepareCoverage({ root: fixture() });
  const fork = forkCoverage({
    manifestPath: base.manifestPath,
    expectedHash: base.manifestSha256,
  });
  const { chmodSync } = require("node:fs") as typeof import("node:fs");
  const path = join(fork.directory, fork.manifest.sources[0].artifact);
  chmodSync(path, 0o600);
  writeFileSync(path, "changed fork");
  expect(() => verifySources(base)).not.toThrow();
  expect(() => verifySources(fork)).toThrow("instrumentation changed");
  const clean = forkCoverage({
    manifestPath: base.manifestPath,
    expectedHash: base.manifestSha256,
  });
  if (clean.manifest.schemaVersion !== 2)
    throw new Error("Expected fork manifest");
  clean.manifest.preparationId = randomUUID();
  writeFileSync(clean.manifestPath, JSON.stringify(clean.manifest));
  expect(() => readCoverageRun(clean.manifestPath)).toThrow(
    "Invalid Istanbul coverage manifest",
  );
  expect(() =>
    forkCoverage({ manifestPath: base.manifestPath, expectedHash: "" }),
  ).toThrow("expected manifest SHA-256");
});

test("the low-level hook also refuses two invocation identities in one global", () => {
  const base = prepareCoverage({ root: fixture() });
  const fork = forkCoverage({
    manifestPath: base.manifestPath,
    expectedHash: base.manifestSha256,
  });
  const { createCoverageCollector } =
    require("../src/index.ts") as typeof import("../src/index.ts");
  createCoverageCollector(base.manifestPath, base.manifestSha256);
  expect(() =>
    createCoverageCollector(fork.manifestPath, fork.manifestSha256),
  ).toThrow("fresh global context");
});
