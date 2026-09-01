import { execFileSync } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  validateRenameLanguage,
} from "../../src/analysis/language.js";
import { ProcessCommandRunner } from "../../src/utils/command.js";

describe("provider-neutral repository inputs", () => {
  it("recognizes common languages and safely handles cross-language renames", () => {
    expect(detectLanguage("src/main.go")).toBe("go");
    expect(detectLanguage("crates/core/src/lib.rs")).toBe("rust");
    expect(detectLanguage("rules/custom.rego")).toBe("rego");
    expect(detectLanguage("Dockerfile")).toBe("text");
    expect(validateRenameLanguage("scripts/check.py", "src/check.ts")).toBe(
      "typescript",
    );
  });

  it("passes untrusted values as literal arguments without invoking a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-to-rule-command-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    const marker = join(root, "shell-was-invoked");
    const result = await new ProcessCommandRunner().run(
      "git",
      ["rev-parse", "--verify", `HEAD;touch ${marker}`],
      { cwd: root },
    );
    expect(result.exitCode).not.toBe(0);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
