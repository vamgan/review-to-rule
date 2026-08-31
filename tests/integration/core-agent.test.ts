import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyReviewLearningBundle } from "../../src/core.js";
import { loadReviewLearningBundle } from "../../src/review-bundle.js";
import {
  ProcessCommandRunner,
  type CommandResult,
  type CommandRunner,
} from "../../src/utils/command.js";

const examplePath = new URL(
  "../../examples/review-bundle/gitlab-tenant-scope.json",
  import.meta.url,
).pathname;

class DeterministicSemgrepRunner implements CommandRunner {
  private readonly process = new ProcessCommandRunner();

  async run(
    binary: "git" | "gh" | "semgrep",
    args: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<CommandResult> {
    if (binary !== "semgrep") return this.process.run(binary, args, options);
    if (args.includes("--validate"))
      return { exitCode: 0, stdout: "", stderr: "" };
    const target = args.at(-1);
    if (!target) throw new Error("missing deterministic scan target");
    const targetState = await stat(target);
    const file = targetState.isFile()
      ? target
      : join(target, "src/invoices.ts");
    const content = await readFile(file, "utf8").catch(() => "");
    const matches = content.includes(".invoice.findMany()")
      ? [
          {
            path: file,
            start: { line: 1 },
            end: { line: 1 },
            extra: {
              lines: content.split("\n")[0],
              message: "Invoice queries must include tenant scope.",
            },
          },
        ]
      : [];
    return {
      exitCode: matches.length ? 1 : 0,
      stdout: JSON.stringify({ results: matches, errors: [] }),
      stderr: "",
    };
  }
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rtr-agent-core-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/invoices.ts"),
    "const invoices = db.invoice.findMany({ where: { tenantId } });\n",
  );
  await writeFile(join(root, "AGENTS.md"), "# Repository guidance\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "src/invoices.ts", "AGENTS.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "accepted correction"], {
    cwd: root,
  });
  return root;
}

describe("provider-neutral agent core", () => {
  it("refuses evidence from a different repository origin", async () => {
    const root = await repository();
    execFileSync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://gitlab.corp.example/other/project.git",
      ],
      { cwd: root },
    );
    const outcome = await applyReviewLearningBundle(
      await loadReviewLearningBundle(examplePath),
      {
        repositoryDir: root,
        runner: new DeterministicSemgrepRunner(),
        invocation: "review-to-rule apply '<temporary-bundle>'",
      },
    );
    expect(outcome.exitCode).toBe(5);
    expect(outcome.result.errors[0]?.message).toMatch(/identity mismatch/i);
  });

  it("validates, discovers policy, previews, and writes without a provider", async () => {
    const root = await repository();
    const bundle = await loadReviewLearningBundle(examplePath);
    const runner = new DeterministicSemgrepRunner();

    const preview = await applyReviewLearningBundle(bundle, {
      repositoryDir: root,
      repositorySource: "agent_explicit",
      runner,
      invocation: "review-to-rule apply '<temporary-bundle>'",
    });
    expect(preview.exitCode).toBe(0);
    expect(preview.result.provider).toEqual({
      name: "bundle",
      model: "precomputed",
    });
    expect(preview.result.source?.source?.reviewSystem).toBe("gitlab");
    expect(preview.result.preview?.discovery.policyFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "AGENTS.md", kind: "agents" }),
      ]),
    );
    await expect(stat(join(root, ".review-to-rule"))).rejects.toThrow();

    const written = await applyReviewLearningBundle(bundle, {
      repositoryDir: root,
      repositorySource: "agent_explicit",
      runner,
      invocation: "review-to-rule apply '<temporary-bundle>'",
      policyTarget: "agents",
      policyTargetExplicit: true,
      agentsPath: "AGENTS.md",
      agentsPathExplicit: true,
      write: true,
      yes: true,
    });
    expect(written.exitCode).toBe(0);
    expect(written.result.writtenFiles).toContain("AGENTS.md");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
      "review-to-rule:managed:start",
    );
    const evidencePath = written.result.writtenFiles.find((path) =>
      path.includes("/evidence/"),
    );
    expect(evidencePath).toBeDefined();
    const evidence = JSON.parse(
      await readFile(join(root, evidencePath ?? "missing"), "utf8"),
    ) as { source?: { reviewSystem?: string; url?: string } };
    expect(evidence.source?.reviewSystem).toBe("gitlab");
    expect(evidence.source?.url).toContain("gitlab.corp.example");
  });
});
