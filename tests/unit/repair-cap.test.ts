import { describe, expect, it } from "vitest";
import { FakeProvider, type RuleRequest } from "../../src/llm/provider.js";
import { generate } from "../../src/pipeline.js";
import type { CommandRunner } from "../../src/utils/command.js";

class AlwaysFailRunner implements CommandRunner {
  calls = 0;
  run(
    binary: "git" | "gh" | "semgrep",
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (binary === "semgrep") this.calls++;
    return Promise.resolve({
      exitCode: 2,
      stdout: "",
      stderr: "synthetic bounded syntax failure",
    });
  }
}

class CapturingProvider extends FakeProvider {
  readonly requests: RuleRequest[] = [];
  override propose(request: RuleRequest): Promise<unknown> {
    this.requests.push(request);
    return super.propose(request);
  }
}

describe("bounded repair", () => {
  it("stops after exactly three proposals and exposes every failed attempt", async () => {
    const provider = new CapturingProvider();
    const runner = new AlwaysFailRunner();
    const outcome = await generate(
      "https://github.com/acme/clock/pull/42#discussion_r1001",
      {
        fixture: "typescript-injected-clock",
        provider,
        runner,
        repositoryDir: process.cwd(),
      },
    );
    expect(outcome.exitCode).toBe(3);
    expect(provider.calls).toEqual([
      "analyze",
      "propose",
      "propose",
      "propose",
    ]);
    expect(runner.calls).toBe(3);
    expect(provider.requests[0]?.previousProposal).toBeUndefined();
    expect(provider.requests[1]?.previousProposal?.id).toMatch(
      /^review-to-rule\./,
    );
    expect(
      provider.requests[1]?.previousProposal?.yaml.length,
    ).toBeLessThanOrEqual(4_000);
    expect(provider.requests[1]?.failedCheck).toContain(
      "synthetic bounded syntax failure",
    );
    expect(
      outcome.result.warnings.filter((warning) =>
        warning.startsWith("Attempt "),
      ),
    ).toHaveLength(3);
    expect(outcome.result.source?.review.commentId).toBe(1001);
    expect(outcome.result.rule?.id).toMatch(/^review-to-rule\./);
    expect(outcome.result.repository?.source).toBe("fixture");
    expect(outcome.result.writtenFiles).toEqual([]);
  });
});
