import { resolve } from "node:path";
import {
  decisionSchema,
  generationResultSchema,
  type EnforceabilityDecision,
  type GenerationResult,
  type GeneratedRuleProposal,
} from "./domain/schemas.js";
import {
  ConfigurationError,
  DomainError,
  ExitCode,
  RefusalError,
  UnsafeRepositoryError,
  ValidationError,
} from "./domain/errors.js";
import { parseReviewUrl } from "./github/url.js";
import { reconstruct } from "./analysis/reconstruct.js";
import {
  buildAnalysisRequest,
  FakeProvider,
  parseProposal,
  type StructuredProvider,
} from "./llm/provider.js";
import { ProcessCommandRunner, type CommandRunner } from "./utils/command.js";
import { getOfflineCase } from "./fixtures/cases.js";
import { redact } from "./security/redact.js";
import { GhGitHubClient } from "./github/client.js";
import { readHistoricalContent, resolveRepository } from "./repository.js";
import type { PolicyTarget } from "./config.js";
import {
  applyReviewLearningBundle,
  errorOutcome,
  type ConfirmationPort,
  type Outcome,
} from "./core.js";
import {
  reviewLearningBundleSchema,
  type ReviewLearningBundle,
} from "./review-bundle.js";

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

async function invokeAnalysisProvider(
  provider: StructuredProvider,
  request: ReturnType<typeof buildAnalysisRequest>,
): Promise<unknown> {
  try {
    return await provider.analyze(request);
  } catch (error) {
    throw new ConfigurationError(
      `Provider analysis failed: ${redact(error instanceof Error ? error.message : String(error))}`,
      "Check the selected standalone provider configuration and retry; credentials are never printed.",
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

function proposalFailure(input: {
  source: GenerationResult["source"];
  correction: GenerationResult["correction"];
  enforceability: GenerationResult["enforceability"];
  warnings: string[];
  error: ValidationError;
}): Outcome {
  return {
    exitCode: input.error.code,
    result: generationResultSchema.parse({
      schemaVersion: 1,
      status: "validation_failed",
      source: input.source,
      correction: input.correction,
      enforceability: input.enforceability,
      rule: null,
      validation: null,
      matches: [],
      plannedFiles: [],
      writtenFiles: [],
      pullRequest: null,
      nextCommand: null,
      warnings: input.warnings,
      errors: [
        {
          kind: input.error.kind,
          message: input.error.message,
          remediation: input.error.remediation,
        },
      ],
    }),
  };
}

function confidenceRefusal(input: {
  source: GenerationResult["source"];
  correction: GenerationResult["correction"];
  enforceability: GenerationResult["enforceability"];
  warnings: string[];
  provider: { name: string; model: string };
  repository: { path: string; source: string };
  invocation: string;
  floor: number;
}): Outcome {
  const confidence = input.enforceability?.confidence ?? 0;
  const refusal = new RefusalError(
    `Analysis confidence ${confidence.toFixed(2)} is below the required ${input.floor.toFixed(2)}.`,
  );
  return {
    exitCode: refusal.code,
    result: generationResultSchema.parse({
      schemaVersion: 1,
      status: "refused",
      source: input.source,
      correction: input.correction,
      enforceability: input.enforceability,
      rule: null,
      validation: null,
      matches: [],
      plannedFiles: [],
      writtenFiles: [],
      pullRequest: null,
      nextCommand: input.invocation,
      warnings: input.warnings,
      errors: [
        {
          kind: refusal.kind,
          message: refusal.message,
          remediation: refusal.remediation,
        },
      ],
      provider: input.provider,
      repository: input.repository,
    }),
  };
}

function buildReviewLearningBundle(input: {
  reviewUrl: string;
  reconstructed: ReturnType<typeof reconstruct>;
  decision: EnforceabilityDecision;
  rule: GeneratedRuleProposal | null;
  fixtures: { before: string; after: string; allowed?: string };
  warnings: string[];
}): ReviewLearningBundle {
  const { evidence, candidate } = input.reconstructed;
  return reviewLearningBundleSchema.parse({
    schemaVersion: 1,
    source: {
      reviewSystem: "github",
      url: input.reviewUrl,
      repository: evidence.repository,
      change: {
        id: evidence.pullRequest.number,
        baseRevision: evidence.pullRequest.baseSha,
        headRevision: evidence.pullRequest.headSha,
        merged: evidence.review.merged,
        ...(evidence.pullRequest.mergedAt !== undefined
          ? { mergedAt: evidence.pullRequest.mergedAt }
          : {}),
        ...(evidence.pullRequest.mergeSha !== undefined
          ? { mergeRevision: evidence.pullRequest.mergeSha }
          : {}),
      },
    },
    review: {
      id: evidence.review.commentId,
      body: evidence.review.body,
      resolved: evidence.review.resolved,
      ...(evidence.review.path ? { path: evidence.review.path } : {}),
      ...(evidence.review.line !== undefined
        ? { line: evidence.review.line }
        : {}),
      ...(evidence.review.side !== undefined
        ? { side: evidence.review.side }
        : {}),
      ...(evidence.review.createdAt
        ? { createdAt: evidence.review.createdAt }
        : {}),
      ...(evidence.review.updatedAt
        ? { updatedAt: evidence.review.updatedAt }
        : {}),
      root: evidence.threadRoot,
      replies: evidence.replies,
    },
    snapshots: {
      before: {
        path: evidence.original.path,
        revision: evidence.original.sha,
        excerpt: evidence.original.excerpt,
        truncated: evidence.original.truncated,
        ...(evidence.original.startLine
          ? { startLine: evidence.original.startLine }
          : {}),
        ...(evidence.original.endLine
          ? { endLine: evidence.original.endLine }
          : {}),
      },
      after: {
        path: evidence.final.path,
        revision: evidence.final.sha,
        excerpt: evidence.final.excerpt,
        truncated: evidence.final.truncated,
        ...(evidence.final.startLine
          ? { startLine: evidence.final.startLine }
          : {}),
        ...(evidence.final.endLine ? { endLine: evidence.final.endLine } : {}),
      },
    },
    correction: candidate,
    enforceability: input.decision,
    rule: input.rule,
    fixtures: input.fixtures,
    provenance: evidence.provenance,
    warnings: input.warnings,
  });
}

/**
 * Optional standalone adapter: GitHub evidence retrieval plus a separately
 * configured model are converted into the same provider-neutral bundle that
 * the deterministic core accepts directly.
 */
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
    let repositoryDir = options.repositoryDir
      ? resolve(options.repositoryDir)
      : undefined;
    let repositorySource = fixtureName
      ? "fixture"
      : repositoryDir
        ? "explicit"
        : "fixture";
    let reconstructed: ReturnType<typeof reconstruct>;
    let validationFixtures: {
      before: string;
      after: string;
      allowed?: string;
    };

    if (fixtureName) {
      const fixture = getOfflineCase(fixtureName);
      validationFixtures = {
        before: fixture.before,
        after: fixture.after,
        allowed: fixture.allowed,
      };
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
            content: fixture.before,
            source: "fixture",
          },
        ],
        after: {
          path: fixture.path,
          sha: "head-fixture-sha",
          content: fixture.after,
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
            content: original.content,
            source: "historical_content",
            ...(changedFile?.previous_filename
              ? { renamedFrom: changedFile.previous_filename }
              : {}),
          },
        ],
        after: {
          path: finalPath,
          sha: bundle.pullRequest.head.sha,
          content: final.content,
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
      validationFixtures = {
        before: reconstructed.candidate.before,
        after: reconstructed.candidate.after,
      };
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

    const baseWarnings = [
      ...reconstructed.evidence.warnings,
      ...(!fixtureName && options.allowOpenPr
        ? ["Open pull-request evidence was explicitly allowed and may change."]
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
    ];
    const invocation = `review-to-rule generate ${shellQuote(reviewUrl)}${options.fixture ? ` --fixture ${shellQuote(options.fixture)}` : ""}`;
    const providerInfo = options.providerInfo ?? {
      name: fixtureName ? "fake" : "injected",
      model: fixtureName ? "deterministic-fixture" : "configured",
    };
    const applyOptions = {
      repositoryDir: repositoryDir ?? process.cwd(),
      repositorySource,
      runner,
      ...(options.write ? { write: true } : {}),
      ...(options.yes ? { yes: true } : {}),
      ...(options.outputDir ? { outputDir: options.outputDir } : {}),
      ...(options.policyTarget ? { policyTarget: options.policyTarget } : {}),
      ...(options.policyTargetExplicit !== undefined
        ? { policyTargetExplicit: options.policyTargetExplicit }
        : {}),
      ...(options.agentsPath ? { agentsPath: options.agentsPath } : {}),
      ...(options.agentsPathExplicit !== undefined
        ? { agentsPathExplicit: options.agentsPathExplicit }
        : {}),
      ...(options.claudePath ? { claudePath: options.claudePath } : {}),
      ...(options.claudePathExplicit !== undefined
        ? { claudePathExplicit: options.claudePathExplicit }
        : {}),
      ...(options.confidenceFloor !== undefined
        ? { confidenceFloor: options.confidenceFloor }
        : {}),
      ...(options.severity ? { severity: options.severity } : {}),
      ...(options.include ? { include: options.include } : {}),
      ...(options.exclude ? { exclude: options.exclude } : {}),
      ...(options.matchLimit !== undefined
        ? { matchLimit: options.matchLimit }
        : {}),
      ...(options.confirmation ? { confirmation: options.confirmation } : {}),
      providerInfo,
      invocation,
      ...(options.allowOpenPr ? { allowOpenReview: true } : {}),
      ...(options.allowUnresolved ? { allowUnresolved: true } : {}),
      ...(options.onInterrupt
        ? { onInterrupt: options.onInterrupt }
        : repositoryCleanup
          ? { onInterrupt: repositoryCleanup }
          : {}),
    };

    const confidenceFloor = options.confidenceFloor ?? 0.8;
    if (decision.enforceable && decision.confidence < confidenceFloor)
      return confidenceRefusal({
        source: reconstructed.evidence,
        correction: reconstructed.candidate,
        enforceability: decision,
        warnings: baseWarnings,
        provider: providerInfo,
        repository: {
          path: repositoryDir ?? process.cwd(),
          source: repositorySource,
        },
        invocation,
        floor: confidenceFloor,
      });

    if (!decision.enforceable) {
      const bundle = buildReviewLearningBundle({
        reviewUrl,
        reconstructed,
        decision,
        rule: null,
        fixtures: validationFixtures,
        warnings: baseWarnings,
      });
      return await applyReviewLearningBundle(bundle, {
        ...applyOptions,
      });
    }

    let lastError: ValidationError | undefined;
    let lastOutcome: Outcome | undefined;
    let previousProposal: { id: string; yaml: string } | undefined;
    const attemptWarnings: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const proposal = parseProposal(
          await invokeProposalProvider(provider, {
            decision,
            candidate: reconstructed.candidate,
            ...(lastError
              ? { failedCheck: redact(lastError.message).slice(0, 500) }
              : {}),
            ...(options.severity ? { severity: options.severity } : {}),
            ...(options.include?.length ? { include: options.include } : {}),
            ...(options.exclude?.length ? { exclude: options.exclude } : {}),
            ...(previousProposal ? { previousProposal } : {}),
          }),
        );
        previousProposal = {
          id: proposal.id,
          yaml: proposal.yaml.slice(0, 4_000),
        };
        const bundle = buildReviewLearningBundle({
          reviewUrl,
          reconstructed,
          decision,
          rule: proposal,
          fixtures: validationFixtures,
          warnings: baseWarnings,
        });
        const outcome = await applyReviewLearningBundle(bundle, {
          ...applyOptions,
          warnings: attemptWarnings,
          attempt,
        });
        if (outcome.exitCode !== ExitCode.validation) return outcome;
        lastOutcome = outcome;
        lastError = new ValidationError(
          outcome.result.errors[0]?.message ?? "Rule validation failed.",
          outcome.result.errors[0]?.remediation,
        );
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
      }
      attemptWarnings.push(
        `Attempt ${attempt}/3 failed: ${redact(lastError.message)}`,
      );
    }
    if (lastOutcome)
      return {
        ...lastOutcome,
        result: generationResultSchema.parse({
          ...lastOutcome.result,
          warnings: [
            ...new Set([...lastOutcome.result.warnings, ...attemptWarnings]),
          ],
        }),
      };
    return proposalFailure({
      source: reconstructed.evidence,
      correction: reconstructed.candidate,
      enforceability: decision,
      warnings: [...baseWarnings, ...attemptWarnings],
      error:
        lastError ??
        new ValidationError("Rule validation failed after three attempts."),
    });
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
  } finally {
    for (const [signal, handler] of signalHandlers)
      process.off(signal, handler);
    try {
      await repositoryCleanup?.();
    } catch (error) {
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

export { errorOutcome } from "./core.js";
export type { ConfirmationPort, Outcome } from "./core.js";
