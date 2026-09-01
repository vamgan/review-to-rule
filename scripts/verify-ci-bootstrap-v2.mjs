import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = new URL("..", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "review-to-rule-ci-bootstrap-"));
try {
  const repository = join(temp, "repository");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://gitlab.example.com/acme/app.git"],
    { cwd: repository },
  );
  writeFileSync(join(repository, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repository });
  const bundle = join(temp, "bundle.json");
  cpSync(
    join(project, "examples/review-bundle/gitlab-agent-memory.json"),
    bundle,
  );
  const cli = join(project, "dist/cli-v2.js");
  const applied = spawnSync(
    process.execPath,
    [
      cli,
      "apply",
      bundle,
      "--repo-dir",
      repository,
      "--policy-target",
      "agents",
      "--write",
      "--yes",
      "--json",
    ],
    { encoding: "utf8" },
  );
  if (applied.status !== 0)
    throw new Error(`packed apply failed: ${applied.stderr || applied.stdout}`);
  const validated = spawnSync(
    process.execPath,
    [
      cli,
      "validate-all",
      ".review-to-rule",
      "--repo-dir",
      repository,
      "--json",
    ],
    { encoding: "utf8" },
  );
  if (validated.status !== 0)
    throw new Error(
      `generated integrity validation failed: ${validated.stderr || validated.stdout}`,
    );
  const rulePath = join(
    repository,
    ".review-to-rule/rules/review-to-rule.use-injected-clock.md",
  );
  writeFileSync(rulePath, `${readFileSync(rulePath, "utf8")}\nchanged\n`);
  const invalid = spawnSync(
    process.execPath,
    [
      cli,
      "validate-all",
      ".review-to-rule",
      "--repo-dir",
      repository,
      "--json",
    ],
    { encoding: "utf8" },
  );
  if (invalid.status !== 3)
    throw new Error("tampered review memory did not fail validation");
  console.log("generated review-memory CI command verified");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
