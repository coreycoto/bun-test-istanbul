import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BunPlugin, plugin } from "bun";
import type { CoverageMapData } from "istanbul-lib-coverage";
import {
  type CoverageRun,
  MANIFEST_ENV,
  MANIFEST_HASH_ENV,
  readCoverageRun,
  sourceDigest,
  verifySources,
} from "./run.ts";

export interface CoverageCapture {
  schemaVersion: 1;
  runId: string;
  manifestSha256: string;
  contextId: string;
  pid: number;
  loaded: Record<string, string>;
  coverage: CoverageMapData;
}
export interface CoverageCollector {
  run: CoverageRun;
  plugin: BunPlugin;
  flush(): string;
}

/** Create an import hook; register it with Bun.plugin before importing sources. */
export function createCoverageCollector(
  manifestPath: string,
  expectedHash?: string,
): CoverageCollector {
  const run = readCoverageRun(manifestPath, expectedHash);
  if (run.manifest.bunVersion !== Bun.version)
    throw new Error("Coverage Bun runtime differs from preparation");
  const expected = new Map(
    run.manifest.sources.map((source) => [
      resolve(run.manifest.root, source.path),
      source,
    ]),
  );
  const loaded: Record<string, string> = {};
  const contextId = randomUUID();
  const target = join(
    run.directory,
    "raw",
    `bun-${process.pid}-${contextId}.json`,
  );
  const filter = new RegExp(
    `^(?:${[...expected.keys()].map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:\\?.*)?$`,
  );
  return {
    run,
    plugin: {
      name: "bun-test-istanbul",
      setup(builder) {
        builder.onLoad({ filter, namespace: "file" }, ({ path }) => {
          const canonical = resolve(path.split("?")[0]);
          const source = expected.get(canonical);
          if (!source) return;
          if (sourceDigest(canonical) !== source.sha256)
            throw new Error(`Coverage source changed: ${source.path}`);
          const artifact = join(run.directory, source.artifact);
          if (sourceDigest(artifact) !== source.artifactSha256)
            throw new Error(`Prepared instrumentation changed: ${source.path}`);
          loaded[canonical] = source.sha256;
          return {
            contents: readFileSync(artifact, "utf8"),
            loader: source.loader,
          };
        });
      },
    },
    flush() {
      verifySources(run);
      const globals = globalThis as unknown as Record<string, CoverageMapData>;
      const capture: CoverageCapture = {
        schemaVersion: 1,
        runId: run.manifest.runId,
        manifestSha256: run.manifestSha256,
        contextId,
        pid: process.pid,
        loaded: { ...loaded },
        coverage: globals[run.manifest.variable] ?? {},
      };
      const temporary = `${target}.${randomUUID()}.pending`;
      writeFileSync(temporary, JSON.stringify(capture), { flag: "wx" });
      // Repeated flushes replace this context's cumulative capture. They must
      // never be merged as independent increments.
      renameSync(temporary, target);
      return target;
    },
  };
}

/** One registration per isolated global; call before importing covered code. */
export function registerCoverage(
  manifestPath: string,
  expectedHash?: string,
): CoverageCollector {
  const globals = globalThis as unknown as Record<symbol, CoverageCollector>;
  const key = Symbol.for("bun-test-istanbul.collector");
  const existing = globals[key];
  if (existing) {
    const requested = readCoverageRun(manifestPath, expectedHash);
    if (requested.manifestSha256 !== existing.run.manifestSha256)
      throw new Error(
        "A different coverage run is already registered in this context",
      );
    return existing;
  }
  const collector = createCoverageCollector(manifestPath, expectedHash);
  plugin(collector.plugin);
  globals[key] = collector;
  return collector;
}

export function registerCoverageFromEnvironment(): CoverageCollector {
  const path = process.env[MANIFEST_ENV];
  const hash = process.env[MANIFEST_HASH_ENV];
  if (!path || !hash)
    throw new Error(
      "Coverage preload requires a prepared manifest and SHA-256; use the CLI or prepareCoverage()",
    );
  return registerCoverage(path, hash);
}
