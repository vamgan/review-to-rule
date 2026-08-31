import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = new URL("..", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "review-to-rule-ci-bootstrap-"));
const run = (binary, args, options = {}) => {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  return result;
};
const expectStatus = (result, expected, label) => {
  if (result.status !== expected)
    throw new Error(
      `${label} exited ${result.status}: ${result.stderr || result.stdout}`,
    );
};

try {
  const packDirectory = join(temp, "pack");
  mkdirSync(packDirectory, { recursive: true });
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", packDirectory],
      { cwd: project, encoding: "utf8" },
    ),
  );
  const tarball = join(packDirectory, packed[0]?.filename ?? "missing.tgz");
  const prefix = join(temp, "global");
  const shimDirectory = join(temp, "registry-fixture-bin");
  mkdirSync(shimDirectory, { recursive: true });
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) throw new Error("npm_execpath is unavailable");
  const npmShim = join(shimDirectory, "npm");
  writeFileSync(
    npmShim,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const expected = ["install", "--global", "review-to-rule@0.1.0", "--ignore-scripts"];
const actual = process.argv.slice(2);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error("unexpected generated npm argv: " + JSON.stringify(actual));
  process.exit(97);
}
const installed = spawnSync(process.execPath, [${JSON.stringify(npmExecPath)}, "install", "--global", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", ${JSON.stringify(prefix)}, ${JSON.stringify(tarball)}], {stdio:"inherit"});
process.exit(installed.status ?? 98);
`,
  );
  chmodSync(npmShim, 0o755);
  const fixtureEnv = {
    ...process.env,
    PATH: `${shimDirectory}:${prefix}/bin:${process.env.PATH ?? ""}`,
  };

  // This argv is byte-for-byte the generated workflow bootstrap command. The
  // disposable resolver maps its exact pinned identity to this release tarball.
  expectStatus(
    run(
      "npm",
      ["install", "--global", "review-to-rule@0.1.0", "--ignore-scripts"],
      { cwd: temp, env: fixtureEnv },
    ),
    0,
    "exact generated npm install",
  );
  const installedBin = join(prefix, "bin", "review-to-rule");
  const repository = join(temp, "valid");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
  writeFileSync(
    join(repository, "clock.ts"),
    "export const now = Date.now();\n",
  );
  execFileSync("git", ["add", "clock.ts"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repository });
  expectStatus(
    run(
      installedBin,
      [
        "generate",
        "https://github.com/acme/clock/pull/42#discussion_r1001",
        "--fixture",
        "injected-clock",
        "--provider",
        "fake",
        "--repo-dir",
        repository,
        "--write",
        "--yes",
        "--policy-target",
        "neither",
        "--json",
      ],
      { cwd: repository, env: fixtureEnv },
    ),
    0,
    "packed artifact generation",
  );

  // These are the exact validate and Semgrep argv emitted by install-ci.
  expectStatus(
    run(
      installedBin,
      ["validate-all", ".review-to-rule", "--repo-dir", ".", "--json"],
      { cwd: repository, env: fixtureEnv },
    ),
    0,
    "exact generated validate-all",
  );
  expectStatus(
    run(
      "semgrep",
      [
        "scan",
        "--config",
        ".review-to-rule/rules",
        "--severity",
        "ERROR",
        "--error",
        ".",
      ],
      { cwd: repository, env: fixtureEnv },
    ),
    0,
    "exact generated Semgrep valid scan",
  );

  const invalid = join(temp, "invalid");
  cpSync(repository, invalid, { recursive: true });
  const manifestDirectory = join(invalid, ".review-to-rule/manifests");
  const manifestPath = join(
    manifestDirectory,
    readdirSync(manifestDirectory)[0],
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.ownedFiles.push("not-owned.txt");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  expectStatus(
    run(
      installedBin,
      ["validate-all", ".review-to-rule", "--repo-dir", ".", "--json"],
      { cwd: invalid, env: fixtureEnv },
    ),
    3,
    "exact generated validate-all invalid set",
  );

  for (const [severity, expected] of [
    ["INFO", 0],
    ["WARNING", 0],
    ["ERROR", 1],
  ]) {
    const matrix = join(temp, `severity-${severity.toLowerCase()}`);
    mkdirSync(join(matrix, ".review-to-rule/rules"), { recursive: true });
    writeFileSync(join(matrix, "target.ts"), "console.log('match');\n");
    writeFileSync(
      join(matrix, ".review-to-rule/rules/matrix.yml"),
      `rules:\n  - id: fixture.${severity.toLowerCase()}\n    message: matrix\n    severity: ${severity}\n    languages: [typescript]\n    pattern: console.log(...)\n`,
    );
    expectStatus(
      run(
        "semgrep",
        [
          "scan",
          "--config",
          ".review-to-rule/rules",
          "--severity",
          "ERROR",
          "--error",
          ".",
        ],
        { cwd: matrix, env: fixtureEnv },
      ),
      expected,
      `exact generated Semgrep ${severity} matrix`,
    );
  }
  console.log("resolvable packed CI bootstrap verified");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
