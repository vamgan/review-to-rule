import { describe, expect, it } from "vitest";
import type {
  RuleRequest,
  StructuredProvider,
} from "../../src/llm/provider.js";
import { generate } from "../../src/pipeline.js";
import type { CommandRunner } from "../../src/utils/command.js";

const reviewUrl = "https://github.com/acme/clock/pull/42#discussion_r1001";
const decision = {
  enforceable: true,
  category: "API_USAGE" as const,
  reviewerIntent: "Inject Clock.",
  prohibitedPattern: "Date.now()",
  preferredPattern: "clock.now()",
  rationale: "local",
  limitations: [],
  confidence: 0.96,
};

class ThrowingProvider implements StructuredProvider {
  proposals: RuleRequest[] = [];
  constructor(
    private readonly stage: "analyze" | "propose",
    private readonly secret: string,
  ) {}
  analyze(): Promise<unknown> {
    if (this.stage === "analyze") throw new Error(this.secret);
    return Promise.resolve(decision);
  }
  propose(request: RuleRequest): Promise<unknown> {
    this.proposals.push(request);
    throw new Error(this.secret);
  }
}

class NeverRun implements CommandRunner {
  calls = 0;
  run(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.calls++;
    return Promise.resolve({ exitCode: 1, stdout: "", stderr: "not expected" });
  }
}

const secrets = [
  "ghp_abcdefghijklmnopqrstuvwxyz",
  "sk-proj-abcdefghijklmnopqrstuvwxyz",
  "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
  "Authorization: Bearer extremely-sensitive-token",
  "OPENAI_API_KEY=environment-secret-value",
];

describe("provider failure redaction", () => {
  it.each(secrets)("redacts analyze failure %s", async (secret) => {
    const outcome = await generate(reviewUrl, {
      fixture: "injected-clock",
      provider: new ThrowingProvider("analyze", secret),
      runner: new NeverRun(),
    });
    const serialized = JSON.stringify(outcome.result);
    expect(outcome.exitCode).toBe(4);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("environment-secret-value");
  });

  it.each(secrets)(
    "redacts all three proposal repair failures %s",
    async (secret) => {
      const provider = new ThrowingProvider("propose", secret);
      const runner = new NeverRun();
      const outcome = await generate(reviewUrl, {
        fixture: "injected-clock",
        provider,
        runner,
      });
      const serialized = JSON.stringify(outcome.result);
      expect(outcome.exitCode).toBe(3);
      expect(provider.proposals).toHaveLength(3);
      expect(runner.calls).toBe(0);
      expect(
        outcome.result.warnings.filter((warning) =>
          warning.startsWith("Attempt "),
        ),
      ).toHaveLength(3);
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("environment-secret-value");
    },
  );
});
