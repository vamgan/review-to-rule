import type { ReviewMemoryBundle } from "../../src/review-memory-bundle.js";

export function reviewBundle(
  overrides: Partial<ReviewMemoryBundle> = {},
): ReviewMemoryBundle {
  return {
    schemaVersion: 2,
    source: {
      reviewSystem: "gitlab",
      url: "https://gitlab.example.com/acme/app/merge_requests/12#note_77",
      repository: {
        host: "gitlab.example.com",
        owner: "acme",
        name: "app",
      },
      change: {
        id: 12,
        baseRevision: "base123",
        headRevision: "head456",
        merged: true,
        mergedAt: "2026-08-30T12:00:00Z",
        mergeRevision: "merge789",
      },
    },
    review: {
      id: 77,
      body: "Use the injected clock here so retries remain deterministic.",
      resolved: true,
      path: "src/jobs/retry.ts",
      line: 10,
      side: "RIGHT",
      root: {
        id: 77,
        body: "Use the injected clock here so retries remain deterministic.",
      },
      replies: [{ id: 78, body: "Fixed in the accepted revision." }],
    },
    snapshots: {
      before: {
        path: "src/jobs/retry.ts",
        revision: "base123",
        excerpt:
          "export function nextRetry(clock: Clock) {\n  return Date.now() + 5000;\n}",
        startLine: 8,
        endLine: 11,
        truncated: false,
      },
      after: {
        path: "src/jobs/retry.ts",
        revision: "head456",
        excerpt:
          "export function nextRetry(clock: Clock) {\n  return clock.now() + 5000;\n}",
        startLine: 8,
        endLine: 11,
        truncated: false,
      },
    },
    correction: {
      path: "src/jobs/retry.ts",
      language: "typescript",
      intentSummary: "Use the injected clock for retry scheduling.",
      before: "return Date.now() + 5000;",
      after: "return clock.now() + 5000;",
      beforeLine: 9,
      afterLine: 9,
      evidence: ["review comment 77", "accepted head head456"],
      confidence: 0.99,
    },
    applicability: {
      reusable: true,
      category: "TESTING",
      reviewerIntent:
        "Use the injected clock for retry scheduling so tests remain deterministic.",
      rationale:
        "The accepted correction establishes a repeatable dependency boundary.",
      limitations: ["Applies only where an injected clock is available."],
      confidence: 0.98,
    },
    rule: {
      id: "review-to-rule.use-injected-clock",
      title: "Use the injected clock in retry scheduling",
      instruction:
        "Use the injected Clock dependency instead of reading wall-clock time directly in retry scheduling code.",
      rationale:
        "Direct wall-clock reads make retry behavior difficult to test deterministically.",
      priority: "important",
      scope: {
        paths: ["src/jobs/*.ts"],
        languages: ["typescript"],
        description:
          "Apply to retry and scheduling code under src/jobs when a Clock dependency is in scope.",
      },
      triggers: [
        "Retry or scheduling code calls Date.now() even though an injected Clock is available.",
      ],
      guidance: [
        "Request clock.now() or an equivalent call through the injected time source.",
      ],
      exceptions: [
        "Bootstrap code that creates the Clock implementation may access system time.",
      ],
      examples: [
        {
          language: "typescript",
          bad: "return Date.now() + 5000;",
          good: "return clock.now() + 5000;",
        },
      ],
      confidence: 0.98,
    },
    provenance: [
      "gitlab merge request 12",
      "resolved review note 77",
      "base base123 and accepted head head456",
    ],
    warnings: [],
    ...overrides,
  };
}
