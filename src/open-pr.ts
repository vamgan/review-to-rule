import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  DependencyError,
  ExitCode,
  UnsafeRepositoryError,
  ValidationError,
} from "./domain/errors.js";
import {
  generationResultSchema,
  pullRequestPlanSchema,
  type GenerationResult,
  type PullRequestPlan,
} from "./domain/schemas.js";
import { parseReviewUrl } from "./github/url.js";
import { generate, type GenerateOptions } from "./pipeline.js";
import { redact } from "./security/redact.js";
import type { CommandRunner } from "./utils/command.js";

export { pullRequestPlanSchema };
const existingPullRequestListSchema = z
  .array(
    z
      .object({
        url: z
          .string()
          .max(500)
          .regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/),
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        headRefName: z.string().min(1).max(255),
      })
      .strict(),
  )
  .max(100);
const MAX_GH_PR_LIST_BYTES = 64 * 1024;
export interface OpenPrOutcome {
  result: GenerationResult;
  exitCode: number;
  plan: PullRequestPlan;
}

async function requiredRun(
  runner: CommandRunner,
  binary: "git" | "gh",
  args: string[],
  cwd: string,
) {
  const result = await runner.run(binary, args, {
    cwd,
    env: { HUSKY: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.exitCode !== 0)
    throw new ValidationError(
      `${binary} ${args[0] ?? "command"} failed: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}
const bounded = (value: string | undefined, max = 1_200) =>
  redact(value ?? "(none)")
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "[HOME]")
    .slice(0, max);
const boundedProtocolDiagnostic = (value: string | undefined) =>
  redact(value ?? "")
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "[HOME]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 500) || "no diagnostic was returned";
function safeBranch(prefix: string, ruleId: string): string {
  const branch = `${prefix}${ruleId.replace(/^review-to-rule\./, "")}`.replace(
    /\/{2,}/g,
    "/",
  );
  if (!/^(?!\/)(?!.*\.\.)(?!.*\/$)[A-Za-z0-9._/-]+$/.test(branch))
    throw new UnsafeRepositoryError("Configured PR branch name is unsafe.");
  return branch;
}
function bodyFor(result: GenerationResult, reviewUrl: string) {
  const checks =
    result.validation?.checks.map(
      (check) =>
        `- ${check.status.toUpperCase()} ${bounded(check.name, 120)}: ${bounded(check.diagnostic, 300)}`,
    ) ?? [];
  const matches = result.matches
    .slice(0, 50)
    .map(
      (match) =>
        `- ${bounded(match.path, 240)}:${match.startLine}-${match.endLine} ${bounded(match.message, 240)}`,
    );
  return [
    "## Machine-generated Semgrep guardrail — human review required",
    "",
    `Source review: ${bounded(reviewUrl, 500)}`,
    "",
    "### Reviewer intent",
    bounded(result.enforceability?.reviewerIntent, 1_000),
    "",
    "### Bounded correction",
    "Before:",
    "```",
    bounded(result.correction?.before),
    "```",
    "After:",
    "```",
    bounded(result.correction?.after),
    "```",
    "",
    "### Validation",
    ...(checks.length ? checks : ["- No validation checks recorded."]),
    "",
    "### Current matches",
    ...(matches.length ? matches : ["- None."]),
    "",
    "### Limitations",
    ...(result.rule?.limitations.map((item) => `- ${bounded(item, 500)}`) ?? [
      "- None recorded.",
    ]),
    "",
    "### Provenance",
    ...(result.source?.provenance.map((item) => `- ${bounded(item, 500)}`) ?? [
      "- None recorded.",
    ]),
    "",
    "### Storage and revalidation",
    "Canonical rules, evidence, fixtures, and manifests live in `.review-to-rule`.",
    "Run `review-to-rule validate-all .review-to-rule` and `review-to-rule scan <rule-path> .` before approval.",
    "",
    "This pull request was machine-generated. A human maintainer must inspect the evidence, scope, matches, and limitations before merging.",
  ]
    .join("\n")
    .slice(0, 12_000);
}
function unsafeOutcome(
  dry: GenerationResult,
  plan: PullRequestPlan,
  message: string,
  remediation?: string,
): OpenPrOutcome {
  const error = new UnsafeRepositoryError(message, remediation);
  return {
    exitCode: ExitCode.unsafeRepository,
    plan,
    result: generationResultSchema.parse({
      ...dry,
      status: "unsafe_repository",
      pullRequestPlan: plan,
      approval: { mode: "interactive", confirmed: false },
      errors: [
        {
          kind: error.kind,
          message: error.message,
          remediation: error.remediation,
        },
      ],
    }),
  };
}
function dependencyOutcome(
  dry: GenerationResult,
  plan: PullRequestPlan,
  message: string,
): OpenPrOutcome {
  const error = new DependencyError(
    message,
    "Check gh authentication, network access, and GitHub permissions; no clone or mutation occurred.",
  );
  return {
    exitCode: ExitCode.configuration,
    plan,
    result: generationResultSchema.parse({
      ...dry,
      status: "dependency_failed",
      pullRequestPlan: plan,
      errors: [
        {
          kind: error.kind,
          message: error.message,
          remediation: error.remediation,
        },
      ],
    }),
  };
}

export async function openPullRequest(input: {
  reviewUrl: string;
  sourceRepositoryDir: string;
  runner: CommandRunner;
  generateOptions: GenerateOptions;
  branchPrefix: string;
  labels: string[];
  approved: boolean;
  confirm?: (preview: string) => Promise<boolean>;
}): Promise<OpenPrOutcome> {
  const source = resolve(input.sourceRepositoryDir);
  const origin = await requiredRun(
    input.runner,
    "git",
    ["config", "--get", "remote.origin.url"],
    source,
  );
  const base =
    (await requiredRun(
      input.runner,
      "git",
      ["branch", "--show-current"],
      source,
    )) || "main";
  const dry = await generate(input.reviewUrl, {
    ...input.generateOptions,
    repositoryDir: source,
    write: false,
    yes: false,
  });
  if (dry.exitCode !== 0 || !dry.result.rule) {
    const emptyPlan = pullRequestPlanSchema.parse({
      schemaVersion: 1,
      branch: `${input.branchPrefix}unavailable`,
      base,
      title: "Unavailable",
      body: "Generation did not produce a rule.",
      labels: input.labels,
      remote: redact(origin),
      pushRefspec: "",
      artifactPaths: [],
      artifacts: [],
      policyDiffs: [],
    });
    return {
      result: { ...dry.result, pullRequestPlan: emptyPlan },
      exitCode: dry.exitCode,
      plan: emptyPlan,
    };
  }
  const branch = safeBranch(input.branchPrefix, dry.result.rule.id);
  const parsed = parseReviewUrl(input.reviewUrl);
  const title = `Add Semgrep guardrail for ${dry.result.rule.id}`;
  const plan = pullRequestPlanSchema.parse({
    schemaVersion: 1,
    branch,
    base,
    title,
    body: bodyFor(dry.result, input.reviewUrl),
    labels: [...input.labels].sort(),
    remote: redact(origin),
    pushRefspec: `HEAD:refs/heads/${branch}`,
    artifactPaths: [...dry.result.plannedFiles].sort(),
    artifacts: (dry.result.preview?.artifacts ?? []).map((item) => ({
      path: item.path,
      action: item.action,
      sha256: item.sha256,
    })),
    policyDiffs: (dry.result.preview?.policyFiles ?? []).map((item) => ({
      path: item.path,
      diff: item.diff,
    })),
  });
  const preview = [
    "Complete pull-request mutation preview (no clone has been created):",
    `- branch: ${plan.branch}`,
    `- base: ${plan.base}`,
    `- remote: ${plan.remote}`,
    `- push: ${plan.pushRefspec}`,
    `- commit: ${plan.title}`,
    `- labels: ${plan.labels.join(", ") || "none"}`,
    "- artifacts:",
    ...plan.artifacts.map(
      (item) => `  - ${item.action} ${item.path} ${item.sha256}`,
    ),
    ...plan.policyDiffs.flatMap((item) => [
      `- policy diff ${item.path}:`,
      item.diff,
    ]),
    "- pull request body:",
    plan.body,
  ].join("\n");
  if (!input.approved && !(await input.confirm?.(preview)))
    return unsafeOutcome(
      dry.result,
      plan,
      "Pull-request creation declined; no clone, branch, commit, push, or PR was created.",
    );

  const existingRemote = await requiredRun(
    input.runner,
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    source,
  );
  const listedResult = await input.runner.run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      `${parsed.owner}/${parsed.repository}`,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "url,state,headRefName",
    ],
    { cwd: source },
  );
  if (listedResult.exitCode !== 0)
    return dependencyOutcome(
      dry.result,
      plan,
      `GitHub PR preflight failed: ${boundedProtocolDiagnostic(listedResult.stderr || listedResult.stdout)}`,
    );
  const listedBytes = Buffer.byteLength(listedResult.stdout, "utf8");
  const listed = listedResult.stdout.trim();
  if (
    listedBytes > MAX_GH_PR_LIST_BYTES ||
    listed.length === 0 ||
    listed.includes("\n") ||
    listed.includes("\r")
  )
    return dependencyOutcome(
      dry.result,
      plan,
      "GitHub CLI returned an empty, multiline, or oversized existing-PR response.",
    );
  let parsedExisting: unknown;
  try {
    parsedExisting = JSON.parse(listed);
  } catch {
    return dependencyOutcome(
      dry.result,
      plan,
      "GitHub CLI returned malformed existing-PR state.",
    );
  }
  const existing = existingPullRequestListSchema.safeParse(parsedExisting);
  if (!existing.success)
    return dependencyOutcome(
      dry.result,
      plan,
      "GitHub CLI returned existing-PR state with an unsupported protocol shape.",
    );
  if (existing.data.length)
    return unsafeOutcome(
      dry.result,
      plan,
      `A pull request already exists for ${branch}; no clone or duplicate was created.`,
      `Open the existing PR returned by: gh pr list --repo ${parsed.owner}/${parsed.repository} --head ${branch}.`,
    );
  if (existingRemote)
    return unsafeOutcome(
      dry.result,
      plan,
      `Remote branch already exists: ${branch}; no clone or duplicate was created.`,
      `Inspect it with git ls-remote origin refs/heads/${branch}; if no PR exists, run gh pr create --repo ${parsed.owner}/${parsed.repository} --head ${branch} --base ${base}.`,
    );

  const parent = await mkdtemp(join(tmpdir(), "review-to-rule-pr-"));
  const isolated = join(parent, "repository");
  let committed = false;
  let pushed = false;
  let commit = "";
  let pullRequestUrl: string | null = null;
  let interrupted: NodeJS.Signals | undefined;
  const handlers: Array<[NodeJS.Signals, () => void]> = [];
  const disarm = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    handlers.length = 0;
  };
  const arm = () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        interrupted ??= signal;
      };
      handlers.push([signal, handler]);
      process.on(signal, handler);
    }
  };
  const pauseForPublicSignalTest = async (phase: string) => {
    if (
      process.env.NODE_ENV !== "test" ||
      process.env.REVIEW_TO_RULE_TEST_PR_SIGNAL_PHASE !== phase
    )
      return;
    const delay = Number(
      process.env.REVIEW_TO_RULE_TEST_PR_SIGNAL_DELAY_MS ?? 1_000,
    );
    if (!Number.isFinite(delay) || delay < 1 || delay > 2_000) return;
    process.stderr.write(`review-to-rule-test-phase:${phase}\n`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  };
  const checkpoint = async (phase: string): Promise<void> => {
    await pauseForPublicSignalTest(phase);
    if (!interrupted) return;
    const signal = interrupted;
    disarm();
    if (!committed) await rm(parent, { recursive: true, force: true });
    const steps = committed
      ? pushed
        ? `gh pr create --repo ${parsed.owner}/${parsed.repository} --head ${branch} --base ${base}`
        : `git -C '${isolated}' push origin '${plan.pushRefspec}' && gh pr create --repo ${parsed.owner}/${parsed.repository} --head ${branch} --base ${base}`
      : "No recovery command is needed; temporary state was removed.";
    process.stderr.write(
      `${JSON.stringify({ schemaVersion: 1, status: "interrupted", signal, phase, isolatedPath: committed ? isolated : null, branch, commit: committed ? commit : null, pushed, pullRequest: pullRequestUrl, recovery: steps })}\n`,
    );
    process.kill(process.pid, signal);
    await new Promise<void>(() => undefined);
  };
  arm();
  try {
    await requiredRun(
      input.runner,
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--no-local",
        "--no-hardlinks",
        origin,
        isolated,
      ],
      parent,
    );
    await checkpoint("clone");
    disarm();
    const written = await generate(input.reviewUrl, {
      ...input.generateOptions,
      repositoryDir: isolated,
      write: true,
      yes: true,
      onInterrupt: async () => rm(parent, { recursive: true, force: true }),
    });
    arm();
    if (written.exitCode !== 0) {
      disarm();
      await rm(parent, { recursive: true, force: true });
      return {
        result: { ...written.result, pullRequestPlan: plan },
        exitCode: written.exitCode,
        plan,
      };
    }
    await checkpoint("artifact-write");
    const actual = [...written.result.writtenFiles].sort();
    if (JSON.stringify(actual) !== JSON.stringify(plan.artifactPaths))
      throw new UnsafeRepositoryError(
        "Written artifact set differed from the approved PR plan.",
      );
    await requiredRun(
      input.runner,
      "git",
      ["-c", "core.hooksPath=/dev/null", "checkout", "-b", branch],
      isolated,
    );
    await checkpoint("branch-create");
    await requiredRun(input.runner, "git", ["add", "--", ...actual], isolated);
    const staged = (
      await requiredRun(
        input.runner,
        "git",
        ["diff", "--cached", "--name-only", "--"],
        isolated,
      )
    )
      .split("\n")
      .filter(Boolean)
      .sort();
    if (JSON.stringify(staged) !== JSON.stringify(actual))
      throw new UnsafeRepositoryError(
        "Staged files differed from the approved artifact set.",
      );
    await requiredRun(
      input.runner,
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "-m",
        title,
        "--no-verify",
      ],
      isolated,
    );
    commit = await requiredRun(
      input.runner,
      "git",
      ["rev-parse", "HEAD"],
      isolated,
    );
    committed = true;
    await checkpoint("commit");
    await requiredRun(
      input.runner,
      "git",
      ["-c", "core.hooksPath=/dev/null", "push", "origin", plan.pushRefspec],
      isolated,
    );
    pushed = true;
    await checkpoint("push");
    const ghArgs = [
      "pr",
      "create",
      "--repo",
      `${parsed.owner}/${parsed.repository}`,
      "--head",
      branch,
      "--base",
      base,
      "--title",
      title,
      "--body",
      plan.body,
    ];
    for (const label of plan.labels) ghArgs.push("--label", label);
    const url = await requiredRun(input.runner, "gh", ghArgs, isolated);
    pullRequestUrl = url;
    await checkpoint("pr-create");
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url))
      throw new ValidationError(
        "GitHub CLI did not return a supported pull-request URL.",
      );
    disarm();
    await rm(parent, { recursive: true, force: true });
    return {
      result: generationResultSchema.parse({
        ...written.result,
        pullRequest: url,
        pullRequestPlan: plan,
        nextCommand: null,
      }),
      exitCode: 0,
      plan,
    };
  } catch (error) {
    if (interrupted) await checkpoint("failure");
    disarm();
    if (!committed) await rm(parent, { recursive: true, force: true });
    const steps = pushed
      ? `gh pr create --repo ${parsed.owner}/${parsed.repository} --head ${branch} --base ${base}`
      : `git -C '${isolated}' push origin '${plan.pushRefspec}' && gh pr create --repo ${parsed.owner}/${parsed.repository} --head ${branch} --base ${base}`;
    const recovery = committed
      ? `Isolated recovery checkout retained at ${isolated}. Branch ${branch}; commit ${commit}; remote pushed: ${pushed ? "yes" : "no"}. Retry without force: ${steps}`
      : "No commit or remote branch was created; temporary state was removed.";
    throw new UnsafeRepositoryError(
      `${redact(error instanceof Error ? error.message : String(error))} ${recovery}`,
    );
  }
}
