import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  semgrepAvailable,
  semgrepSkipReason,
} from "../semgrep-availability.js";
import { buildPublicCli } from "../build-public-cli.js";

const project = new URL("../..", import.meta.url).pathname;

function run(
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
}

async function snapshotTree(
  root: string,
  relative = "",
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    if (!relative && entry.name === ".git") continue;
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

describe("packed Sprint 2 vertical slice", () => {
  it.skipIf(!semgrepAvailable)(
    semgrepAvailable
      ? "uses the installed bin for recorded GitHub/provider, real Semgrep, write, and replay"
      : semgrepSkipReason,
    async () => {
      const packDirectory = await mkdtemp(join(tmpdir(), "rtr-pack-"));
      await buildPublicCli();
      const packed = JSON.parse(
        execFileSync(
          "npm",
          ["pack", "--json", "--pack-destination", packDirectory],
          { cwd: project, encoding: "utf8" },
        ),
      ) as Array<{ filename: string }>;
      const tarball = join(packDirectory, packed[0]?.filename ?? "missing.tgz");
      const consumer = await mkdtemp(join(tmpdir(), "rtr-consumer-"));
      await writeFile(
        join(consumer, "package.json"),
        '{"name":"packed-consumer","private":true,"type":"module"}\n',
      );
      execFileSync(
        "npm",
        [
          "install",
          "--offline",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          tarball,
        ],
        { cwd: consumer, stdio: "pipe" },
      );
      const installedBin = join(
        consumer,
        "node_modules",
        ".bin",
        "review-to-rule",
      );
      const schemaConsumer = await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import { generationResultSchema,replayResultSchema,scanResultSchema,doctorResultSchema,installCiResultSchema,validateAllResultSchema,pullRequestPlanSchema,debugBundleSchema,publicErrorResultSchema } from 'review-to-rule'; const schemas=[generationResultSchema,replayResultSchema,scanResultSchema,doctorResultSchema,installCiResultSchema,validateAllResultSchema,pullRequestPlanSchema,debugBundleSchema,publicErrorResultSchema]; if(schemas.some(s=>typeof s?.parse!=='function')) process.exit(2); console.log('schemas-ok');",
        ],
        { cwd: consumer, env: process.env },
      );
      expect(schemaConsumer.status).toBe(0);
      expect(schemaConsumer.stdout.trim()).toBe("schemas-ok");
      const repository = join(consumer, "repository");
      execFileSync("git", ["init", "-q", repository]);
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repository,
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: repository,
      });
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://github.com/acme/clock.git"],
        { cwd: repository },
      );
      await writeFile(
        join(repository, "clock.ts"),
        "export const now = () => Date.now();\n",
      );
      execFileSync("git", ["add", "clock.ts"], { cwd: repository });
      execFileSync("git", ["commit", "-qm", "before"], { cwd: repository });
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
      }).trim();
      await writeFile(
        join(repository, "clock.ts"),
        "export const now = (clock: Clock) => clock.now();\n",
      );
      execFileSync("git", ["add", "clock.ts"], { cwd: repository });
      execFileSync("git", ["commit", "-qm", "after"], { cwd: repository });
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
      }).trim();
      const comment = {
        id: 1001,
        body: "Inject Clock instead of calling Date.now directly.",
        path: "clock.ts",
        line: 1,
        side: "RIGHT",
        commit_id: headSha,
        original_commit_id: baseSha,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:05:00Z",
      };
      const shimDirectory = join(consumer, "bin");
      await mkdir(shimDirectory, { recursive: true });
      const ghShim = join(shimDirectory, "gh");
      await writeFile(
        ghShim,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
const endpoint = args.find((arg) => arg.startsWith('/repos/'));
const comment = ${JSON.stringify(comment)};
let body;
if (args[0] === '--version') { process.stdout.write('gh version 2.98.0\\n'); process.exit(0); }
else if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write('authenticated\\n'); process.exit(0); }
else if (args[0] === 'pr' && args[1] === 'list' && process.env.RTR_GH_LIST_MODE === 'auth') { process.stderr.write('authentication required\\n'); process.exit(1); }
else if (args[0] === 'pr' && args[1] === 'list' && process.env.RTR_GH_LIST_MODE === 'malformed') { process.stdout.write('not-json\\n'); process.exit(0); }
else if (args[0] === 'pr' && args[1] === 'list') { process.stdout.write('[]\\n'); process.exit(0); }
else if (args[0] === 'pr' && args[1] === 'create') { process.stdout.write('https://github.com/acme/clock/pull/99\\n'); process.exit(0); }
else if (args.includes('graphql')) body = {data:{repository:{pullRequest:{reviewThreads:{nodes:[{isResolved:true,isOutdated:false,comments:{nodes:[{databaseId:1001}]}}],pageInfo:{hasNextPage:false,endCursor:null}}}}}};
else if (endpoint?.endsWith('/pulls/42')) body = {number:42,state:'closed',merged:true,merged_at:'2026-01-02T00:00:00Z',merge_commit_sha:${JSON.stringify(headSha)},base:{sha:${JSON.stringify(baseSha)}},head:{sha:${JSON.stringify(headSha)}}};
else if (endpoint?.endsWith('/pulls/comments/1001')) body = comment;
else if (endpoint?.includes('/comments?')) body = [[comment]];
else if (endpoint?.includes('/files?')) body = [[{filename:'clock.ts',status:'modified',sha:${JSON.stringify(headSha)},patch:'@@ -1 +1 @@'}]];
else { console.error('unrecorded read-only gh request'); process.exit(2); }
process.stdout.write(JSON.stringify(body));
`,
      );
      await chmod(ghShim, 0o755);
      const decision = {
        enforceable: true,
        category: "API_USAGE",
        reviewerIntent: "Inject Clock instead of calling Date.now directly.",
        prohibitedPattern: "Date.now()",
        preferredPattern: "clock.now()",
        rationale: "A local static API substitution.",
        limitations: [],
        confidence: 0.98,
      };
      const ruleId = "review-to-rule.inject-clock-recorded";
      const yaml = `rules:\n  - id: ${ruleId}\n    message: Inject Clock\n    severity: WARNING\n    languages: [typescript]\n    metadata: {source: review-to-rule, generator: review-to-rule@0.1.0, review: supplied-review}\n    pattern: Date.now()\n    paths:\n      include: [clock.ts]\n      exclude: [node_modules/**, dist/**, build/**, .git/**, "**/generated/**", "**/fixtures/**"]\n`;
      const proposal = {
        id: ruleId,
        title: "Inject Clock",
        message: "Inject Clock",
        language: "typescript",
        severity: "WARNING",
        yaml,
        include: ["clock.ts"],
        exclude: [
          "node_modules/**",
          "dist/**",
          "build/**",
          ".git/**",
          "**/generated/**",
          "**/fixtures/**",
        ],
        rationale: "A local static API substitution.",
        limitations: [],
        confidence: 0.98,
      };
      let providerCalls = 0;
      const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => (body += chunk));
        request.on("end", () => {
          providerCalls++;
          const requestBody = JSON.parse(body) as {
            text?: { format?: { name?: string } };
          };
          const result =
            requestBody.text?.format?.name === "decision" ? decision : proposal;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: `resp_${providerCalls}`,
              object: "response",
              status: "completed",
              output: [
                {
                  id: `msg_${providerCalls}`,
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify(result),
                      annotations: [],
                    },
                  ],
                },
              ],
            }),
          );
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("recorded provider did not bind");
      const config = join(consumer, "recorded.yml");
      await writeFile(
        config,
        `version: 1\nprovider: openai\nmodel: gpt-recorded\nbaseUrl: http://127.0.0.1:${address.port}/v1\n`,
      );
      const environment = {
        ...process.env,
        PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
        OPENAI_API_KEY: "recorded-not-a-secret",
        GITHUB_TOKEN: undefined,
        GH_TOKEN: undefined,
      };
      const reviewUrl =
        "https://github.com/acme/clock/pull/42#discussion_r1001";
      try {
        const collected = await run(
          installedBin,
          ["evidence", reviewUrl, "--json"],
          { cwd: consumer, env: environment },
        );
        if (collected.status !== 0)
          throw new Error(
            `packed evidence failed: ${JSON.stringify(collected)}`,
          );
        expect(JSON.parse(collected.stdout)).toMatchObject({
          schemaVersion: 1,
          status: "success",
          repository: { host: "github.com", owner: "acme", name: "clock" },
          pullRequest: { number: 42, headSha, baseSha },
          review: { id: 1001, path: "clock.ts", resolved: true },
        });
        const commonArgs = [
          "generate",
          reviewUrl,
          "--repo-dir",
          repository,
          "--config",
          config,
          "--json",
        ];
        const dryRun = await run(installedBin, commonArgs, {
          cwd: consumer,
          env: environment,
        });
        expect(dryRun.status).toBe(0);
        const preview = JSON.parse(dryRun.stdout) as {
          source: {
            pullRequest: { mergeSha: string };
            review: { path: string };
          };
          writtenFiles: string[];
        };
        expect(preview.source.pullRequest.mergeSha).toBe(headSha);
        expect(preview.source.review.path).toBe("clock.ts");
        expect(preview.writtenFiles).toEqual([]);
        const written = await run(
          installedBin,
          [
            ...commonArgs.slice(0, -1),
            "--write",
            "--yes",
            "--policy-target",
            "agents",
            "--json",
          ],
          { cwd: consumer, env: environment },
        );
        expect(written.status).toBe(0);
        const result = JSON.parse(written.stdout) as {
          plannedFiles: string[];
          writtenFiles: string[];
        };
        expect(result.writtenFiles).toContain("AGENTS.md");
        const manifestPath = result.plannedFiles.find((path) =>
          path.includes("/manifests/"),
        );
        expect(manifestPath).toBeTruthy();
        expect(await readFile(join(repository, "AGENTS.md"), "utf8")).toContain(
          `review-to-rule replay '${manifestPath}'`,
        );
        const replay = await run(
          installedBin,
          [
            "replay",
            manifestPath ?? "missing",
            "--repo-dir",
            repository,
            "--json",
          ],
          { cwd: consumer, env: environment },
        );
        expect(replay.status).toBe(0);
        expect(JSON.parse(replay.stdout)).toMatchObject({
          schemaVersion: 1,
          status: "success",
          manifestPath,
        });
        const rulePath = result.plannedFiles.find((path) =>
          path.endsWith(".yml"),
        );
        for (const artifactPath of [manifestPath, rulePath]) {
          const validated = await run(
            installedBin,
            [
              "validate",
              artifactPath ?? "missing",
              "--repo-dir",
              repository,
              "--json",
            ],
            { cwd: consumer, env: environment },
          );
          expect(validated.status).toBe(0);
          expect(
            (JSON.parse(validated.stdout) as { status: string }).status,
          ).toBe("success");
        }
        const validateAll = await run(
          installedBin,
          ["validate-all", "--repo-dir", repository, "--json"],
          { cwd: consumer, env: environment },
        );
        expect(validateAll.status).toBe(0);
        expect(JSON.parse(validateAll.stdout)).toMatchObject({
          schemaVersion: 1,
          status: "success",
          unownedRules: [],
        });
        const scan = await run(
          installedBin,
          ["scan", rulePath ?? "missing", "--repo-dir", repository, "--json"],
          { cwd: consumer, env: environment },
        );
        expect(scan.status).toBe(0);
        expect(JSON.parse(scan.stdout)).toMatchObject({
          schemaVersion: 1,
          status: "success",
          rulePath,
        });
        const ciPreview = await run(
          installedBin,
          ["install-ci", "--repo-dir", repository, "--json"],
          { cwd: consumer, env: environment },
        );
        expect(ciPreview.status).toBe(0);
        expect(JSON.parse(ciPreview.stdout)).toMatchObject({
          action: "create",
          written: false,
        });
        const ciWrite = await run(
          installedBin,
          [
            "install-ci",
            "--repo-dir",
            repository,
            "--write",
            "--yes",
            "--json",
          ],
          { cwd: consumer, env: environment },
        );
        expect(ciWrite.status).toBe(0);
        expect(
          (JSON.parse(ciWrite.stdout) as { written: boolean }).written,
        ).toBe(true);
        const doctor = await run(
          installedBin,
          ["doctor", "--repo-dir", repository, "--config", config, "--json"],
          { cwd: consumer, env: environment },
        );
        expect(doctor.status).toBe(0);
        expect((JSON.parse(doctor.stdout) as { status: string }).status).toBe(
          "success",
        );
        const bundleFailure = await run(
          installedBin,
          [
            "doctor",
            "--json",
            "--debug-bundle",
            "packed-diagnostics/failure.json",
            "--yes",
          ],
          {
            cwd: consumer,
            env: {
              ...environment,
              NODE_ENV: "test",
              REVIEW_TO_RULE_TEST_DEBUG_BUNDLE_FAILURE: "after-write",
            },
          },
        );
        expect(bundleFailure.status).toBe(5);
        expect(bundleFailure.stderr).toBe("");
        expect(bundleFailure.stdout.trim().split("\n")).toHaveLength(1);
        expect(JSON.parse(bundleFailure.stdout)).toMatchObject({
          schemaVersion: 1,
          status: "unsafe_repository",
          errors: [{ kind: "unsafe_repository" }],
        });
        await expect(
          readFile(join(consumer, "packed-diagnostics/failure.json")),
        ).rejects.toThrow();
        await expect(
          readdir(join(consumer, "packed-diagnostics")),
        ).rejects.toThrow();
        const bundleSuccess = await run(
          installedBin,
          [
            "doctor",
            "--json",
            "--debug-bundle",
            "packed-diagnostics/success.json",
            "--yes",
          ],
          {
            cwd: consumer,
            env: {
              ...environment,
              OPENAI_API_KEY: "seeded-secret-must-not-appear",
            },
          },
        );
        expect(bundleSuccess.stdout.trim().split("\n")).toHaveLength(1);
        expect(
          await readFile(
            join(consumer, "packed-diagnostics/success.json"),
            "utf8",
          ),
        ).not.toContain("seeded-secret-must-not-appear");
        for (const [path, expectedStatus] of [
          ["../escape.json", 5],
          ["packed-diagnostics/success.json", 5],
          ["packed-diagnostics/declined.json", 5],
        ] as const) {
          const args = ["doctor", "--json", "--debug-bundle", path];
          if (!path.endsWith("declined.json")) args.push("--yes");
          const unsafe = await run(installedBin, args, {
            cwd: consumer,
            env: environment,
          });
          expect(unsafe.status, path).toBe(expectedStatus);
          expect(unsafe.stderr, path).toBe("");
          expect(unsafe.stdout.trim().split("\n"), path).toHaveLength(1);
        }
        const prRemote = join(consumer, "pr-remote.git");
        const prSource = join(consumer, "pr-source");
        execFileSync("git", ["init", "--bare", "-q", prRemote]);
        execFileSync("git", ["init", "-q", prSource]);
        execFileSync("git", ["config", "user.email", "test@example.com"], {
          cwd: prSource,
        });
        execFileSync("git", ["config", "user.name", "Test"], {
          cwd: prSource,
        });
        await writeFile(join(prSource, "README.md"), "source\n");
        execFileSync("git", ["add", "README.md"], { cwd: prSource });
        execFileSync("git", ["commit", "-qm", "initial"], { cwd: prSource });
        execFileSync("git", ["branch", "-M", "main"], { cwd: prSource });
        execFileSync("git", ["remote", "add", "origin", prRemote], {
          cwd: prSource,
        });
        execFileSync("git", ["push", "-q", "-u", "origin", "main"], {
          cwd: prSource,
        });
        execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
          cwd: prRemote,
        });
        await writeFile(join(prSource, "dirty.txt"), "preserve me\n");
        const sourceBefore = await snapshotTree(prSource);
        for (const target of ["agents", "claude", "both", "neither"]) {
          const policyDryRun = await run(
            installedBin,
            [
              "generate",
              reviewUrl,
              "--fixture",
              "injected-clock",
              "--provider",
              "fake",
              "--repo-dir",
              prSource,
              "--policy-target",
              target,
              "--json",
            ],
            { cwd: consumer, env: environment },
          );
          expect(policyDryRun.status, target).toBe(0);
          expect(
            (
              JSON.parse(policyDryRun.stdout) as {
                preview: { policyTarget: string };
              }
            ).preview.policyTarget,
          ).toBe(target);
        }
        for (const mode of ["auth", "malformed"]) {
          const preflightFailure = await run(
            installedBin,
            [
              "generate",
              reviewUrl,
              "--fixture",
              "injected-clock",
              "--provider",
              "fake",
              "--repo-dir",
              prSource,
              "--open-pr",
              "--yes",
              "--policy-target",
              "neither",
              "--json",
            ],
            {
              cwd: consumer,
              env: { ...environment, RTR_GH_LIST_MODE: mode },
            },
          );
          expect(preflightFailure.status, mode).toBe(4);
          const parsedPreflight = JSON.parse(preflightFailure.stdout) as Record<
            string,
            unknown
          >;
          expect(parsedPreflight, mode).toMatchObject({
            schemaVersion: 1,
            status: "dependency_failed",
            errors: [{ kind: "dependency_failed" }],
          });
          const preflightPlan = parsedPreflight.pullRequestPlan as {
            branch: string;
            body: string;
          };
          expect(preflightPlan.branch, mode).toMatch(/^review-to-rule\//);
          expect(preflightPlan.body, mode).toContain("Reviewer intent");
          expect(await snapshotTree(prSource)).toEqual(sourceBefore);
        }
        const opened = await run(
          installedBin,
          [
            "generate",
            reviewUrl,
            "--fixture",
            "injected-clock",
            "--provider",
            "fake",
            "--repo-dir",
            prSource,
            "--open-pr",
            "--yes",
            "--policy-target",
            "neither",
            "--json",
          ],
          { cwd: consumer, env: environment },
        );
        expect(opened.status).toBe(0);
        expect(
          (
            JSON.parse(opened.stdout) as {
              pullRequest: string;
              pullRequestPlan: { body: string; pushRefspec: string };
            }
          ).pullRequest,
        ).toBe("https://github.com/acme/clock/pull/99");
        const openedResult = JSON.parse(opened.stdout) as {
          pullRequestPlan: { body: string; pushRefspec: string };
        };
        for (const heading of [
          "Reviewer intent",
          "Bounded correction",
          "Validation",
          "Current matches",
          "Limitations",
          "Provenance",
          "human review required",
        ])
          expect(openedResult.pullRequestPlan.body).toContain(heading);
        expect(openedResult.pullRequestPlan.pushRefspec).toMatch(
          /^HEAD:refs\/heads\/review-to-rule\//,
        );
        expect(await snapshotTree(prSource)).toEqual(sourceBefore);
        const repeatedOpen = await run(
          installedBin,
          [
            "generate",
            reviewUrl,
            "--fixture",
            "injected-clock",
            "--provider",
            "fake",
            "--repo-dir",
            prSource,
            "--open-pr",
            "--yes",
            "--policy-target",
            "neither",
            "--json",
          ],
          { cwd: consumer, env: environment },
        );
        expect(repeatedOpen.status).toBe(5);
        expect(JSON.parse(repeatedOpen.stdout)).toMatchObject({
          schemaVersion: 1,
          status: "unsafe_repository",
        });
        expect(await snapshotTree(prSource)).toEqual(sourceBefore);
        const packedUsage = await run(
          installedBin,
          ["validate-all", "one", "two", "--json"],
          { cwd: consumer, env: environment },
        );
        expect(packedUsage.status).toBe(6);
        expect(packedUsage.stderr).toBe("");
        expect(packedUsage.stdout.trim().split("\n")).toHaveLength(1);
        const manifestAbsolute = join(repository, manifestPath ?? "missing");
        const pristineManifest = await readFile(manifestAbsolute, "utf8");
        const parsedManifest = JSON.parse(pristineManifest) as {
          generatorVersion: string;
          ruleId: string;
          source: { url: string; identity: string };
          approval: {
            mode: string;
            policyTarget: string;
            policyExplicit: boolean;
          };
          ownedFiles: string[];
          writtenFiles: Array<{ path: string; sha256: string }>;
        };
        const evidenceRecord = parsedManifest.writtenFiles.find((record) =>
          record.path.includes("/evidence/"),
        );
        const policyRecord = parsedManifest.writtenFiles.find(
          (record) => record.path === "AGENTS.md",
        );
        const beforeRecord = parsedManifest.writtenFiles.find((record) =>
          /\/before\.(?:ts|js|py)$/.test(record.path),
        );
        expect(evidenceRecord && policyRecord && beforeRecord).toBeTruthy();
        const evidenceAbsolute = join(
          repository,
          evidenceRecord?.path ?? "missing",
        );
        const pristineEvidence = await readFile(evidenceAbsolute, "utf8");
        const policyAbsolute = join(
          repository,
          policyRecord?.path ?? "missing",
        );
        const pristinePolicy = await readFile(policyAbsolute, "utf8");
        const corruptions: Array<{
          name: string;
          apply: (manifest: typeof parsedManifest) => Promise<void> | void;
        }> = [
          {
            name: "mismatched rule ID",
            apply: (manifest) => {
              manifest.ruleId = "review-to-rule.mismatched";
            },
          },
          {
            name: "omitted evidence hash",
            apply: (manifest) => {
              manifest.writtenFiles = manifest.writtenFiles.filter(
                (record) => record.path !== evidenceRecord?.path,
              );
            },
          },
          {
            name: "omitted selected policy hash",
            apply: (manifest) => {
              manifest.writtenFiles = manifest.writtenFiles.filter(
                (record) => record.path !== policyRecord?.path,
              );
            },
          },
          {
            name: "wrong fixture artifact ID and root",
            apply: (manifest) => {
              const replacement = ".review-to-rule/fixtures/wrong/before.ts";
              manifest.ownedFiles = manifest.ownedFiles.map((path) =>
                path === beforeRecord?.path ? replacement : path,
              );
              manifest.writtenFiles = manifest.writtenFiles.map((record) =>
                record.path === beforeRecord?.path
                  ? { ...record, path: replacement }
                  : record,
              );
            },
          },
          {
            name: "unowned hash",
            apply: (manifest) => {
              manifest.writtenFiles.push({
                path: "foreign.txt",
                sha256: "0".repeat(64),
              });
            },
          },
          {
            name: "duplicate path",
            apply: (manifest) => {
              const duplicate = manifest.writtenFiles[0];
              if (duplicate) manifest.writtenFiles.push({ ...duplicate });
            },
          },
          {
            name: "malformed versioned evidence",
            apply: async (manifest) => {
              const malformed = '{"schemaVersion":1}\n';
              await writeFile(evidenceAbsolute, malformed);
              const record = manifest.writtenFiles.find(
                (item) => item.path === evidenceRecord?.path,
              );
              if (record)
                record.sha256 = createHash("sha256")
                  .update(malformed)
                  .digest("hex");
            },
          },
          {
            name: "implicit selected policy consent",
            apply: (manifest) => {
              manifest.approval.policyExplicit = false;
            },
          },
          {
            name: "redirected managed policy pointer with adjusted hash",
            apply: async (manifest) => {
              const redirected = pristinePolicy.replaceAll(
                manifestPath ?? "missing",
                ".review-to-rule/manifests/redirected.json",
              );
              await writeFile(policyAbsolute, redirected);
              const record = manifest.writtenFiles.find(
                (item) => item.path === policyRecord?.path,
              );
              if (record)
                record.sha256 = createHash("sha256")
                  .update(redirected)
                  .digest("hex");
            },
          },
          {
            name: "unsupported source host with adjusted identity",
            apply: (manifest) => {
              manifest.source.url =
                "https://example.com/acme/clock/pull/42#discussion_r1001";
              manifest.source.identity = "example.com/acme/clock#1001";
            },
          },
          {
            name: "blank generator version",
            apply: (manifest) => {
              manifest.generatorVersion = "";
            },
          },
          {
            name: "malformed generator version",
            apply: (manifest) => {
              manifest.generatorVersion = "version-one";
            },
          },
          {
            name: "source and evidence review identity mismatch",
            apply: (manifest) => {
              manifest.source.url =
                "https://github.com/acme/clock/pull/42#discussion_r1002";
              manifest.source.identity = "github.com/acme/clock#1002";
            },
          },
        ];
        for (const corruption of corruptions) {
          const corrupted = JSON.parse(
            pristineManifest,
          ) as typeof parsedManifest;
          await corruption.apply(corrupted);
          await writeFile(
            manifestAbsolute,
            `${JSON.stringify(corrupted, null, 2)}\n`,
          );
          const beforeReplay = await snapshotTree(repository);
          const refused = await run(
            installedBin,
            [
              "replay",
              manifestPath ?? "missing",
              "--repo-dir",
              repository,
              "--json",
            ],
            { cwd: consumer, env: environment },
          );
          expect(refused.status, corruption.name).toBe(3);
          expect(JSON.parse(refused.stdout), corruption.name).toMatchObject({
            schemaVersion: 1,
            status: "validation_failed",
            verifiedFiles: [],
          });
          expect(await snapshotTree(repository), corruption.name).toEqual(
            beforeReplay,
          );
          await writeFile(manifestAbsolute, pristineManifest);
          await writeFile(evidenceAbsolute, pristineEvidence);
          await writeFile(policyAbsolute, pristinePolicy);
        }
        const external = join(consumer, "external-evidence.json");
        await writeFile(external, pristineEvidence);
        await rm(evidenceAbsolute);
        await symlink(external, evidenceAbsolute);
        const beforeSymlinkReplay = await snapshotTree(repository);
        const externalBefore = await readFile(external);
        const symlinkRefused = await run(
          installedBin,
          [
            "replay",
            manifestPath ?? "missing",
            "--repo-dir",
            repository,
            "--json",
          ],
          { cwd: consumer, env: environment },
        );
        expect(symlinkRefused.status).toBe(3);
        expect(JSON.parse(symlinkRefused.stdout)).toMatchObject({
          schemaVersion: 1,
          status: "validation_failed",
          verifiedFiles: [],
        });
        expect(await snapshotTree(repository)).toEqual(beforeSymlinkReplay);
        expect(await readFile(external)).toEqual(externalBefore);
        await rm(evidenceAbsolute);
        await writeFile(evidenceAbsolute, pristineEvidence);
        const repeated = await run(
          installedBin,
          [
            ...commonArgs.slice(0, -1),
            "--write",
            "--yes",
            "--policy-target",
            "agents",
            "--json",
          ],
          { cwd: consumer, env: environment },
        );
        expect(repeated.status).toBe(0);
        const repeatedResult = JSON.parse(repeated.stdout) as {
          writtenFiles: string[];
          preview: {
            collision: string;
            policyFiles: Array<{ action: string }>;
          };
        };
        expect(repeatedResult.preview.collision).toBe("replace_same_source");
        expect(repeatedResult.preview.policyFiles[0]?.action).toBe("unchanged");
        expect(repeatedResult.writtenFiles).not.toContain("AGENTS.md");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      expect(providerCalls).toBe(6);
    },
    300_000,
  );
});
