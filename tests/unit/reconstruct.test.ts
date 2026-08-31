import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  reconstruct,
  type ReconstructionInput,
} from "../../src/analysis/reconstruct.js";
import { RefusalError, UnsupportedError } from "../../src/domain/errors.js";
import {
  correctionCandidateSchema,
  reviewEvidenceSchema,
} from "../../src/domain/schemas.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const base = {
  owner: "acme",
  repository: "repo",
  pullRequestNumber: 1,
  commentId: 2,
  reviewBody: "Inject Clock instead of Date.now.",
  contextLines: 1,
};
const before =
  "const header = true;\nexport const now = () => Date.now();\nconst footer = true;\n";
const after =
  "const header = true;\nexport const now = (clock: Clock) => clock.now();\nconst footer = true;\n";

function input(
  overrides: Partial<ReconstructionInput> = {},
): ReconstructionInput {
  return {
    ...base,
    before: [
      { path: "src/a.ts", sha: "base", source: "fixture", content: before },
    ],
    after: { path: "src/a.ts", sha: "head", source: "fixture", content: after },
    ...overrides,
  };
}

async function gitRevisionSources(): Promise<{
  original: string;
  final: string;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), "review-to-rule-reconstruct-git-"),
  );
  temporaryDirectories.push(directory);
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], {
    cwd: directory,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: directory });
  const path = join(directory, "clock.ts");
  await writeFile(path, before, "utf8");
  execFileSync("git", ["add", "clock.ts"], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "before"], { cwd: directory });
  await writeFile(path, after, "utf8");
  const original = execFileSync("git", ["show", "HEAD:clock.ts"], {
    cwd: directory,
    encoding: "utf8",
  });
  return { original, final: await readFile(path, "utf8") };
}

