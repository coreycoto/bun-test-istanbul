# GitHub Releases

Packages are distributed as versioned GitHub Release assets. No npm publication
or registry credentials are required for this project. Istanbul dependencies
still install from their normal package registry.

## Prepare a release

1. Review the source and compatibility notes. Update `package.json`, `bun.lock`,
   `CHANGELOG.md`, and the README install example for the intended version.
   Write `RELEASE_NOTES.md` for the current version only: useful changes,
   installation and compatibility. Review that exact public body; the workflow
   uses it instead of copying the full development changelog.
2. Merge the reviewed candidate and verify its exact main CI. Keep source and
   assets tied to that revision; an older green candidate is insufficient.
3. Run the **GitHub Releases** workflow manually against the reviewed ref. It
   installs frozen dependencies, runs checks, prepares a fresh package, and
   verifies that exact tarball through its installed CLI and API.
4. The workflow creates a **draft** with exactly three assets: the versioned
   `.tgz`, `release.json` containing the source commit/tree and package digest,
   and `SHA256SUMS`. It downloads the uploaded assets and verifies their identity
   and installation again. Inspect the draft and terminal workflow result.
5. Publish the reviewed draft when authorized. The repository must be public for
   anonymous use. Changing a private repository to public also exposes its
   history and repository discussions; that is a separate visibility decision.
6. The published-release event runs anonymous downloads, checks both manifest
   and package checksums, installs the version-specific asset URL into a fresh
   consumer/cache, and exercises its CLI and API. Inspect that terminal result
   before announcing the release.

Published versions and assets must remain unchanged. A correction gets a new
version. Never overwrite a failed or partially uploaded draft automatically:
inspect the existing draft and preserved failure first. Do not infer publication
from a tag, upload, or draft preparation alone.

## Local preparation and verification

Use a clean exact checkout and a fresh output directory:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run release:prepare --out-dir=.tmp/release-assets-unique
bun run release:verify --assets-dir=.tmp/release-assets-unique
```

After publication, from the exact released checkout:

```sh
bun run release:verify
```

The latter fetches public HTTPS asset URLs without an Authorization header and
uses a fresh Bun cache for installation. Local receipts remain under `.tmp/`.
Preparation refuses dirty or untracked source and existing output directories. The
manual workflow stages a draft; it does not merge PRs, change repository
visibility, publish to npm, or publish the draft automatically.
