import { z } from "zod";
import { reviewSystemSchema } from "../source.js";

const reviewIdSchema = z.union([
  z.number().int().positive(),
  z.string().trim().min(1).max(200),
]);

const sourceUrlSchema = z
  .url()
  .refine(
    (value) => new Set(["https:", "http:"]).has(new URL(value).protocol),
    "must be an HTTP(S) URL",
  )
  .refine((value) => {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password;
  }, "must not contain embedded credentials");

export const languageSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9+#._-]*$/i);
export type Language = z.infer<typeof languageSchema>;

export const boundedSourceSchema = z
  .object({
    path: z.string().min(1),
    sha: z.string().min(1),
    source: z.enum([
      "original_commit",
      "comment_commit",
      "diff_preimage",
      "historical_content",
      "fixture",
      "agent_context",
    ]),
    excerpt: z.string().max(8_000),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    truncated: z.boolean(),
  })
  .strict();

export const reviewEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z
      .object({ reviewSystem: reviewSystemSchema, url: sourceUrlSchema })
      .strict()
      .optional(),
    repository: z
      .object({
        host: z.string().trim().min(1).max(255).optional(),
        owner: z.string().trim().min(1).max(500),
        name: z.string().trim().min(1).max(500),
      })
      .strict(),
    pullRequest: z
      .object({
        number: reviewIdSchema,
        headSha: z.string().min(1),
        baseSha: z.string().min(1),
        mergedAt: z.string().nullable().optional(),
        mergeSha: z.string().nullable().optional(),
      })
      .strict(),
    review: z
      .object({
        commentId: reviewIdSchema,
        body: z.string().max(4_000),
        resolved: z.boolean(),
        merged: z.boolean(),
        path: z.string().optional(),
        line: z.number().int().positive().nullable().optional(),
        side: z.string().nullable().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
      })
      .strict(),
    threadRoot: z
      .object({ id: reviewIdSchema, body: z.string().max(4_000) })
      .strict(),
    replies: z
      .array(
        z.object({ id: reviewIdSchema, body: z.string().max(4_000) }).strict(),
      )
      .max(100),
    original: boundedSourceSchema,
    final: boundedSourceSchema,
    rename: z
      .object({ from: z.string(), to: z.string() })
      .strict()
      .nullable()
      .optional(),
    provenance: z.array(z.string().min(1)).min(1),
    warnings: z.array(z.string()),
  })
  .strict();
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;

export const correctionCandidateSchema = z
  .object({
    path: z.string().min(1),
    language: languageSchema,
    intentSummary: z.string().trim().min(1).max(2_000),
    before: z.string().min(1).max(8_000),
    after: z.string().min(1).max(8_000),
    beforeLine: z.number().int().positive().optional(),
    afterLine: z.number().int().positive().optional(),
    evidence: z.array(z.string().min(1)).min(1).max(100),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type CorrectionCandidate = z.infer<typeof correctionCandidateSchema>;

export const publicErrorResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    status: z.enum([
      "refused",
      "validation_failed",
      "dependency_failed",
      "unsafe_repository",
      "unsupported",
      "internal_error",
    ]),
    errors: z.array(
      z
        .object({
          kind: z.string(),
          message: z.string(),
          remediation: z.string(),
        })
        .strict(),
    ),
    debug: z.object({ diagnostic: z.string() }).strict().optional(),
  })
  .strict();
