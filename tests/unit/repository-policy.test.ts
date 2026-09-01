import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeGitRemote,
  readHistoricalContent,
  resolveRepository,
} from "../../src/repository.js";
import { assertSafeExactPath } from "../../src/security/path.js";
import {
  MANAGED_END,
  MANAGED_START,
  discoverPolicy,
  planManagedPolicyUpdate,
  resolvePolicyPaths,
} from "../../src/policy.js";
import { ProcessCommandRunner } from "../../src/utils/command.js";
import type { CommandResult, CommandRunner } from "../../src/utils/command.js";

describe("repository and path hardening", () => {
  it.each([
    "https://GitHub.com/Acme/Repo.git",
    "git@github.com:Acme/Repo.git",
    "ssh://git@github.com/Acme/Repo.git",
  ])("normalizes HTTPS and SSH remotes: %s", (remote) => {
    expect(normalizeGitRemote(remote)).toBe("github.com/acme/repo");
  });

  it("normalizes nested enterprise repository groups", () => {
    expect(
      normalizeGitRemote("git@gitlab.corp.example:platform/payments/api.git"),
    ).toBe("gitlab.corp.example/platform/payments/api");
  });

  it.each([
    "src/*.ts",
    "src/a?.ts",
    "src/[a].ts",
    "src/{a}.ts",
    "src/a\u202Eb.ts",
    "../x",
  ])("rejects unsafe exact paths: %s", (path) => {
    expect(() => assertSafeExactPath(path)).toThrow(/unsafe/i);
  });

  it("cleans a temporary clone when post-clone identity verification fails", async () => {
    let cloneParent = "";
    const runner: CommandRunner = {
      async run(binary, args): Promise<CommandResult> {
        if (binary === "git" && args[0] === "rev-parse")
          return { exitCode: 1, stdout: "", stderr: "" };
        if (binary === "gh") {
          const destination = String(args[3]);
          cloneParent = dirname(destination);
          await mkdir(destination, { recursive: true });
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: "https://github.com/wrong/repository.git\n",
          stderr: "",
        };
      },
    };
    await expect(
      resolveRepository(
        { host: "github.com", owner: "acme", name: "repo" },
        { cwd: await mkdtemp(join(tmpdir(), "rtr-not-repo-")), runner },
      ),
    ).rejects.toThrow(/identity mismatch/i);
    expect(cloneParent).not.toBe("");
    expect(existsSync(cloneParent)).toBe(false);
  });

  it("rejects unvalidated revision expressions before invoking git or gh", async () => {
    let invoked = false;
    const runner: CommandRunner = {
      run: () => {
        invoked = true;
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    };
    await expect(
      readHistoricalContent({
        runner,
        repositoryDir: "/tmp",
        identity: { host: "github.com", owner: "acme", name: "repo" },
        sha: "HEAD:../../secret",
        path: "src/a.ts",
      }),
    ).rejects.toThrow(/full validated commit SHA/i);
    expect(invoked).toBe(false);
  });
});

describe("managed policy pointers", () => {
  it("discovers only bounded Semgrep conventions and reports nested policy state", async () => {
    const root = await mkdtemp(join(tmpdir(), "rtr-discovery-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    await mkdir(join(root, ".semgrep"), { recursive: true });
    await mkdir(join(root, "pkg"), { recursive: true });
    await writeFile(join(root, ".semgrep.yml"), "rules: []\n");
    await writeFile(join(root, ".semgrep/broken.yaml"), "rules: [\n");
    await writeFile(join(root, "random.yaml"), "rules: []\n");
    await writeFile(join(root, "AGENTS.md"), "# Root\n");
    await writeFile(join(root, "pkg/AGENTS.md"), `${MANAGED_START}\nbroken\n`);
    await symlink("../random.yaml", join(root, ".semgrep/link.yml"));
    execFileSync("git", ["add", "."], { cwd: root });
    await mkdir(join(root, ".review-to-rule/manifests"), { recursive: true });
    await writeFile(
      join(root, ".review-to-rule/manifests/healthy.json"),
      JSON.stringify({
        ruleId: "review-to-rule.healthy",
        source: { identity: "github.com/acme/repo#1" },
        ownedFiles: ["a", "b", "c", "d", "e"],
      }),
    );
    await writeFile(
      join(root, ".review-to-rule/manifests/broken.json"),
      "not-json",
    );
    const canonicalPaths = [
      ".review-to-rule/rules/canonical.yml",
      ".review-to-rule/evidence/canonical.json",
      ".review-to-rule/fixtures/canonical/before.ts",
      ".review-to-rule/fixtures/canonical/after.ts",
    ];
    await writeFile(
      join(root, ".review-to-rule/manifests/canonical.json"),
      JSON.stringify({
        schemaVersion: 1,
        generatorVersion: "0.1.0",
        source: {
          url: "https://github.com/acme/repo/pull/1#discussion_r1",
          identity: "github.com/acme/repo#1",
        },
        ruleId: "review-to-rule.canonical",
        approval: {
          mode: "yes",
          policyTarget: "neither",
          policyExplicit: true,
        },
        expectations: {
          beforeMatches: true,
          afterMatches: false,
          allowedMatches: false,
        },
        ownedFiles: [
          ...canonicalPaths,
          ".review-to-rule/manifests/canonical.json",
        ],
        writtenFiles: canonicalPaths.map((path) => ({
          path,
          sha256: "0".repeat(64),
        })),
      }),
    );
    await writeFile(
      join(root, ".review-to-rule/manifests/future.json"),
      JSON.stringify({ schemaVersion: 99 }),
    );
    const found = await discoverPolicy(root, new ProcessCommandRunner());
    expect(found.semgrepFiles).toEqual([
      ".semgrep.yml",
      ".semgrep/broken.yaml",
      ".semgrep/link.yml",
    ]);
    expect(found.semgrepFiles).not.toContain("random.yaml");
    expect(found.semgrepCandidates?.map((item) => item.status).sort()).toEqual([
      "malformed",
      "symlink",
      "valid",
    ]);
    expect(
      found.policyFiles?.find((file) => file.path === "pkg/AGENTS.md"),
    ).toMatchObject({
      nested: true,
      managed: "malformed",
      scope: "pkg",
    });
    expect(found.ambiguities).toHaveLength(2);
    expect(found.artifactState?.manifests).toEqual([
      expect.objectContaining({
        path: ".review-to-rule/manifests/broken.json",
        status: "malformed",
      }),
      expect.objectContaining({
        path: ".review-to-rule/manifests/canonical.json",
        status: "valid",
        ruleId: "review-to-rule.canonical",
        ownedFileCount: 5,
      }),
      expect.objectContaining({
        path: ".review-to-rule/manifests/future.json",
        status: "unsupported_version",
      }),
      expect.objectContaining({
        path: ".review-to-rule/manifests/healthy.json",
        status: "malformed",
        ruleId: null,
        ownedFileCount: null,
      }),
    ]);
  });

  it("preserves CRLF and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "rtr-policy-"));
    await writeFile(join(root, "AGENTS.md"), "# Policy\r\nNo final newline");
    const first = await planManagedPolicyUpdate(
      root,
      "AGENTS.md",
      ".review-to-rule/manifests/rule.json",
    );
    expect(first.content).toContain("\r\n");
    await writeFile(join(root, "AGENTS.md"), first.content);
    const second = await planManagedPolicyUpdate(
      root,
      "AGENTS.md",
      ".review-to-rule/manifests/rule.json",
    );
    expect(second.action).toBe("unchanged");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(first.content);
  });

  it("reports a symlinked artifact root without traversing external manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "rtr-discovery-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "rtr-discovery-outside-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    await mkdir(join(outside, "manifests"), { recursive: true });
    await writeFile(
      join(outside, "manifests/external.json"),
      '{"schemaVersion":1,"canary":"external-ownership"}\n',
    );
    await symlink(outside, join(root, ".review-to-rule"));
    const found = await discoverPolicy(root, new ProcessCommandRunner());
    expect(found.artifactState).toMatchObject({
      exists: true,
      symlink: true,
      manifests: [],
    });
    expect(found.ambiguities).toContain(
      "Artifact output root traverses a symlink at .review-to-rule and is unusable.",
    );
  });

  it.each(["AGENTS.md", "CLAUDE.md"])(
    "renders exact runnable default and custom pointer commands in %s",
    async (policyPath) => {
      const root = await mkdtemp(join(tmpdir(), "rtr-policy-golden-"));
      await writeFile(join(root, policyPath), "# Existing\nKeep this prose.\n");
      const custom = await planManagedPolicyUpdate(root, policyPath, {
        manifestPath: "quality/reviews/manifests/review-to-rule.clock.json",
        rulePath: "quality/reviews/rules/review-to-rule.clock.yml",
      });
      expect(custom.content).toContain("- Rules: `quality/reviews/rules/`");
      expect(custom.content).toContain(
        "- Validate: `semgrep scan --validate --config 'quality/reviews/rules/review-to-rule.clock.yml'`",
      );
      expect(custom.content).toContain(
        "- Replay: `review-to-rule replay 'quality/reviews/manifests/review-to-rule.clock.json'`",
      );
      expect(custom.content.startsWith("# Existing\nKeep this prose.\n")).toBe(
        true,
      );
      await writeFile(join(root, policyPath), custom.content);
      const replay = await planManagedPolicyUpdate(root, policyPath, {
        manifestPath: "quality/reviews/manifests/review-to-rule.clock.json",
        rulePath: "quality/reviews/rules/review-to-rule.clock.yml",
      });
      expect(replay.action).toBe("unchanged");
      expect(replay.content).toBe(custom.content);
      const updated = await planManagedPolicyUpdate(root, policyPath, {
        manifestPath: ".review-to-rule/manifests/review-to-rule.clock.json",
        rulePath: ".review-to-rule/rules/review-to-rule.clock.yml",
      });
      expect(updated.action).toBe("update");
      expect(updated.content).toContain("- Rules: `.review-to-rule/rules/`");
      expect(updated.content).toContain(
        "review-to-rule replay '.review-to-rule/manifests/review-to-rule.clock.json'",
      );
      expect(
        updated.content.match(/review-to-rule:managed:start/g),
      ).toHaveLength(1);
      expect(updated.content.startsWith("# Existing\nKeep this prose.\n")).toBe(
        true,
      );
    },
  );

  it("rejects malformed markers and nested ambiguity", async () => {
    const root = await mkdtemp(join(tmpdir(), "rtr-policy-"));
    await writeFile(join(root, "CLAUDE.md"), `${MANAGED_START}\nbroken`);
    await expect(
      planManagedPolicyUpdate(root, "CLAUDE.md", "x"),
    ).rejects.toThrow(/malformed/i);
    expect(() =>
      resolvePolicyPaths(
        {
          trackedFiles: [],
          semgrepFiles: [],
          agentsFiles: ["AGENTS.md", "pkg/AGENTS.md"],
          claudeFiles: [],
        },
        "agents",
        {},
      ),
    ).toThrow(/multiple/i);
    expect(MANAGED_END).toContain("managed:end");
  });
});
