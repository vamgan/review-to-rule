import { describe, expect, it } from "vitest";
import {
  buildAnalysisRequest,
  FakeMemoryProvider,
  parseApplicability,
} from "../../src/agent-rule-provider.js";
import { reviewBundle } from "./fixture.js";

const cases = [
  [
    "Use the injected clock so retry tests remain deterministic.",
    true,
    "TESTING",
  ],
  [
    "Preserve the service boundary between domain code and HTTP adapters.",
    true,
    "ARCHITECTURE",
  ],
  ["Check tenant authorization before loading this record.", true, "SECURITY"],
  ["Call parseSafe instead of parse in user-input paths.", true, "API_USAGE"],
  [
    "Cache this immutable lookup to meet the documented latency budget.",
    true,
    "PERFORMANCE",
  ],
  [
    "Preserve this state transition behavior when the job is retried.",
    true,
    "BEHAVIOR",
  ],
  [
    "Follow the repository naming convention for event handlers.",
    true,
    "STYLE",
  ],
  ["Return an explicit error when the record is missing.", true, "CORRECTNESS"],
  ["This looks nicer.", false, "STYLE"],
  ["Prefer the style used here.", false, "STYLE"],
  [
    "The product should use a different user experience.",
    false,
    "PRODUCT_CONSTRAINT",
  ],
  ["This might be faster.", false, "PERFORMANCE"],
  ["Change the architecture across all services.", false, "ARCHITECTURE"],
] as const;

describe("applicability matrix", () => {
  it.each(cases)("%s", async (review, reusable, category) => {
    const provider = new FakeMemoryProvider();
    const decision = parseApplicability(
      await provider.analyze(
        buildAnalysisRequest(review, reviewBundle().correction),
      ),
    );
    expect(decision).toMatchObject({ reusable, category });
  });
});
