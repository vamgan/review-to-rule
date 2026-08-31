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
    {
      message: "must be an HTTP(S) URL",
    },
  )
  .refine((value) => {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password;
  }, "must not contain embedded credentials");

export const languageSchema = z.enum(["typescript", "javascript", "python"]);
export type Language = z.infer<typeof languageSchema>;

export const boundedSourceSchema = z.object({
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
  excerpt: z.string().max(8000),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  truncated: z.boolean(),
});

export const reviewEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  source: z
    .object({
      reviewSystem: reviewSystemSchema,
      url: sourceUrlSchema,
    })
    .strict()
    .optional(),
  repository: z.object({
    host: z.string().trim().min(1).max(255).optional(),
    owner: z.string(),
    name: z.string(),
  }),
  pullRequest: z.object({
    number: reviewIdSchema,
    headSha: z.string(),
    baseSha: z.string(),
    mergedAt: z.string().nullable().optional(),
    mergeSha: z.string().nullable().optional(),
  }),
  review: z.object({
    commentId: reviewIdSchema,
    body: z.string().max(4000),
    resolved: z.boolean(),
    merged: z.boolean(),
    path: z.string().optional(),
    line: z.number().int().positive().nullable().optional(),
    side: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  }),
  threadRoot: z.object({
    id: reviewIdSchema,
    body: z.string().max(4000),
  }),
  replies: z.array(
    z.object({ id: reviewIdSchema, body: z.string().max(4000) }),
  ),
  original: boundedSourceSchema,
  final: boundedSourceSchema,
  rename: z.object({ from: z.string(), to: z.string() }).nullable().optional(),
  provenance: z.array(z.string().min(1)),
  warnings: z.array(z.string()),
});
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;

export const correctionCandidateSchema = z.object({
  path: z.string(),
  language: languageSchema,
  intentSummary: z.string(),
  before: z.string().min(1).max(8000),
  after: z.string().min(1).max(8000),
  beforeLine: z.number().int().positive().optional(),
  afterLine: z.number().int().positive().optional(),
  evidence: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
});
export type CorrectionCandidate = z.infer<typeof correctionCandidateSchema>;

export const categorySchema = z.enum([
  "API_USAGE",
  "CONTROL_FLOW",
  "NULL_SAFETY",
  "RESOURCE_LIFETIME",
  "LANGUAGE_IDIOM",
  "BEHAVIORAL",
  "CROSS_FILE_ARCHITECTURAL",
  "SUBJECTIVE_STYLE",
  "PRODUCT_DECISION",
  "PERFORMANCE_SPECULATION",
  "UNKNOWN",
]);

