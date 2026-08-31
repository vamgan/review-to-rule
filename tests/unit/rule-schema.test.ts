import { describe, expect, it } from "vitest";
import { FakeProvider, parseProposal } from "../../src/llm/provider.js";
import { validateRuleYaml } from "../../src/semgrep/rule.js";
import { ValidationError } from "../../src/domain/errors.js";
import type {
  CorrectionCandidate,
  EnforceabilityDecision,
  GeneratedRuleProposal,
} from "../../src/domain/schemas.js";
import { parse, stringify } from "yaml";
import { validateWithSemgrep } from "../../src/semgrep/runner.js";
import type { CommandRunner } from "../../src/utils/command.js";

const candidate: CorrectionCandidate = {
  path: "src/a.ts",
  language: "typescript",
  intentSummary: "clock",
  before: "Date.now()",
  after: "clock.now()",
  evidence: ["diff"],
  confidence: 0.96,
};
const decision: EnforceabilityDecision = {
  enforceable: true,
  category: "API_USAGE",
  reviewerIntent: "Inject clock.",
  prohibitedPattern: "Date.now()",
  preferredPattern: "clock.now()",
  rationale: "local",
  limitations: [],
  confidence: 0.96,
};

describe("safe Semgrep schema", () => {
  it("accepts one deterministic proposal", async () => {
    const proposal = parseProposal(
      await new FakeProvider().propose({ decision, candidate }),
    );
    expect(validateRuleYaml(proposal)).toMatchObject({
      id: proposal.id,
      pattern: "Date.now()",
    });
    expect(proposal.yaml).not.toContain("fix:");
  });

  it("embeds and enforces the exact declared include and exclude scope", async () => {
    const proposal = parseProposal(
      await new FakeProvider().propose({ decision, candidate }),
    );
    const parsed = validateRuleYaml(proposal) as {
      paths: { include: string[]; exclude: string[] };
    };
    expect(parsed.paths.include).toEqual(["src/a.ts"]);
    expect(parsed.paths.exclude).toEqual(proposal.exclude);
  });

  it.each([
    ["malformed", "rules: ["],
    [
      "multiple",
      "rules:\n  - {id: review-to-rule.a, message: x, severity: WARNING, languages: [typescript], metadata: {source: review-to-rule, generator: review-to-rule@x, review: x}, pattern: x}\n  - {id: review-to-rule.b, message: x, severity: WARNING, languages: [typescript], metadata: {source: review-to-rule, generator: review-to-rule@x, review: x}, pattern: x}",
    ],
    [
      "autofix",
      "rules:\n  - id: review-to-rule.a\n    message: x\n    severity: WARNING\n    languages: [typescript]\n    metadata: {source: review-to-rule, generator: review-to-rule@x, review: x}\n    pattern: x\n    fix: y",
    ],
    [
      "missing pattern",
      "rules:\n  - id: review-to-rule.a\n    message: x\n    severity: WARNING\n    languages: [typescript]\n    metadata: {source: review-to-rule, generator: review-to-rule@x, review: x}",
    ],
    [
      "unsupported field",
      "rules:\n  - id: review-to-rule.a\n    message: x\n    severity: WARNING\n    languages: [typescript]\n    metadata: {source: review-to-rule, generator: review-to-rule@x, review: x}\n    pattern: x\n    arbitrary: true",
    ],
  ])("rejects %s YAML before execution", (_name, yaml) => {
    const proposal = {
      id: "review-to-rule.a",
      title: "a",
      message: "x",
      language: "typescript",
      severity: "WARNING",
      yaml,
      include: [],
      exclude: [],
      rationale: "x",
      limitations: [],
      confidence: 1,
    } satisfies GeneratedRuleProposal;
    expect(() => validateRuleYaml(proposal)).toThrow(ValidationError);
  });

  it.each([
    [
      "extra metadata",
      (rule: Record<string, unknown>) =>
        ((rule.metadata as Record<string, unknown>).token = "unsafe"),
    ],
    [
      "unknown path key",
      (rule: Record<string, unknown>) =>
        ((rule.paths as Record<string, unknown>).follow = true),
    ],
    [
      "unknown nested patterns key",
      (rule: Record<string, unknown>) => {
        delete rule.pattern;
        rule.patterns = [
          { pattern: "Date.now()" },
          { "focus-metavariable": "$X" },
        ];
      },
    ],
    [
      "unknown nested pattern-either key",
      (rule: Record<string, unknown>) => {
        delete rule.pattern;
        rule["pattern-either"] = [{ arbitrary: "Date.now()" }];
      },
    ],
    [
      "unsafe include traversal",
      (rule: Record<string, unknown>) =>
        ((rule.paths as { include: string[] }).include = ["../src/a.ts"]),
    ],
    [
      "dot-segment include",
      (rule: Record<string, unknown>) =>
        ((rule.paths as { include: string[] }).include = ["src/./a.ts"]),
    ],
    [
      "newline include",
      (rule: Record<string, unknown>) =>
        ((rule.paths as { include: string[] }).include = ["src/a\n.ts"]),
    ],
    [
      "tab exclude",
      (rule: Record<string, unknown>) =>
        ((rule.paths as { exclude: string[] }).exclude = ["vendor/\t/**"]),
    ],
    [
      "backslash include",
      (rule: Record<string, unknown>) =>
        ((rule.paths as { include: string[] }).include = ["src\\a.ts"]),
    ],
    [
      "include mismatch",
      (rule: Record<string, unknown>) =>
        ((rule.paths as { include: string[] }).include = ["other/a.ts"]),
    ],
    [
      "exclude mismatch",
      (rule: Record<string, unknown>) =>
        ((rule.paths as { exclude: string[] }).exclude = ["vendor/**"]),
    ],
  ])(
    "rejects recursively unsafe %s before Semgrep runs",
    async (_name, mutate) => {
      const proposal = parseProposal(
        await new FakeProvider().propose({ decision, candidate }),
      );
      const document = parse(proposal.yaml) as {
        rules: Array<Record<string, unknown>>;
      };
      mutate(document.rules[0] ?? {});
      const unsafe = { ...proposal, yaml: stringify(document) };
      const runner: CommandRunner & { calls: number } = {
        calls: 0,
        run() {
          this.calls++;
          return Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "" });
        },
      };
      await expect(
        validateWithSemgrep(
          { proposal: unsafe, before: "Date.now()", after: "clock.now()" },
          runner,
        ),
      ).rejects.toThrow(ValidationError);
      expect(runner.calls).toBe(0);
    },
  );
});
