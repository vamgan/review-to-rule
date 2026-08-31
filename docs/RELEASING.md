# Release guide

Releases are deliberate. A GitHub release is the only event that can start the
npm publishing workflow.

## One-time bootstrap

1. Publish the first version manually from a clean, verified checkout.
2. Configure the npm trusted publisher for `vamgan/review-to-rule`:
   - provider: GitHub Actions
   - repository: `vamgan/review-to-rule`
   - workflow: `publish.yml`
   - allowed action: `npm publish`
3. Verify the trust relationship with `npm trust list review-to-rule`.
4. Revoke the bootstrap publishing token. CI must not contain an npm token.

## Publish a version

1. Update `package.json` and `package-lock.json` in a dedicated version commit.
2. From a clean checkout, install Node.js 24 and Semgrep 1.175.0.
3. Run `PATH="$PWD/.venv/bin:$PATH" npm run release:check`.
4. Inspect `npm pack --json` and install the tarball in a temporary consumer.
5. Verify the tarball excludes credentials, `.git`, `.harness`, journals,
   temporary files, tests, and local artifact output.
6. Merge the version pull request after the required `release-gate` check.
7. Create a signed `vX.Y.Z` tag and a GitHub release from that exact commit.
8. Watch the `Publish` workflow and verify the npm version and provenance.

The workflow checks that the release tag equals `v` plus the package version,
runs the complete release gate, and publishes from a GitHub-hosted runner using
short-lived npm OIDC credentials. It has read-only repository access plus the
minimum `id-token: write` permission; it holds no long-lived npm token.
