import { z } from "zod";
import { ConfigurationError, RefusalError } from "../domain/errors.js";
import { redact } from "../security/redact.js";
import type { CommandRunner, CommandResult } from "../utils/command.js";
import type { ParsedReviewUrl } from "./url.js";

const commentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string(),
  path: z.string(),
  commit_id: z.string(),
  original_commit_id: z.string().nullable().optional(),
  diff_hunk: z.string().optional(),
  in_reply_to_id: z.number().int().positive().optional(),
  pull_request_review_id: z.number().int().positive().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  line: z.number().int().positive().nullable().optional(),
  original_line: z.number().int().positive().nullable().optional(),
  side: z.string().nullable().optional(),
});
const prSchema = z.object({
  number: z.number().int().positive(),
  state: z.string().optional(),
  merged: z.boolean(),
  merged_at: z.string().nullable(),
  merge_commit_sha: z.string().nullable().optional(),
  base: z.object({ sha: z.string() }),
  head: z.object({ sha: z.string() }),
});
const fileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
  sha: z.string(),
  patch: z.string().optional(),
});
const threadSchema = z.object({
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.object({
    nodes: z.array(z.object({ databaseId: z.number().int().positive() })),
  }),
});
const graphSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          nodes: z.array(threadSchema),
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
        }),
      }),
    }),
  }),
});

export type GitHubComment = z.infer<typeof commentSchema>;
export interface GitHubReviewBundle {
  repository: { host: string; owner: string; name: string };
  pullRequest: z.infer<typeof prSchema>;
  comment: GitHubComment;
  threadRoot: GitHubComment;
  replies: GitHubComment[];
  files: Array<z.infer<typeof fileSchema>>;
  thread: z.infer<typeof threadSchema>;
  provenance: string[];
}

function classifyGhFailure(result: CommandResult): ConfigurationError {
  const message = redact(
    result.stderr || result.stdout || "unknown gh failure",
  );
  if (/rate.?limit/i.test(message))
    return new ConfigurationError(
      `GitHub rate limit: ${message}`,
      "Wait for the reset time or authenticate with a higher-limit token.",
    );
  if (/authentication|unauthorized|401|login/i.test(message))
    return new ConfigurationError(
      `GitHub authentication failed: ${message}`,
      "Run gh auth login for the requested host.",
    );
  if (/forbidden|permission|403/i.test(message))
    return new ConfigurationError(
      `GitHub permission denied: ${message}`,
      "Grant read access to the repository and review metadata.",
    );
  if (/not found|404/i.test(message))
    return new ConfigurationError(
      `GitHub resource not found: ${message}`,
      "Verify the review URL and repository access.",
    );
  return new ConfigurationError(`GitHub read failed: ${message}`);
}

