import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyReviewMemoryBundle } from "../../src/memory-core.js";
import { ProcessCommandRunner } from "../../src/utils/command.js";
import { replayMemoryManifest } from "../../src/memory-replay.js";
import { validateAllMemory } from "../../src/memory-validation.js";
import { reviewBundle } from "./fixture.js";

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "review-to-rule-v2-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://gitlab.example.com/acme/app.git"],
    { cwd: root },
  );
  await writeFile(join(root, "README.md"), "# app\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("agent review-memory core", () => {
  it("produces a complete preview without mutating the repository", async () => {
    const root = await repository();
    const before = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    });
    const outcome = await applyReviewMemoryBundle(reviewBundle(), {
      repositoryDir: root,
      runner: new ProcessCommandRunner(),
      policyTarget: "agents",
      policyTargetExplicit: true,
      invocation: "review-to-rule apply bundle.json --policy-target agents",
    });
    expect(outcome).toMatchObject({
      exitCode: 0,
      result: {
        status: "success",
        writtenFiles: [],
        approval: { confirmed: false },
        preview: { policyTarget: "agents" },
      },
    });
    expect(outcome.result.plannedFiles.length).toBeGreaterThanOrEqual(4);
    await expect(access(join(root, ".review-to-rule"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(root, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }),
    ).toBe(before);
  });

  it("previews, writes, replays, and validates provider-neutral memory", async () => {
    const root = await repository();
    const options = {
      repositoryDir: root,
      runner: new ProcessCommandRunner(),
      write: true,
      yes: true,
      policyTarget: "both" as const,
      policyTargetExplicit: true,
      invocation: "review-to-rule apply bundle.json --policy-target both",
    };
    const outcome = await applyReviewMemoryBundle(reviewBundle(), options);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.status).toBe("success");
    expect(outcome.result.writtenFiles).toContain(
      ".review-to-rule/rules/review-to-rule.use-injected-clock.md",
    );
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
      ".review-to-rule/INDEX.md",
    );
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain(
      "Load only the Markdown rules",
    );
    const manifest =
      ".review-to-rule/manifests/review-to-rule.use-injected-clock.json";
    const replay = await replayMemoryManifest({
      repositoryDir: root,
      manifestPath: manifest,
    });
    expect(replay.status).toBe("success");
    const all = await validateAllMemory({
      repositoryDir: root,
      outputDir: ".review-to-rule",
    });
    expect(all).toMatchObject({ status: "success", errors: [] });
  });

  it("fails closed when stored rule bytes are changed", async () => {
    const root = await repository();
    await applyReviewMemoryBundle(reviewBundle(), {
      repositoryDir: root,
      runner: new ProcessCommandRunner(),
      write: true,
      yes: true,
      policyTarget: "neither",
      policyTargetExplicit: true,
      invocation: "review-to-rule apply bundle.json",
    });
    const rulePath = join(
      root,
      ".review-to-rule/rules/review-to-rule.use-injected-clock.md",
    );
    await writeFile(rulePath, "# tampered\n");
    await expect(
      replayMemoryManifest({
        repositoryDir: root,
        manifestPath:
          ".review-to-rule/manifests/review-to-rule.use-injected-clock.json",
      }),
    ).rejects.toThrow(/hash mismatch/i);
  });

  it("replaces the same source and suffixes an unrelated source collision", async () => {
    const root = await repository();
    const options = {
      repositoryDir: root,
      runner: new ProcessCommandRunner(),
      write: true,
      yes: true,
      policyTarget: "neither" as const,
      invocation: "review-to-rule apply bundle.json",
    };
    const first = await applyReviewMemoryBundle(reviewBundle(), options);
    expect(first.result.preview?.collision).toBe("new");

    const replacementBundle = reviewBundle();
    if (!replacementBundle.rule) throw new Error("fixture rule is missing");
    replacementBundle.rule = {
      ...replacementBundle.rule,
      title: "Use the injected clock for all retry scheduling",
    };
    const replacement = await applyReviewMemoryBundle(
      replacementBundle,
      options,
    );
    expect(replacement.result.preview?.collision).toBe("replace_same_source");

    const collisionBundle = reviewBundle();
    collisionBundle.source = {
      ...collisionBundle.source,
      url: "https://gitlab.example.com/acme/app/merge_requests/13#note_99",
      change: { ...collisionBundle.source.change, id: 13 },
    };
    collisionBundle.review = {
      ...collisionBundle.review,
      id: 99,
      root: { id: 99, body: collisionBundle.review.root.body },
      replies: [{ id: 100, body: "Fixed in the accepted revision." }],
    };
    const collision = await applyReviewMemoryBundle(collisionBundle, options);
    expect(collision.result.preview?.collision).toBe("suffixed");
    expect(collision.result.rule?.id).toBe(
      "review-to-rule.use-injected-clock-2",
    );
  });
});
