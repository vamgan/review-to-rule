import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StructuredProvider } from "../../src/llm/provider.js";
import { generate } from "../../src/pipeline.js";
import type { CommandRunner } from "../../src/utils/command.js";
import {
  semgrepAvailable,
  semgrepSkipReason,
} from "../semgrep-availability.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function walk(root: string, directory = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(root, path)));
    else output.push(relative(root, path));
  }
  return output.sort();
}

async function snapshot(root: string): Promise<unknown> {
  const files = await walk(root);
  return {
    status: execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
      cwd: root,
      encoding: "utf8",
    }),
    files: await Promise.all(
      files.map(async (path) => ({
        path,
        sha256: createHash("sha256")
          .update(await readFile(join(root, path)))
          .digest("hex"),
      })),
    ),
  };
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-to-rule-nonmutation-"));
  directories.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "token.ts"),
    "export const current = Date.now();\n",
    "utf8",
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["add", "src/token.ts"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  await writeFile(
    join(root, "untracked-sentinel.txt"),
    "preserve me\n",
    "utf8",
  );
  return root;
}

const lowConfidenceProvider: StructuredProvider = {
  analyze() {
    return Promise.resolve({
      enforceable: true,
      category: "API_USAGE",
      reviewerIntent: "Inject Clock.",
      prohibitedPattern: "Date.now()",
      rationale: "local",
      limitations: [],
      confidence: 0.5,
    });
  },
  propose() {
    throw new Error("must not propose below threshold");
  },
};

class AlwaysFailRunner implements CommandRunner {
  run(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return Promise.resolve({
      exitCode: 2,
      stdout: "",
      stderr: "synthetic failure",
    });
  }
}

describe.skipIf(!semgrepAvailable)(
  semgrepAvailable
    ? "dry-run Git and filesystem non-mutation"
    : `dry-run Git and filesystem non-mutation (${semgrepSkipReason})`,
  () => {
    it("preserves hashes, tracked state, and untracked paths on success", async () => {
      const root = await repository();
      const before = await snapshot(root);
      const outcome = await generate(
        "https://github.com/acme/clock/pull/42#discussion_r1001",
        { fixture: "injected-clock", repositoryDir: root },
      );
      expect(outcome.exitCode).toBe(0);
      expect(await snapshot(root)).toEqual(before);
    }, 30_000);

    it("preserves the repository for all four static refusals", async () => {
      const root = await repository();
      const before = await snapshot(root);
      for (const fixture of [
        "subjective-style",
        "product-decision",
        "performance-speculation",
        "cross-file-architecture",
      ]) {
        const outcome = await generate(
          `https://github.com/acme/clock/pull/42#discussion_r${fixture.length + 2_000}`,
          { fixture, repositoryDir: root },
        );
        expect(outcome.exitCode).toBe(2);
        expect(await snapshot(root)).toEqual(before);
      }
    });

    it("preserves the repository below threshold and after exhausted repair", async () => {
      const root = await repository();
      const before = await snapshot(root);
      const below = await generate(
        "https://github.com/acme/clock/pull/42#discussion_r3001",
        {
          fixture: "injected-clock",
          repositoryDir: root,
          provider: lowConfidenceProvider,
        },
      );
      expect(below.exitCode).toBe(2);
      expect(await snapshot(root)).toEqual(before);
      const exhausted = await generate(
        "https://github.com/acme/clock/pull/42#discussion_r3002",
        {
          fixture: "injected-clock",
          repositoryDir: root,
          runner: new AlwaysFailRunner(),
        },
      );
      expect(exhausted.exitCode).toBe(3);
      expect(await snapshot(root)).toEqual(before);
    });
  },
);
