import { describe, expect, it } from "vitest";
import { offlineCases } from "../../src/fixtures/cases.js";
import { generate } from "../../src/pipeline.js";
import { generationResultSchema } from "../../src/domain/schemas.js";
import {
  semgrepAvailable,
  semgrepSkipReason,
} from "../semgrep-availability.js";

describe.skipIf(!semgrepAvailable)(
  semgrepAvailable
    ? "twelve-case offline evaluation matrix"
    : `twelve-case offline evaluation matrix (${semgrepSkipReason})`,
  () => {
    it("produces deterministic validated successes and safe refusals", async () => {
      const summary: Array<{
        name: string;
        outcome: string;
        exitCode: number;
      }> = [];
      for (const item of offlineCases) {
        const first = await generate(item.url, { fixture: item.name });
        generationResultSchema.parse(first.result);
        if (item.enforceable) {
          expect(first.exitCode).toBe(0);
          expect(first.result.status).toBe("success");
          expect(first.result.rule).not.toBeNull();
          expect(
            first.result.validation?.checks.every(
              (check) => check.status !== "failed",
            ),
          ).toBe(true);
        } else {
          expect(first.exitCode).toBe(2);
          expect(first.result.status).toBe("refused");
          expect(first.result.rule).toBeNull();
          expect(first.result.writtenFiles).toEqual([]);
        }
        summary.push({
          name: item.name,
          outcome: first.result.status,
          exitCode: first.exitCode,
        });
      }
      expect(summary).toHaveLength(12);
      console.log(`EVALUATION_SUMMARY=${JSON.stringify(summary)}`);
    }, 120_000);
  },
);
