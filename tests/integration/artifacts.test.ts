import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitArtifactPlan, planArtifacts } from "../../src/artifacts.js";
import {
  proposalSchema,
  reviewEvidenceSchema,
} from "../../src/domain/schemas.js";
import { ProcessCommandRunner } from "../../src/utils/command.js";
import { planManagedPolicyUpdate } from "../../src/policy.js";
import { canonicalReviewSourceIdentity } from "../../src/source.js";

const proposal = proposalSchema.parse({
  id: "review-to-rule.inject-clock",
  title: "Inject Clock",
  message: "Inject Clock",
  language: "typescript",
  severity: "WARNING",
  include: ["src/a.ts"],
  exclude: [],
  rationale: "static API call",
  limitations: [],
  confidence: 0.95,
  yaml: "rules:\n  - id: review-to-rule.inject-clock\n    message: Inject Clock\n    severity: WARNING\n    languages: [typescript]\n    pattern: Date.now()\n",
});
const evidence = reviewEvidenceSchema.parse({
  schemaVersion: 1,
  repository: { owner: "acme", name: "repo" },
  pullRequest: { number: 1, headSha: "head", baseSha: "base" },
  review: { commentId: 2, body: "Inject Clock", resolved: true, merged: true },
  threadRoot: { id: 2, body: "Inject Clock" },
  replies: [],
  original: {
    path: "src/a.ts",
    sha: "base",
    source: "historical_content",
    excerpt: "Date.now()",
    truncated: false,
  },
  final: {
    path: "src/a.ts",
    sha: "head",
    source: "historical_content",
    excerpt: "clock.now()",
    truncated: false,
  },
  provenance: ["test"],
  warnings: [],
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rtr-artifacts-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "clean\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("transactional artifact persistence", () => {
  it("plans artifacts from a provider-neutral enterprise review URL", async () => {
    const root = await repository();
    const sourceUrl =
      "https://gitlab.corp.example/acme/repo/-/merge_requests/1#note_2";
    const agentEvidence = reviewEvidenceSchema.parse({
      ...evidence,
      source: { reviewSystem: "gitlab", url: sourceUrl },
      repository: {
        host: "gitlab.corp.example",
        owner: "acme",
        name: "repo",
      },
    });
    const plan = await planArtifacts({
      repositoryDir: root,
      outputDir: ".review-to-rule",
      sourceUrl,
      sourceIdentity: canonicalReviewSourceIdentity(sourceUrl),
      proposal,
      evidence: agentEvidence,
      before: "Date.now()\n",
      after: "clock.now()\n",
      approvalMode: "yes",
      policyTarget: "neither",
    });
    expect(plan.collision).toBe("new");
    expect(plan.files.map((file) => file.path)).toContain(
      ".review-to-rule/rules/review-to-rule.inject-clock.yml",
    );
  });

  it("writes the complete versioned set and records hashes", async () => {
    const root = await repository();
    const plan = await planArtifacts({
      repositoryDir: root,
      outputDir: ".review-to-rule",
      sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
      sourceIdentity: "github.com/acme/repo#2",
      proposal,
      evidence,
      before: "Date.now()\n",
      after: "clock.now()\n",
      allowed: "other.now()\n",
      approvalMode: "yes",
      policyTarget: "neither",
    });
    const written = await commitArtifactPlan({
      repositoryDir: root,
      plan,
      runner: new ProcessCommandRunner(),
    });
    expect(written).toHaveLength(6);
    const manifest = JSON.parse(
      await readFile(join(root, plan.manifestPath), "utf8"),
    ) as { schemaVersion: number; writtenFiles: unknown[] };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.writtenFiles).toHaveLength(5);
    const rerun = await planArtifacts({
      repositoryDir: root,
      outputDir: ".review-to-rule",
      sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
      sourceIdentity: "github.com/acme/repo#2",
      proposal,
      evidence,
      before: "Date.now()\n",
      after: "clock.now()\n",
      allowed: "other.now()\n",
      approvalMode: "yes",
      policyTarget: "neither",
    });
    await expect(
      commitArtifactPlan({
        repositoryDir: root,
        plan: rerun,
        runner: new ProcessCommandRunner(),
      }),
    ).resolves.toEqual(written);
  });

  it("rolls every committed file back after an injected failure", async () => {
    const root = await repository();
    const plan = await planArtifacts({
      repositoryDir: root,
      outputDir: "generated/rules",
      sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
      sourceIdentity: "github.com/acme/repo#2",
      proposal,
      evidence,
      before: "Date.now()\n",
      after: "clock.now()\n",
      approvalMode: "interactive",
      policyTarget: "neither",
    });
    await expect(
      commitArtifactPlan({
        repositoryDir: root,
        plan,
        runner: new ProcessCommandRunner(),
        beforeCommit: (index) =>
          index === 2
            ? Promise.reject(new Error("injected"))
            : Promise.resolve(),
      }),
    ).rejects.toThrow(/rolled back/i);
    expect(existsSync(join(root, plan.files[0]?.path ?? "missing"))).toBe(
      false,
    );
  });

  it("uses a deterministic suffix when the same rule id has another source", async () => {
    const root = await repository();
    const first = await planArtifacts({
      repositoryDir: root,
      outputDir: ".review-to-rule",
      sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
      sourceIdentity: "github.com/acme/repo#2",
      proposal,
      evidence,
      before: "a",
      after: "b",
      approvalMode: "yes",
      policyTarget: "neither",
    });
    await commitArtifactPlan({
      repositoryDir: root,
      plan: first,
      runner: new ProcessCommandRunner(),
    });
    execFileSync("git", ["add", ".review-to-rule"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "generated"], { cwd: root });
    const rerun = await planArtifacts({
      repositoryDir: root,
      outputDir: ".review-to-rule",
      sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
      sourceIdentity: "github.com/acme/repo#2",
      proposal,
      evidence,
      before: "a",
      after: "b",
      approvalMode: "yes",
      policyTarget: "neither",
    });
    expect(rerun.collision).toBe("replace_same_source");
    expect(rerun.ruleId).toBe("review-to-rule.inject-clock");
    const second = await planArtifacts({
      repositoryDir: root,
      outputDir: ".review-to-rule",
      sourceUrl: "https://github.com/acme/repo/pull/2#discussion_r3",
      sourceIdentity: "github.com/acme/repo#3",
      proposal,
      evidence,
      before: "a",
      after: "b",
      approvalMode: "yes",
      policyTarget: "neither",
    });
    expect(second.collision).toBe("suffixed");
    expect(second.ruleId).toBe("review-to-rule.inject-clock-2");
  });

  it("rejects traversal and symlinked output roots", async () => {
    const root = await repository();
    await expect(
      planArtifacts({
        repositoryDir: root,
        outputDir: "../outside",
        sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
        sourceIdentity: "github.com/acme/repo#2",
        proposal,
        evidence,
        before: "a",
        after: "b",
        approvalMode: "yes",
        policyTarget: "neither",
      }),
    ).rejects.toThrow(/unsafe/i);
    const outside = await mkdtemp(join(tmpdir(), "rtr-outside-"));
    await symlink(outside, join(root, ".review-to-rule"));
    await expect(
      planArtifacts({
        repositoryDir: root,
        outputDir: ".review-to-rule",
        sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
        sourceIdentity: "github.com/acme/repo#2",
        proposal,
        evidence,
        before: "a",
        after: "b",
        approvalMode: "yes",
        policyTarget: "neither",
      }),
    ).rejects.toThrow(/symlink/i);
  });

  it("rolls artifacts back when a selected policy write fails", async () => {
    const root = await repository();
    await writeFile(join(root, "AGENTS.md"), "# Existing policy\n");
    execFileSync("git", ["add", "AGENTS.md"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "policy"], { cwd: root });
    const policy = await planManagedPolicyUpdate(
      root,
      "AGENTS.md",
      ".review-to-rule/manifests/review-to-rule.inject-clock.json",
    );
    const plan = await planArtifacts({
      repositoryDir: root,
      outputDir: ".review-to-rule",
      sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
      sourceIdentity: "github.com/acme/repo#2",
      proposal,
      evidence,
      before: "a",
      after: "b",
      approvalMode: "yes",
      policyTarget: "agents",
      policyExplicit: true,
      policyUpdates: [policy],
    });
    await expect(
      commitArtifactPlan({
        repositoryDir: root,
        plan,
        runner: new ProcessCommandRunner(),
        expectedPolicyHashes: new Map([[policy.path, policy.previousHash]]),
        beforeCommit: (index) =>
          index === plan.files.length - 1
            ? Promise.reject(new Error("policy unavailable"))
            : Promise.resolve(),
      }),
    ).rejects.toThrow(/rolled back/i);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
      "# Existing policy\n",
    );
    expect(existsSync(join(root, plan.files[0]?.path ?? "missing"))).toBe(
      false,
    );
  });

  it("restores every original for failures at every transaction phase and target", async () => {
    for (const phase of [
      "before_backup",
      "after_backup",
      "during_replace",
      "cleanup",
    ] as const) {
      for (let failureIndex = 0; failureIndex < 6; failureIndex++) {
        const root = await repository();
        const originalPolicy = "# Existing policy\n";
        await writeFile(join(root, "AGENTS.md"), originalPolicy);
        execFileSync("git", ["add", "AGENTS.md"], { cwd: root });
        execFileSync("git", ["commit", "-qm", "policy"], { cwd: root });
        const policy = await planManagedPolicyUpdate(
          root,
          "AGENTS.md",
          ".review-to-rule/manifests/review-to-rule.inject-clock.json",
        );
        const plan = await planArtifacts({
          repositoryDir: root,
          outputDir: ".review-to-rule",
          sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
          sourceIdentity: "github.com/acme/repo#2",
          proposal,
          evidence,
          before: "a",
          after: "b",
          approvalMode: "yes",
          policyTarget: "agents",
          policyExplicit: true,
          policyPaths: ["AGENTS.md"],
          policyUpdates: [policy],
        });
        expect(plan.files).toHaveLength(6);
        await expect(
          commitArtifactPlan({
            repositoryDir: root,
            plan,
            runner: new ProcessCommandRunner(),
            expectedPolicyHashes: new Map([[policy.path, policy.previousHash]]),
            inject: (event) =>
              event.phase === phase && event.index === failureIndex
                ? Promise.reject(new Error(`${phase}:${failureIndex}`))
                : Promise.resolve(),
          }),
        ).rejects.toThrow(
          /rolled back|after_backup|during_replace|cleanup|before_backup/i,
        );
        expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
          originalPolicy,
        );
        for (const file of plan.files.filter(
          (file) => file.kind === "artifact",
        ))
          expect(existsSync(join(root, file.path))).toBe(false);
        const outputEntries = existsSync(join(root, ".review-to-rule"))
          ? await readdir(join(root, ".review-to-rule"))
          : [];
        expect(
          outputEntries.some((name) => name.startsWith(".transaction-")),
        ).toBe(false);
      }
    }
  }, 30_000);

  it("never treats an unmanaged identical target or incomplete manifest as owned", async () => {
    const root = await repository();
    const unmanaged = join(
      root,
      ".review-to-rule/rules/review-to-rule.inject-clock.yml",
    );
    await mkdir(join(root, ".review-to-rule/rules"), { recursive: true });
    await writeFile(unmanaged, proposal.yaml, { flag: "wx" });
    const initial = await planArtifacts({
      repositoryDir: root,
      outputDir: ".review-to-rule",
      sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
      sourceIdentity: "github.com/acme/repo#2",
      proposal,
      evidence,
      before: "a",
      after: "b",
      approvalMode: "yes",
      policyTarget: "neither",
    });
    expect(initial.ruleId).toBe("review-to-rule.inject-clock-2");
    await commitArtifactPlan({
      repositoryDir: root,
      plan: initial,
      runner: new ProcessCommandRunner(),
    });
    await writeFile(join(root, initial.manifestPath), '{"schemaVersion":1}\n');
    const replanned = await planArtifacts({
      repositoryDir: root,
      outputDir: ".review-to-rule",
      sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
      sourceIdentity: "github.com/acme/repo#2",
      proposal,
      evidence,
      before: "a",
      after: "b",
      approvalMode: "yes",
      policyTarget: "neither",
    });
    expect(replanned.collision).toBe("suffixed");
    expect(replanned.ruleId).toBe("review-to-rule.inject-clock-3");
  });

  it("keeps agents, claude, and both policy ownership exactly idempotent", async () => {
    for (const paths of [
      ["AGENTS.md"],
      ["CLAUDE.md"],
      ["AGENTS.md", "CLAUDE.md"],
    ]) {
      const root = await repository();
      const provisional = await planArtifacts({
        repositoryDir: root,
        outputDir: ".review-to-rule",
        sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
        sourceIdentity: "github.com/acme/repo#2",
        proposal,
        evidence,
        before: "a",
        after: "b",
        approvalMode: "yes",
        policyTarget:
          paths.length === 2
            ? "both"
            : paths[0]?.startsWith("A")
              ? "agents"
              : "claude",
        policyExplicit: true,
        policyPaths: paths,
        provisional: true,
      });
      const updates = await Promise.all(
        paths.map((path) =>
          planManagedPolicyUpdate(root, path, provisional.manifestPath),
        ),
      );
      const first = await planArtifacts({
        repositoryDir: root,
        outputDir: ".review-to-rule",
        sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
        sourceIdentity: "github.com/acme/repo#2",
        proposal,
        evidence,
        before: "a",
        after: "b",
        approvalMode: "yes",
        policyTarget:
          paths.length === 2
            ? "both"
            : paths[0]?.startsWith("A")
              ? "agents"
              : "claude",
        policyExplicit: true,
        policyPaths: paths,
        policyUpdates: updates,
      });
      await commitArtifactPlan({
        repositoryDir: root,
        plan: first,
        runner: new ProcessCommandRunner(),
        expectedPolicyHashes: new Map(
          updates.map((update) => [update.path, update.previousHash]),
        ),
      });
      const originalPolicies = new Map(
        await Promise.all(
          paths.map(
            async (path) =>
              [path, await readFile(join(root, path), "utf8")] as const,
          ),
        ),
      );
      const replayUpdates = await Promise.all(
        paths.map((path) =>
          planManagedPolicyUpdate(root, path, first.manifestPath),
        ),
      );
      expect(
        replayUpdates.every((update) => update.action === "unchanged"),
      ).toBe(true);
      const replay = await planArtifacts({
        repositoryDir: root,
        outputDir: ".review-to-rule",
        sourceUrl: "https://github.com/acme/repo/pull/1#discussion_r2",
        sourceIdentity: "github.com/acme/repo#2",
        proposal,
        evidence,
        before: "a",
        after: "b",
        approvalMode: "yes",
        policyTarget:
          paths.length === 2
            ? "both"
            : paths[0]?.startsWith("A")
              ? "agents"
              : "claude",
        policyExplicit: true,
        policyPaths: paths,
        policyUpdates: replayUpdates,
      });
      expect(replay.collision).toBe("replace_same_source");
      expect(replay.files.filter((file) => file.kind === "policy")).toEqual([]);
      expect(replay.ownedFiles).toEqual(expect.arrayContaining(paths));
      await commitArtifactPlan({
        repositoryDir: root,
        plan: replay,
        runner: new ProcessCommandRunner(),
        expectedPolicyHashes: new Map(
          replayUpdates.map((update) => [update.path, update.previousHash]),
        ),
      });
      for (const path of paths)
        expect(await readFile(join(root, path), "utf8")).toBe(
          originalPolicies.get(path),
        );
    }
  });
});
