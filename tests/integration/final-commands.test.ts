import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/doctor.js";
import {
  CI_WORKFLOW,
  CI_WORKFLOW_PATH,
  installCi,
  planCiInstall,
} from "../../src/install-ci.js";
import { generate } from "../../src/pipeline.js";
import {
  validateAllArtifacts,
  validateArtifact,
} from "../../src/validation.js";
import { FakeProvider } from "../../src/llm/provider.js";
import {
  ProcessCommandRunner,
  type CommandResult,
  type CommandRunner,
} from "../../src/utils/command.js";
import { openPullRequest } from "../../src/open-pr.js";
import {
  preflightDebugBundle,
  writeDebugBundle,
} from "../../src/debug-bundle.js";
import {
  semgrepAvailable,
  semgrepSkipReason,
} from "../semgrep-availability.js";

class HealthyRunner implements CommandRunner {
  run(
    binary: "git" | "gh" | "semgrep",
    args: readonly string[],
  ): Promise<CommandResult> {
    if (binary === "gh" && args[0] === "auth")
      return Promise.resolve({
        exitCode: 0,
        stdout: "authenticated",
        stderr: "",
      });
    if (binary === "git" && args[0] === "rev-parse")
      return Promise.resolve({ exitCode: 0, stdout: "/repo\n", stderr: "" });
    return Promise.resolve({
      exitCode: 0,
      stdout: `${binary} 1.0`,
      stderr: "",
    });
  }
}

class OfflinePublishRunner implements CommandRunner {
  readonly calls: Array<{ binary: string; args: readonly string[] }> = [];
  private readonly process = new ProcessCommandRunner();
  async run(
    binary: "git" | "gh" | "semgrep",
    args: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<CommandResult> {
    this.calls.push({ binary, args: [...args] });
    if (binary === "semgrep") {
      if (args.includes("--validate"))
        return { exitCode: 0, stdout: "", stderr: "" };
      const target = args.at(-1) ?? "";
      const file = join(target, "src/token.ts");
      const content = await readFile(file, "utf8").catch(() => "");
      const results = content.includes("Date.now()")
        ? [
            {
              path: file,
              start: { line: 2 },
              end: { line: 2 },
              extra: { lines: "return Date.now();", message: "Inject Clock" },
            },
          ]
        : [];
      return {
        exitCode: results.length ? 1 : 0,
        stdout: JSON.stringify({ results, errors: [] }),
        stderr: "",
      };
    }
    if (binary === "gh")
      return {
        exitCode: 0,
        stdout:
          args[1] === "list"
            ? "[]\n"
            : "https://github.com/acme/clock/pull/99\n",
        stderr: "",
      };
    return this.process.run(binary, args, options);
  }
}

class FailingGitHubPreflightRunner extends OfflinePublishRunner {
  constructor(private readonly mode: "auth" | "malformed") {
    super();
  }

  override async run(
    binary: "git" | "gh" | "semgrep",
    args: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<CommandResult> {
    if (binary === "gh" && args[0] === "pr" && args[1] === "list") {
      this.calls.push({ binary, args: [...args] });
      return this.mode === "auth"
        ? { exitCode: 1, stdout: "", stderr: "authentication required" }
        : { exitCode: 0, stdout: "not-json", stderr: "" };
    }
    return super.run(binary, args, options);
  }
}

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), "rtr-final-"));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: directory,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  await writeFile(join(directory, "README.md"), "target\n");
  execFileSync("git", ["add", "README.md"], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: directory });
  return directory;
}

