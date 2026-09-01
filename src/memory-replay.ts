import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  memoryValidationReportSchema,
  type MemoryValidationReport,
} from "./domain/memory.js";
import { reviewEvidenceSchema } from "./domain/evidence.js";
import { ValidationError } from "./domain/errors.js";
import { parseMemoryManifest } from "./memory-artifacts.js";
import { renderAgentReviewRule } from "./rules/render.js";
import {
  validateManagedMemoryPointer,
  type ManagedPointerTarget,
} from "./memory-policy.js";
import {
  assertSafeExactPath,
  containedPath,
  inspectContainedPathNoFollow,
} from "./security/path.js";
import {
  canonicalReviewSourceIdentity,
  normalizeReviewSourceUrl,
} from "./source.js";

const MAX_REPLAY_FILE_BYTES = 2_000_000;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const replayResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    status: z.literal("success"),
    manifestPath: z.string(),
    rulePath: z.string(),
    verifiedFiles: z.array(z.string()),
    validation: memoryValidationReportSchema,
  })
  .strict();
export type ReplayResult = z.infer<typeof replayResultSchema>;

async function boundedRegularFile(
  repositoryDir: string,
  path: string,
): Promise<string> {
  assertSafeExactPath(path, "review-memory artifact path");
  const state = await inspectContainedPathNoFollow(repositoryDir, path);
  if (!state.exists)
    throw new ValidationError(`Review-memory artifact is missing: ${path}`);
  if (state.kind !== "file")
    throw new ValidationError(
      `Review-memory artifact is not a regular non-symlink file: ${path}`,
    );
  if ((state.size ?? 0) > MAX_REPLAY_FILE_BYTES)
    throw new ValidationError(
      `Review-memory artifact exceeds ${MAX_REPLAY_FILE_BYTES} bytes: ${path}`,
    );
  return readFile(containedPath(repositoryDir, path), "utf8");
}

function evidenceMatchesSource(
  evidence: z.infer<typeof reviewEvidenceSchema>,
  sourceUrl: string,
): boolean {
  return Boolean(
    evidence.source &&
    normalizeReviewSourceUrl(evidence.source.url) ===
      normalizeReviewSourceUrl(sourceUrl),
  );
}

function validationReport(input: {
  anchored: boolean;
  policyCount: number;
}): MemoryValidationReport {
  return memoryValidationReportSchema.parse({
    checks: [
      {
        name: "integrity",
        status: "passed",
        diagnostic: "Manifest-owned rule and evidence hashes match.",
      },
      {
        name: "deterministic rendering",
        status: "passed",
        diagnostic: "Stored Markdown exactly matches the structured rule.",
      },
      {
        name: "accepted evidence",
        status: "passed",
        diagnostic: input.anchored
          ? "A flagged/accepted example is anchored in the stored before/after evidence."
          : "Stored evidence was verified.",
      },
      {
        name: "agent instruction pointers",
        status: "passed",
        diagnostic: `${input.policyCount} managed instruction pointer(s) verified.`,
      },
    ],
  });
}

export async function replayMemoryManifest(input: {
  repositoryDir: string;
  manifestPath: string;
}): Promise<ReplayResult> {
  assertSafeExactPath(input.manifestPath, "manifest path");
  let parsed;
  try {
    parsed = parseMemoryManifest(
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
  const { manifest, layout } = parsed;
  const contents = new Map<string, string>();
  for (const record of manifest.writtenFiles) {
    const content = await boundedRegularFile(input.repositoryDir, record.path);
    if (sha256(content) !== record.sha256)
      throw new ValidationError(`Manifest hash mismatch: ${record.path}`);
    contents.set(record.path, content);
  }
  const expectedRule = renderAgentReviewRule(
    manifest.rule,
    manifest.source.url,
  );
  if (contents.get(layout.rulePath) !== expectedRule)
    throw new ValidationError(
      "Stored Markdown does not deterministically match the manifest rule.",
    );
  let evidence: z.infer<typeof reviewEvidenceSchema>;
  try {
    evidence = reviewEvidenceSchema.parse(
      JSON.parse(contents.get(layout.evidencePath) ?? ""),
    );
  } catch (error) {
    throw new ValidationError(
      `Stored evidence is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!evidenceMatchesSource(evidence, manifest.source.url))
    throw new ValidationError(
      "Stored evidence source does not match the manifest source review.",
    );
  if (
    manifest.source.identity !==
    canonicalReviewSourceIdentity(manifest.source.url)
  )
    throw new ValidationError(
      "Manifest source identity is not canonical for the source review.",
    );
  const anchored = manifest.rule.examples.some(
    (example) =>
      evidence.original.excerpt.includes(example.bad) &&
      evidence.final.excerpt.includes(example.good),
  );
  if (!anchored)
    throw new ValidationError(
      "No rule example is anchored in the stored before/after review evidence.",
    );
  const pointer: ManagedPointerTarget = {
    indexPath: layout.indexPath,
    rulesDir: `${layout.outputDir}/rules`,
  };
  for (const policyPath of layout.policyPaths)
    validateManagedMemoryPointer(
      await boundedRegularFile(input.repositoryDir, policyPath),
      pointer,
      policyPath,
    );
  return replayResultSchema.parse({
    schemaVersion: 2,
    status: "success",
    manifestPath: input.manifestPath,
    rulePath: layout.rulePath,
    verifiedFiles: [
      ...manifest.writtenFiles.map((file) => file.path),
      ...layout.policyPaths,
    ].sort(),
    validation: validationReport({
      anchored,
      policyCount: layout.policyPaths.length,
    }),
  });
}
