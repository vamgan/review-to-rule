import { createHash } from "node:crypto";
import {
  generationResultSchema,
  type GenerationResult,
} from "./domain/memory.js";
import {
  DomainError,
  RefusalError,
  UnsafeRepositoryError,
  ValidationError,
  type ExitCodeValue,
} from "./domain/errors.js";
import {
  reviewMemoryBundleSchema,
  reviewMemoryBundleToEvidence,
  type ReviewMemoryBundle,
} from "./review-memory-bundle.js";
import { GitCommandRunner, type CommandRunner } from "./utils/command.js";
import {
  commitTransaction,
  recoverPendingTransactions,
} from "./transaction.js";
import { planMemoryArtifacts } from "./memory-artifacts.js";
import {
  discoverMemoryPolicy,
  planManagedMemoryUpdate,
  resolveMemoryPolicyPaths,
} from "./memory-policy.js";
import type { PolicyTarget } from "./memory-core-config.js";
import { validateAgentReviewRule } from "./rules/validate.js";
import { canonicalReviewSourceIdentity } from "./source.js";
import { normalizeGitRemote } from "./repository.js";

export interface ConfirmationPort {
  isTTY: boolean;
  confirm(summary: string): Promise<boolean>;
}

export interface Outcome {
  result: GenerationResult;
  exitCode: ExitCodeValue;
}

export interface ApplyMemoryOptions {
  repositoryDir: string;
  repositorySource?: string;
  runner?: CommandRunner;
  write?: boolean;
  yes?: boolean;
  outputDir?: string;
  policyTarget?: PolicyTarget;
  policyTargetExplicit?: boolean;
  agentsPath?: string;
  claudePath?: string;
  confidenceFloor?: number;
  confirmation?: ConfirmationPort;
  providerInfo?: { name: string; model: string };
  invocation: string;
  warnings?: string[];
  allowOpenReview?: boolean;
  allowUnresolved?: boolean;
  onInterrupt?: () => Promise<void>;
}

type FailureContext = Omit<
  GenerationResult,
  "schemaVersion" | "status" | "errors"
>;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function statusForError(error: DomainError): GenerationResult["status"] {
  return error.code === 2
    ? "refused"
    : error.code === 3
      ? "validation_failed"
      : error.code === 4
        ? "dependency_failed"
        : error.code === 5
          ? "unsafe_repository"
          : error.code === 6
            ? "unsupported"
            : "internal_error";
}

function emptyResult(
  status: GenerationResult["status"],
  error?: DomainError,
): GenerationResult {
  return generationResultSchema.parse({
    schemaVersion: 2,
    status,
    source: null,
    correction: null,
    applicability: null,
    rule: null,
    validation: null,
    plannedFiles: [],
    writtenFiles: [],
    pullRequest: null,
    pullRequestPlan: null,
    nextCommand: null,
    warnings: [],
    errors: error
      ? [
          {
            kind: error.kind,
            message: error.message,
            remediation: error.remediation,
          },
        ]
      : [],
    preview: null,
    approval: null,
  });
}

export function errorOutcome(error: DomainError): Outcome {
  return {
    exitCode: error.code,
    result: emptyResult(statusForError(error), error),
  };
}

