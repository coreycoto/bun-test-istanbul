import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Loader } from "bun";
import type { CoverageMapData } from "istanbul-lib-coverage";
import { createInstrumenter } from "istanbul-lib-instrument";

export const MANIFEST_ENV = "BUN_TEST_ISTANBUL_MANIFEST";
export const MANIFEST_HASH_ENV = "BUN_TEST_ISTANBUL_MANIFEST_SHA256";
export const GENERATOR = "istanbul-lib-instrument@6.0.3";
if (
  createRequire(import.meta.url)("istanbul-lib-instrument/package.json")
    .version !== "6.0.3"
) {
  throw new Error("Istanbul instrumenter differs from the pinned generator");
}
export const DEFAULT_INCLUDE = ["src/**/*.{js,jsx,ts,tsx,mjs,mts}"];
const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/*.d.{ts,mts,cts}",
  "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
];

export interface CoverageOptions {
  root?: string;
  include?: string[];
  exclude?: string[];
  outputDir?: string;
}
export interface SourceRecord {
  path: string;
  sha256: string;
  loader: Loader;
  artifact: string;
  artifactSha256: string;
}
interface ManifestFields {
  runId: string;
  root: string;
  generator: string;
  bunVersion: string;
  variable: string;
  sources: SourceRecord[];
  seedSha256: string;
}
export type RunManifest = ManifestFields &
  (
    | { schemaVersion: 1 }
    | {
        schemaVersion: 2;
        preparationId: string;
        preparedFromManifestSha256: string;
      }
  );
export interface ForkCoverageOptions {
  manifestPath: string;
  expectedHash: string;
  outputDir?: string;
}
export interface CoverageRun {
  manifestPath: string;
  directory: string;
  manifest: RunManifest;
  manifestSha256: string;
}
export const digest = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
export const sourceDigest = (path: string): string =>
  digest(readFileSync(path));
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}
export function isWithin(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
  );
}
function loaderFor(path: string): Loader {
  const extension = extname(path);
  if ([".cjs", ".cts"].includes(extension))
    throw new Error(
      `CommonJS sources are not supported by this runtime hook: ${path}`,
    );
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  if ([".ts", ".mts"].includes(extension)) return "ts";
  if ([".js", ".mjs"].includes(extension)) return "js";
  throw new Error(`Unsupported coverage source: ${path}`);
}

/** Prepare immutable source text once; every test context still owns its counters. */
export function prepareCoverage(options: CoverageOptions = {}): CoverageRun {
  const root = realpathSync(resolve(options.root ?? process.cwd()));
  const output = resolve(root, options.outputDir ?? "coverage/istanbul");
  const include = options.include ?? DEFAULT_INCLUDE;
  const exclude = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])].map(
    (glob) => new Bun.Glob(glob),
  );
  if (
    !include.length ||
    include.some(
      (pattern) => isAbsolute(pattern) || pattern.split(/[\\/]/).includes(".."),
    )
  ) {
    throw new Error(
      "Coverage include patterns must be nonempty and relative to root",
    );
  }
  const paths = new Set<string>();
  for (const pattern of include) {
    for (const path of new Bun.Glob(pattern).scanSync({
      cwd: root,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      if (
        exclude.some((glob) => glob.match(path)) ||
        isWithin(output, resolve(root, path))
      )
        continue;
      const canonical = realpathSync(resolve(root, path));
      if (!isWithin(root, canonical) || canonical !== resolve(root, path)) {
        throw new Error(
          `Coverage sources must be regular files inside root: ${path}`,
        );
      }
      if (!statSync(canonical).isFile())
        throw new Error(`Not a coverage file: ${path}`);
      loaderFor(path);
      paths.add(path.split(sep).join("/"));
    }
  }
  if (!paths.size)
    throw new Error("No coverage sources matched include patterns");
  const runId = randomUUID();
  const directory = join(output, runId);
  mkdirSync(output, { recursive: true });
  mkdirSync(directory);
  mkdirSync(join(directory, "prepared"));
  mkdirSync(join(directory, "raw"));
  const variable = `__bun_test_istanbul_${runId.replaceAll("-", "")}__`;
  const seed: CoverageMapData = {};
  const sources = [...paths].sort().map((path, index): SourceRecord => {
    const absolute = resolve(root, path);
    const source = readFileSync(absolute, "utf8");
    const loader = loaderFor(path);
    const instrumenter = createInstrumenter({
      coverageVariable: variable,
      esModules: true,
      parserPlugins: [
        "typescript",
        ...(["jsx", "tsx"].includes(loader) ? ["jsx" as const] : []),
      ],
      compact: false,
      produceSourceMap: false,
    });
    const contents = instrumenter.instrumentSync(source, absolute);
    const artifact = `prepared/${index}.${loader}`;
    writeFileSync(join(directory, artifact), contents, {
      flag: "wx",
      mode: 0o400,
    });
    seed[absolute] = instrumenter.lastFileCoverage();
    return {
      path,
      sha256: digest(source),
      loader,
      artifact,
      artifactSha256: digest(contents),
    };
  });
  writeJson(join(directory, "seed.json"), seed);
  const manifest: RunManifest = {
    schemaVersion: 1,
    runId,
    root,
    generator: GENERATOR,
    bunVersion: Bun.version,
    variable,
    sources,
    seedSha256: sourceDigest(join(directory, "seed.json")),
  };
  const manifestPath = join(directory, "manifest.json");
  writeJson(manifestPath, manifest);
  return {
    manifestPath,
    directory,
    manifest,
    manifestSha256: sourceDigest(manifestPath),
  };
}

export function readCoverageRun(
  manifestPath: string,
  expectedHash?: string,
): CoverageRun {
  const path = resolve(manifestPath);
  const bytes = readFileSync(path);
  const manifestSha256 = digest(bytes);
  if (expectedHash && expectedHash !== manifestSha256)
    throw new Error("Coverage manifest changed");
  const manifest = JSON.parse(bytes.toString()) as RunManifest;
  const preparationId =
    manifest.schemaVersion === 2 ? manifest.preparationId : manifest.runId;
  if (
    ![1, 2].includes(manifest.schemaVersion) ||
    manifest.generator !== GENERATOR ||
    !/^[a-f0-9-]{36}$/.test(manifest.runId) ||
    !isAbsolute(manifest.root) ||
    typeof preparationId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(preparationId) ||
    (manifest.schemaVersion === 2 &&
      !/^[a-f0-9]{64}$/.test(manifest.preparedFromManifestSha256)) ||
    (manifest.schemaVersion === 1 &&
      ("preparationId" in manifest ||
        "preparedFromManifestSha256" in manifest)) ||
    manifest.variable !==
      `__bun_test_istanbul_${preparationId.replaceAll("-", "")}__` ||
    !Array.isArray(manifest.sources) ||
    !manifest.sources.length ||
    new Set(manifest.sources.map((source) => source.path)).size !==
      manifest.sources.length
  ) {
    throw new Error("Invalid Istanbul coverage manifest");
  }
  for (const source of manifest.sources) {
    if (
      typeof source.path !== "string" ||
      isAbsolute(source.path) ||
      source.path
        .split(/[\\/]/)
        .some((part) => ["", ".", ".."].includes(part)) ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !/^[a-f0-9]{64}$/.test(source.artifactSha256) ||
      !/^prepared\/[0-9]+\.(js|jsx|ts|tsx)$/.test(source.artifact) ||
      source.loader !== loaderFor(source.path)
    ) {
      throw new Error("Invalid coverage source record");
    }
  }
  const directory = resolve(path, "..");
  if (sourceDigest(join(directory, "seed.json")) !== manifest.seedSha256)
    throw new Error("Coverage seed changed");
  return { manifestPath: path, directory, manifest, manifestSha256 };
}

/** Reuse only immutable preparation; raw captures, reports and run identity are fresh. */
export function forkCoverage(options: ForkCoverageOptions): CoverageRun {
  if (!/^[a-f0-9]{64}$/.test(options.expectedHash))
    throw new Error("Fork requires an expected manifest SHA-256");
  const source = readCoverageRun(options.manifestPath, options.expectedHash);
  if (source.manifest.bunVersion !== Bun.version)
    throw new Error("Coverage Bun runtime differs from preparation");
  verifySources(source);
  const runId = randomUUID();
  const output = resolve(
    source.manifest.root,
    options.outputDir ?? "coverage/istanbul",
  );
  const directory = join(output, runId);
  mkdirSync(output, { recursive: true });
  mkdirSync(directory);
  mkdirSync(join(directory, "prepared"));
  mkdirSync(join(directory, "raw"));
  // Prefer copy-on-write when supported, with a byte-copy fallback. Never share
  // writable inodes: replacing/changing one fork must not mutate another run.
  for (const path of [
    "seed.json",
    ...source.manifest.sources.map((s) => s.artifact),
  ]) {
    const target = join(directory, path);
    copyFileSync(
      join(source.directory, path),
      target,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
    chmodSync(target, 0o400);
  }
  const manifest: RunManifest = {
    ...source.manifest,
    schemaVersion: 2,
    runId,
    preparationId:
      source.manifest.schemaVersion === 2
        ? source.manifest.preparationId
        : source.manifest.runId,
    preparedFromManifestSha256: source.manifestSha256,
  };
  const manifestPath = join(directory, "manifest.json");
  writeJson(manifestPath, manifest);
  const run = readCoverageRun(manifestPath);
  verifySources(source);
  verifySources(run);
  return run;
}

export function verifySources(run: CoverageRun): void {
  if (sourceDigest(run.manifestPath) !== run.manifestSha256)
    throw new Error("Coverage manifest changed");
  for (const source of run.manifest.sources) {
    const absolute = resolve(run.manifest.root, source.path);
    if (
      realpathSync(absolute) !== absolute ||
      sourceDigest(absolute) !== source.sha256
    )
      throw new Error(`Coverage source changed: ${source.path}`);
    if (
      sourceDigest(join(run.directory, source.artifact)) !==
      source.artifactSha256
    )
      throw new Error(`Prepared instrumentation changed: ${source.path}`);
  }
}