describe("deterministic reconstruction", () => {
  it("selects a direct edit from temporary Git history without a provider", async () => {
    const revisions = await gitRevisionSources();
    const output = reconstruct(
      input({
        before: [
          {
            path: "src/a.ts",
            sha: "git-base",
            source: "original_commit",
            content: revisions.original,
          },
        ],
        after: {
          path: "src/a.ts",
          sha: "git-head",
          source: "fixture",
          content: revisions.final,
        },
      }),
    );
    expect(reviewEvidenceSchema.parse(output.evidence)).toEqual(
      output.evidence,
    );
    expect(correctionCandidateSchema.parse(output.candidate)).toEqual(
      output.candidate,
    );
    expect(output.candidate.before).toContain("Date.now()");
    expect(output.candidate.after).toContain("clock.now()");
  });

  it("enforces historical fallback priority regardless of input order", () => {
    const output = reconstruct(
      input({
        before: [
          {
            path: "src/a.ts",
            sha: "historical",
            source: "historical_content",
            content: before.replace("Date.now()", "legacy.now()"),
          },
          {
            path: "src/a.ts",
            sha: "diff",
            source: "diff_preimage",
            content: before,
          },
          {
            path: "src/a.ts",
            sha: "comment",
            source: "comment_commit",
            content: before,
          },
          {
            path: "src/a.ts",
            sha: "original",
            source: "original_commit",
            content: before,
          },
        ],
      }),
    );
    expect(output.evidence.original.sha).toBe("original");
    expect(output.evidence.original.source).toBe("original_commit");
  });

  it("falls through missing objects and records bounded rename evidence", () => {
    const output = reconstruct(
      input({
        before: [
          { path: "src/old.ts", sha: "missing", source: "original_commit" },
          {
            path: "src/old.ts",
            sha: "fallback",
            source: "historical_content",
            content: before,
          },
        ],
        after: {
          path: "src/new.ts",
          renamedFrom: "src/old.ts",
          sha: "head",
          source: "fixture",
          content: after,
        },
      }),
    );
    expect(output.evidence.original.sha).toBe("fallback");
    expect(output.evidence.warnings).toContain("Renamed from src/old.ts");
  });

  it("clips long individual source lines and review text before schema parsing", () => {
    const giant = `const giant = "${"x".repeat(6_000)}";`;
    const output = reconstruct(
      input({
        reviewBody: `Inject Clock ${"review".repeat(1_000)}`,
        before: [
          {
            path: "src/a.ts",
            sha: "base",
            source: "fixture",
            content: `${giant}\nexport const now = () => Date.now();\n`,
          },
        ],
        after: {
          path: "src/a.ts",
          sha: "head",
          source: "fixture",
          content: `${giant}\nexport const now = (clock: Clock) => clock.now();\n`,
        },
      }),
    );
    expect(output.evidence.original.excerpt.length).toBeLessThanOrEqual(4_000);
    expect(output.evidence.original.truncated).toBe(true);
    expect(output.evidence.original.excerpt).toContain(
      "export const now = () => Date.now();",
    );
    expect(output.evidence.final.excerpt).toContain(
      "export const now = (clock: Clock) => clock.now();",
    );
    expect(output.evidence.original.excerpt).toContain("…[truncated context]");
    expect(output.evidence.review.body.length).toBeLessThanOrEqual(4_000);
    expect(output.evidence.warnings.join(" ")).toMatch(
      /Source excerpts.*truncated/,
    );
    expect(output.evidence.warnings.join(" ")).toMatch(
      /Review text.*truncated/,
    );
  });

  it("refuses pure moves and equally plausible separated corrections", () => {
    expect(() =>
      reconstruct(
        input({
          before: [
            {
              path: "src/a.ts",
              sha: "a",
              source: "fixture",
              content: "const a = 1;\nconst b = 2;\n",
            },
          ],
          after: {
            path: "src/a.ts",
            sha: "b",
            source: "fixture",
            content: "const b = 2;\nconst a = 1;\n",
          },
        }),
      ),
    ).toThrow(/only moves/);
    expect(() =>
      reconstruct(
        input({
          reviewBody: "Please correct these calls.",
          before: [
            {
              path: "src/a.ts",
              sha: "a",
              source: "fixture",
              content:
                "const a = oldOne();\nconst stable = 1;\nconst b = oldTwo();\n",
            },
          ],
          after: {
            path: "src/a.ts",
            sha: "b",
            source: "fixture",
            content:
              "const a = newOne();\nconst stable = 1;\nconst b = newTwo();\n",
          },
        }),
      ),
    ).toThrow(/equally plausible/);
  });

  it("pairs an edited-and-moved TypeScript correction", () => {
    const output = reconstruct(
      input({
        before: [
          {
            path: "src/a.ts",
            sha: "a",
            source: "fixture",
            content:
              "export function stamp() {\n  const value = Date.now();\n  audit();\n  return value;\n}\n",
          },
        ],
        after: {
          path: "src/a.ts",
          sha: "b",
          source: "fixture",
          content:
            "export function stamp() {\n  audit();\n  const value = clock.now();\n  return value;\n}\n",
        },
      }),
    );
    expect(output.candidate.before).toBe("const value = Date.now();");
    expect(output.candidate.after).toBe("const value = clock.now();");
    expect(output.candidate.beforeLine).toBe(2);
    expect(output.candidate.afterLine).toBe(3);
  });

  it("pairs a token-disjoint legacy() to modern() replacement after it moves", () => {
    const output = reconstruct(
      input({
        reviewBody: "Replace legacy with modern.",
        before: [
          {
            path: "src/a.ts",
            sha: "a",
            source: "fixture",
            content:
              "export function run() {\n  const value = legacy();\n  audit();\n  return value;\n}\n",
          },
        ],
        after: {
          path: "src/a.ts",
          sha: "b",
          source: "fixture",
          content:
            "export function run() {\n  audit();\n  const value = modern();\n  return value;\n}\n",
        },
      }),
    );
    expect(output.candidate.before).toBe("const value = legacy();");
    expect(output.candidate.after).toBe("const value = modern();");
    expect(output.candidate.beforeLine).toBe(2);
    expect(output.candidate.afterLine).toBe(3);
  });

  it("pairs an edited-and-moved Python correction", () => {
    const output = reconstruct(
      input({
        reviewBody: "Inject the clock instead of time.time.",
        before: [
          {
            path: "src/a.py",
            sha: "a",
            source: "fixture",
            content:
              "def stamp():\n    value = time.time()\n    audit()\n    return value\n",
          },
        ],
        after: {
          path: "src/a.py",
          sha: "b",
          source: "fixture",
          content:
            "def stamp():\n    audit()\n    value = clock.now()\n    return value\n",
        },
      }),
    );
    expect(output.candidate.language).toBe("python");
    expect(output.candidate.before).toBe("value = time.time()");
    expect(output.candidate.after).toBe("value = clock.now()");
  });

  it("preserves a bounded root and every reply in stable order when supplied comment is a reply", () => {
    const output = reconstruct(
      input({
        commentId: 103,
        reviewBody: "Done in the latest push.",
        threadRoot: {
          id: 100,
          body: "Inject Clock instead of calling Date.now directly.",
        },
        replies: [
          { id: 103, body: "Done in the latest push." },
          { id: 101, body: "Please keep the clock injectable." },
          { id: 102, body: "Agreed." },
        ],
      }),
    );
    expect(output.evidence.review.commentId).toBe(103);
    expect(output.evidence.threadRoot).toEqual({
      id: 100,
      body: "Inject Clock instead of calling Date.now directly.",
    });
    expect(output.evidence.replies.map((reply) => reply.id)).toEqual([
      101, 102, 103,
    ]);
    expect(output.candidate.before).toContain("Date.now");
    expect(output.candidate.intentSummary).toContain("Inject Clock");
    expect(
      output.candidate.intentSummary.match(/Done in the latest push\./g),
    ).toHaveLength(1);
  });

  it("bounds reply bodies and maps invalid reply shapes to typed refusals", () => {
    const bounded = reconstruct(
      input({ replies: [{ id: 101, body: "reply".repeat(1_000) }] }),
    );
    expect(bounded.evidence.replies[0]?.body.length).toBeLessThanOrEqual(4_000);
    expect(bounded.evidence.warnings.join(" ")).toContain(
      "Review thread replies were truncated",
    );
    expect(() =>
      reconstruct(input({ replies: [{ id: 0, body: "invalid" }] })),
    ).toThrow(RefusalError);
  });

  it("does not warn about a meaningless terminal empty line", () => {
    const output = reconstruct(
      input({
        contextLines: 20,
        before: [
          {
            path: "src/a.ts",
            sha: "a",
            source: "fixture",
            content: "const stable = true;\nconst now = Date.now();\n",
          },
        ],
        after: {
          path: "src/a.ts",
          sha: "b",
          source: "fixture",
          content: "const stable = true;\nconst now = clock.now();\n",
        },
      }),
    );
    expect(output.evidence.original.truncated).toBe(false);
    expect(output.evidence.final.truncated).toBe(false);
    expect(output.evidence.warnings.join(" ")).not.toContain("Source excerpts");
  });

  it("selects one review-relevant hunk when unrelated edits are separated", () => {
    const output = reconstruct(
      input({
        before: [
          {
            path: "src/a.ts",
            sha: "a",
            source: "fixture",
            content:
              "const now = Date.now();\nconst stable = 1;\nconst label = oldLabel();\n",
          },
        ],
        after: {
          path: "src/a.ts",
          sha: "b",
          source: "fixture",
          content:
            "const now = clock.now();\nconst stable = 1;\nconst label = newLabel();\n",
        },
      }),
    );
    expect(output.candidate.before).toContain("Date.now");
    expect(output.candidate.before).not.toContain("oldLabel");
  });

  it("refuses unchanged, deletion, missing history, oversize, and unsupported rename", () => {
    expect(() =>
      reconstruct(
        input({
          after: {
            path: "src/a.ts",
            sha: "b",
            source: "fixture",
            content: before,
          },
        }),
      ),
    ).toThrow(RefusalError);
    expect(() =>
      reconstruct(
        input({
          after: {
            path: "src/a.ts",
            sha: "b",
            source: "fixture",
            deleted: true,
          },
        }),
      ),
    ).toThrow(RefusalError);
    expect(() =>
      reconstruct(
        input({
          before: [{ path: "src/a.ts", sha: "a", source: "original_commit" }],
        }),
      ),
    ).toThrow(RefusalError);
    expect(() =>
      reconstruct(
        input({
          before: [
            {
              path: "src/a.ts",
              sha: "a",
              source: "fixture",
              content: "x".repeat(200_001),
            },
          ],
        }),
      ),
    ).toThrow(RefusalError);
    expect(() =>
      reconstruct(
        input({
          after: {
            path: "src/a.py",
            renamedFrom: "src/a.ts",
            sha: "b",
            source: "fixture",
            content: after,
          },
        }),
      ),
    ).toThrow(UnsupportedError);
  });
});
