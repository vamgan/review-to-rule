import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAnalysisRequest,
  FakeMemoryProvider,
  parseAgentReviewRule,
  parseApplicability,
} from "../../src/agent-rule-provider.js";
import {
  discoverMemoryPolicy,
  managedMemoryPointerBlock,
  planManagedMemoryUpdate,
  resolveMemoryPolicyPaths,
} from "../../src/memory-policy.js";
import { ProcessCommandRunner } from "../../src/utils/command.js";
import { reviewBundle } from "./fixture.js";

describe("provider-neutral analysis and repository discovery", () => {
  it("allows architectural and behavioral review memory", async () => {
    const bundle = reviewBundle();
    const candidate = bundle.correction;
    const provider = new FakeMemoryProvider();
    const decision = parseApplicability(
      await provider.analyze(
        buildAnalysisRequest(
          "Preserve the service boundary: domain code must not import the HTTP adapter.",
          candidate,
        ),
      ),
    );
    expect(decision.reusable).toBe(true);
    expect(decision.category).toBe("ARCHITECTURE");
    const rule = parseAgentReviewRule(
      await provider.propose({ decision, candidate }),
    );
    expect(rule.examples[0]).toMatchObject({
      bad: candidate.before,
      good: candidate.after,
    });
  });

  it("discovers Markdown memory and produces a stable agent pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-to-rule-policy-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "AGENTS.md"), "# Instructions\n");
    execFileSync("git", ["add", "AGENTS.md"], { cwd: root });
    const discovery = await discoverMemoryPolicy(
      root,
      new ProcessCommandRunner(),
    );
    expect(discovery.agentsFiles).toEqual(["AGENTS.md"]);
    expect(discovery.ruleCandidates).toEqual([]);
    const target = {
      indexPath: ".review-to-rule/INDEX.md",
      rulesDir: ".review-to-rule/rules",
    };
    const update = await planManagedMemoryUpdate(root, "AGENTS.md", target);
    expect(update.content).toContain(managedMemoryPointerBlock(target));
    expect(update.content).not.toContain("validate:");
  });

  it("requires an exact instruction path when nested policy is ambiguous", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-to-rule-policy-scope-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    await mkdir(join(root, "services/api"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "# Root instructions\n");
    await writeFile(
      join(root, "services/api/AGENTS.md"),
      "# API instructions\n",
    );
    execFileSync("git", ["add", "AGENTS.md", "services/api/AGENTS.md"], {
      cwd: root,
    });
    const discovery = await discoverMemoryPolicy(
      root,
      new ProcessCommandRunner(),
    );
    expect(() => resolveMemoryPolicyPaths(discovery, "agents", {})).toThrow(
      /multiple AGENTS\.md/i,
    );
    expect(
      resolveMemoryPolicyPaths(discovery, "agents", {
        agentsPath: "services/api/AGENTS.md",
      }),
    ).toEqual(["services/api/AGENTS.md"]);
  });

  it("preserves unmanaged instructions and refuses malformed managed markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-to-rule-policy-edit-"));
    const target = {
      indexPath: ".review-to-rule/INDEX.md",
      rulesDir: ".review-to-rule/rules",
    };
    await writeFile(join(root, "CLAUDE.md"), "# Keep this\n");
    const update = await planManagedMemoryUpdate(root, "CLAUDE.md", target);
    expect(update.content).toMatch(/^# Keep this\n\n<!-- review-to-rule/m);
    await writeFile(
      join(root, "CLAUDE.md"),
      "<!-- review-to-rule:managed:start -->\nbroken\n",
    );
    await expect(
      planManagedMemoryUpdate(root, "CLAUDE.md", target),
    ).rejects.toThrow(/malformed/i);
  });
});
