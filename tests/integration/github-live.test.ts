import { execFileSync, spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { collectedEvidenceResultSchema } from "../../src/evidence.js";
import { buildPublicCli } from "../build-public-cli.js";

const liveUrl = process.env.REVIEW_TO_RULE_LIVE_URL;
const project = new URL("../..", import.meta.url).pathname;
const cli = new URL("../../dist/cli.js", import.meta.url).pathname;

describe("opt-in authenticated read-only GitHub smoke", () => {
  beforeAll(async () => {
    if (!liveUrl) return;
    await buildPublicCli();
  });

  it.skipIf(!liveUrl)(
    liveUrl
      ? "uses the built CLI and compares sanitized fields to direct read-only gh"
      : "set REVIEW_TO_RULE_LIVE_URL to a stable public review-comment URL",
    () => {
      const parsedUrl = new URL(liveUrl ?? "");
      const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(
        parsedUrl.pathname,
      );
      const comment = /^#discussion_r(\d+)$/.exec(parsedUrl.hash);
      expect(match && comment).toBeTruthy();
      const owner = match?.[1] ?? "";
      const repository = match?.[2] ?? "";
      const pullRequest = match?.[3] ?? "";
      const commentId = comment?.[1] ?? "";
      const execution = spawnSync(
        process.execPath,
        [
          cli,
          "evidence",
          liveUrl ?? "",
          "--allow-open-pr",
          "--allow-unresolved",
          "--allow-unmapped",
          "--json",
        ],
        { cwd: project, encoding: "utf8", env: process.env },
      );
      expect(execution.status, execution.stderr).toBe(0);
      const result = collectedEvidenceResultSchema.parse(
        JSON.parse(execution.stdout),
      );
      const directPull = JSON.parse(
        execFileSync(
          "gh",
          [
            "api",
            "--hostname",
            parsedUrl.host,
            "--method",
            "GET",
            `/repos/${owner}/${repository}/pulls/${pullRequest}`,
          ],
          { encoding: "utf8" },
        ),
      ) as {
        number: number;
        merged: boolean;
        merged_at: string | null;
        merge_commit_sha?: string | null;
        head: { sha: string };
        base: { sha: string };
      };
      const directComment = JSON.parse(
        execFileSync(
          "gh",
          [
            "api",
            "--hostname",
            parsedUrl.host,
            "--method",
            "GET",
            `/repos/${owner}/${repository}/pulls/comments/${commentId}`,
          ],
          { encoding: "utf8" },
        ),
      ) as {
        id: number;
        path: string;
        line?: number | null;
        original_line?: number | null;
        side?: string | null;
        created_at: string;
        updated_at: string;
      };
      expect(result).toMatchObject({
        repository: {
          host: parsedUrl.host,
          owner,
          name: repository,
        },
        pullRequest: {
          number: directPull.number,
          merged: directPull.merged,
          mergedAt: directPull.merged_at,
          mergeSha: directPull.merge_commit_sha ?? null,
          headSha: directPull.head.sha,
          baseSha: directPull.base.sha,
        },
        review: {
          id: directComment.id,
          path: directComment.path,
          line: directComment.line ?? directComment.original_line ?? null,
          side: directComment.side ?? null,
          createdAt: directComment.created_at,
          updatedAt: directComment.updated_at,
        },
      });
      expect(result.provenance).toContain(
        "gh api graphql paginated review threads",
      );
      console.log(`SANITIZED_LIVE_GITHUB=${JSON.stringify(result)}`);
    },
    60_000,
  );
});
