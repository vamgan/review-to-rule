import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "review-to-rule-smoke-"));
try {
  const packed = execFileSync(
    "npm",
    ["pack", "--silent", "--pack-destination", dir],
    { encoding: "utf8" },
  ).trim();
  const tgz = join(dir, packed.split("\n").at(-1));
  const listing = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" });
  if (!listing.includes("package/dist/cli.js"))
    throw new Error("packed CLI missing");
  if (!listing.includes("package/.agents/skills/review-to-rule-write/SKILL.md"))
    throw new Error("packed write skill missing");
  if (
    !listing.includes(
      "package/.agents/skills/review-to-rule-write/references/review-bundle.md",
    )
  )
    throw new Error("packed review-bundle skill reference missing");
  const installDir = join(dir, "installed-consumer");
  execFileSync(
    "npm",
    ["install", "--silent", "--ignore-scripts", "--prefix", installDir, tgz],
    { stdio: "ignore" },
  );
  const installedCli = join(
    installDir,
    "node_modules",
    "review-to-rule",
    "dist",
    "cli.js",
  );
  const cli = readFileSync(installedCli, "utf8");
  if (!cli.startsWith("#!/usr/bin/env node"))
    throw new Error("built CLI has no shebang");
  execFileSync(process.execPath, [installedCli, "--help"], {
    stdio: "ignore",
  });
  execFileSync(process.execPath, [installedCli, "--version"], {
    stdio: "ignore",
  });
  execFileSync(process.execPath, [installedCli, "replay", "--help"], {
    stdio: "ignore",
  });
  execFileSync(process.execPath, [installedCli, "evidence", "--help"], {
    stdio: "ignore",
  });
  execFileSync(process.execPath, [installedCli, "apply", "--help"], {
    stdio: "ignore",
  });
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const core = await import('review-to-rule/core'); if (typeof core.applyReviewLearningBundle !== 'function') process.exit(1);",
    ],
    { cwd: installDir, stdio: "ignore" },
  );
  const fixture = spawnSync(
    process.execPath,
    [
      installedCli,
      "generate",
      "https://github.com/acme/clock/pull/42#discussion_r1009",
      "--fixture",
      "subjective-style",
      "--json",
    ],
    { encoding: "utf8" },
  );
  const result = JSON.parse(fixture.stdout);
  if (
    fixture.status !== 2 ||
    result.schemaVersion !== 1 ||
    result.status !== "refused"
  )
    throw new Error("installed packed fixture path failed");
  console.log("packed CLI smoke test passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
