import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate } from "../../src/pipeline.js";
import { ProcessCommandRunner } from "../../src/utils/command.js";
import { replayArtifactManifest } from "../../src/replay.js";
import {
  semgrepAvailable,
  semgrepSkipReason,
} from "../semgrep-availability.js";

describe("explicit write flow", () => {
  it.skipIf(!semgrepAvailable)(
    semgrepAvailable
      ? "commits artifacts and selected managed pointer as one validated set"
      : semgrepSkipReason,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "rtr-write-e2e-"));
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: root,
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      await writeFile(join(root, "README.md"), "target\n");
      execFileSync("git", ["add", "README.md"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
      let approvalText = "";
      const declined = await generate(
        "https://github.com/acme/clock/pull/42#discussion_r1001",
        {
          fixture: "injected-clock",
          repositoryDir: root,
          runner: new ProcessCommandRunner(),
          write: true,
          policyTarget: "agents",
          policyTargetExplicit: true,
          confirmation: {
            isTTY: true,
            confirm: (summary) => {
              approvalText = summary;
              expect(existsSync(join(root, ".review-to-rule"))).toBe(false);
              expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
              return Promise.resolve(false);
            },
          },
        },
      );
      expect(declined.exitCode).toBe(5);
      expect(approvalText).toContain("Complete mutation preview:");
      expect(approvalText).toContain("validated Semgrep rule");
      expect(approvalText).toContain("Policy diff (create AGENTS.md)");
      const nonInteractive = await generate(
        "https://github.com/acme/clock/pull/42#discussion_r1001",
        {
          fixture: "injected-clock",
          repositoryDir: root,
          runner: new ProcessCommandRunner(),
          write: true,
          policyTarget: "agents",
          policyTargetExplicit: true,
          confirmation: {
            isTTY: false,
            confirm: () => Promise.resolve(true),
          },
        },
      );
      expect(nonInteractive.exitCode).toBe(5);
      expect(nonInteractive.result.writtenFiles).toEqual([]);
      const outcome = await generate(
        "https://github.com/acme/clock/pull/42#discussion_r1001",
        {
          fixture: "injected-clock",
          repositoryDir: root,
          runner: new ProcessCommandRunner(),
          write: true,
          yes: true,
          policyTarget: "agents",
          policyTargetExplicit: true,
          providerInfo: { name: "fake", model: "deterministic-fixture" },
        },
      );
      expect(outcome.exitCode).toBe(0);
      expect(outcome.result.writtenFiles).toContain("AGENTS.md");
      expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
        "review-to-rule:managed:start",
      );
      const manifestPath = outcome.result.plannedFiles.find((path) =>
        path.includes("/manifests/"),
      );
      expect(manifestPath).toBeTruthy();
      expect(
        JSON.parse(
          await readFile(join(root, manifestPath ?? "missing"), "utf8"),
        ),
      ).toMatchObject({
        schemaVersion: 1,
        approval: { mode: "yes", policyTarget: "agents" },
      });
      const replayedManifest = await replayArtifactManifest({
        repositoryDir: root,
        manifestPath: manifestPath ?? "missing",
        runner: new ProcessCommandRunner(),
      });
      expect(replayedManifest.status).toBe("success");
      expect(
        replayedManifest.validation.checks.every(
          (check) => check.status !== "failed",
        ),
      ).toBe(true);
      const manifestAbsolute = join(root, manifestPath ?? "missing");
      const originalManifest = await readFile(manifestAbsolute, "utf8");
      const manifest = JSON.parse(originalManifest) as {
        writtenFiles: Array<{ path: string; sha256: string }>;
      };
      const afterRecord = manifest.writtenFiles.find((record) =>
        /\/after\.[^.]+$/.test(record.path),
      );
      expect(afterRecord).toBeTruthy();
      const afterAbsolute = join(root, afterRecord?.path ?? "missing");
      const originalAfter = await readFile(afterAbsolute, "utf8");
      await rm(afterAbsolute);
      await expect(
        replayArtifactManifest({
          repositoryDir: root,
          manifestPath: manifestPath ?? "missing",
          runner: new ProcessCommandRunner(),
        }),
      ).rejects.toThrow(/missing/i);
      await writeFile(afterAbsolute, originalAfter);
      await writeFile(afterAbsolute, `${originalAfter}\nDate.now();\n`);
      await expect(
        replayArtifactManifest({
          repositoryDir: root,
          manifestPath: manifestPath ?? "missing",
          runner: new ProcessCommandRunner(),
        }),
      ).rejects.toThrow(/hash mismatch/i);
      const corruptedAfter = await readFile(afterAbsolute, "utf8");
      if (afterRecord)
        afterRecord.sha256 = createHash("sha256")
          .update(corruptedAfter)
          .digest("hex");
      await writeFile(
        manifestAbsolute,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await expect(
        replayArtifactManifest({
          repositoryDir: root,
          manifestPath: manifestPath ?? "missing",
          runner: new ProcessCommandRunner(),
        }),
      ).rejects.toThrow(/corrected fixture/i);
      await writeFile(afterAbsolute, originalAfter);
      await writeFile(manifestAbsolute, originalManifest);
      const policyAfterFirst = await readFile(join(root, "AGENTS.md"), "utf8");
      const replay = await generate(
        "https://github.com/acme/clock/pull/42#discussion_r1001",
        {
          fixture: "injected-clock",
          repositoryDir: root,
          runner: new ProcessCommandRunner(),
          write: true,
          yes: true,
          policyTarget: "agents",
          policyTargetExplicit: true,
        },
      );
      expect(replay.exitCode).toBe(0);
      expect(replay.result.preview?.collision).toBe("replace_same_source");
      expect(replay.result.preview?.policyFiles).toMatchObject([
        { path: "AGENTS.md", action: "unchanged", diff: "" },
      ]);
      expect(replay.result.plannedFiles).toContain("AGENTS.md");
      expect(replay.result.writtenFiles).not.toContain("AGENTS.md");
      expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
        policyAfterFirst,
      );
    },
    120_000,
  );
});
