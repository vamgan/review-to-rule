import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { parseCanonicalArtifactManifest } from "./artifacts.js";
import { ValidationError } from "./domain/errors.js";
import {
  proposalSchema,
  reviewEvidenceSchema,
  validationReportSchema,
  type GeneratedRuleProposal,
} from "./domain/schemas.js";
import {
  assertSafeExactPath,
  containedPath,
  inspectContainedPathNoFollow,
} from "./security/path.js";
import { validateWithSemgrep } from "./semgrep/runner.js";
import type { CommandRunner } from "./utils/command.js";
import { validateManagedPolicyPointer } from "./policy.js";
import { parseReviewUrl } from "./github/url.js";
import {
  canonicalReviewSourceIdentity,
  normalizeReviewSourceUrl,
} from "./source.js";

const maxReplayFileBytes = 2_000_000;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const replayResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("success"),
  manifestPath: z.string(),
  rulePath: z.string(),
  verifiedFiles: z.array(z.string()),
  validation: validationReportSchema,
});
export type ReplayResult = z.infer<typeof replayResultSchema>;

async function boundedRegularFile(
  repositoryDir: string,
  path: string,
): Promise<string> {
  assertSafeExactPath(path, "replay artifact path");
  const absolute = containedPath(repositoryDir, path);
  const state = await inspectContainedPathNoFollow(repositoryDir, path);
  if (!state.exists)
    throw new ValidationError(`Replay artifact is missing: ${path}`);
  if (state.kind !== "file")
    throw new ValidationError(
      `Replay artifact is not a regular non-symlink file: ${path}`,
    );
  if ((state.size ?? 0) > maxReplayFileBytes)
    throw new ValidationError(
      `Replay artifact exceeds ${maxReplayFileBytes} bytes: ${path}`,
    );
  return readFile(absolute, "utf8");
}

export function proposalFromYaml(yaml: string): GeneratedRuleProposal {
  let document: unknown;
  try {
    document = parse(yaml);
  } catch (error) {
    throw new ValidationError(
      `Stored rule YAML is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = z
    .object({
      rules: z
        .array(
          z.object({
            id: z.string(),
            message: z.string(),
            severity: z.enum(["INFO", "WARNING", "ERROR"]),
            languages: z
              .array(z.enum(["typescript", "javascript", "python"]))
              .length(1),
            paths: z.object({
              include: z.array(z.string()),
              exclude: z.array(z.string()),
            }),
          }),
        )
        .length(1),
    })
    .parse(document);
  const rule = parsed.rules[0];
  if (!rule) throw new ValidationError("Stored rule YAML has no rule.");
  return proposalSchema.parse({
    id: rule.id,
    title: `Replay ${rule.id}`,
    message: rule.message,
    language: rule.languages[0],
    severity: rule.severity,
    yaml,
    include: rule.paths.include,
    exclude: rule.paths.exclude,
    rationale: "Behavioral replay from a verified review-to-rule manifest.",
    limitations: [],
    confidence: 1,
  });
}

export async function replayArtifactManifest(input: {
  repositoryDir: string;
  manifestPath: string;
  runner: CommandRunner;
}): Promise<ReplayResult> {
  assertSafeExactPath(input.manifestPath, "manifest path");
  let canonical;
  try {
    canonical = parseCanonicalArtifactManifest(
      JSON.parse(
        await boundedRegularFile(input.repositoryDir, input.manifestPath),
      ),
      input.manifestPath,
    );
  } catch (error) {
    throw error instanceof ValidationError
      ? error
      : new ValidationError(
          `Manifest consistency check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
  }
  const { manifest, layout } = canonical;
  const writtenPaths = manifest.writtenFiles.map((file) => file.path);
  const contents = new Map<string, string>();
  for (const record of manifest.writtenFiles) {
    const content = await boundedRegularFile(input.repositoryDir, record.path);
    if (sha256(content) !== record.sha256)
      throw new ValidationError(`Manifest hash mismatch: ${record.path}`);
    contents.set(record.path, content);
  }
  for (const policyPath of layout.policyPaths)
    validateManagedPolicyPointer(
      contents.get(policyPath) ?? "",
      { manifestPath: input.manifestPath, rulePath: layout.rulePath },
      policyPath,
    );
  let evidence;
  try {
    evidence = reviewEvidenceSchema.parse(
      JSON.parse(contents.get(layout.evidencePath) ?? ""),
    );
  } catch (error) {
    throw new ValidationError(
      `Stored evidence is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsedSource;
  try {
    parsedSource = parseReviewUrl(manifest.source.url);
  } catch {
    parsedSource = undefined;
  }
  if (parsedSource) {
    if (
      evidence.repository.owner.toLowerCase() !==
        parsedSource.owner.toLowerCase() ||
      evidence.repository.name.toLowerCase() !==
        parsedSource.repository.toLowerCase() ||
      evidence.pullRequest.number !== parsedSource.pullRequestNumber ||
      evidence.review.commentId !== parsedSource.commentId
    )
      throw new ValidationError(
        "Stored evidence identity does not match the manifest source review.",
      );
  } else if (
    !evidence.source ||
    normalizeReviewSourceUrl(evidence.source.url) !==
      normalizeReviewSourceUrl(manifest.source.url)
  )
    throw new ValidationError(
      "Stored agent evidence source does not match the manifest source review.",
    );
  if (
    manifest.source.identity !==
    canonicalReviewSourceIdentity(manifest.source.url)
  )
    throw new ValidationError(
      "Manifest canonical source identity does not match its source URL.",
    );
  const proposal = proposalFromYaml(contents.get(layout.rulePath) ?? "");
  if (proposal.id !== manifest.ruleId)
    throw new ValidationError(
      "Manifest ruleId does not match the single stored rule YAML ID.",
    );
  const fixturePath = proposal.include.find((path) => !/[*?[\]{}]/.test(path));
  if (!fixturePath)
    throw new ValidationError(
      "Stored rule has no exact include path for behavioral replay.",
    );
  const validation = await validateWithSemgrep(
    {
      proposal,
      before: contents.get(layout.beforePath) ?? "",
      after: contents.get(layout.afterPath) ?? "",
      ...(layout.allowedPath
        ? { allowed: contents.get(layout.allowedPath) ?? "" }
        : {}),
      fixturePath,
    },
    input.runner,
  );
  return replayResultSchema.parse({
    schemaVersion: 1,
    status: "success",
    manifestPath: input.manifestPath,
    rulePath: layout.rulePath,
    verifiedFiles: writtenPaths,
    validation,
  });
}
