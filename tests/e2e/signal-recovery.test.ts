import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPublicCli } from "../build-public-cli.js";

const project = new URL("../..", import.meta.url).pathname;
const cli = join(project, "dist", "cli.js");
const review = "https://github.com/acme/clock/pull/42#discussion_r1001";

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rtr-signal-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "tracked\n");
  await writeFile(join(root, "AGENTS.md"), "# Original policy\n");
  execFileSync("git", ["add", "README.md", "AGENTS.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function journalProgress(
  root: string,
): Promise<{ phase: string; index: number } | undefined> {
  const output = join(root, ".review-to-rule");
  if (!existsSync(output)) return undefined;
  const transaction = (await readdir(output)).find((name) =>
    name.startsWith(".transaction-"),
  );
  if (!transaction) return undefined;
  try {
    const parsed = JSON.parse(
      await readFile(join(output, transaction, "journal.json"), "utf8"),
    ) as { progress?: { phase: string; index: number } };
    return parsed.progress;
  } catch {
    return undefined;
  }
}

describe("public CLI signal recovery", () => {
  let shimDirectory = "";
  beforeAll(async () => {
    await buildPublicCli();
    shimDirectory = await mkdtemp(join(tmpdir(), "rtr-signal-bin-"));
    const semgrep = join(shimDirectory, "semgrep");
    await writeFile(
      semgrep,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('recorded-semgrep'); process.exit(0); }
if (args.includes('--validate')) process.exit(0);
const target = args.at(-1);
const files = [];
const walk = (entry) => { for (const name of fs.readdirSync(entry)) { const item = path.join(entry, name); const stat = fs.statSync(item); if (stat.isDirectory()) walk(item); else if (/\\.(?:ts|js|py)$/.test(name)) files.push(item); } };
walk(target);
const match = target.includes('/before') || target.includes('/mutation-');
const results = match && files[0] ? [{path:files[0],start:{line:1},end:{line:1},extra:{lines:fs.readFileSync(files[0],'utf8').split('\\n')[0],message:'recorded match'}}] : [];
process.stdout.write(JSON.stringify({results,errors:[]}));
`,
    );
    await chmod(semgrep, 0o755);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (let targetIndex = 0; targetIndex < 7; targetIndex++) {
      it(`restores every byte after ${signal} at during_replace target ${targetIndex}`, async () => {
        const root = await repository();
        const beforeStatus = execFileSync(
          "git",
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          { cwd: root },
        );
        const originalPolicy = await readFile(join(root, "AGENTS.md"));
        const child = spawn(
          process.execPath,
          [
            cli,
            "generate",
            review,
            "--fixture",
            "injected-clock",
            "--repo-dir",
            root,
            "--write",
            "--yes",
            "--policy-target",
            "agents",
            "--json",
          ],
          {
            cwd: project,
            env: {
              ...process.env,
              NODE_ENV: "test",
              REVIEW_TO_RULE_TEST_TRANSACTION_DELAY_MS: "120",
              PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        child.stdout.resume();
        child.stderr.resume();
        const exited = new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve) =>
          child.once("close", (code, exitSignal) =>
            resolve({ code, signal: exitSignal }),
          ),
        );
        let observed = false;
        for (let attempt = 0; attempt < 4_000; attempt++) {
          const progress = await journalProgress(root);
          if (
            progress?.phase === "during_replace" &&
            progress.index === targetIndex
          ) {
            observed = true;
            child.kill(signal);
            break;
          }
          await wait(5);
        }
        expect(observed).toBe(true);
        const exit = await exited;
        expect(exit.signal ?? exit.code).not.toBe(0);
        expect(await readFile(join(root, "AGENTS.md"))).toEqual(originalPolicy);
        expect(
          execFileSync(
            "git",
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            { cwd: root },
          ),
        ).toEqual(beforeStatus);
        expect(existsSync(join(root, ".review-to-rule"))).toBe(false);
      }, 30_000);
    }
  }

  it.each([2, 6])(
    "recovers an abrupt journal through a second public invocation at target %i",
    async (killIndex) => {
      const root = await repository();
      const originalPolicy = await readFile(join(root, "AGENTS.md"));
      const child = spawn(
        process.execPath,
        [
          cli,
          "generate",
          review,
          "--fixture",
          "injected-clock",
          "--repo-dir",
          root,
          "--write",
          "--yes",
          "--policy-target",
          "agents",
          "--json",
        ],
        {
          cwd: project,
          env: {
            ...process.env,
            NODE_ENV: "test",
            REVIEW_TO_RULE_TEST_TRANSACTION_DELAY_MS: "200",
            PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.resume();
      child.stderr.resume();
      const exited = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      let killed = false;
      for (let attempt = 0; attempt < 4_000; attempt++) {
        const progress = await journalProgress(root);
        if (
          progress?.phase === "during_replace" &&
          progress.index === killIndex
        ) {
          child.kill("SIGKILL");
          killed = true;
          break;
        }
        await wait(5);
      }
      await exited;
      expect(killed).toBe(true);
      expect(existsSync(join(root, ".review-to-rule"))).toBe(true);
      const recovery = spawn(
        process.execPath,
        [
          cli,
          "generate",
          review,
          "--fixture",
          "injected-clock",
          "--repo-dir",
          root,
          "--write",
          "--yes",
          "--policy-target",
          "agents",
          "--json",
        ],
        {
          cwd: project,
          env: {
            ...process.env,
            NODE_ENV: "test",
            PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      recovery.stdout.setEncoding("utf8").on("data", (value: string) => {
        stdout += value;
      });
      recovery.stderr.setEncoding("utf8").on("data", (value: string) => {
        stderr += value;
      });
      const recoveryExit = await new Promise<number | null>((resolve) =>
        recovery.once("close", resolve),
      );
      expect(recoveryExit, stderr).toBe(0);
      const recovered = JSON.parse(stdout) as {
        plannedFiles: string[];
        preview: { collision: string };
      };
      expect(recovered.preview.collision).toBe("new");
      expect(
        recovered.plannedFiles.some((path) =>
          /\/manifests\/review-to-rule\.[^/]+-2\.json$/.test(path),
        ),
      ).toBe(false);
      expect(await readFile(join(root, "AGENTS.md"))).not.toEqual(
        originalPolicy,
      );
      expect(
        (await readdir(join(root, ".review-to-rule"))).some((name) =>
          name.startsWith(".transaction-"),
        ),
      ).toBe(false);
    },
    30_000,
  );
});
