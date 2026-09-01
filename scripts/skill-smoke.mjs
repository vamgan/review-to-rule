import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "review-to-rule-skill-only-"));

try {
  const marketplace = JSON.parse(
    readFileSync(join(project, ".claude-plugin/marketplace.json"), "utf8"),
  );
  const pluginEntry = marketplace.plugins?.find(
    (entry) => entry.name === "review-to-rule",
  );
  if (
    marketplace.name !== "review-to-rule" ||
    pluginEntry?.source !== "./.agents/skills/review-to-rule-write"
  )
    throw new Error("Claude Code marketplace does not point at the skill");
  const pluginManifest = JSON.parse(
    readFileSync(
      join(
        project,
        ".agents/skills/review-to-rule-write/.claude-plugin/plugin.json",
      ),
      "utf8",
    ),
  );
  const packageVersion = JSON.parse(
    readFileSync(join(project, "package.json"), "utf8"),
  ).version;
  if (
    pluginManifest.name !== "review-to-rule" ||
    pluginManifest.version !== packageVersion ||
    pluginEntry.version !== packageVersion
  )
    throw new Error("Claude Code plugin namespace is invalid");

  const installedSkill = join(temp, "installed-skill");
  cpSync(join(project, ".agents/skills/review-to-rule-write"), installedSkill, {
    recursive: true,
  });
  const helper = join(installedSkill, "scripts/review-to-rule.mjs");
  if (!existsSync(helper)) throw new Error("installed skill has no helper");
  const shippedSurface = [
    readFileSync(join(installedSkill, "SKILL.md"), "utf8"),
    readFileSync(join(installedSkill, "references/review-bundle.md"), "utf8"),
    readFileSync(join(installedSkill, ".claude-plugin/plugin.json"), "utf8"),
    readFileSync(helper, "utf8"),
  ].join("\n");
  const normalizedSurface = shippedSurface.toLowerCase();
  for (const unrelatedDetail of [
    "self-contained",
    "npx review-to-rule",
    "gh auth login",
    "openai_api_key",
    "anthropic_api_key",
    "github-cli",
    "model-credential",
    "provider configuration",
    "global cli",
    "standalone",
  ])
    if (normalizedSurface.includes(unrelatedDetail))
      throw new Error(`installed skill leaks: ${unrelatedDetail}`);

  const helperHelp = execFileSync(process.execPath, [helper, "--help"], {
    encoding: "utf8",
  });
  for (const command of ["apply", "validate", "validate-all", "replay"])
    if (!helperHelp.includes(command))
      throw new Error(`installed skill is missing command: ${command}`);
  for (const unrelatedCommand of ["doctor", "generate", "install-ci"])
    if (helperHelp.includes(unrelatedCommand))
      throw new Error(`installed skill exposes command: ${unrelatedCommand}`);

  const repository = join(temp, "repository");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: repository,
  });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://gitlab.example.com/acme/app.git"],
    { cwd: repository },
  );
  writeFileSync(join(repository, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repository });

  const bundle = join(temp, "review-bundle.json");
  cpSync(
    join(project, "examples/review-bundle/gitlab-agent-memory.json"),
    bundle,
  );

  execFileSync(process.execPath, [helper, "--version"], { stdio: "ignore" });
  const preview = JSON.parse(
    execFileSync(
      process.execPath,
      [
        helper,
        "apply",
        bundle,
        "--repo-dir",
        repository,
        "--policy-target",
        "both",
        "--json",
      ],
      { encoding: "utf8" },
    ),
  );
  if (preview.status !== "success" || preview.writtenFiles.length !== 0)
    throw new Error("skill-only dry run did not remain non-mutating");

  const written = JSON.parse(
    execFileSync(
      process.execPath,
      [
        helper,
        "apply",
        bundle,
        "--repo-dir",
        repository,
        "--policy-target",
        "both",
        "--write",
        "--yes",
        "--json",
      ],
      { encoding: "utf8" },
    ),
  );
  if (written.status !== "success" || written.writtenFiles.length < 5)
    throw new Error("skill-only write did not create complete review memory");

  execFileSync(
    process.execPath,
    [helper, "validate-all", ".review-to-rule", "--repo-dir", repository],
    { stdio: "ignore" },
  );
  for (const instructionFile of ["AGENTS.md", "CLAUDE.md"])
    if (
      !readFileSync(join(repository, instructionFile), "utf8").includes(
        ".review-to-rule/INDEX.md",
      )
    )
      throw new Error(`${instructionFile} has no review-memory pointer`);

  console.log(
    "installed skill preview, write, and validation passed in isolation",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
