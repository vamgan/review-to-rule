import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import {
  correctionCandidateSchema,
  decisionSchema,
  proposalSchema,
  reviewEvidenceSchema,
  type ReviewEvidence,
} from "./domain/schemas.js";
import { ConfigurationError } from "./domain/errors.js";
import { normalizeReviewSourceUrl, reviewSystemSchema } from "./source.js";
import { redact } from "./security/redact.js";

const MAX_BUNDLE_BYTES = 128_000;

const reviewIdSchema = z.union([
  z.number().int().positive(),
  z.string().trim().min(1).max(200),
]);

const exactPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes("\\") &&
      !/[*?[\]{}]/.test(value) &&
      !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
    "must be one exact, portable repository-relative path",
  );

const sourceSchema = z
  .object({
    reviewSystem: reviewSystemSchema,
    url: z.string().transform(normalizeReviewSourceUrl),
    repository: z
      .object({
        host: z.string().trim().min(1).max(255).optional(),
        owner: z.string().trim().min(1).max(500),
        name: z.string().trim().min(1).max(500),
      })
      .strict(),
    change: z
      .object({
        id: reviewIdSchema,
        baseRevision: z.string().trim().min(1).max(200),
        headRevision: z.string().trim().min(1).max(200),
        merged: z.boolean(),
        mergedAt: z.string().trim().min(1).max(200).nullable().optional(),
        mergeRevision: z.string().trim().min(1).max(200).nullable().optional(),
      })
      .strict(),
  })
  .strict();

const reviewSchema = z
  .object({
    id: reviewIdSchema,
    body: z.string().min(1).max(4_000),
    resolved: z.boolean(),
    path: exactPathSchema.optional(),
    line: z.number().int().positive().nullable().optional(),
    side: z.string().trim().min(1).max(32).nullable().optional(),
    createdAt: z.string().trim().min(1).max(200).optional(),
    updatedAt: z.string().trim().min(1).max(200).optional(),
    root: z
      .object({ id: reviewIdSchema, body: z.string().min(1).max(4_000) })
      .strict(),
    replies: z
      .array(
        z
          .object({ id: reviewIdSchema, body: z.string().min(1).max(4_000) })
          .strict(),
      )
      .max(100),
  })
  .strict();

const snapshotSchema = z
  .object({
    path: exactPathSchema,
    revision: z.string().trim().min(1).max(200),
    excerpt: z.string().min(1).max(8_000),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    truncated: z.boolean(),
  })
  .strict();

const fixtureSchema = z.string().min(1).max(16_000);

export const reviewLearningBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: sourceSchema,
    review: reviewSchema,
    snapshots: z
      .object({ before: snapshotSchema, after: snapshotSchema })
      .strict(),
    correction: correctionCandidateSchema,
    enforceability: decisionSchema,
    rule: proposalSchema.nullable(),
    fixtures: z
      .object({
        before: fixtureSchema,
        after: fixtureSchema,
        allowed: fixtureSchema.optional(),
      })
      .strict(),
    provenance: z.array(z.string().min(1).max(1_000)).min(1).max(100),
    warnings: z.array(z.string().min(1).max(1_000)).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.source.repository.host &&
      value.source.repository.host.toLowerCase() !==
        new URL(value.source.url).hostname.toLowerCase()
    )
      context.addIssue({
        code: "custom",
        path: ["source", "repository", "host"],
        message: "repository host must match the review URL host",
      });
    if (value.enforceability.enforceable && !value.rule)
      context.addIssue({
        code: "custom",
        path: ["rule"],
        message: "an enforceable review requires exactly one proposed rule",
      });
    if (!value.enforceability.enforceable && value.rule)
      context.addIssue({
        code: "custom",
        path: ["rule"],
        message: "a refused review must not include a proposed rule",
      });
    if (value.rule && value.rule.language !== value.correction.language)
      context.addIssue({
        code: "custom",
        path: ["rule", "language"],
        message: "rule and correction languages must match",
      });
    if (value.source.change.baseRevision !== value.snapshots.before.revision)
      context.addIssue({
        code: "custom",
        path: ["snapshots", "before", "revision"],
        message: "before snapshot must use the change base revision",
      });
    if (value.source.change.headRevision !== value.snapshots.after.revision)
      context.addIssue({
        code: "custom",
        path: ["snapshots", "after", "revision"],
        message: "after snapshot must use the change head revision",
      });
    if (value.correction.path !== value.snapshots.after.path)
      context.addIssue({
        code: "custom",
        path: ["correction", "path"],
        message: "correction path must match the after snapshot path",
      });
    if (
      value.review.path &&
      value.review.path !== value.snapshots.before.path &&
      value.review.path !== value.snapshots.after.path
    )
      context.addIssue({
        code: "custom",
        path: ["review", "path"],
        message: "review path must match the before or after snapshot path",
      });
    if (!value.snapshots.before.excerpt.includes(value.correction.before))
      context.addIssue({
        code: "custom",
        path: ["correction", "before"],
        message: "before correction must be present in the before snapshot",
      });
    if (!value.snapshots.after.excerpt.includes(value.correction.after))
      context.addIssue({
        code: "custom",
        path: ["correction", "after"],
        message: "after correction must be present in the after snapshot",
      });
    if (!value.fixtures.before.includes(value.correction.before))
      context.addIssue({
        code: "custom",
        path: ["fixtures", "before"],
        message: "before fixture must contain the reviewed correction",
      });
    if (!value.fixtures.after.includes(value.correction.after))
      context.addIssue({
        code: "custom",
        path: ["fixtures", "after"],
        message: "after fixture must contain the accepted correction",
      });
    if (value.fixtures.before.trim() === value.fixtures.after.trim())
      context.addIssue({
        code: "custom",
        path: ["fixtures"],
        message: "before and after fixtures must differ",
      });
  });

