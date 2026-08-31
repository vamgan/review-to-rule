import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  decisionSchema,
  generationResultSchema,
  type GenerationResult,
} from "./domain/schemas.js";
import {
  ConfigurationError,
  DomainError,
  ExitCode,
  RefusalError,
  UnsafeRepositoryError,
  ValidationError,
  type ExitCodeValue,
} from "./domain/errors.js";
import { canonicalReviewIdentity, parseReviewUrl } from "./github/url.js";
import { reconstruct } from "./analysis/reconstruct.js";
import {
  buildAnalysisRequest,
  FakeProvider,
  parseProposal,
  type StructuredProvider,
} from "./llm/provider.js";
import { ProcessCommandRunner, type CommandRunner } from "./utils/command.js";
import { validateWithSemgrep } from "./semgrep/runner.js";
import { applyRuleConfiguration } from "./semgrep/rule.js";
import { getOfflineCase } from "./fixtures/cases.js";
import { redact } from "./security/redact.js";
import { GhGitHubClient } from "./github/client.js";
import { readHistoricalContent, resolveRepository } from "./repository.js";
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

export interface GenerateOptions {
  fixture?: string;
  repositoryDir?: string;
  confidenceFloor?: number;
  provider?: StructuredProvider;
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
  allowOpenPr?: boolean;
  allowUnresolved?: boolean;
  allowUnmapped?: boolean;
  providerInfo?: { name: string; model: string };
  confirmation?: ConfirmationPort;
  contextLines?: number;
  severity?: "INFO" | "WARNING" | "ERROR";
  include?: string[];
  exclude?: string[];
  matchLimit?: number;
  onInterrupt?: () => Promise<void>;
}
export interface ConfirmationPort {
  isTTY: boolean;
  confirm(summary: string): Promise<boolean>;
}
export interface Outcome {
  result: GenerationResult;
  exitCode: ExitCodeValue;
}

async function invokeAnalysisProvider(
  provider: StructuredProvider,
  request: ReturnType<typeof buildAnalysisRequest>,
): Promise<unknown> {
  try {
    return await provider.analyze(request);
  } catch (error) {
    throw new ConfigurationError(
      `Provider analysis failed: ${redact(error instanceof Error ? error.message : String(error))}`,
      "Check the selected provider configuration and retry; credentials are never printed.",
    );
  }
}

