import { describe, expect, it } from "vitest";
import { ProcessCommandRunner } from "../../src/utils/command.js";

describe("shell-free process runner", () => {
  it("passes arguments literally with shell disabled", async () => {
    const result = await new ProcessCommandRunner().run("git", [
      "--version",
      "; echo SHOULD_NOT_RUN",
    ]);
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
    expect(result.stdout.trim()).toMatch(/^git version /);
  });
});
