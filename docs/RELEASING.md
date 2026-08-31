# Manual release guide

Releases are deliberate and never triggered automatically by CI.

1. Start from a clean clone of the intended tag commit.
2. Install Node.js 24 and Semgrep 1.175.0.
3. Run the single gate: `PATH="$PWD/.venv/bin:$PATH" npm run release:check`.
4. Inspect `npm pack --json` and install that tarball in a temporary consumer.
5. Exercise the installed bin: dry run and every policy target, write, replay,
   validate by rule and manifest, validate-all, scan, doctor, install-ci, the
   checked-in skill, and the offline fake-gh/fake-git open-PR journey.
6. Verify the tarball excludes credentials, `.git`, `.harness`, journals,
   temporary files, tests, and local artifact output.
7. Create a signed tag and publish manually only after human approval.

CI has read-only repository permission and validates release inputs; it does not
hold an npm publishing token or create releases.
