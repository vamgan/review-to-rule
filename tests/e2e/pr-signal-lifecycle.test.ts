import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPublicCli } from "../build-public-cli.js";

const project = new URL("../..", import.meta.url).pathname;
const review = "https://github.com/acme/clock/pull/42#discussion_r1001";
let installedBin = "";
let shimDirectory = "";

async function makeRepository(root: string) {
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: source,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: source });
  await writeFile(join(source, "README.md"), "source\n");
  execFileSync("git", ["add", "README.md"], { cwd: source });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: source });
  execFileSync("git", ["branch", "-M", "main"], { cwd: source });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: source });
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], {
    cwd: source,
  });
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: remote,
  });
  return { remote, source };
}

async function snapshotTree(
  root: string,
  relative = "",
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      Object.assign(snapshot, await snapshotTree(root, path));
    else if (entry.isFile())
      snapshot[path] = (await readFile(join(root, path))).toString("base64");
    else
      snapshot[path] =
        `non-file:${entry.isSymbolicLink() ? "symlink" : "other"}`;
  }
  return snapshot;
}

async function runInterrupted(input: {
  source: string;
  temp: string;
  phase: string;
  signal: "SIGINT" | "SIGTERM";
  branchPrefix: string;
}) {
  const child = spawn(
    installedBin,
    [
      "generate",
      review,
      "--fixture",
      "injected-clock",
      "--provider",
      "fake",
      "--repo-dir",
      input.source,
      "--open-pr",
      "--yes",
      "--policy-target",
      "neither",
      "--json",
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        NODE_ENV: "test",
        TMPDIR: input.temp,
        PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
        REVIEW_TO_RULE_BRANCH_PREFIX: input.branchPrefix,
        REVIEW_TO_RULE_TEST_PR_SIGNAL_PHASE: input.phase,
        REVIEW_TO_RULE_TEST_PR_SIGNAL_DELAY_MS: "1000",
        GITHUB_TOKEN: undefined,
        GH_TOKEN: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value: string) => {
    stdout += value;
  });
  const marker = `review-to-rule-test-phase:${input.phase}`;
  let marked = false;
  const observed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`did not observe ${marker}: ${stderr}`)),
      25_000,
    );
    child.stderr.setEncoding("utf8").on("data", (value: string) => {
      stderr += value;
      if (!marked && stderr.includes(marker)) {
        marked = true;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  await observed;
  child.kill(input.signal);
  const exit = await closed;
  return { exit, stdout, stderr };
}

describe("packed public PR signal lifecycle", () => {
  beforeAll(async () => {
    await buildPublicCli();
    const installRoot = await mkdtemp(join(tmpdir(), "rtr-pr-signal-pack-"));
    const packDirectory = join(installRoot, "pack");
    await mkdir(packDirectory);
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--json", "--pack-destination", packDirectory],
        { cwd: project, encoding: "utf8" },
      ),
    ) as Array<{ filename: string }>;
    execFileSync(
      "npm",
      [
        "install",
        "--prefer-offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        installRoot,
        join(packDirectory, packed[0]?.filename ?? "missing.tgz"),
      ],
      { stdio: "pipe" },
    );
    installedBin = join(installRoot, "node_modules/.bin/review-to-rule");
    shimDirectory = join(installRoot, "bin");
    await mkdir(shimDirectory);
    await writeFile(
      join(shimDirectory, "gh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.RTR_GH_CALL_LOG) fs.appendFileSync(process.env.RTR_GH_CALL_LOG, JSON.stringify(args) + "\\n");
const mode = process.env.RTR_GH_LIST_MODE;
const fakeShortToken = ["gh", "p_", "maliciousToken123456789"].join("");
const fakeFineGrainedToken = ["github", "_pat_", "maliciousToken123456789"].join("");
if (args[0] === "pr" && args[1] === "list" && mode === "object") process.stdout.write("{}\\n");
else if (args[0] === "pr" && args[1] === "list" && mode === "null") process.stdout.write("null\\n");
else if (args[0] === "pr" && args[1] === "list" && mode === "string") process.stdout.write('"existing"\\n');
else if (args[0] === "pr" && args[1] === "list" && mode === "number") process.stdout.write("7\\n");
else if (args[0] === "pr" && args[1] === "list" && mode === "empty-entry") process.stdout.write("[{}]\\n");
else if (args[0] === "pr" && args[1] === "list" && mode === "wrong-fields") process.stdout.write(JSON.stringify([{url:7,state:"open",headRefName:null}]) + "\\n");
else if (args[0] === "pr" && args[1] === "list" && mode === "unexpected-fields") process.stdout.write(JSON.stringify([{url:"https://github.com/acme/clock/pull/9",state:"OPEN",headRefName:"branch",unexpected:true}]) + "\\n");
else if (args[0] === "pr" && args[1] === "list" && mode === "malformed") process.stdout.write("[{\\n");
else if (args[0] === "pr" && args[1] === "list" && mode === "oversized") process.stdout.write(" ".repeat(65537) + "[]");
else if (args[0] === "pr" && args[1] === "list" && mode === "multiline-token") process.stdout.write(JSON.stringify([{url:fakeShortToken,state:"OPEN",headRefName:"branch"}], null, 2) + "\\n");
else if (args[0] === "pr" && args[1] === "list" && mode === "auth-token") { process.stderr.write(["authentication failed", ["Authorization: ", "Bearer ", fakeFineGrainedToken].join(""), "GH_TOKEN=" + fakeShortToken, ""].join("\\n")); process.exit(1); }
else if (args[0] === "pr" && args[1] === "list") process.stdout.write("[]\\n");
else if (args[0] === "pr" && args[1] === "create") process.stdout.write("https://github.com/acme/clock/pull/99\\n");
else { console.error("unexpected gh argv: " + JSON.stringify(args)); process.exit(2); }
`,
    );
    await chmod(join(shimDirectory, "gh"), 0o755);
    await writeFile(
      join(shimDirectory, "semgrep"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("recorded-semgrep"); process.exit(0); }
if (args.includes("--validate")) process.exit(0);
const target = args.at(-1);
const files = [];
const walk = (entry) => { for (const name of fs.readdirSync(entry)) { const item = path.join(entry, name); const stat = fs.statSync(item); if (stat.isDirectory()) walk(item); else if (/\\.(?:ts|js|py)$/.test(name)) files.push(item); } };
walk(target);
const match = target.includes("/before") || target.includes("/mutation-");
const results = match && files[0] ? [{path:files[0],start:{line:1},end:{line:1},extra:{lines:fs.readFileSync(files[0],"utf8").split("\\n")[0],message:"recorded match"}}] : [];
process.stdout.write(JSON.stringify({results,errors:[]}));
`,
    );
    await chmod(join(shimDirectory, "semgrep"), 0o755);
  }, 60_000);

  for (const mode of [
    "object",
    "null",
    "string",
    "number",
    "empty-entry",
    "wrong-fields",
    "unexpected-fields",
    "malformed",
    "oversized",
    "multiline-token",
    "auth-token",
  ]) {
    it(`rejects ${mode} existing-PR protocol output before any mutation`, async () => {
      const root = await mkdtemp(join(tmpdir(), "rtr-pr-protocol-case-"));
      const childTemp = join(root, "tmp");
      const callLog = join(root, "gh-calls.jsonl");
      await mkdir(childTemp);
      await writeFile(callLog, "");
      const { remote, source } = await makeRepository(root);
      const sourceBefore = await snapshotTree(source);
      const remoteBefore = await snapshotTree(remote);
      const result = await new Promise<{
        status: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          installedBin,
          [
            "generate",
            review,
            "--fixture",
            "injected-clock",
            "--provider",
            "fake",
            "--repo-dir",
            source,
            "--open-pr",
            "--yes",
            "--policy-target",
            "neither",
            "--json",
          ],
          {
            cwd: project,
            env: {
              ...process.env,
              NODE_ENV: "test",
              TMPDIR: childTemp,
              PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
              REVIEW_TO_RULE_BRANCH_PREFIX: `review-to-rule/protocol-${mode}-`,
              RTR_GH_LIST_MODE: mode,
              RTR_GH_CALL_LOG: callLog,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (value: string) => {
          stdout += value;
        });
        child.stderr.setEncoding("utf8").on("data", (value: string) => {
          stderr += value;
        });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      expect(result.status).toBe(4);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.stdout).not.toMatch(/maliciousToken/);
      const parsed = JSON.parse(result.stdout) as {
        schemaVersion: number;
        status: string;
        pullRequestPlan: { branch: string; body: string };
        errors: Array<{ kind: string; remediation: string }>;
      };
      expect(parsed).toMatchObject({
        schemaVersion: 1,
        status: "dependency_failed",
        errors: [{ kind: "dependency_failed" }],
      });
      expect(parsed.pullRequestPlan.branch).toContain(`protocol-${mode}-`);
      expect(parsed.pullRequestPlan.body).toContain("Reviewer intent");
      expect(parsed.errors[0]?.remediation).toMatch(/gh|GitHub/i);
      const calls = (await readFile(callLog, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.slice(0, 2)).toEqual(["pr", "list"]);
      expect(calls.some((args) => args[1] === "create")).toBe(false);
      expect(await snapshotTree(source)).toEqual(sourceBefore);
      expect(await snapshotTree(remote)).toEqual(remoteBefore);
      expect(await readdir(childTemp)).toEqual([]);
    }, 30_000);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`awaits recursive isolated transaction cleanup before ${signal} termination`, async () => {
      const root = await mkdtemp(join(tmpdir(), "rtr-pr-transaction-case-"));
      const childTemp = join(root, "tmp");
      await mkdir(childTemp);
      const { source } = await makeRepository(root);
      const child = spawn(
        installedBin,
        [
          "generate",
          review,
          "--fixture",
          "injected-clock",
          "--provider",
          "fake",
          "--repo-dir",
          source,
          "--open-pr",
          "--yes",
          "--policy-target",
          "neither",
          "--json",
        ],
        {
          cwd: project,
          env: {
            ...process.env,
            NODE_ENV: "test",
            TMPDIR: childTemp,
            PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
            REVIEW_TO_RULE_BRANCH_PREFIX: `review-to-rule/transaction-${signal.toLowerCase()}-`,
            REVIEW_TO_RULE_TEST_TRANSACTION_DELAY_MS: "1000",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.resume();
      child.stderr.resume();
      let observed = false;
      for (let attempt = 0; attempt < 5_000; attempt++) {
        const parents = await readdir(childTemp);
        for (const parent of parents) {
          const output = join(childTemp, parent, "repository/.review-to-rule");
          try {
            const entries = await readdir(output);
            if (entries.some((entry) => entry.startsWith(".transaction-")))
              observed = true;
          } catch {
            // The clone and transaction are still being prepared.
          }
        }
        if (observed) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      expect(observed).toBe(true);
      const closed = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) =>
        child.once("close", (code, exitSignal) =>
          resolve({ code, signal: exitSignal }),
        ),
      );
      child.kill(signal);
      const exit = await closed;
      expect(exit.signal ?? exit.code).not.toBe(0);
      expect(await readdir(childTemp)).toEqual([]);
    }, 30_000);
  }

  for (const phase of [
    "artifact-write",
    "branch-create",
    "commit",
    "push",
    "pr-create",
  ]) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      it(`handles ${signal} after ${phase} without ambiguous state`, async () => {
        const root = await mkdtemp(join(tmpdir(), "rtr-pr-signal-case-"));
        const childTemp = join(root, "tmp");
        await mkdir(childTemp);
        const { remote, source } = await makeRepository(root);
        const branchPrefix = `review-to-rule/${phase}-${signal.toLowerCase()}-`;
        const before = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
          cwd: source,
        });
        const result = await runInterrupted({
          source,
          temp: childTemp,
          phase,
          signal,
          branchPrefix,
        });
        expect(result.exit.signal ?? result.exit.code).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(
          execFileSync("git", ["status", "--porcelain=v1", "-z"], {
            cwd: source,
          }),
        ).toEqual(before);
        const records = result.stderr
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(records).toHaveLength(1);
        const recovery = records[0];
        expect(recovery).toMatchObject({
          schemaVersion: 1,
          status: "interrupted",
          signal,
          phase,
        });
        expect(recovery?.branch).toMatch(branchPrefix);
        if (phase === "artifact-write" || phase === "branch-create") {
          expect(recovery?.isolatedPath).toBeNull();
          expect(recovery?.commit).toBeNull();
          expect(recovery?.pushed).toBe(false);
          expect(await readdir(childTemp)).toEqual([]);
        } else {
          const isolated = recovery?.isolatedPath;
          expect(typeof isolated).toBe("string");
          expect(recovery?.commit).toMatch(/^[0-9a-f]{40}$/);
          expect(
            await readFile(join(String(isolated), ".git/HEAD"), "utf8"),
          ).toContain(String(recovery?.branch));
          if (phase === "push" || phase === "pr-create") {
            expect(recovery?.pushed).toBe(true);
            expect(
              execFileSync(
                "git",
                ["show-ref", `refs/heads/${String(recovery?.branch)}`],
                { cwd: remote, encoding: "utf8" },
              ),
            ).toContain(String(recovery?.commit));
          } else expect(recovery?.pushed).toBe(false);
          if (phase === "pr-create")
            expect(recovery?.pullRequest).toBe(
              "https://github.com/acme/clock/pull/99",
            );
          expect(String(recovery?.recovery)).toMatch(/git|gh pr create/);
          await rm(dirname(String(isolated)), { recursive: true, force: true });
        }
      }, 30_000);
    }
  }
});