export type ReviewLearningBundle = z.infer<typeof reviewLearningBundleSchema>;

export function reviewLearningBundleToEvidence(
  input: ReviewLearningBundle,
): ReviewEvidence {
  const bundle = reviewLearningBundleSchema.parse(input);
  return reviewEvidenceSchema.parse({
    schemaVersion: 1,
    source: {
      reviewSystem: bundle.source.reviewSystem,
      url: bundle.source.url,
    },
    repository: bundle.source.repository,
    pullRequest: {
      number: bundle.source.change.id,
      headSha: bundle.source.change.headRevision,
      baseSha: bundle.source.change.baseRevision,
      ...(bundle.source.change.mergedAt !== undefined
        ? { mergedAt: bundle.source.change.mergedAt }
        : {}),
      ...(bundle.source.change.mergeRevision !== undefined
        ? { mergeSha: bundle.source.change.mergeRevision }
        : {}),
    },
    review: {
      commentId: bundle.review.id,
      body: bundle.review.body,
      resolved: bundle.review.resolved,
      merged: bundle.source.change.merged,
      ...(bundle.review.path ? { path: bundle.review.path } : {}),
      ...(bundle.review.line !== undefined ? { line: bundle.review.line } : {}),
      ...(bundle.review.side !== undefined ? { side: bundle.review.side } : {}),
      ...(bundle.review.createdAt
        ? { createdAt: bundle.review.createdAt }
        : {}),
      ...(bundle.review.updatedAt
        ? { updatedAt: bundle.review.updatedAt }
        : {}),
    },
    threadRoot: bundle.review.root,
    replies: bundle.review.replies,
    original: {
      path: bundle.snapshots.before.path,
      sha: bundle.snapshots.before.revision,
      source: "agent_context",
      excerpt: bundle.snapshots.before.excerpt,
      truncated: bundle.snapshots.before.truncated,
      ...(bundle.snapshots.before.startLine
        ? { startLine: bundle.snapshots.before.startLine }
        : {}),
      ...(bundle.snapshots.before.endLine
        ? { endLine: bundle.snapshots.before.endLine }
        : {}),
    },
    final: {
      path: bundle.snapshots.after.path,
      sha: bundle.snapshots.after.revision,
      source: "agent_context",
      excerpt: bundle.snapshots.after.excerpt,
      truncated: bundle.snapshots.after.truncated,
      ...(bundle.snapshots.after.startLine
        ? { startLine: bundle.snapshots.after.startLine }
        : {}),
      ...(bundle.snapshots.after.endLine
        ? { endLine: bundle.snapshots.after.endLine }
        : {}),
    },
    ...(bundle.snapshots.before.path !== bundle.snapshots.after.path
      ? {
          rename: {
            from: bundle.snapshots.before.path,
            to: bundle.snapshots.after.path,
          },
        }
      : {}),
    provenance: bundle.provenance,
    warnings: bundle.warnings,
  });
}

export async function loadReviewLearningBundle(
  path: string,
): Promise<ReviewLearningBundle> {
  try {
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink())
      throw new ConfigurationError(
        "Review bundle must be a regular non-symlink JSON file.",
      );
    if (state.size > MAX_BUNDLE_BYTES)
      throw new ConfigurationError(
        `Review bundle exceeds ${MAX_BUNDLE_BYTES} bytes.`,
      );
    return reviewLearningBundleSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(
      `Invalid review bundle: ${redact(error instanceof Error ? error.message : String(error))}`,
      "Create a bounded version-1 review learning bundle and retry.",
    );
  }
}
