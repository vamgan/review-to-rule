import {
  memoryValidationReportSchema,
  type AgentReviewRule,
  type MemoryValidationReport,
} from "../domain/memory.js";
import { ValidationError } from "../domain/errors.js";
import {
  scopePathCovers,
  type ReviewMemoryBundle,
} from "../review-memory-bundle.js";
import { redact } from "../security/redact.js";

function assertCredentialFree(rule: AgentReviewRule): void {
  const serialized = JSON.stringify(rule);
  if (redact(serialized) !== serialized)
    throw new ValidationError(
      "The proposed review rule appears to contain a credential or authorization value.",
      "Remove credentials and retain only bounded, non-secret review guidance.",
    );
}

export function validateAgentReviewRule(
  bundle: ReviewMemoryBundle,
): MemoryValidationReport {
  const rule = bundle.rule;
  if (!rule)
    throw new ValidationError(
      "A reusable review bundle did not contain exactly one agent review rule.",
      "Provide one structured review rule or mark the feedback non-reusable.",
    );
  assertCredentialFree(rule);
  if (
    rule.examples.some((example) => example.bad.trim() === example.good.trim())
  )
    throw new ValidationError(
      "Rule examples must show a meaningful difference between flagged and accepted code.",
    );
  if (
    !rule.examples.some(
      (example) =>
        example.bad.includes(bundle.correction.before) &&
        example.good.includes(bundle.correction.after),
    )
  )
    throw new ValidationError(
      "Rule examples are not anchored to the accepted before/after correction.",
    );
  if (
    !rule.scope.paths.some((pattern) =>
      scopePathCovers(pattern, bundle.correction.path),
    )
  )
    throw new ValidationError(
      "Rule scope does not cover the reviewed correction path.",
    );
  if (
    !rule.scope.languages.includes(bundle.correction.language) &&
    !rule.scope.languages.includes("any")
  )
    throw new ValidationError(
      "Rule scope does not include the reviewed correction language.",
    );

  const broad = rule.scope.paths.some((path) => /[*?]/.test(path));
  return memoryValidationReportSchema.parse({
    checks: [
      {
        name: "accepted evidence",
        status: "passed",
        diagnostic:
          "The rule is anchored to the accepted before/after correction.",
      },
      {
        name: "credential boundary",
        status: "passed",
        diagnostic: "No credential-shaped values were found in the rule.",
      },
      {
        name: "scope",
        status: broad ? "warning" : "passed",
        diagnostic: broad
          ? "The rule uses a glob scope; review the complete affected area before writing."
          : `The rule is scoped to ${rule.scope.paths.join(", ")}.`,
      },
      {
        name: "agent context",
        status: "passed",
        diagnostic:
          "Instruction, triggers, guidance, rationale, scope, and examples are complete.",
      },
    ],
  });
}