async function invokeProposalProvider(
  provider: StructuredProvider,
  request: Parameters<StructuredProvider["propose"]>[0],
): Promise<unknown> {
  try {
    return await provider.propose(request);
  } catch (error) {
    throw new ValidationError(
      `Provider proposal attempt failed: ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }
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

export async function generate(
  reviewUrl: string,
  options: GenerateOptions = {},
): Promise<Outcome> {
  let repositoryCleanup: (() => Promise<void>) | undefined;
  const signalHandlers: Array<
    [NodeJS.Signals, (signal: NodeJS.Signals) => void]
  > = [];
  try {
    const parsedUrl = parseReviewUrl(reviewUrl);
    const fixtureName =
      options.fixture === "injected-clock"
        ? "typescript-injected-clock"
        : options.fixture;
    const runner = options.runner ?? new ProcessCommandRunner();
    let before: string;
    let after: string;
    let allowed: string | undefined;
    let repositoryDir = options.repositoryDir
      ? resolve(options.repositoryDir)
      : undefined;
    let repositorySource = repositoryDir ? "explicit" : "fixture";
    let reconstructed: ReturnType<typeof reconstruct>;
    if (fixtureName) {
      const fixture = getOfflineCase(fixtureName);
      before = fixture.before;
      after = fixture.after;
      allowed = fixture.allowed;
      reconstructed = reconstruct({
        owner: parsedUrl.owner,
        repository: parsedUrl.repository,
        pullRequestNumber: parsedUrl.pullRequestNumber,
        commentId: parsedUrl.commentId,
        reviewBody: fixture.review,
        before: [
          {
            path: fixture.path,
            sha: "base-fixture-sha",
            content: before,
            source: "fixture",
          },
        ],
        after: {
          path: fixture.path,
          sha: "head-fixture-sha",
          content: after,
          source: "fixture",
        },
        contextLines: options.contextLines ?? 3,
      });
    } else {
      const bundle = await new GhGitHubClient(runner).collect(parsedUrl, {
        ...(options.allowOpenPr ? { allowOpenPr: true } : {}),
        ...(options.allowUnresolved ? { allowUnresolved: true } : {}),
        ...(options.allowUnmapped ? { allowUnmapped: true } : {}),
      });
      const repository = await resolveRepository(bundle.repository, {
        ...(options.repositoryDir ? { repoDir: options.repositoryDir } : {}),
        runner,
      });
      repositoryCleanup = () => repository.cleanup();
      if (repository.source === "temporary_clone") {
        const disarm = () => {
          for (const [signal, handler] of signalHandlers)
            process.off(signal, handler);
          signalHandlers.length = 0;
        };
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
          const handler = () => {
            disarm();
            void repository
              .cleanup()
              .finally(() => process.kill(process.pid, signal));
          };
          signalHandlers.push([signal, handler]);
          process.once(signal, handler);
        }
      }
      repositoryDir = repository.path;
      repositorySource = repository.source;
      const changedFile = bundle.files.find(
        (file) =>
          file.filename === bundle.comment.path ||
          file.previous_filename === bundle.comment.path,
      );
      if (!changedFile && !options.allowUnmapped)
        throw new RefusalError(
          "The review comment path is not present in the pull request changed-file pages.",
        );
      const finalPath = changedFile?.filename ?? bundle.comment.path;
      const originalPath =
        changedFile?.previous_filename ?? bundle.comment.path;
      const original = await readHistoricalContent({
        runner,
        repositoryDir,
        identity: bundle.repository,
        sha: bundle.comment.original_commit_id ?? bundle.pullRequest.base.sha,
        path: originalPath,
        ...(repository.source === "temporary_clone"
          ? { allowFetch: true }
          : {}),
      });
      const final = await readHistoricalContent({
        runner,
        repositoryDir,
        identity: bundle.repository,
        sha: bundle.pullRequest.head.sha,
        path: finalPath,
        ...(repository.source === "temporary_clone"
          ? { allowFetch: true }
          : {}),
      });
      before = original.content;
      after = final.content;
      allowed = undefined;
      reconstructed = reconstruct({
        owner: parsedUrl.owner,
        repository: parsedUrl.repository,
        pullRequestNumber: parsedUrl.pullRequestNumber,
        commentId: parsedUrl.commentId,
        reviewBody: bundle.comment.body,
        threadRoot: { id: bundle.threadRoot.id, body: bundle.threadRoot.body },
        replies: bundle.replies.map((reply) => ({
          id: reply.id,
          body: reply.body,
        })),
        before: [
          {
            path: originalPath,
            sha:
              bundle.comment.original_commit_id ?? bundle.pullRequest.base.sha,
            content: before,
            source: "historical_content",
            ...(changedFile?.previous_filename
              ? { renamedFrom: changedFile.previous_filename }
              : {}),
          },
        ],
        after: {
          path: finalPath,
          sha: bundle.pullRequest.head.sha,
          content: after,
          source: "historical_content",
        },
        resolved: bundle.thread.isResolved,
        merged: bundle.pullRequest.merged,
        pullRequestDetails: {
          mergedAt: bundle.pullRequest.merged_at,
          mergeSha: bundle.pullRequest.merge_commit_sha ?? null,
        },
        reviewDetails: {
          path: bundle.comment.path,
          line: bundle.comment.line ?? bundle.comment.original_line ?? null,
          side: bundle.comment.side ?? null,
          createdAt: bundle.comment.created_at,
          updatedAt: bundle.comment.updated_at,
        },
        provenance: [
          ...bundle.provenance,
          ...(changedFile?.previous_filename
            ? [
                `changed-file rename ${changedFile.previous_filename} -> ${changedFile.filename}`,
              ]
            : []),
        ],
        contextLines: options.contextLines ?? 3,
      });
    }
    const provider = options.provider ?? new FakeProvider();
    const analysisRequest = buildAnalysisRequest(
      reconstructed.evidence.review.body,
      reconstructed.candidate,
    );
    const rawDecision = await invokeAnalysisProvider(provider, analysisRequest);
    let decision;
    try {
      decision = decisionSchema.parse(rawDecision);
    } catch (error) {
      throw new ValidationError(
        `Provider analysis was malformed: ${redact(error instanceof Error ? error.message : String(error))}`,
      );
    }
    const base = {
      schemaVersion: 1 as const,
      source: reconstructed.evidence,
      correction: reconstructed.candidate,
      enforceability: decision,
      matches: [],
      plannedFiles: [],
      writtenFiles: [],
      pullRequest: null,
      nextCommand: null,
      warnings: [
        ...reconstructed.evidence.warnings,
        ...(!fixtureName && options.allowOpenPr
          ? [
              "Open pull-request evidence was explicitly allowed and may change.",
            ]
          : []),
        ...(!fixtureName && options.allowUnresolved
          ? ["Unresolved review-thread evidence was explicitly allowed."]
          : []),
        ...(!fixtureName && options.allowUnmapped
          ? ["Incomplete GitHub evidence mapping was explicitly allowed."]
          : []),
        ...(Object.values(analysisRequest.truncation).some(Boolean)
          ? ["Provider request data was truncated to bounded character limits."]
          : []),
      ],
      errors: [],
    };
    if (!decision.enforceable) {
      const refusal = new RefusalError(
        `${decision.category}: ${decision.rationale} ${decision.limitations.join(" ")}`,
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
    if (decision.confidence < floor) {
      const refusal = new RefusalError(
        `Analysis confidence ${decision.confidence.toFixed(2)} is below the required ${floor.toFixed(2)}.`,
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
    let lastError: ValidationError | undefined;
    let previousProposal: { id: string; yaml: string } | undefined;
    const attemptWarnings: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const proposed = parseProposal(
          await invokeProposalProvider(provider, {
            decision,
            candidate: reconstructed.candidate,
            ...(lastError
              ? { failedCheck: redact(lastError.message).slice(0, 500) }
              : {}),
            ...(options.severity ? { severity: options.severity } : {}),
            ...(options.include?.length ? { include: options.include } : {}),
            ...(options.exclude?.length ? { exclude: options.exclude } : {}),
            ...(previousProposal
              ? {
                  previousProposal: {
                    id: previousProposal.id,
                    yaml: previousProposal.yaml.slice(0, 4_000),
                  },
                }
              : {}),
          }),
        );
        const proposal = applyRuleConfiguration(proposed, {
          ...(options.severity ? { severity: options.severity } : {}),
          ...(options.include?.length ? { include: options.include } : {}),
          ...(options.exclude?.length ? { exclude: options.exclude } : {}),
        });
        previousProposal = { id: proposal.id, yaml: proposal.yaml };
        const validation = await validateWithSemgrep(
          {
            proposal,
            before,
            after,
            ...(allowed !== undefined ? { allowed } : {}),
            ...(repositoryDir ? { repositoryDir } : {}),
            matchLimit: options.matchLimit ?? 200,
            fixturePath: reconstructed.candidate.path,
          },
          runner,
          attempt,
        );
        const outputDir = options.outputDir ?? ".review-to-rule";
        assertSafeExactPath(outputDir, "output directory");
        const policyTarget = options.policyTarget ?? "neither";
        const approvalMode = options.yes ? "yes" : "interactive";
        let policyUpdates: PolicyUpdate[] = [];
        const sourceIdentity = canonicalReviewIdentity(parsedUrl);
        const planRoot = repositoryDir ?? process.cwd();
        if (options.write)
          await recoverPendingTransactions({
            repositoryDir: planRoot,
            outputDir,
          });
        const discovery = await discoverPolicy(planRoot, runner, outputDir);
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
        let plan = await planArtifacts({
          repositoryDir: planRoot,
          outputDir,
          sourceUrl: reviewUrl,
          sourceIdentity,
          proposal,
          evidence: reconstructed.evidence,
          before,
          after,
          ...(allowed !== undefined ? { allowed } : {}),
          approvalMode,
          policyTarget,
          policyExplicit: options.policyTargetExplicit ?? false,
          policyPaths,
          provisional: true,
        });
        if (policyTarget !== "neither") {
          if (!repositoryDir)
            throw new UnsafeRepositoryError(
              "Policy updates require an explicit or resolved repository.",
            );
          policyUpdates = await Promise.all(
            policyPaths.map((path) => {
              const rulePath = plan.files.find(
                (file) =>
                  file.kind === "artifact" && file.path.endsWith(".yml"),
              )?.path;
              if (!rulePath)
                throw new UnsafeRepositoryError(
                  "The final artifact plan did not contain one rule path.",
                );
              return planManagedPolicyUpdate(repositoryDir, path, {
                manifestPath: plan.manifestPath,
                rulePath,
              });
            }),
          );
          plan = await planArtifacts({
            repositoryDir,
            outputDir,
            sourceUrl: reviewUrl,
            sourceIdentity,
            proposal,
            evidence: reconstructed.evidence,
            before,
            after,
            ...(allowed !== undefined ? { allowed } : {}),
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
        const writeCommand = `review-to-rule generate ${shellQuote(reviewUrl)}${options.fixture ? ` --fixture ${shellQuote(options.fixture)}` : ""}${options.repositoryDir ? ` --repo-dir ${shellQuote(options.repositoryDir)}` : ""} --write --policy-target ${shellQuote(policyTarget)}${options.agentsPath ? ` --agents-path ${shellQuote(options.agentsPath)}` : ""}${options.claudePath ? ` --claude-path ${shellQuote(options.claudePath)}` : ""}`;
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
        let approval: {
          mode: "interactive" | "yes";
          confirmed: boolean;
        } | null = null;
        if (options.write) {
          if (!repositoryDir)
            throw new UnsafeRepositoryError(
              "Artifact writes require a repository directory.",
            );
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
          for (const [signal, handler] of signalHandlers)
            process.off(signal, handler);
          signalHandlers.length = 0;
          writtenFiles = await commitArtifactPlan({
            repositoryDir,
            plan,
            runner,
            expectedPolicyHashes: new Map(
              policyUpdates.map((update) => [update.path, update.previousHash]),
            ),
            ...(options.onInterrupt
              ? { onInterrupt: options.onInterrupt }
              : repositoryCleanup
                ? { onInterrupt: repositoryCleanup }
                : {}),
          });
        }
        const result = generationResultSchema.parse({
          ...base,
          status: "success",
          rule: proposal,
          validation,
          matches: validation.matches,
          plannedFiles: plan.ownedFiles,
          writtenFiles,
          warnings: [...base.warnings, ...attemptWarnings],
          nextCommand: `review-to-rule generate ${shellQuote(reviewUrl)}${fixtureName ? ` --fixture ${shellQuote(options.fixture ?? fixtureName)}` : ""}`,
          provider: options.providerInfo ?? {
            name: fixtureName ? "fake" : "injected",
            model: fixtureName ? "deterministic-fixture" : "configured",
          },
          repository: repositoryDir
            ? { path: repositoryDir, source: repositorySource }
            : null,
          preview,
          approval,
        });
        return { result, exitCode: ExitCode.success };
      } catch (error) {
        if (
          error instanceof ConfigurationError ||
          error instanceof UnsafeRepositoryError ||
          error instanceof RefusalError
        )
          throw error;
        lastError =
          error instanceof ValidationError
            ? new ValidationError(redact(error.message), error.remediation)
            : new ValidationError(
                redact(error instanceof Error ? error.message : String(error)),
              );
        attemptWarnings.push(
          `Attempt ${attempt}/3 failed: ${redact(lastError.message)}`,
        );
      }
    }
    const failure =
      lastError ??
      new ValidationError("Rule validation failed after three attempts.");
    return {
      exitCode: failure.code,
      result: generationResultSchema.parse({
        ...base,
        status: "validation_failed",
        rule: null,
        validation: null,
        warnings: [...base.warnings, ...attemptWarnings],
        errors: [
          {
            kind: failure.kind,
            message: failure.message,
            remediation: failure.remediation,
          },
        ],
      }),
    };
  } catch (error) {
    if (error instanceof DomainError) return errorOutcome(error);
    const internal = new DomainError(
      redact(error instanceof Error ? error.message : String(error)),
      ExitCode.internal,
      "internal",
      "Run again with --debug and report the sanitized diagnostic.",
    );
    return {
      exitCode: internal.code,
      result: emptyResult("internal_error", internal),
    };
  } finally {
    for (const [signal, handler] of signalHandlers)
      process.off(signal, handler);
    try {
      await repositoryCleanup?.();
    } catch (error) {
      // A cleanup failure must override a would-be success so callers never
      // receive a false clean-state report.
      // eslint-disable-next-line no-unsafe-finally
      return errorOutcome(
        new UnsafeRepositoryError(
          `Temporary repository cleanup failed: ${redact(error instanceof Error ? error.message : String(error))}`,
          "Remove the reported disposable checkout after verifying its exact path.",
        ),
      );
    }
  }
}
