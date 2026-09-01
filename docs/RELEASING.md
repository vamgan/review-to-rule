# Release guide

Releases are deliberate. A package version change merged to `main` starts the
npm publishing workflow automatically.

## One-time bootstrap

1. Configure the npm trusted publisher for `vamgan/review-to-rule`:
   - provider: GitHub Actions
   - repository: `vamgan/review-to-rule`
   - workflow: `publish_release.yml`
   - environment: leave blank
   - allowed action: `npm publish`
2. Verify the trust relationship with `npm trust list review-to-rule`.
3. Revoke any bootstrap publishing token. CI must not contain an npm token.

## Publish a version

1. Land the feature or fix without changing any version field.
2. Open a separate version-only pull request updating `package.json`,
   `package-lock.json`, the Claude plugin manifests, `src/version.ts`, and the
   generated skill writer.
3. From a clean checkout with Node.js 24, run `npm run release:check`.
4. Inspect `npm pack --json` and install the tarball in a temporary consumer.
5. Verify the tarball excludes credentials, `.git`, `.harness`, journals,
   temporary files, tests, and local artifact output.
6. Merge the version pull request after the required `release-gate` check.
7. Watch `tag / auto` create `vX.Y.Z` and dispatch `publish / release` and
   `release / github`.
8. Verify the new npm `latest` version, provenance, Git tag, and GitHub release.

`tag.yml` compares the merged package version with the previous `main` revision.
When the version changed, it pushes the matching tag and explicitly dispatches
the publishing and GitHub Release workflows. `publish_release.yml` verifies
that every release surface has the same version, runs the complete release
gate, and publishes from a GitHub-hosted runner using short-lived npm OIDC
credentials. The workflows hold no long-lived npm token.
