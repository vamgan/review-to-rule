import { z } from "zod";
import { GhGitHubClient } from "./github/client.js";
import { parseReviewUrl } from "./github/url.js";
import type { CommandRunner } from "./utils/command.js";

export const collectedEvidenceResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("success"),
  repository: z.object({
    host: z.string(),
    owner: z.string(),
    name: z.string(),
  }),
  pullRequest: z.object({
    number: z.number().int().positive(),
    merged: z.boolean(),
    mergedAt: z.string().nullable(),
    mergeSha: z.string().nullable(),
    headSha: z.string(),
    baseSha: z.string(),
  }),
  review: z.object({
    id: z.number().int().positive(),
    path: z.string(),
    line: z.number().int().positive().nullable(),
    side: z.string().nullable(),
    resolved: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  provenance: z.array(z.string()),
});
export type CollectedEvidenceResult = z.infer<
  typeof collectedEvidenceResultSchema
>;

export async function collectReviewEvidence(input: {
  reviewUrl: string;
  runner: CommandRunner;
  allowOpenPr?: boolean;
  allowUnresolved?: boolean;
  allowUnmapped?: boolean;
}): Promise<CollectedEvidenceResult> {
  const bundle = await new GhGitHubClient(input.runner).collect(
    parseReviewUrl(input.reviewUrl),
    {
      ...(input.allowOpenPr ? { allowOpenPr: true } : {}),
      ...(input.allowUnresolved ? { allowUnresolved: true } : {}),
      ...(input.allowUnmapped ? { allowUnmapped: true } : {}),
    },
  );
  return collectedEvidenceResultSchema.parse({
    schemaVersion: 1,
    status: "success",
    repository: bundle.repository,
    pullRequest: {
      number: bundle.pullRequest.number,
      merged: bundle.pullRequest.merged,
      mergedAt: bundle.pullRequest.merged_at,
      mergeSha: bundle.pullRequest.merge_commit_sha ?? null,
      headSha: bundle.pullRequest.head.sha,
      baseSha: bundle.pullRequest.base.sha,
    },
    review: {
      id: bundle.comment.id,
      path: bundle.comment.path,
      line: bundle.comment.line ?? bundle.comment.original_line ?? null,
      side: bundle.comment.side ?? null,
      resolved: bundle.thread.isResolved,
      createdAt: bundle.comment.created_at,
      updatedAt: bundle.comment.updated_at,
    },
    provenance: bundle.provenance,
  });
}
