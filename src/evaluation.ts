import { offlineCases } from "./fixtures/cases.js";
import { generate, type Outcome } from "./pipeline.js";

export interface EvaluationCaseSummary {
  name: string;
  expected: "success" | "refused";
  status: string;
  exitCode: number;
  ok: boolean;
  validation: {
    passed: boolean;
    totalChecks: number;
    passedChecks: number;
    omittedChecks: number;
    failedChecks: number;
    currentMatches: number;
  } | null;
}

export interface EvaluationSummary {
  schemaVersion: 1;
  ok: boolean;
  cases: EvaluationCaseSummary[];
}

export type EvaluationRunner = (
  reviewUrl: string,
  options: { fixture: string },
) => Promise<Outcome>;

function summarize(
  fixture: (typeof offlineCases)[number],
  outcome: Outcome,
): EvaluationCaseSummary {
  const expected = fixture.enforceable ? "success" : "refused";
  const report = outcome.result.validation;
  const validation = fixture.enforceable
    ? {
        passed:
          report !== null &&
          report.checks.every((check) => check.status !== "failed") &&
          ["before fixture", "corrected fixture", "allowed alternative"].every(
            (name) =>
              report.checks.some(
                (check) => check.name === name && check.status === "passed",
              ),
          ),
        totalChecks: report?.checks.length ?? 0,
        passedChecks:
          report?.checks.filter((check) => check.status === "passed").length ??
          0,
        omittedChecks:
          report?.checks.filter((check) => check.status === "omitted").length ??
          0,
        failedChecks:
          report?.checks.filter((check) => check.status === "failed").length ??
          0,
        currentMatches: outcome.result.matches.length,
      }
    : null;
  const ok = fixture.enforceable
    ? outcome.exitCode === 0 &&
      outcome.result.status === "success" &&
      outcome.result.rule !== null &&
      validation?.passed === true
    : outcome.exitCode === 2 &&
      outcome.result.status === "refused" &&
      outcome.result.rule === null &&
      outcome.result.writtenFiles.length === 0;
  return {
    name: fixture.name,
    expected,
    status: outcome.result.status,
    exitCode: outcome.exitCode,
    ok,
    validation,
  };
}

export function matrixSucceeded(summary: EvaluationSummary): boolean {
  return (
    summary.cases.length === offlineCases.length &&
    summary.cases.every((item) => item.ok)
  );
}

export async function evaluateOfflineMatrix(
  run: EvaluationRunner = generate,
): Promise<EvaluationSummary> {
  const cases: EvaluationCaseSummary[] = [];
  for (const fixture of offlineCases) {
    try {
      const outcome = await run(fixture.url, { fixture: fixture.name });
      cases.push(summarize(fixture, outcome));
    } catch {
      cases.push({
        name: fixture.name,
        expected: fixture.enforceable ? "success" : "refused",
        status: "internal_error",
        exitCode: 7,
        ok: false,
        validation: null,
      });
    }
  }
  const summary: EvaluationSummary = { schemaVersion: 1, ok: false, cases };
  summary.ok = matrixSucceeded(summary);
  return summary;
}
