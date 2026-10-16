#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORTERS, type Reporter, reportCoverage } from "./report.ts";
import {
  MANIFEST_ENV,
  MANIFEST_HASH_ENV,
  prepareCoverage,
  writeJson,
} from "./run.ts";

const help = `Usage: bun-test-istanbul [options] -- [bun test arguments]

  --include=<glob>     ESM sources relative to cwd (repeatable; default src/**/*.{js,jsx,ts,tsx,mjs,mts})
  --exclude=<glob>     Additional excluded source files (repeatable)
  --out-dir=<path>     Retained run directory parent (default coverage/istanbul)
  --reporter=<name>    text, text-summary, json, json-summary, lcovonly, html (repeatable)
  --help              Show this help

Each invocation creates a fresh run. Tests still use bun:test. The CLI retains
raw Istanbul data and test execution status; it does not enforce coverage gates.
`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help);
    return 0;
  }
  const divider = args.indexOf("--");
  const options = divider < 0 ? args : args.slice(0, divider);
  const testArgs = divider < 0 ? [] : args.slice(divider + 1);
  const include: string[] = [],
    exclude: string[] = [],
    reporters: Reporter[] = [];
  let outputDir: string | undefined;
  for (const option of options) {
    const match = /^--(include|exclude|out-dir|reporter)=(.+)$/.exec(option);
    if (!match)
      throw new Error(
        `Unknown option: ${option}. Use --help; options use --name=value.`,
      );
    if (match[1] === "include") include.push(match[2]);
    if (match[1] === "exclude") exclude.push(match[2]);
    if (match[1] === "out-dir") outputDir = match[2];
    if (match[1] === "reporter") {
      if (!REPORTERS.includes(match[2] as Reporter))
        throw new Error(`Unsupported reporter: ${match[2]}`);
      reporters.push(match[2] as Reporter);
    }
  }
  // Native coverage and watch/retry modes have different counter/lifecycle
  // semantics. Avoid silently combining them with this one-shot collector.
  if (
    testArgs.some((arg) =>
      /^(--coverage(?:[=-]|$)|--watch(?:=|$)|--hot(?:=|$)|--rerun-each(?:=|$)|--retry(?:=|$))/.test(
        arg,
      ),
    )
  )
    throw new Error(
      "Native coverage, watch, rerun and retry modes are not supported by this CLI",
    );
  if (process.env.BUN_OPTIONS?.trim())
    throw new Error(
      "BUN_OPTIONS is already set; use the programmatic API to compose preloads explicitly",
    );
  const run = prepareCoverage({
    include: include.length ? include : undefined,
    exclude,
    outputDir,
  });
  const scratch = realpathSync(
    mkdtempSync(join(tmpdir(), "bun-test-istanbul-")),
  );
  const started = new Date();
  let status: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let reportError: string | null = null;
  let failure: string | null = null;
  let interrupted = false;
  try {
    if (/\s/.test(scratch))
      throw new Error(
        "Bun subprocess preload requires a whitespace-free temporary directory",
      );
    const alias = join(scratch, "preload.ts");
    symlinkSync(fileURLToPath(new URL("./preload.ts", import.meta.url)), alias);
    const child = spawn(
      process.execPath,
      ["--no-env-file", "test", "--preload", alias, ...testArgs],
      {
        stdio: "inherit",
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          BUN_OPTIONS: `--no-env-file --preload=${alias}`,
          [MANIFEST_ENV]: run.manifestPath,
          [MANIFEST_HASH_ENV]: run.manifestSha256,
        },
      },
    );
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (requested: NodeJS.Signals) => {
      interrupted = true;
      const send = (next: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill(next);
          else process.kill(-child.pid, next);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      send(requested);
      escalation ??= setTimeout(() => send("SIGKILL"), 1000);
    };
    const interrupt = () => stop("SIGINT"),
      terminate = () => stop("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      await new Promise<void>((accept, reject) => {
        child.once("error", reject);
        child.once("close", (code, endedBy) => {
          status = code;
          signal = endedBy;
          accept();
        });
      });
      // Allow cancellation escalation to reach descendants even after the test
      // leader exits. Never produce a successful receipt after cancellation.
      if (interrupted) await Bun.sleep(1100);
    } finally {
      if (escalation) clearTimeout(escalation);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
    try {
      reportCoverage({
        manifestPath: run.manifestPath,
        reporters: reporters.length ? reporters : undefined,
      });
    } catch (error) {
      reportError = String(error);
    }
  } catch (error) {
    failure = String(error);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    writeJson(join(run.directory, "execution.json"), {
      schemaVersion: 1,
      runId: run.manifest.runId,
      manifestSha256: run.manifestSha256,
      bunVersion: Bun.version,
      args: testArgs,
      startedAt: started.toISOString(),
      endedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started.getTime(),
      exitCode: status,
      signal,
      interrupted,
      failure,
      reportError,
      testsSucceeded:
        status === 0 && signal === null && !failure && !interrupted,
      qualificationEstablished: false,
    });
  }
  console.log(`Istanbul artifacts: ${run.directory}`);
  if (failure || reportError) console.error(failure ?? reportError);
  if (interrupted || signal) return 1;
  if (status !== 0) return status ?? 1;
  return failure || reportError ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