function parseJson<T>(result: CommandResult, schema: z.ZodType<T>): T {
  if (result.exitCode !== 0) throw classifyGhFailure(result);
  try {
    return schema.parse(JSON.parse(result.stdout));
  } catch (error) {
    throw new ConfigurationError(
      `Malformed GitHub response: ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

const reviewThreadsQuery = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved isOutdated comments(first:100){nodes{databaseId}}}pageInfo{hasNextPage endCursor}}}}}`;

export class GhGitHubClient {
  constructor(private readonly runner: CommandRunner) {}

  private async api(
    host: string,
    endpoint: string,
    paginate = false,
  ): Promise<CommandResult> {
    return this.runner.run("gh", [
      "api",
      "--hostname",
      host,
      "--method",
      "GET",
      endpoint,
      ...(paginate ? ["--paginate", "--slurp"] : []),
    ]);
  }

  async collect(
    ref: ParsedReviewUrl,
    options: {
      allowOpenPr?: boolean;
      allowUnresolved?: boolean;
      allowUnmapped?: boolean;
    } = {},
  ): Promise<GitHubReviewBundle> {
    const host = ref.host ?? "github.com";
    const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repository)}`;
    const pr = parseJson(
      await this.api(host, `${base}/pulls/${ref.pullRequestNumber}`),
      prSchema,
    );
    if (!pr.merged && !options.allowOpenPr)
      throw new RefusalError(
        "The pull request is not merged.",
        "Pass --allow-open-pr only after reviewing this warning.",
      );
    const target = parseJson(
      await this.api(host, `${base}/pulls/comments/${ref.commentId}`),
      commentSchema,
    );
    const commentPages = parseJson(
      await this.api(
        host,
        `${base}/pulls/${ref.pullRequestNumber}/comments?per_page=100`,
        true,
      ),
      z.array(z.array(commentSchema)).max(100),
    );
    const filePages = parseJson(
      await this.api(
        host,
        `${base}/pulls/${ref.pullRequestNumber}/files?per_page=100`,
        true,
      ),
      z.array(z.array(fileSchema)).max(100),
    );
    const comments = commentPages.flat();
    const rootId = target.in_reply_to_id ?? target.id;
    const root =
      comments.find((comment) => comment.id === rootId) ??
      (target.id === rootId ? target : undefined);
    if (!root)
      throw new RefusalError("The review thread root could not be mapped.");
    const replies = comments
      .filter((comment) => comment.in_reply_to_id === rootId)
      .sort(
        (left, right) =>
          left.created_at.localeCompare(right.created_at) || left.id - right.id,
      );
    if (replies.length > 100)
      throw new RefusalError(
        "The review thread exceeds the bounded 100-reply evidence limit.",
      );
    let cursor: string | null = null;
    let mappedThread: z.infer<typeof threadSchema> | undefined;
    for (let page = 0; page < 100; page++) {
      const graph: z.infer<typeof graphSchema> = parseJson(
        await this.runner.run("gh", [
          "api",
          "--hostname",
          host,
          "graphql",
          "--method",
          "POST",
          "-f",
          `query=${reviewThreadsQuery}`,
          "-F",
          `owner=${ref.owner}`,
          "-F",
          `name=${ref.repository}`,
          "-F",
          `number=${ref.pullRequestNumber}`,
          ...(cursor ? ["-F", `cursor=${cursor}`] : []),
        ]),
        graphSchema,
      );
      const connection: z.infer<
        typeof graphSchema
      >["data"]["repository"]["pullRequest"]["reviewThreads"] =
        graph.data.repository.pullRequest.reviewThreads;
      mappedThread ??= connection.nodes.find((thread) =>
        thread.comments.nodes.some((comment) => comment.databaseId === rootId),
      );
      if (!connection.pageInfo.hasNextPage) break;
      cursor = connection.pageInfo.endCursor;
      if (!cursor)
        throw new ConfigurationError("GitHub pagination returned no cursor.");
      if (page === 99)
        throw new ConfigurationError("GitHub pagination exceeded 100 pages.");
    }
    if (!mappedThread && !options.allowUnmapped)
      throw new RefusalError(
        "The review comment could not be mapped to a GraphQL review thread.",
      );
    const thread = mappedThread ?? {
      isResolved: false,
      isOutdated: false,
      comments: { nodes: [{ databaseId: target.id }] },
    };
    if (!thread.isResolved && !options.allowUnresolved)
      throw new RefusalError(
        "The review thread is unresolved.",
        "Pass --allow-unresolved only after reviewing this warning.",
      );
    return {
      repository: { host, owner: ref.owner, name: ref.repository },
      pullRequest: pr,
      comment: target,
      threadRoot: root,
      replies,
      files: filePages.flat(),
      thread,
      provenance: [
        `gh api pull request state=${pr.state ?? (pr.merged ? "merged" : "open")} merged_at=${pr.merged_at ?? "none"} merge_sha=${pr.merge_commit_sha ?? "none"}`,
        `gh api supplied review comment path=${target.path} line=${target.line ?? target.original_line ?? "unknown"} side=${target.side ?? "unknown"} commit=${target.commit_id} created_at=${target.created_at} updated_at=${target.updated_at}`,
        "gh api paginated review comments",
        "gh api paginated changed files",
        "gh api graphql paginated review threads",
        ...(target.path !== root.path
          ? [`review path provenance root=${root.path} selected=${target.path}`]
          : []),
      ],
    };
  }
}
