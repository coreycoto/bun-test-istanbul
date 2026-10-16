import { createHash } from "node:crypto";

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
export function releaseIdentity(version: string) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version))
    throw new Error("Release version must be a plain SemVer or prerelease");
  return {
    version,
    tag: `v${version}`,
    filename: `bun-test-istanbul-${version}.tgz`,
    prerelease: version.includes("-"),
  };
}
export interface ReleaseManifest {
  schemaVersion: 1;
  name: "bun-test-istanbul";
  version: string;
  tag: string;
  repository: "coreycoto/bun-test-istanbul";
  sourceCommit: string;
  sourceTree: string;
  bunVersion: string;
  asset: { filename: string; sha256: string; bytes: number };
}
export function validateRelease(
  manifest: ReleaseManifest,
  version: string,
  commit: string,
  tree: string,
) {
  const expected = releaseIdentity(version);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.name !== "bun-test-istanbul" ||
    manifest.repository !== "coreycoto/bun-test-istanbul" ||
    manifest.version !== version ||
    manifest.tag !== expected.tag ||
    manifest.sourceCommit !== commit ||
    !/^[a-f0-9]{40}$/.test(commit) ||
    manifest.sourceTree !== tree ||
    !/^[a-f0-9]{40}$/.test(tree) ||
    manifest.bunVersion !== "1.4.3" ||
    manifest.asset?.filename !== expected.filename ||
    !/^[a-f0-9]{64}$/.test(manifest.asset.sha256) ||
    !Number.isSafeInteger(manifest.asset.bytes) ||
    manifest.asset.bytes <= 0
  )
    throw new Error(
      "Release identity does not match the expected source and version",
    );
  return expected;
}
export function verifyChecksums(
  text: string,
  entries: Record<string, string>,
): void {
  const lines = text.trim().split("\n");
  const expected = Object.entries(entries)
    .map(([name, digest]) => `${digest}  ${name}`)
    .sort();
  if (JSON.stringify(lines.sort()) !== JSON.stringify(expected))
    throw new Error("Release checksum inventory differs from expected assets");
}
