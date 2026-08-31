import { describe, expect, it } from "vitest";
import { FakeProvider, parseProposal } from "../../src/llm/provider.js";
import { validateWithSemgrep } from "../../src/semgrep/runner.js";
import { ProcessCommandRunner } from "../../src/utils/command.js";
import { getOfflineCase } from "../../src/fixtures/cases.js";
import type {
  CorrectionCandidate,
  EnforceabilityDecision,
} from "../../src/domain/schemas.js";
import {
  semgrepAvailable,
  semgrepSkipReason,
} from "../semgrep-availability.js";

describe.skipIf(!semgrepAvailable)(
  semgrepAvailable
    ? "real Semgrep integration"
    : `real Semgrep integration (${semgrepSkipReason})`,
  () => {
    it("validates syntax, before, corrected, alternative, mutations, and normalized repository scan", async () => {
      const item = getOfflineCase("typescript-injected-clock");
      const candidate: CorrectionCandidate = {
        path: item.path,
        language: item.language,
        intentSummary: item.review,
        before: "Date.now()",
        after: "clock.now()",
        evidence: ["diff"],
        confidence: 0.96,
      };
      const decision: EnforceabilityDecision = {
        enforceable: true,
        category: "API_USAGE",
        reviewerIntent: item.review,
        prohibitedPattern: "Date.now()",
        preferredPattern: "clock.now()",
        rationale: "local",
        limitations: [],
        confidence: 0.96,
      };
      const proposal = parseProposal(
        await new FakeProvider().propose({ decision, candidate }),
      );
      const report = await validateWithSemgrep(
        {
          proposal,
          before: item.before,
          after: item.after,
          allowed: item.allowed,
          repositoryDir: new URL(
            "../../examples/injected-clock/repository",
            import.meta.url,
          ).pathname,
        },
        new ProcessCommandRunner(),
      );
      expect(report.checks.every((check) => check.status !== "failed")).toBe(
        true,
      );
      expect(report.matches).toHaveLength(1);
      expect(report.matches[0]?.path).toBe("src/token.ts");
    }, 30_000);
  },
);