export const decisionSchema = z.object({
  enforceable: z.boolean(),
  category: categorySchema,
  reviewerIntent: z.string(),
  prohibitedPattern: z.string().optional(),
  preferredPattern: z.string().optional(),
  rationale: z.string(),
  limitations: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type EnforceabilityDecision = z.infer<typeof decisionSchema>;

export const proposalSchema = z.object({
  id: z.string().regex(/^review-to-rule\.[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string(),
  message: z.string(),
  language: languageSchema,
  severity: z.enum(["INFO", "WARNING", "ERROR"]),
  yaml: z.string(),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  rationale: z.string(),
  limitations: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type GeneratedRuleProposal = z.infer<typeof proposalSchema>;

export const validationCheckSchema = z.object({
  name: z.string(),
  status: z.enum(["passed", "failed", "omitted"]),
  diagnostic: z.string(),
});
export const matchSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  excerpt: z.string(),
  message: z.string(),
});
export const validationReportSchema = z.object({
  attempts: z.number().int().min(1).max(3),
  checks: z.array(validationCheckSchema),
  matches: z.array(matchSchema),
});

export const pullRequestPlanSchema = z.object({
  schemaVersion: z.literal(1),
  branch: z.string(),
  base: z.string(),
  title: z.string(),
  body: z.string().max(12_000),
  labels: z.array(z.string()),
  remote: z.string(),
  pushRefspec: z.string(),
  artifactPaths: z.array(z.string()),
  artifacts: z.array(
    z.object({ path: z.string(), action: z.string(), sha256: z.string() }),
  ),
  policyDiffs: z.array(
    z.object({ path: z.string(), diff: z.string().max(8_000) }),
  ),
});
export type PullRequestPlan = z.infer<typeof pullRequestPlanSchema>;

export const publicErrorResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum([
    "refused",
    "validation_failed",
    "dependency_failed",
    "unsafe_repository",
    "unsupported",
    "internal_error",
  ]),
  errors: z.array(
    z.object({
      kind: z.string(),
      message: z.string(),
      remediation: z.string(),
    }),
  ),
  debug: z.object({ diagnostic: z.string() }).optional(),
});

export const generationResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum([
    "success",
    "refused",
    "validation_failed",
    "dependency_failed",
    "unsafe_repository",
    "unsupported",
    "internal_error",
  ]),
  source: reviewEvidenceSchema.nullable(),
  correction: correctionCandidateSchema.nullable(),
  enforceability: decisionSchema.nullable(),
  rule: proposalSchema.nullable(),
  validation: validationReportSchema.nullable(),
  matches: z.array(matchSchema),
  plannedFiles: z.array(z.string()),
  writtenFiles: z.array(z.string()),
  pullRequest: z.string().nullable(),
  pullRequestPlan: pullRequestPlanSchema.nullable().optional(),
  nextCommand: z.string().nullable(),
  warnings: z.array(z.string()),
  errors: z.array(
    z.object({
      kind: z.string(),
      message: z.string(),
      remediation: z.string(),
    }),
  ),
  provider: z
    .object({ name: z.string(), model: z.string() })
    .nullable()
    .optional(),
  repository: z
    .object({ path: z.string(), source: z.string() })
    .nullable()
    .optional(),
  preview: z
    .object({
      collision: z.enum(["new", "replace_same_source", "suffixed"]),
      policyTarget: z.string(),
      policyExplicit: z.boolean(),
      policyFiles: z.array(
        z.object({
          path: z.string(),
          action: z.string(),
          previousHash: z.string().nullable(),
          nextHash: z.string(),
          diff: z.string(),
        }),
      ),
      artifacts: z.array(
        z.object({
          path: z.string(),
          kind: z.enum(["artifact", "policy"]),
          action: z.enum(["create", "replace", "update", "unchanged"]),
          bytes: z.number().int().nonnegative(),
          sha256: z.string().length(64),
          summary: z.string(),
        }),
      ),
      discovery: z.object({
        artifactState: z.object({
          path: z.string(),
          exists: z.boolean(),
          symlink: z.boolean(),
          trackedFiles: z.array(z.string()),
          manifests: z
            .array(
              z.object({
                path: z.string(),
                status: z.enum([
                  "valid",
                  "malformed",
                  "unsupported_version",
                  "symlink",
                ]),
                ruleId: z.string().nullable(),
                sourceIdentity: z.string().nullable(),
                ownedFileCount: z.number().int().nonnegative().nullable(),
              }),
            )
            .optional(),
        }),
        semgrepCandidates: z.array(
          z.object({
            path: z.string(),
            scope: z.string(),
            status: z.enum([
              "valid",
              "malformed",
              "symlink",
              "too_large",
              "missing",
            ]),
            diagnostic: z.string(),
          }),
        ),
        policyFiles: z.array(
          z.object({
            path: z.string(),
            kind: z.enum(["agents", "claude"]),
            scope: z.string(),
            nested: z.boolean(),
            exists: z.boolean(),
            symlink: z.boolean(),
            managed: z.enum(["absent", "valid", "malformed"]),
          }),
        ),
        ambiguities: z.array(z.string()),
      }),
      broadness: z.string(),
      broadnessWarnings: z.array(z.string()),
      suggestedWriteCommand: z.string(),
    })
    .nullable()
    .optional(),
  approval: z
    .object({ mode: z.enum(["interactive", "yes"]), confirmed: z.boolean() })
    .nullable()
    .optional(),
});
export type GenerationResult = z.infer<typeof generationResultSchema>;
