import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkConsumer, command } from "./consumer-check.ts";
import {
  type ReleaseManifest,
  releaseIdentity,
  sha256,
  validateRelease,
  verifyChecksums,
} from "./release-contract.ts";

const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const identity = releaseIdentity(pkg.version);
const commit = command(["git", "rev-parse", "HEAD"], root).trim();
const tree = command(["git", "rev-parse", "HEAD^{tree}"], root).trim();
const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => !arg.startsWith("--assets-dir=")))
  throw new Error(
    "Usage: bun run release:verify [--assets-dir=<downloaded draft assets>]",
  );
const scratch = join(root, ".tmp", `release-verification-${randomUUID()}`);
mkdirSync(scratch, { recursive: true });
const local = args[0] ? resolve(args[0].slice("--assets-dir=".length)) : null;
const base = `https://github.com/coreycoto/bun-test-istanbul/releases/download/${identity.tag}`;
async function acquire(filename: string): Promise<Uint8Array> {
  if (local) return readFileSync(join(local, filename));
  // No GitHub token or Authorization header: this checks anonymous acquisition.
  const response = await fetch(`${base}/${filename}`, {
    redirect: "follow",
    credentials: "omit",
  });
  if (!response.ok)
    throw new Error(
      `Anonymous release download failed: HTTP ${response.status} for ${filename}`,
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  writeFileSync(join(scratch, filename), bytes, { flag: "wx" });
  return bytes;
}
const manifestBytes = await acquire("release.json");
const manifest = JSON.parse(
  new TextDecoder().decode(manifestBytes),
) as ReleaseManifest;
validateRelease(manifest, pkg.version, commit, tree);
const bytes = await acquire(identity.filename);
if (
  sha256(bytes) !== manifest.asset.sha256 ||
  bytes.length !== manifest.asset.bytes
)
  throw new Error("Downloaded release package differs from its manifest");
verifyChecksums(new TextDecoder().decode(await acquire("SHA256SUMS")), {
  [identity.filename]: sha256(bytes),
  "release.json": sha256(manifestBytes),
});
const result = checkConsumer(
  local
    ? `file:${join(local, identity.filename)}`
    : `${base}/${identity.filename}`,
  join(scratch, "consumer with spaces"),
  identity.version,
  join(local ?? scratch, identity.filename),
);
const receipt = {
  sourceCommit: commit,
  version: identity.version,
  tag: identity.tag,
  packageSha256: manifest.asset.sha256,
  anonymousAcquisition: !local,
  consumerResult: result,
  assetBase: local ?? base,
};
writeFileSync(
  join(scratch, "verification.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(
  JSON.stringify({ ...receipt, receipt: join(scratch, "verification.json") }),
);