function contextualErrorOutcome(
  error: DomainError,
  context: FailureContext,
): Outcome {
  return {
    exitCode: error.code,
    result: generationResultSchema.parse({
      schemaVersion: 2,
      status: statusForError(error),
      ...context,
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

async function verifyRepositoryIdentity(input: {
  repositoryDir: string;
  runner: CommandRunner;
  source: ReviewMemoryBundle["source"];
}): Promise<string[]> {
  const origin = await input.runner.run(
    "git",
    ["config", "--get", "remote.origin.url"],
    { cwd: input.repositoryDir },
  );
  if (origin.exitCode !== 0 || !origin.stdout.trim())
    return [
      "Repository origin is unavailable; the explicit repository path was used without remote identity verification.",
    ];
  let actual: string;
  try {
    actual = normalizeGitRemote(origin.stdout);
  } catch {
    return [
      "Repository origin uses an unsupported shape; the explicit repository path was used without remote identity verification.",
    ];
  }
  const host =
    input.source.repository.host ?? new URL(input.source.url).hostname;
  const expected =
    `${host}/${input.source.repository.owner}/${input.source.repository.name}`.toLowerCase();
  if (actual !== expected)
    throw new UnsafeRepositoryError(
      `Repository identity mismatch: review evidence names ${expected}, but the selected repository origin is ${actual}.`,
      "Select the repository that owns the reviewed change or correct the bundle provenance.",
    );
  return [];
}

function writeCommand(invocation: string): string {
  return /(?:^|\s)--write(?:\s|$)/.test(invocation)
    ? invocation
    : `${invocation} --write`;
}

function previewText(result: GenerationResult): string {
  const preview = result.preview;
  if (!preview) return "No mutation plan is available.";
  return [
    "Complete review-memory mutation preview:",
    `- Collision: ${preview.collision}`,
    `- Scope: ${preview.scope}`,
    `- Instruction target: ${preview.policyTarget} (explicit: ${preview.policyExplicit ? "yes" : "no"})`,
    "- Planned targets:",
    ...preview.artifacts.map(
      (artifact) =>
        `  - ${artifact.action} ${artifact.path} (${artifact.bytes} bytes; ${artifact.summary})`,
    ),
    ...preview.policyFiles.flatMap((policy) =>
      policy.diff
        ? [`- Instruction diff (${policy.path}):`, policy.diff]
        : [`- Instruction ${policy.action}: ${policy.path}`],
    ),
    ...preview.scopeWarnings.map((warning) => `- Scope warning: ${warning}`),
  ].join("\n");
}

export async function applyReviewMemoryBundle(
  input: ReviewMemoryBundle,
  options: ApplyMemoryOptions,
): Promise<Outcome> {
  let context: FailureContext | undefined;
  try {
    const bundle = reviewMemoryBundleSchema.parse(input);
    const evidence = reviewMemoryBundleToEvidence(bundle);
    const warnings = [...bundle.warnings, ...(options.warnings ?? [])];
    context = {
      source: evidence,
      correction: bundle.correction,
      applicability: bundle.applicability,
      rule: bundle.rule,
      validation: null,
      plannedFiles: [],
      writtenFiles: [],
      pullRequest: null,
      pullRequestPlan: null,
      nextCommand: null,
      warnings,
      provider: options.providerInfo ?? {
        name: "bundle",
        model: "precomputed",
      },
      repository: {
        path: options.repositoryDir,
        source: options.repositorySource ?? "explicit",
      },
      preview: null,
      approval: null,
    };
    if (!bundle.source.change.merged && !options.allowOpenReview)
      throw new RefusalError(
        "The supplied code review is not marked merged.",
        "Use an accepted review, or explicitly allow an open review after checking the warning.",
      );
    if (!bundle.review.resolved && !options.allowUnresolved)
      throw new RefusalError(
        "The supplied review thread is not marked resolved.",
        "Use a resolved review, or explicitly allow an unresolved review after checking the warning.",
      );
    if (!bundle.applicability.reusable) {
      const refusal = new RefusalError(
        `${bundle.applicability.category}: ${bundle.applicability.rationale} ${bundle.applicability.limitations.join(" ")}`,
      );
      return contextualErrorOutcome(refusal, context);
    }
    const floor = options.confidenceFloor ?? 0.8;
    if (bundle.applicability.confidence < floor)
      throw new RefusalError(
        `Analysis confidence ${bundle.applicability.confidence.toFixed(2)} is below the required ${floor.toFixed(2)}.`,
      );
    if (!bundle.rule)
      throw new ValidationError(
        "A reusable review bundle did not contain exactly one review rule.",
      );

    const runner = options.runner ?? new GitCommandRunner();
    context.warnings.push(
      ...(await verifyRepositoryIdentity({
        repositoryDir: options.repositoryDir,
        runner,
        source: bundle.source,
      })),
    );
    const validation = validateAgentReviewRule(bundle);
    context.validation = validation;
    const outputDir = options.outputDir ?? ".review-to-rule";
    context.warnings.push(
      ...(
        await recoverPendingTransactions({
          repositoryDir: options.repositoryDir,
          outputDir,
        })
      ).map((path) => `Recovered interrupted transaction: ${path}`),
    );
    const discovery = await discoverMemoryPolicy(
      options.repositoryDir,
      runner,
      outputDir,
    );
    const policyTarget = options.policyTarget ?? "neither";
    const policyExplicit = options.policyTargetExplicit ?? false;
    if (policyTarget !== "neither" && !policyExplicit)
      throw new UnsafeRepositoryError(
        "Writing AGENTS.md or CLAUDE.md requires an explicit policy target for this invocation.",
        "Pass --policy-target agents, claude, or both after reviewing the preview.",
      );
    const policyPaths = resolveMemoryPolicyPaths(discovery, policyTarget, {
      ...(options.agentsPath ? { agentsPath: options.agentsPath } : {}),
      ...(options.claudePath ? { claudePath: options.claudePath } : {}),
    });
    const pointer = {
      indexPath: `${outputDir}/INDEX.md`,
      rulesDir: `${outputDir}/rules`,
    };
    const policyUpdates = await Promise.all(
      policyPaths.map((path) =>
        planManagedMemoryUpdate(options.repositoryDir, path, pointer),
      ),
    );
    const plan = await planMemoryArtifacts({
      repositoryDir: options.repositoryDir,
      outputDir,
      sourceUrl: bundle.source.url,
      sourceIdentity: canonicalReviewSourceIdentity(bundle.source.url),
      rule: bundle.rule,
      evidence,
      approvalMode: options.yes ? "yes" : "interactive",
      policyTarget,
      policyExplicit,
      policyPaths,
      policyUpdates,
    });
    const artifacts: Array<{
      path: string;
      kind: "artifact" | "policy";
      action: "create" | "replace" | "update" | "unchanged";
      bytes: number;
      sha256: string;
      summary: string;
    }> = plan.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      action: file.action,
      bytes: Buffer.byteLength(file.content),
      sha256: sha256(file.content),
      summary:
        file.path === plan.manifestPath
          ? "provenance and integrity manifest"
          : file.path === plan.index.path
            ? "shared review-memory index"
            : file.path.includes("/evidence/")
              ? "bounded accepted review evidence"
              : file.kind === "policy"
                ? "managed agent instruction pointer"
                : "agent-readable review rule",
    }));
    if (plan.index.action === "unchanged")
      artifacts.push({
        path: plan.index.path,
        kind: "artifact",
        action: "unchanged",
        bytes: Buffer.byteLength(plan.index.content),
        sha256: sha256(plan.index.content),
        summary: "shared review-memory index",
      });
    const plannedFiles = [
      ...new Set(artifacts.map((item) => item.path)),
    ].sort();
    const scopeWarnings = validation.checks
      .filter((check) => check.status === "warning")
      .map((check) => check.diagnostic);
    const result = generationResultSchema.parse({
      schemaVersion: 2,
      status: "success",
      source: evidence,
      correction: bundle.correction,
      applicability: bundle.applicability,
      rule: { ...bundle.rule, id: plan.ruleId },
      validation,
      plannedFiles,
      writtenFiles: [],
      pullRequest: null,
      pullRequestPlan: null,
      nextCommand: options.invocation,
      warnings: context.warnings,
      errors: [],
      provider: context.provider,
      repository: context.repository,
      preview: {
        collision: plan.collision,
        policyTarget,
        policyExplicit,
        policyFiles: policyUpdates.map((update) => ({
          path: update.path,
          action: update.action,
          previousHash: update.previousHash,
          nextHash: update.nextHash,
          diff: update.diff,
        })),
        artifacts,
        discovery: {
          artifactState: discovery.artifactState,
          ruleCandidates: discovery.ruleCandidates,
          policyFiles: discovery.policyFiles,
          ambiguities: discovery.ambiguities,
        },
        scope: `${bundle.rule.scope.paths.join(", ")} (${bundle.rule.scope.languages.join(", ")})`,
        scopeWarnings,
        suggestedWriteCommand: writeCommand(options.invocation),
      },
      approval: {
        mode: options.yes ? "yes" : "interactive",
        confirmed: false,
      },
    });
    context = {
      ...result,
      preview: result.preview ?? null,
      approval: result.approval ?? null,
    };
    delete (context as Partial<GenerationResult>).schemaVersion;
    delete (context as Partial<GenerationResult>).status;
    delete (context as Partial<GenerationResult>).errors;
    if (!options.write) return { result, exitCode: 0 };
    const confirmed =
      Boolean(options.yes) ||
      Boolean(
        options.confirmation?.isTTY &&
        (await options.confirmation.confirm(previewText(result))),
      );
    if (!confirmed)
      throw new UnsafeRepositoryError(
        "Artifact writing requires an interactive confirmation or --yes.",
        "Review the dry-run preview, then rerun with --write in a TTY or add --yes.",
      );
    const writtenFiles = await commitTransaction({
      repositoryDir: options.repositoryDir,
      plan,
      runner,
      ...(options.onInterrupt ? { onInterrupt: options.onInterrupt } : {}),
    });
    return {
      exitCode: 0,
      result: generationResultSchema.parse({
        ...result,
        writtenFiles,
        nextCommand: `review-to-rule replay '${plan.manifestPath.replaceAll("'", `'"'"'`)}'`,
        approval: {
          mode: options.yes ? "yes" : "interactive",
          confirmed: true,
        },
      }),
    };
  } catch (error) {
    const domain =
      error instanceof DomainError
        ? error
        : new ValidationError(
            error instanceof Error ? error.message : String(error),
          );
    return context
      ? contextualErrorOutcome(domain, context)
      : errorOutcome(domain);
  }
}
