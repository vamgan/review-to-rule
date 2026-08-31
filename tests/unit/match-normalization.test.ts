import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeSemgrepMatches } from "../../src/semgrep/runner.js";
import { ValidationError } from "../../src/domain/errors.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function dottedRepository(): Promise<{
  root: string;
  source: string;
  other: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), "review-to-rule-normalize-"));
  directories.push(parent);
  const root = join(parent, "repository.with.dots");
  const source = join(root, "src", "token.ts");
  const other = join(root, "other", "token.ts");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "other"), { recursive: true });
  await writeFile(
    source,
    "const safe = 1;\nconst match = Date.now();\nconst end = 2;\n",
    "utf8",
  );
  await writeFile(other, "const other = Date.now();\n", "utf8");
  return { root, source, other };
}

describe("trustworthy Semgrep match normalization", () => {
  it("uses filesystem stat for dotted directories and reads real bounded excerpts", async () => {
    const fixture = await dottedRepository();
    const matches = await normalizeSemgrepMatches(
      {
        results: [
          {
            path: fixture.other,
            start: { line: 1 },
            end: { line: 1 },
            extra: { lines: "requires login", message: "guardrail" },
          },
          {
            path: fixture.source,
            start: { line: 2 },
            end: { line: 2 },
            extra: { lines: "requires login", message: "guardrail" },
          },
        ],
      },
      fixture.root,
    );
    expect(matches.map((match) => match.path)).toEqual([
      "other/token.ts",
      "src/token.ts",
    ]);
    expect(matches[1]?.excerpt).toBe("const match = Date.now();");
    expect(JSON.stringify(matches)).not.toContain("requires login");
  });

  it("rejects traversal, invalid line bounds, and missing files", async () => {
    const fixture = await dottedRepository();
    const outside = join(fixture.root, "..", "outside.ts");
    await writeFile(outside, "Date.now();\n", "utf8");
    await expect(
      normalizeSemgrepMatches(
        { results: [{ path: outside, start: { line: 1 }, end: { line: 1 } }] },
        fixture.root,
      ),
    ).rejects.toThrow(/outside the scan root/);
    await expect(
      normalizeSemgrepMatches(
        {
          results: [
            { path: fixture.source, start: { line: 99 }, end: { line: 100 } },
          ],
        },
        fixture.root,
      ),
    ).rejects.toThrow(/invalid line bounds/);
    await expect(
      normalizeSemgrepMatches(
        {
          results: [
            { path: join(fixture.root, "missing.ts"), start: { line: 1 } },
          ],
        },
        fixture.root,
      ),
    ).rejects.toThrow(ValidationError);
  });
});
