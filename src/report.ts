import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createCoverageMap,
  type FileCoverageData,
} from "istanbul-lib-coverage";
import { createContext } from "istanbul-lib-report";
import { create } from "istanbul-reports";
import type { CoverageCapture } from "./collector.ts";
import { readCoverageRun, verifySources, writeJson } from "./run.ts";

export type Reporter =
  | "text"
  | "text-summary"
  | "json"
  | "json-summary"
  | "lcovonly"
  | "html";
export const REPORTERS: Reporter[] = [
  "text",
  "text-summary",
  "json",
  "json-summary",
  "lcovonly",
  "html",
];
export interface ReportOptions {
  manifestPath: string;
  reporters?: Reporter[];
  reportDir?: string;
}
function validCounters(
  actual: FileCoverageData,
  expected: FileCoverageData,
): boolean {
  for (const key of ["statementMap", "fnMap", "branchMap"] as const) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key]))
      return false;
  }
  for (const key of ["s", "f", "b"] as const) {
    const values = actual[key];
    if (
      !values ||
      JSON.stringify(Object.keys(values).sort()) !==
        JSON.stringify(Object.keys(expected[key]).sort())
    )
      return false;
    for (const [id, count] of Object.entries(values)) {
      const numbers = key === "b" ? count : [count];
      if (
        !Array.isArray(numbers) ||
        numbers.some((value) => !Number.isSafeInteger(value) || value < 0)
      )
        return false;
      if (key === "b" && numbers.length !== expected.b[id].length) return false;
    }
  }
  return true;
}

/** Merge only captures belonging to this exact run, source inventory and maps. */
export function reportCoverage(options: ReportOptions) {
  const run = readCoverageRun(options.manifestPath);
  verifySources(run);
  const reporters = options.reporters ?? ["text", "json", "lcovonly"];
  if (!reporters.length || reporters.some((name) => !REPORTERS.includes(name)))
    throw new Error("Unsupported Istanbul reporter");
  const seed = createCoverageMap(
    JSON.parse(readFileSync(join(run.directory, "seed.json"), "utf8")),
  );
  const expected = new Map(
    run.manifest.sources.map((source) => [
      resolve(run.manifest.root, source.path),
      source.sha256,
    ]),
  );
  if (
    JSON.stringify(seed.files().sort()) !==
    JSON.stringify([...expected.keys()].sort())
  )
    throw new Error("Coverage seed inventory differs from manifest");
  // CoverageMap.toJSON() contains FileCoverage instances until serialized.
  // A JSON round trip copies their public data instead of cloning private wrappers.
  const map = createCoverageMap(JSON.parse(JSON.stringify(seed)));
  const files = readdirSync(join(run.directory, "raw")).sort();
  if (files.some((file) => !/^bun-[0-9]+-[a-f0-9-]{36}\.json$/.test(file)))
    throw new Error("Incomplete or unexpected raw coverage artifact");
  if (!files.length)
    throw new Error("No coverage captures; execution may be incomplete");
  const contexts = new Set<string>();
  for (const file of files) {
    const capture = JSON.parse(
      readFileSync(join(run.directory, "raw", file), "utf8"),
    ) as CoverageCapture;
    if (
      capture.schemaVersion !== 1 ||
      capture.runId !== run.manifest.runId ||
      capture.manifestSha256 !== run.manifestSha256 ||
      file !== `bun-${capture.pid}-${capture.contextId}.json` ||
      contexts.has(capture.contextId) ||
      !capture.loaded ||
      !capture.coverage
    )
      throw new Error(`Coverage capture identity mismatch: ${file}`);
    contexts.add(capture.contextId);
    for (const [path, sha256] of Object.entries(capture.loaded)) {
      if (expected.get(path) !== sha256)
        throw new Error(`Unexpected or changed loaded source: ${path}`);
    }
    for (const [path, data] of Object.entries(capture.coverage)) {
      if (
        !expected.has(path) ||
        capture.loaded[path] !== expected.get(path) ||
        data.path !== path ||
        !validCounters(
          data,
          seed.fileCoverageFor(path).toJSON() as FileCoverageData,
        )
      )
        throw new Error(`Invalid coverage counters: ${path}`);
    }
    for (const path of Object.keys(capture.loaded)) {
      if (!capture.coverage[path])
        throw new Error(`Loaded source has no counters: ${path}`);
    }
    map.merge(capture.coverage);
  }
  const reportDir = resolve(
    options.reportDir ?? join(run.directory, "reports"),
  );
  // Existing reports are not overwritten: a second rendering uses a fresh path.
  mkdirSync(reportDir, { recursive: false });
  const context = createContext({ dir: reportDir, coverageMap: map });
  for (const reporter of [...new Set(reporters)])
    create(reporter, { projectRoot: run.manifest.root }).execute(context);
  verifySources(run);
  const result = {
    schemaVersion: 1,
    runId: run.manifest.runId,
    manifestSha256: run.manifestSha256,
    captureCount: files.length,
    sourceCount: expected.size,
    summary: map.getCoverageSummary().toJSON(),
    reportDir,
    // Coverage captures alone cannot establish test success, full discovery or
    // completion of unobserved children. Keep that authority with the consumer.
    executionVerified: false,
  };
  writeJson(join(reportDir, "capture-summary.json"), result);
  return result;
}
