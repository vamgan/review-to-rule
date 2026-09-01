import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "review-to-rule-smoke-"));
try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--json",
        "--pack-destination",
        directory,
        "--cache",
        join(directory, "npm-cache"),
      ],
      { encoding: "utf8" },
    ),
  );
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack returned no filename");
  const tarball = join(directory, filename);
  const listing = execFileSync("tar", ["-tzf", tarball], {
    encoding: "utf8",
  });
  for (const required of [
    "package/dist/cli-v2.js",
    "package/.agents/skills/review-to-rule-write/SKILL.md",
    "package/.agents/skills/review-to-rule-write/references/review-bundle.md",
  ])
    if (!listing.includes(required))
      throw new Error(`packed artifact missing: ${required}`);
  const installDirectory = join(directory, "consumer");
  execFileSync(
    "npm",
    [
      "install",
      "--silent",
      "--ignore-scripts",
      "--prefix",
      installDirectory,
      "--cache",
      join(directory, "npm-cache"),
      tarball,
    ],
    { stdio: "ignore" },
  );
  const cli = join(
    installDirectory,
    "node_modules",
    "review-to-rule",
    "dist",
    "cli-v2.js",
  );
  if (!readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node"))
    throw new Error("built CLI has no shebang");
  for (const args of [
    ["--help"],
    ["--version"],
    ["apply", "--help"],
    ["doctor", "--help"],
    ["validate-all", "--help"],
  ])
    execFileSync(process.execPath, [cli, ...args], { stdio: "ignore" });
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const core = await import('review-to-rule/core'); if (typeof core.applyReviewMemoryBundle !== 'function') process.exit(1);",
    ],
    { cwd: installDirectory, stdio: "ignore" },
  );
  console.log("packed agent-memory CLI smoke test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
