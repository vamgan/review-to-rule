import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCoreConfig } from "../../src/memory-config.js";
import { runDoctor } from "../../src/memory-doctor.js";
import { ProcessCommandRunner } from "../../src/utils/command.js";

describe("agent-mode configuration", () => {
  it("does not require a review host or model credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-to-rule-doctor-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(
      join(root, ".review-to-rule.yml"),
      "version: 2\noutputDir: .review-to-rule\n",
    );
    const config = await resolveCoreConfig({}, { cwd: root, env: {} });
    expect(config.outputDir).toBe(".review-to-rule");
    const result = await runDoctor({
      runner: new ProcessCommandRunner(),
      cwd: root,
      env: {},
      mode: "agent",
    });
    expect(result.status).toBe("success");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "review-provider", status: "skip" }),
        expect.objectContaining({ name: "model-credential", status: "skip" }),
      ]),
    );
  });
});
