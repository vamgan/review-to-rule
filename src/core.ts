import { createHash } from "node:crypto";
import {
  generationResultSchema,
  type GenerationResult,
} from "./domain/schemas.js";
import {
  DomainError,
  ExitCode,
  RefusalError,
  UnsafeRepositoryError,
  ValidationError,
  type ExitCodeValue,
} from "./domain/errors.js";
import {
  reviewLearningBundleSchema,
  reviewLearningBundleToEvidence,
  type ReviewLearningBundle,
} from "./review-bundle.js";
import { ProcessCommandRunner, type CommandRunner } from "./utils/command.js";
import { validateWithSemgrep } from "./semgrep/runner.js";
import { applyRuleConfiguration } from "./semgrep/rule.js";
import {
  planArtifacts,
  commitArtifactPlan,
  recoverPendingTransactions,
} from "./artifacts.js";
import {
  discoverPolicy,
  planManagedPolicyUpdate,
  resolvePolicyPaths,
  type PolicyUpdate,
} from "./policy.js";
import type { PolicyTarget } from "./config.js";
import { assertSafeExactPath } from "./security/path.js";
import { canonicalReviewSourceIdentity } from "./source.js";
import { redact } from "./security/redact.js";
import { normalizeGitRemote } from "./repository.js";

export interface ConfirmationPort {
  isTTY: boolean;
  confirm(summary: string): Promise<boolean>;
}

export interface Outcome {
  result: GenerationResult;
  exitCode: ExitCodeValue;
}

