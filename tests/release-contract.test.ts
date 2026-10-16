import { expect, test } from "bun:test";
import {
  type ReleaseManifest,
  releaseIdentity,
  sha256,
  validateRelease,
  verifyChecksums,
} from "../scripts/release-contract.ts";

const manifest: ReleaseManifest = {
  schemaVersion: 1,
  name: "bun-test-istanbul",
  repository: "coreycoto/bun-test-istanbul",
  version: "0.1.0-beta.1",
  tag: "v0.1.0-beta.1",
  sourceCommit: "a".repeat(40),
  sourceTree: "b".repeat(40),
  bunVersion: "1.4.3",
  asset: {
    filename: "bun-test-istanbul-0.1.0-beta.1.tgz",
    sha256: sha256("artifact"),
    bytes: 8,
  },
};
test("release identity binds prerelease version, source and artifact", () => {
  expect(
    validateRelease(
      manifest,
      manifest.version,
      manifest.sourceCommit,
      manifest.sourceTree,
    ).prerelease,
  ).toBe(true);
  expect(releaseIdentity("1.0.0").prerelease).toBe(false);
  for (const changed of [
    { ...manifest, sourceCommit: "c".repeat(40) },
    { ...manifest, version: "0.1.0" },
    { ...manifest, sourceTree: "c".repeat(40) },
    {
      ...manifest,
      asset: { ...manifest.asset, filename: "../../outside.tgz" },
    },
  ])
    expect(() =>
      validateRelease(
        changed,
        manifest.version,
        manifest.sourceCommit,
        manifest.sourceTree,
      ),
    ).toThrow("Release identity");
  expect(() => releaseIdentity("0.1.0; command")).toThrow("SemVer");
});
test("checksum verification refuses missing, added and altered artifacts", () => {
  const entries = {
    "package.tgz": sha256("one"),
    "release.json": sha256("two"),
  };
  const text = Object.entries(entries)
    .map(([name, digest]) => `${digest}  ${name}`)
    .join("\n");
  expect(() => verifyChecksums(`${text}\n`, entries)).not.toThrow();
  expect(() => verifyChecksums(text.split("\n")[0], entries)).toThrow(
    "inventory",
  );
  expect(() =>
    verifyChecksums(`${text}\n${sha256("extra")}  other`, entries),
  ).toThrow("inventory");
  expect(() =>
    verifyChecksums(
      text.replace(entries["package.tgz"], "0".repeat(64)),
      entries,
    ),
  ).toThrow("inventory");
});
