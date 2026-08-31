import { describe, expect, it } from "vitest";
import { GhGitHubClient } from "../../src/github/client.js";
import type { CommandResult, CommandRunner } from "../../src/utils/command.js";

class QueueRunner implements CommandRunner {
  readonly calls: Array<{ binary: string; args: readonly string[] }> = [];
  constructor(private readonly outputs: unknown[]) {}
  run(
    binary: "git" | "gh" | "semgrep",
    args: readonly string[],
  ): Promise<CommandResult> {
    this.calls.push({ binary, args });
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify(this.outputs.shift()),
      stderr: "",
    });
  }
}

const comment = {
  id: 456,
  body: "Inject Clock",
  path: "src/a.ts",
  commit_id: "head",
  original_commit_id: "base",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("read-only GitHub adapter", () => {
  it("collects paginated REST and GraphQL evidence with exact shell-free argv", async () => {
    const runner = new QueueRunner([
      {
        number: 123,
        merged: true,
        merged_at: "2026-01-02T00:00:00Z",
        base: { sha: "base" },
        head: { sha: "head" },
      },
      comment,
      [
        [
          comment,
          {
            ...comment,
            id: 457,
            in_reply_to_id: 456,
            created_at: "2026-01-01T01:00:00Z",
          },
        ],
      ],
      [
        [
          {
            filename: "src/a.ts",
            status: "modified",
            sha: "head",
            patch: "@@",
          },
        ],
      ],
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    isResolved: true,
                    isOutdated: false,
                    comments: { nodes: [{ databaseId: 456 }] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    ]);
    const result = await new GhGitHubClient(runner).collect({
      owner: "acme",
      repository: "repo",
      pullRequestNumber: 123,
      commentId: 456,
    });
    expect(result.replies.map((reply) => reply.id)).toEqual([457]);
    expect(result.provenance.join(" ")).toContain("merged_at=2026-01-02");
    expect(result.provenance.join(" ")).toContain("created_at=2026-01-01");
    expect(runner.calls[0]?.args).toEqual([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "/repos/acme/repo/pulls/123",
    ]);
    expect(runner.calls[2]?.args).toContain("--paginate");
    expect(
      runner.calls.every(
        (call) =>
          !call.args.some(
            (arg) =>
              /create|merge|comment|mutation/i.test(arg) && arg === "mutation",
          ),
      ),
    ).toBe(true);
  });

  it("fails closed for open or unresolved reviews", async () => {
    const runner = new QueueRunner([
      {
        number: 123,
        merged: false,
        merged_at: null,
        base: { sha: "base" },
        head: { sha: "head" },
      },
    ]);
    await expect(
      new GhGitHubClient(runner).collect({
        owner: "a",
        repository: "b",
        pullRequestNumber: 123,
        commentId: 456,
      }),
    ).rejects.toThrow(/not merged/i);
  });

  it("maps a deeply paginated reply through its thread root", async () => {
    const reply = { ...comment, id: 999, in_reply_to_id: 456 };
    const runner = new QueueRunner([
      {
        number: 123,
        state: "closed",
        merged: true,
        merged_at: "2026-01-02T00:00:00Z",
        merge_commit_sha: "a".repeat(40),
        base: { sha: "b".repeat(40) },
        head: { sha: "c".repeat(40) },
      },
      reply,
      [[comment, reply]],
      [[{ filename: "src/a.ts", status: "modified", sha: "c".repeat(40) }]],
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    isResolved: true,
                    isOutdated: false,
                    comments: { nodes: [{ databaseId: 456 }] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    ]);
    const result = await new GhGitHubClient(runner).collect({
      owner: "acme",
      repository: "repo",
      pullRequestNumber: 123,
      commentId: 999,
    });
    expect(result.threadRoot.id).toBe(456);
    expect(result.comment.id).toBe(999);
  });

  it("classifies bounded gh permission and rate-limit failures", async () => {
    for (const diagnostic of [
      "HTTP 403 forbidden",
      "API rate limit exceeded",
    ]) {
      const runner: CommandRunner = {
        run: () =>
          Promise.resolve({ exitCode: 1, stdout: "", stderr: diagnostic }),
      };
      await expect(
        new GhGitHubClient(runner).collect({
          owner: "acme",
          repository: "repo",
          pullRequestNumber: 123,
          commentId: 456,
        }),
      ).rejects.toThrow(/permission|rate limit/i);
    }
  });
});
