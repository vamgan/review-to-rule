import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadReviewLearningBundle,
  reviewLearningBundleSchema,
  reviewLearningBundleToEvidence,
} from "../../src/review-bundle.js";
import {
  canonicalReviewSourceIdentity,
  normalizeReviewSourceUrl,
} from "../../src/source.js";

const examplePath = new URL(
  "../../examples/review-bundle/gitlab-tenant-scope.json",
  import.meta.url,
).pathname;

describe("provider-neutral review learning bundle", () => {
  it("accepts provider-neutral, bounded review evidence", async () => {
    const parsed = await loadReviewLearningBundle(examplePath);
    expect(parsed.source.reviewSystem).toBe("gitlab");
    expect(parsed.source.change.id).toBe(482);
    expect(parsed.snapshots.before.path).toBe("src/invoices.ts");
    expect(parsed.rule?.language).toBe(parsed.correction.language);
    const evidence = reviewLearningBundleToEvidence(parsed);
    expect(evidence.original.source).toBe("agent_context");
    expect(evidence.pullRequest.number).toBe(482);
    expect(evidence.source?.reviewSystem).toBe("gitlab");
    expect(canonicalReviewSourceIdentity(parsed.source.url)).toMatch(
      /^review-url:https:\/\/gitlab\.corp\.example\//,
    );
  });

  it("rejects inconsistent evidence, rules, and embedded credentials", async () => {
    const valid = await loadReviewLearningBundle(examplePath);
    expect(() =>
      reviewLearningBundleSchema.parse({
        ...valid,
        correction: { ...valid.correction, before: "unrelated();\n" },
      }),
    ).toThrow(/before snapshot/i);
    expect(() =>
      reviewLearningBundleSchema.parse({
        ...valid,
        rule: valid.rule ? { ...valid.rule, language: "python" } : null,
      }),
    ).toThrow(/languages must match/i);
    expect(() =>
      normalizeReviewSourceUrl("https://token@example.com/review/1"),
    ).toThrow(/credentials/i);
    expect(() =>
      canonicalReviewSourceIdentity(
        "https://token@github.com/acme/repo/pull/1#discussion_r2",
      ),
    ).toThrow(/credentials/i);
    expect(() =>
      reviewLearningBundleSchema.parse({
        ...valid,
        source: {
          ...valid.source,
          repository: { ...valid.source.repository, host: "other.example" },
        },
      }),
    ).toThrow(/review URL host/i);
    expect(() =>
      reviewLearningBundleSchema.parse({
        ...valid,
        correction: { ...valid.correction, path: "../src/invoices.ts" },
        snapshots: {
          ...valid.snapshots,
          after: { ...valid.snapshots.after, path: "../src/invoices.ts" },
        },
      }),
    ).toThrow(/repository-relative path/i);
  });

  it("refuses symlinked review bundle files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rtr-review-bundle-"));
    const target = join(directory, "input.json");
    const link = join(directory, "linked.json");
    await writeFile(target, "{}\n");
    await symlink(target, link);
    await expect(loadReviewLearningBundle(link)).rejects.toThrow(
      /non-symlink/i,
    );
  });
});
