import { z } from "zod";
import { correctionCandidateSchema, reviewEvidenceSchema } from "./evidence.js";

export const categorySchema = z.enum([
  "CORRECTNESS",
  "SECURITY",
  "API_USAGE",
  "ARCHITECTURE",
  "BEHAVIOR",
  "TESTING",
  "PERFORMANCE",
  "STYLE",
  "MAINTAINABILITY",
  "PRODUCT_CONSTRAINT",
  "OTHER",
]);

export const applicabilitySchema = z
  .object({
    reusable: z.boolean(),
    category: categorySchema,
    reviewerIntent: z.string().trim().min(1).max(1000),
    rationale: z.string().trim().min(1).max(2000),
    limitations: z.array(z.string().trim().min(1).max(1000)).max(20),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type ApplicabilityDecision = z.infer<typeof applicabilitySchema>;

export const reviewLanguageSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9+#._-]*$/i);

export const scopePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes("\\") &&
      !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
    "must be a portable repository-relative path or glob",
  );

export const reviewRuleSchema = z
  .object({
    id: z.string().regex(/^review-to-rule\.[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().trim().min(1).max(160),
    instruction: z.string().trim().min(1).max(2000),
    rationale: z.string().trim().min(1).max(3000),
    priority: z.enum(["advisory", "important", "critical"]),
    scope: z
      .object({
        paths: z.array(scopePathSchema).min(1).max(100),
        languages: z.array(reviewLanguageSchema).min(1).max(20),
        description: z.string().trim().min(1).max(1000),
      })
      .strict(),
    triggers: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
    guidance: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
    exceptions: z.array(z.string().trim().min(1).max(1000)).max(20),
    examples: z
      .array(
        z
          .object({
            language: reviewLanguageSchema,
            bad: z.string().min(1).max(8000),
            good: z.string().min(1).max(8000),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type AgentReviewRule = z.infer<typeof reviewRuleSchema>;

export const validationCheckSchema = z
  .object({
    name: z.string(),
    status: z.enum(["passed", "warning"]),
    diagnostic: z.string(),
  })
  .strict();
export const memoryValidationReportSchema = z
  .object({ checks: z.array(validationCheckSchema).min(1) })
  .strict();
export type MemoryValidationReport = z.infer<
  typeof memoryValidationReportSchema
>;

const pullRequestPlanSchema = z.object({
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

const discoverySchema = z.object({
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
  ruleCandidates: z.array(
    z.object({
      path: z.string(),
      scope: z.string(),
      status: z.enum(["valid", "malformed", "symlink", "too_large", "missing"]),
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
});

export const generationResultSchema = z.object({
  schemaVersion: z.literal(2),
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
  applicability: applicabilitySchema.nullable(),
  rule: reviewRuleSchema.nullable(),
  validation: memoryValidationReportSchema.nullable(),
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
      discovery: discoverySchema,
      scope: z.string(),
      scopeWarnings: z.array(z.string()),
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

export { pullRequestPlanSchema };
