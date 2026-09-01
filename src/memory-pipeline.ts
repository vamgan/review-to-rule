import { resolve } from "node:path";
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
  parseAgentReviewRule,
  parseApplicability,
  type StructuredMemoryProvider,
} from "./agent-rule-provider.js";
import { ProcessCommandRunner, type CommandRunner } from "./utils/command.js";
import { redact } from "./security/redact.js";
import { GhGitHubClient } from "./github/client.js";
import { readHistoricalContent, resolveRepository } from "./repository.js";
import type { PolicyTarget } from "./memory-config.js";
import {
  applyReviewMemoryBundle,
  errorOutcome,
  type ConfirmationPort,
  type Outcome,
} from "./memory-core.js";
import {
  reviewMemoryBundleSchema,
  type ReviewMemoryBundle,
} from "./review-memory-bundle.js";
import type {
  AgentReviewRule,
  ApplicabilityDecision,
} from "./domain/memory.js";

export interface GenerateOptions {
  repositoryDir?: string;
  confidenceFloor?: number;
  provider: StructuredMemoryProvider;
  runner?: CommandRunner;
  write?: boolean;
  yes?: boolean;
  outputDir?: string;
  policyTarget?: PolicyTarget;
  policyTargetExplicit?: boolean;
  agentsPath?: string;
  claudePath?: string;
  allowOpenPr?: boolean;
  allowUnresolved?: boolean;
  allowUnmapped?: boolean;
  providerInfo?: { name: string; model: string };
  confirmation?: ConfirmationPort;
  contextLines?: number;
  onInterrupt?: () => Promise<void>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function analyze(
  provider: StructuredMemoryProvider,
  request: ReturnType<typeof buildAnalysisRequest>,
): Promise<ApplicabilityDecision> {
  try {
    return parseApplicability(await provider.analyze(request));
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ConfigurationError(
      `Provider analysis failed: ${redact(error instanceof Error ? error.message : String(error))}`,
      "Check the optional standalone provider configuration and retry; credentials are never printed.",
    );
  }
}

async function propose(
  provider: StructuredMemoryProvider,
  decision: ApplicabilityDecision,
  candidate: ReturnType<typeof reconstruct>["candidate"],
): Promise<AgentReviewRule> {
  try {
    return parseAgentReviewRule(
      await provider.propose({ decision, candidate }),
    );
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(
      `Provider proposal failed: ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

function buildBundle(input: {
  reviewUrl: string;
  reconstructed: ReturnType<typeof reconstruct>;
  decision: ApplicabilityDecision;
  rule: AgentReviewRule | null;
  warnings: string[];
}): ReviewMemoryBundle {
  const { evidence, candidate } = input.reconstructed;
  return reviewMemoryBundleSchema.parse({
    schemaVersion: 2,
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
    applicability: input.decision,
    rule: input.rule,
    provenance: evidence.provenance,
    warnings: input.warnings,
  });
}

/**
 * Optional standalone GitHub adapter. Host agents should normally collect the
 * review through their own tools, build a version-2 bundle, and call apply.
 */
export async function generate(
  reviewUrl: string,
  options: GenerateOptions,
): Promise<Outcome> {
  let repositoryCleanup: (() => Promise<void>) | undefined;
  const signalHandlers: Array<
    [NodeJS.Signals, (signal: NodeJS.Signals) => void]
  > = [];
  try {
    const parsedUrl = parseReviewUrl(reviewUrl);
    const runner = options.runner ?? new ProcessCommandRunner();
    const collected = await new GhGitHubClient(runner).collect(parsedUrl, {
      ...(options.allowOpenPr ? { allowOpenPr: true } : {}),
      ...(options.allowUnresolved ? { allowUnresolved: true } : {}),
      ...(options.allowUnmapped ? { allowUnmapped: true } : {}),
    });
    const repository = await resolveRepository(collected.repository, {
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
    const repositoryDir = resolve(repository.path);
    const changedFile = collected.files.find(
      (file) =>
        file.filename === collected.comment.path ||
        file.previous_filename === collected.comment.path,
    );
    if (!changedFile && !options.allowUnmapped)
      throw new RefusalError(
        "The review comment path is not present in the pull request changed-file pages.",
      );
    const finalPath = changedFile?.filename ?? collected.comment.path;
    const originalPath =
      changedFile?.previous_filename ?? collected.comment.path;
    const original = await readHistoricalContent({
      runner,
      repositoryDir,
      identity: collected.repository,
      sha:
        collected.comment.original_commit_id ?? collected.pullRequest.base.sha,
      path: originalPath,
      ...(repository.source === "temporary_clone" ? { allowFetch: true } : {}),
    });
    const final = await readHistoricalContent({
      runner,
      repositoryDir,
      identity: collected.repository,
      sha: collected.pullRequest.head.sha,
      path: finalPath,
      ...(repository.source === "temporary_clone" ? { allowFetch: true } : {}),
    });
    const reconstructed = reconstruct({
      owner: parsedUrl.owner,
      repository: parsedUrl.repository,
      pullRequestNumber: parsedUrl.pullRequestNumber,
      commentId: parsedUrl.commentId,
      reviewBody: collected.comment.body,
      threadRoot: {
        id: collected.threadRoot.id,
        body: collected.threadRoot.body,
      },
      replies: collected.replies.map((reply) => ({
        id: reply.id,
        body: reply.body,
      })),
      before: [
        {
          path: originalPath,
          sha:
            collected.comment.original_commit_id ??
            collected.pullRequest.base.sha,
          content: original.content,
          source: "historical_content",
          ...(changedFile?.previous_filename
            ? { renamedFrom: changedFile.previous_filename }
            : {}),
        },
      ],
      after: {
        path: finalPath,
        sha: collected.pullRequest.head.sha,
        content: final.content,
        source: "historical_content",
      },
      resolved: collected.thread.isResolved,
      merged: collected.pullRequest.merged,
      pullRequestDetails: {
        mergedAt: collected.pullRequest.merged_at,
        mergeSha: collected.pullRequest.merge_commit_sha ?? null,
      },
      reviewDetails: {
        path: collected.comment.path,
        line: collected.comment.line ?? collected.comment.original_line ?? null,
        side: collected.comment.side ?? null,
        createdAt: collected.comment.created_at,
        updatedAt: collected.comment.updated_at,
      },
      provenance: [
        ...collected.provenance,
        ...(changedFile?.previous_filename
          ? [
              `changed-file rename ${changedFile.previous_filename} -> ${changedFile.filename}`,
            ]
          : []),
      ],
      contextLines: options.contextLines ?? 3,
    });
    const request = buildAnalysisRequest(
      reconstructed.evidence.review.body,
      reconstructed.candidate,
    );
    const decision = await analyze(options.provider, request);
    const rule = decision.reusable
      ? await propose(options.provider, decision, reconstructed.candidate)
      : null;
    const warnings = [
      ...reconstructed.evidence.warnings,
      ...(options.allowOpenPr
        ? ["Open review evidence was explicitly allowed and may change."]
        : []),
      ...(options.allowUnresolved
        ? ["Unresolved review-thread evidence was explicitly allowed."]
        : []),
      ...(options.allowUnmapped
        ? ["Incomplete GitHub evidence mapping was explicitly allowed."]
        : []),
      ...(Object.values(request.truncation).some(Boolean)
        ? ["Provider request data was truncated to bounded character limits."]
        : []),
    ];
    const invocation = `review-to-rule generate ${shellQuote(reviewUrl)}`;
    return await applyReviewMemoryBundle(
      buildBundle({
        reviewUrl,
        reconstructed,
        decision,
        rule,
        warnings,
      }),
      {
        repositoryDir,
        repositorySource: repository.source,
        runner,
        ...(options.write ? { write: true } : {}),
        ...(options.yes ? { yes: true } : {}),
        ...(options.outputDir ? { outputDir: options.outputDir } : {}),
        ...(options.policyTarget ? { policyTarget: options.policyTarget } : {}),
        ...(options.policyTargetExplicit !== undefined
          ? { policyTargetExplicit: options.policyTargetExplicit }
          : {}),
        ...(options.agentsPath ? { agentsPath: options.agentsPath } : {}),
        ...(options.claudePath ? { claudePath: options.claudePath } : {}),
        ...(options.confidenceFloor !== undefined
          ? { confidenceFloor: options.confidenceFloor }
          : {}),
        ...(options.confirmation ? { confirmation: options.confirmation } : {}),
        providerInfo: options.providerInfo ?? {
          name: "configured",
          model: "standalone",
        },
        invocation,
        ...(options.allowOpenPr ? { allowOpenReview: true } : {}),
        ...(options.allowUnresolved ? { allowUnresolved: true } : {}),
        ...(options.onInterrupt
          ? { onInterrupt: options.onInterrupt }
          : { onInterrupt: repositoryCleanup }),
      },
    );
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

export { errorOutcome } from "./memory-core.js";
export type { ConfirmationPort, Outcome } from "./memory-core.js";