export interface ApplyBundleOptions {
  repositoryDir: string;
  repositorySource?: string;
  runner?: CommandRunner;
  write?: boolean;
  yes?: boolean;
  outputDir?: string;
  policyTarget?: PolicyTarget;
  policyTargetExplicit?: boolean;
  agentsPath?: string;
  agentsPathExplicit?: boolean;
  claudePath?: string;
  claudePathExplicit?: boolean;
  confidenceFloor?: number;
  severity?: "INFO" | "WARNING" | "ERROR";
  include?: string[];
  exclude?: string[];
  matchLimit?: number;
  confirmation?: ConfirmationPort;
  providerInfo?: { name: string; model: string };
  invocation: string;
  warnings?: string[];
  attempt?: number;
  allowOpenReview?: boolean;
  allowUnresolved?: boolean;
  onInterrupt?: () => Promise<void>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function approvalPreview(input: {
  collision: string;
  policyTarget: string;
  policyExplicit: boolean;
  artifacts: Array<{
    path: string;
    action: string;
    bytes: number;
    summary: string;
  }>;
  policyFiles: Array<{ path: string; action: string; diff: string }>;
  discovery: {
    artifactState: { path: string; exists: boolean; symlink: boolean };
    semgrepCandidates: Array<{ path: string; status: string; scope: string }>;
    policyFiles: Array<{ path: string; managed: string; scope: string }>;
    ambiguities: string[];
  };
  broadness: string;
  broadnessWarnings: string[];
}): string {
  const lines = [
    "Complete mutation preview:",
    `- Collision: ${input.collision}`,
    `- Policy: ${input.policyTarget} (explicit this invocation: ${input.policyExplicit ? "yes" : "no"})`,
    `- Scope: ${input.broadness}`,
    `- Existing output: ${input.discovery.artifactState.path} (${input.discovery.artifactState.exists ? "present" : "absent"}${input.discovery.artifactState.symlink ? ", symlink" : ""})`,
    "- Planned targets:",
    ...input.artifacts.map(
      (file) =>
        `  - ${file.action} ${file.path} (${file.bytes} bytes; ${file.summary})`,
    ),
  ];
  if (input.discovery.semgrepCandidates.length) {
    lines.push("- Existing Semgrep candidates:");
    for (const candidate of input.discovery.semgrepCandidates)
      lines.push(
        `  - ${candidate.path}: ${candidate.status} (scope ${candidate.scope})`,
      );
  }
  if (input.discovery.policyFiles.length) {
    lines.push("- Existing policy files:");
    for (const policy of input.discovery.policyFiles)
      lines.push(
        `  - ${policy.path}: ${policy.managed} (scope ${policy.scope})`,
      );
  }
  for (const ambiguity of input.discovery.ambiguities)
    lines.push(`- Ambiguity: ${ambiguity}`);
  for (const warning of input.broadnessWarnings)
    lines.push(`- Scope warning: ${warning}`);
  for (const policy of input.policyFiles)
    if (policy.diff)
      lines.push(`Policy diff (${policy.action} ${policy.path}):`, policy.diff);
  return lines.join("\n");
}

function emptyResult(
  status: GenerationResult["status"],
  error?: DomainError,
): GenerationResult {
  return generationResultSchema.parse({
    schemaVersion: 1,
    status,
    source: null,
    correction: null,
    enforceability: null,
    rule: null,
    validation: null,
    matches: [],
    plannedFiles: [],
    writtenFiles: [],
    pullRequest: null,
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
  });
}

async function verifyRepositoryIdentity(input: {
  repositoryDir: string;
  runner: CommandRunner;
  source: ReviewLearningBundle["source"];
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

export function errorOutcome(error: DomainError): Outcome {
  const status: GenerationResult["status"] =
    error.code === 2
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
  return { exitCode: error.code, result: emptyResult(status, error) };
}

export async function applyReviewLearningBundle(
  input: ReviewLearningBundle,
  options: ApplyBundleOptions,
): Promise<Outcome> {
  try {
    const bundle = reviewLearningBundleSchema.parse(input);
    const evidence = reviewLearningBundleToEvidence(bundle);
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

    const runner = options.runner ?? new ProcessCommandRunner();
    const repositoryWarnings = await verifyRepositoryIdentity({
      repositoryDir: options.repositoryDir,
      runner,
      source: bundle.source,
    });
    const base = {
      schemaVersion: 1 as const,
      source: evidence,
      correction: bundle.correction,
      enforceability: bundle.enforceability,
      matches: [],
      plannedFiles: [],
      writtenFiles: [],
      pullRequest: null,
      nextCommand: null,
      warnings: [
        ...bundle.warnings,
        ...repositoryWarnings,
        ...(options.warnings ?? []),
      ],
      errors: [],
    };
    if (!bundle.enforceability.enforceable) {
      const refusal = new RefusalError(
        `${bundle.enforceability.category}: ${bundle.enforceability.rationale} ${bundle.enforceability.limitations.join(" ")}`,
      );
      return {
        exitCode: refusal.code,
        result: generationResultSchema.parse({
          ...base,
          status: "refused",
          rule: null,
          validation: null,
          errors: [
            {
              kind: refusal.kind,
              message: refusal.message,
              remediation: refusal.remediation,
            },
          ],
        }),
      };
    }
    const floor = options.confidenceFloor ?? 0.8;
    if (bundle.enforceability.confidence < floor) {
      const refusal = new RefusalError(
        `Analysis confidence ${bundle.enforceability.confidence.toFixed(2)} is below the required ${floor.toFixed(2)}.`,
      );
      return {
        exitCode: refusal.code,
        result: generationResultSchema.parse({
          ...base,
          status: "refused",
          rule: null,
          validation: null,
          errors: [
            {
              kind: refusal.kind,
              message: refusal.message,
              remediation: refusal.remediation,
            },
          ],
        }),
      };
    }
    if (!bundle.rule)
      throw new ValidationError(
        "An enforceable review bundle did not contain exactly one rule.",
      );
    const proposal = applyRuleConfiguration(bundle.rule, {
      ...(options.severity ? { severity: options.severity } : {}),
      ...(options.include?.length ? { include: options.include } : {}),
      ...(options.exclude?.length ? { exclude: options.exclude } : {}),
    });
    const validation = await validateWithSemgrep(
      {
        proposal,
        before: bundle.fixtures.before,
        after: bundle.fixtures.after,
        ...(bundle.fixtures.allowed !== undefined
          ? { allowed: bundle.fixtures.allowed }
          : {}),
        repositoryDir: options.repositoryDir,
        matchLimit: options.matchLimit ?? 200,
        fixturePath: bundle.correction.path,
      },
      runner,
      options.attempt ?? 1,
    );

    const outputDir = options.outputDir ?? ".review-to-rule";
    assertSafeExactPath(outputDir, "output directory");
    const policyTarget = options.policyTarget ?? "neither";
    const approvalMode = options.yes ? "yes" : "interactive";
    if (options.write)
      await recoverPendingTransactions({
        repositoryDir: options.repositoryDir,
        outputDir,
      });
    const discovery = await discoverPolicy(
      options.repositoryDir,
      runner,
      outputDir,
    );
    const policyPaths = resolvePolicyPaths(discovery, policyTarget, {
      ...(options.agentsPath ? { agentsPath: options.agentsPath } : {}),
      ...(options.claudePath ? { claudePath: options.claudePath } : {}),
    });
    if (
      options.write &&
      options.yes &&
      policyTarget !== "neither" &&
      !options.policyTargetExplicit
    )
      throw new UnsafeRepositoryError(
        "Non-interactive policy mutation requires --policy-target in the current CLI invocation.",
      );
    for (const policyPath of policyPaths) {
      const isAgents = policyPath.toLowerCase().endsWith("agents.md");
      const candidates = isAgents
        ? discovery.agentsFiles
        : discovery.claudeFiles;
      const pathExplicit = isAgents
        ? options.agentsPathExplicit
        : options.claudePathExplicit;
      if (
        options.write &&
        options.yes &&
        candidates.length > 1 &&
        !pathExplicit
      )
        throw new UnsafeRepositoryError(
          `Non-interactive nested policy mutation requires an exact current-CLI path: ${policyPath}`,
        );
    }

    const sourceIdentity = canonicalReviewSourceIdentity(bundle.source.url);
    let policyUpdates: PolicyUpdate[] = [];
    let plan = await planArtifacts({
      repositoryDir: options.repositoryDir,
      outputDir,
      sourceUrl: bundle.source.url,
      sourceIdentity,
      proposal,
      evidence,
      before: bundle.fixtures.before,
      after: bundle.fixtures.after,
      ...(bundle.fixtures.allowed !== undefined
        ? { allowed: bundle.fixtures.allowed }
        : {}),
      approvalMode,
      policyTarget,
      policyExplicit: options.policyTargetExplicit ?? false,
      policyPaths,
      provisional: true,
    });
    if (policyTarget !== "neither") {
      policyUpdates = await Promise.all(
        policyPaths.map((path) => {
          const rulePath = plan.files.find(
            (file) => file.kind === "artifact" && file.path.endsWith(".yml"),
          )?.path;
          if (!rulePath)
            throw new UnsafeRepositoryError(
              "The final artifact plan did not contain one rule path.",
            );
          return planManagedPolicyUpdate(options.repositoryDir, path, {
            manifestPath: plan.manifestPath,
            rulePath,
          });
        }),
      );
      plan = await planArtifacts({
        repositoryDir: options.repositoryDir,
        outputDir,
        sourceUrl: bundle.source.url,
        sourceIdentity,
        proposal,
        evidence,
        before: bundle.fixtures.before,
        after: bundle.fixtures.after,
        ...(bundle.fixtures.allowed !== undefined
          ? { allowed: bundle.fixtures.allowed }
          : {}),
        approvalMode,
        policyTarget,
        policyExplicit: options.policyTargetExplicit ?? false,
        policyPaths,
        policyUpdates,
      });
    }

    const broadness =
      proposal.include.length === 1 && !proposal.include[0]?.includes("*")
        ? "exact-file"
        : "review-required";
    const broadnessWarnings =
      broadness === "exact-file"
        ? []
        : [
            "The generated include scope is globbed or absent; review affected paths before writing.",
          ];
    const writeCommand = `${options.invocation}${options.repositoryDir ? ` --repo-dir ${shellQuote(options.repositoryDir)}` : ""} --write --policy-target ${shellQuote(policyTarget)}${options.agentsPath ? ` --agents-path ${shellQuote(options.agentsPath)}` : ""}${options.claudePath ? ` --claude-path ${shellQuote(options.claudePath)}` : ""}`;
    const unchangedPolicies = policyUpdates.filter(
      (update) => update.action === "unchanged",
    );
    const artifacts = [
      ...plan.files.map((file) => ({
        path: file.path,
        kind: file.kind,
        action: file.action,
        bytes: Buffer.byteLength(file.content),
        sha256: hash(file.content),
        summary:
          file.kind === "policy"
            ? "managed policy pointer"
            : file.path.endsWith(".yml")
              ? "validated Semgrep rule"
              : file.path.includes("/fixtures/")
                ? "bounded regression fixture"
                : file.path.includes("/evidence/")
                  ? "bounded review evidence"
                  : "ownership and replay manifest",
      })),
      ...unchangedPolicies.map((policy) => ({
        path: policy.path,
        kind: "policy" as const,
        action: "unchanged" as const,
        bytes: Buffer.byteLength(policy.content),
        sha256: policy.nextHash,
        summary: "managed policy pointer already exact",
      })),
    ];
    const preview = {
      collision: plan.collision,
      policyTarget,
      policyExplicit: options.policyTargetExplicit ?? false,
      policyFiles: policyUpdates.map((update) => ({
        path: update.path,
        action: update.action,
        previousHash: update.previousHash,
        nextHash: update.nextHash,
        diff: update.diff,
      })),
      artifacts,
      discovery: {
        artifactState: discovery.artifactState ?? {
          path: outputDir,
          exists: false,
          symlink: false,
          trackedFiles: [],
        },
        semgrepCandidates: discovery.semgrepCandidates ?? [],
        policyFiles: discovery.policyFiles ?? [],
        ambiguities: discovery.ambiguities ?? [],
      },
      broadness,
      broadnessWarnings,
      suggestedWriteCommand: writeCommand,
    };
    let writtenFiles: string[] = [];
    let approval: { mode: "interactive" | "yes"; confirmed: boolean } | null =
      null;
    if (options.write) {
      if (!options.yes) {
        if (!options.confirmation?.isTTY)
          throw new UnsafeRepositoryError(
            "Interactive confirmation requires a TTY; use --yes after reviewing a dry run.",
          );
        const confirmed = await options.confirmation.confirm(
          approvalPreview(preview),
        );
        if (!confirmed)
          throw new UnsafeRepositoryError(
            "Write declined; no files were changed.",
          );
        approval = { mode: "interactive", confirmed: true };
      } else approval = { mode: "yes", confirmed: true };
      writtenFiles = await commitArtifactPlan({
        repositoryDir: options.repositoryDir,
        plan,
        runner,
        expectedPolicyHashes: new Map(
          policyUpdates.map((update) => [update.path, update.previousHash]),
        ),
        ...(options.onInterrupt ? { onInterrupt: options.onInterrupt } : {}),
      });
    }
    return {
      exitCode: ExitCode.success,
      result: generationResultSchema.parse({
        ...base,
        status: "success",
        rule: proposal,
        validation,
        matches: validation.matches,
        plannedFiles: plan.ownedFiles,
        writtenFiles,
        nextCommand: options.invocation,
        provider: options.providerInfo ?? {
          name: "bundle",
          model: "precomputed",
        },
        repository: {
          path: options.repositoryDir,
          source: options.repositorySource ?? "explicit",
        },
        preview,
        approval,
      }),
    };
  } catch (error) {
    if (error instanceof DomainError) return errorOutcome(error);
    return errorOutcome(
      new DomainError(
        redact(error instanceof Error ? error.message : String(error)),
        ExitCode.internal,
        "internal",
        "Run again with --debug and report the sanitized diagnostic.",
      ),
    );
  }
}
