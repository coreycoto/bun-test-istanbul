import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkConsumer, command } from "./consumer-check.ts";
import {
  type ReleaseManifest,
  releaseIdentity,
  sha256,
  validateRelease,
} from "./release-contract.ts";

const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const identity = releaseIdentity(pkg.version);
if (Bun.version !== "1.4.3")
  throw new Error("Release preparation requires Bun 1.4.3");
if (
  command(
    ["git", "status", "--porcelain", "--untracked-files=all"],
    root,
  ).trim()
)
  throw new Error("Release preparation requires a clean checkout");
const commit = command(["git", "rev-parse", "HEAD"], root).trim();
const tree = command(["git", "rev-parse", "HEAD^{tree}"], root).trim();
const input = process.argv.slice(2);
if (input.length > 1 || input.some((arg) => !arg.startsWith("--out-dir=")))
  throw new Error("Usage: bun run release:prepare --out-dir=<fresh directory>");
const output = resolve(
  root,
  input[0]?.slice("--out-dir=".length) ||
    `.tmp/releases/${identity.tag}-${randomUUID()}`,
);
mkdirSync(resolve(output, ".."), { recursive: true });
mkdirSync(output);
const packOutput = command(
  [process.execPath, "pm", "pack", "--destination", output],
  root,
);
const files = readdirSync(output);
if (files.length !== 1 || files[0] !== identity.filename)
  throw new Error(
    `Unexpected package artifact inventory: ${JSON.stringify(files)}`,
  );
const asset = join(output, identity.filename);
const packedFiles = command(["tar", "-tzf", asset], root).trim().split("\n");
const committedFiles = new Set(
  command(["git", "ls-tree", "-r", "--name-only", "HEAD"], root)
    .trim()
    .split("\n"),
);
if (
  packedFiles.some(
    (file) =>
      !/^package\/(?:src\/[^/]+\.ts|README\.md|LICENSE|package\.json)$/.test(
        file,
      ) || !committedFiles.has(file.slice("package/".length)),
  )
)
  throw new Error("Release package contains unexpected files");
const consumer = join(
  root,
  ".tmp",
  `release-consumer-${randomUUID()}`,
  "consumer with spaces",
);
const consumerResult = checkConsumer(
  `file:${asset}`,
  consumer,
  identity.version,
  asset,
  { verifyFork: true },
);
const bytes = readFileSync(asset);
const manifest: ReleaseManifest = {
  schemaVersion: 1,
  name: "bun-test-istanbul",
  version: identity.version,
  tag: identity.tag,
  repository: "coreycoto/bun-test-istanbul",
  sourceCommit: commit,
  sourceTree: tree,
  bunVersion: Bun.version,
  asset: {
    filename: identity.filename,
    sha256: sha256(bytes),
    bytes: bytes.length,
  },
};
validateRelease(manifest, pkg.version, commit, tree);
if (
  command(
    ["git", "status", "--porcelain", "--untracked-files=all"],
    root,
  ).trim()
)
  throw new Error("Source changed during release preparation");
const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(output, "release.json"), manifestBytes, { flag: "wx" });
writeFileSync(
  join(output, "SHA256SUMS"),
  `${manifest.asset.sha256}  ${identity.filename}\n${sha256(manifestBytes)}  release.json\n`,
  { flag: "wx" },
);
const receipt = {
  manifest,
  output,
  consumer,
  consumerResult,
  packedFiles,
  packOutput,
};
writeFileSync(
  join(consumer, "release-preparation.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    output,
    tag: identity.tag,
    sourceCommit: commit,
    sha256: manifest.asset.sha256,
    prerelease: identity.prerelease,
    consumerVerified: true,
  }),
);