describe("final public operations", () => {
  it("keeps agent doctor independent from GitHub and model credentials", async () => {
    const result = await runDoctor({
      runner: new HealthyRunner(),
      cwd: process.cwd(),
      env: {
        OPENAI_API_KEY: "present",
        ANTHROPIC_API_KEY: "also-present",
        REVIEW_TO_RULE_MODEL: "   ",
      },
      mode: "agent",
    });
    expect(result.status).toBe("success");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "gh", status: "skip" }),
        expect.objectContaining({ name: "github-auth", status: "skip" }),
        expect.objectContaining({
          name: "provider-credential",
          status: "skip",
        }),
      ]),
    );
  });

  it("diagnoses prerequisites with stable statuses without credentials", async () => {
    const result = await runDoctor({
      runner: new HealthyRunner(),
      cwd: process.cwd(),
      env: {},
      config: { fixture: "injected-clock" },
    });
    expect(result.status).toBe("success");
    expect(result.checks.map((check) => check.status)).toContain("skip");
    expect(
      result.checks.every((check) =>
        ["pass", "warn", "fail", "skip"].includes(check.status),
      ),
    ).toBe(true);
  });

  it("previews and atomically installs CI without overwriting a conflict", async () => {
    const repo = await repository();
    expect((await planCiInstall(repo)).written).toBe(false);
    expect((await installCi(repo)).written).toBe(true);
    expect(await readFile(join(repo, CI_WORKFLOW_PATH), "utf8")).toBe(
      CI_WORKFLOW,
    );
    expect((await installCi(repo)).action).toBe("unchanged");
    await writeFile(join(repo, CI_WORKFLOW_PATH), "name: user-owned\n");
    await expect(installCi(repo)).rejects.toThrow(/refusing to overwrite/i);
  });

  it("refuses a tracked deletion and preserves the user's CI overlap", async () => {
    const repo = await repository();
    await installCi(repo);
    execFileSync("git", ["add", CI_WORKFLOW_PATH], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "track workflow"], { cwd: repo });
    execFileSync("git", ["rm", "-q", CI_WORKFLOW_PATH], { cwd: repo });
    await expect(planCiInstall(repo)).rejects.toThrow(/tracked Git changes/i);
    expect(
      execFileSync(
        "git",
        ["status", "--porcelain=v1", "--", CI_WORKFLOW_PATH],
        { cwd: repo, encoding: "utf8" },
      ),
    ).toContain("D ");
  });

  it("writes only a contained sanitized debug bundle without overwrite", async () => {
    const repo = await repository();
    await writeDebugBundle(repo, "diagnostics/report.json", "doctor");
    const text = await readFile(join(repo, "diagnostics/report.json"), "utf8");
    expect(text).toContain('"status": "sanitized"');
    expect(text).not.toMatch(/OPENAI_API_KEY|Authorization:|\/Users\//);
    await expect(
      preflightDebugBundle(repo, "diagnostics/report.json"),
    ).rejects.toThrow(/overwrite/i);
    await expect(
      preflightDebugBundle(repo, "../escape.json"),
    ).rejects.toThrow();
  });

  it("refuses a symlinked CI target", async () => {
    const repo = await repository();
    const outside = join(
      await mkdtemp(join(tmpdir(), "rtr-ci-outside-")),
      "workflow.yml",
    );
    await writeFile(outside, "sentinel\n");
    execFileSync("mkdir", ["-p", join(repo, ".github/workflows")]);
    await symlink(outside, join(repo, CI_WORKFLOW_PATH));
    await expect(planCiInstall(repo)).rejects.toThrow(/symlink/i);
    expect(await readFile(outside, "utf8")).toBe("sentinel\n");
  });

  it.skipIf(!semgrepAvailable)(
    semgrepAvailable
      ? "enforces only ERROR-level findings with the generated CI scan argv"
      : semgrepSkipReason,
    async () => {
      const repo = await repository();
      await writeFile(join(repo, "target.ts"), "console.log('match');\n");
      const runner = new ProcessCommandRunner();
      for (const [severity, expected] of [
        ["INFO", 0],
        ["WARNING", 0],
        ["ERROR", 1],
      ] as const) {
        const rule = join(repo, `${severity.toLowerCase()}.yml`);
        await writeFile(
          rule,
          `rules:\n  - id: test.${severity.toLowerCase()}\n    message: test\n    severity: ${severity}\n    languages: [typescript]\n    pattern: console.log(...)\n`,
        );
        const result = await runner.run(
          "semgrep",
          ["scan", "--config", rule, "--severity", "ERROR", "--error", repo],
          { cwd: repo },
        );
        expect(result.exitCode, severity).toBe(expected);
      }
      expect(CI_WORKFLOW).toContain("--severity ERROR --error");
      expect(CI_WORKFLOW).toContain("review-to-rule@0.2.0");
      expect(CI_WORKFLOW).not.toMatch(/OPENAI|ANTHROPIC|GH_TOKEN|secrets\./);
    },
    180_000,
  );

  it.each(["auth", "malformed"] as const)(
    "preserves the completed PR plan for a %s GitHub preflight failure without cloning",
    async (mode) => {
      const repo = await repository();
      const bare = await mkdtemp(join(tmpdir(), "rtr-remote-"));
      execFileSync("git", ["init", "--bare", "-q"], { cwd: bare });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repo });
      execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo });
      execFileSync("git", ["push", "-q", "-u", "origin", "main"], {
        cwd: repo,
      });
      const runner = new FailingGitHubPreflightRunner(mode);
      const outcome = await openPullRequest({
        reviewUrl: "https://github.com/acme/clock/pull/42#discussion_r1001",
        sourceRepositoryDir: repo,
        runner,
        generateOptions: {
          fixture: "injected-clock",
          provider: new FakeProvider(),
          runner,
          policyTarget: "neither",
          policyTargetExplicit: true,
        },
        branchPrefix: "review-to-rule/",
        labels: [],
        approved: true,
      });
      expect(outcome.exitCode).toBe(4);
      expect(outcome.result).toMatchObject({
        status: "dependency_failed",
        pullRequestPlan: outcome.plan,
        errors: [{ kind: "dependency_failed" }],
      });
      expect(outcome.result.errors[0]?.remediation).toMatch(/gh|GitHub/i);
      expect(
        runner.calls.some(
          (call) => call.binary === "git" && call.args.includes("clone"),
        ),
      ).toBe(false);
    },
    60_000,
  );

  it.skipIf(!semgrepAvailable)(
    semgrepAvailable
      ? "validates by rule and manifest and aggregates orphan rules"
      : semgrepSkipReason,
    async () => {
      const repo = await repository();
      const generated = await generate(
        "https://github.com/acme/clock/pull/42#discussion_r1001",
        {
          fixture: "injected-clock",
          repositoryDir: repo,
          provider: new FakeProvider(),
          runner: new ProcessCommandRunner(),
          write: true,
          yes: true,
          policyTarget: "neither",
          policyTargetExplicit: true,
        },
      );
      expect(generated.exitCode).toBe(0);
      const manifest = generated.result.writtenFiles.find((path) =>
        path.includes("/manifests/"),
      );
      const rule = generated.result.writtenFiles.find((path) =>
        path.endsWith(".yml"),
      );
      expect(manifest).toBeTruthy();
      expect(rule).toBeTruthy();
      if (!manifest || !rule) throw new Error("generated paths missing");
      expect(
        (
          await validateArtifact({
            repositoryDir: repo,
            inputPath: manifest,
            runner: new ProcessCommandRunner(),
          })
        ).status,
      ).toBe("success");
      expect(
        (
          await validateArtifact({
            repositoryDir: repo,
            inputPath: rule,
            runner: new ProcessCommandRunner(),
          })
        ).status,
      ).toBe("success");
      await writeFile(
        join(repo, ".review-to-rule/rules/orphan.yml"),
        "rules: []\n",
      );
      const aggregate = await validateAllArtifacts({
        repositoryDir: repo,
        outputDir: ".review-to-rule",
        runner: new ProcessCommandRunner(),
      });
      expect(aggregate.status).toBe("validation_failed");
      expect(aggregate.unownedRules).toEqual([
        ".review-to-rule/rules/orphan.yml",
      ]);
    },
    180_000,
  );

  it.skipIf(!semgrepAvailable)(
    semgrepAvailable
      ? "publishes only from an isolated clone with fixed argv and leaves a dirty source untouched"
      : semgrepSkipReason,
    async () => {
      const repo = await repository();
      const bare = await mkdtemp(join(tmpdir(), "rtr-remote-"));
      execFileSync("git", ["init", "--bare", "-q"], { cwd: bare });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repo });
      execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo });
      execFileSync("git", ["push", "-q", "-u", "origin", "main"], {
        cwd: repo,
      });
      execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
        cwd: bare,
      });
      await writeFile(join(repo, "DIRTY.txt"), "user bytes\n");
      const before = execFileSync("git", ["status", "--porcelain=v1"], {
        cwd: repo,
        encoding: "utf8",
      });
      const runner = new OfflinePublishRunner();
      const result = await openPullRequest({
        reviewUrl: "https://github.com/acme/clock/pull/42#discussion_r1001",
        sourceRepositoryDir: repo,
        runner,
        generateOptions: {
          fixture: "injected-clock",
          provider: new FakeProvider(),
          runner,
          policyTarget: "neither",
          policyTargetExplicit: true,
        },
        branchPrefix: "review-to-rule/",
        labels: ["semgrep"],
        approved: true,
      });
      expect(result.result.pullRequest).toBe(
        "https://github.com/acme/clock/pull/99",
      );
      expect(result.plan.body).toContain("Reviewer intent");
      expect(result.plan.body).toContain("Bounded correction");
      expect(result.plan.body).toContain("Validation");
      expect(result.plan.body).toContain("Current matches");
      expect(result.plan.body).toContain("Limitations");
      expect(result.plan.body).toContain("Provenance");
      expect(result.plan.body).toContain("human review required");
      expect(result.result.pullRequestPlan).toEqual(result.plan);
      expect(
        execFileSync("git", ["status", "--porcelain=v1"], {
          cwd: repo,
          encoding: "utf8",
        }),
      ).toBe(before);
      expect(await readFile(join(repo, "DIRTY.txt"), "utf8")).toBe(
        "user bytes\n",
      );
      const gh = runner.calls.find(
        (call) => call.binary === "gh" && call.args[1] === "create",
      );
      expect(gh?.args.slice(0, 2)).toEqual(["pr", "create"]);
      expect(
        runner.calls.some(
          (call) => call.binary === "gh" && call.args.includes("merge"),
        ),
      ).toBe(false);
      expect(
        runner.calls.some(
          (call) =>
            call.binary === "git" &&
            call.args.some((arg) => arg.includes("force")),
        ),
      ).toBe(false);
    },
    90_000,
  );
});
