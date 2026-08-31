import { describe, expect, it } from "vitest";
import {
  evaluateOfflineMatrix,
  matrixSucceeded,
} from "../../src/evaluation.js";
import { generationResultSchema } from "../../src/domain/schemas.js";

const refusedResult = generationResultSchema.parse({
  schemaVersion: 1,
  status: "refused",
  source: null,
  correction: null,
  enforceability: null,
  rule: null,
  validation: null,
  matches: [],
  plannedFiles: [],
  writtenFiles: [],
  pullRequest: null,
  nextCommand: null,
  warnings: [],
  errors: [
    {
      kind: "not_enforceable",
      message: "synthetic refusal",
      remediation: "use a static correction",
    },
  ],
});

describe("fail-closed standalone evaluation summary", () => {
  it("marks the matrix failed when an enforceable case refuses", async () => {
    const summary = await evaluateOfflineMatrix(() =>
      Promise.resolve({ exitCode: 2, result: refusedResult }),
    );
    expect(summary.cases).toHaveLength(12);
    expect(summary.ok).toBe(false);
    expect(matrixSucceeded(summary)).toBe(false);
    expect(
      summary.cases
        .filter((item) => item.expected === "success")
        .every((item) => !item.ok),
    ).toBe(true);
    expect(
      summary.cases
        .filter((item) => item.expected === "refused")
        .every((item) => item.ok),
    ).toBe(true);
  });

  it("records thrown cases as failures instead of producing a false-positive gate", async () => {
    const summary = await evaluateOfflineMatrix(() => {
      throw new Error("runner crashed");
    });
    expect(summary.ok).toBe(false);
    expect(summary.cases).toHaveLength(12);
    expect(summary.cases.every((item) => !item.ok)).toBe(true);
    expect(
      summary.cases.every((item) => item.status === "internal_error"),
    ).toBe(true);
  });
});
