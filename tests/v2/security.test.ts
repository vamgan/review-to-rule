import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyReviewMemoryBundle } from "../../src/memory-core.js";
import { validateAgentReviewRule } from "../../src/rules/validate.js";
import { reviewMemoryBundleSchema } from "../../src/review-memory-bundle.js";
import { ProcessCommandRunner } from "../../src/utils/command.js";
import { reviewBundle } from "./fixture.js";

describe("review-memory security boundaries", () => {
  it("rejects credential-shaped content in a rule", () => {
    const bundle = reviewBundle();
    const unsafe = reviewMemoryBundleSchema.parse({
      ...bundle,
      rule: {
        ...bundle.rule,
        rationale: [
          "Authorization: ",
          "Bearer ",
          "deliberately-invalid-fixture must never be logged.",
        ].join(""),
      },
    });
    expect(() => validateAgentReviewRule(unsafe)).toThrow(/credential/i);
  });

  it("rejects rule examples that are not anchored to accepted evidence", () => {
    const bundle = reviewBundle();
    expect(() =>
      reviewMemoryBundleSchema.parse({
        ...bundle,
        rule: {
          ...bundle.rule,
          examples: [
            {
              language: "typescript",
              bad: "legacy()",
              good: "modern()",
            },
          ],
        },
      }),
    ).toThrow(/exact reviewed before/i);
  });

  it("rejects embedded URL credentials and traversing evidence paths", () => {
    const bundle = reviewBundle();
    expect(() =>
      reviewMemoryBundleSchema.parse({
        ...bundle,
        source: {
          ...bundle.source,
          url: "https://user:password@gitlab.example.com/acme/app/merge_requests/12#note_77",
        },
      }),
    ).toThrow(/credentials/i);
    expect(() =>
      reviewMemoryBundleSchema.parse({
        ...bundle,
        snapshots: {
          ...bundle.snapshots,
          after: { ...bundle.snapshots.after, path: "../retry.ts" },
        },
        correction: { ...bundle.correction, path: "../retry.ts" },
      }),
    ).toThrow(/portable repository-relative path/i);
  });

  it("refuses a symlinked memory root without touching its destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-to-rule-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "review-to-rule-outside-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.example.com/acme/app.git"],
      { cwd: root },
    );
    await writeFile(join(root, "README.md"), "# app\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
    await symlink(outside, join(root, ".review-to-rule"));
    const outcome = await applyReviewMemoryBundle(reviewBundle(), {
      repositoryDir: root,
      runner: new ProcessCommandRunner(),
      policyTarget: "neither",
      invocation: "review-to-rule apply bundle.json",
    });
    expect(outcome).toMatchObject({
      exitCode: 5,
      result: { status: "unsafe_repository" },
    });
    expect(await readdir(outside)).toEqual([]);
  });
});
