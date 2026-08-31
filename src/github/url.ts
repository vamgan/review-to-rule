import { UnsupportedError } from "../domain/errors.js";

export interface ParsedReviewUrl {
  host?: string;
  owner: string;
  repository: string;
  pullRequestNumber: number;
  commentId: number;
}

export function canonicalReviewIdentity(ref: ParsedReviewUrl): string {
  return `${ref.host ?? "github.com"}/${ref.owner}/${ref.repository}#${ref.commentId}`.toLowerCase();
}

const example = "https://github.com/owner/repo/pull/123#discussion_r456";

export function parseReviewUrl(input: string): ParsedReviewUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsupportedError(
      `Invalid GitHub review URL: ${input}`,
      `Use ${example}`,
    );
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    (url.hostname.toLowerCase() !== "github.com" &&
      url.hostname.toLowerCase() !== process.env.GH_HOST?.toLowerCase() &&
      !/(?:^|[.-])(?:github|ghe)(?:[.-]|$)/i.test(url.hostname)) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new UnsupportedError(
      `Unsupported review host: ${url.hostname || "(missing)"}`,
      `Use an HTTPS GitHub or GitHub Enterprise review URL such as ${example}`,
    );
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  const fragment = /^#discussion_r([1-9]\d*)$/.exec(url.hash);
  if (!match || !fragment)
    throw new UnsupportedError(
      "URL is not a GitHub pull-request review comment.",
      `Use ${example}`,
    );
  const owner = match[1] ?? "";
  const repository = match[2] ?? "";
  return {
    ...(url.hostname.toLowerCase() === "github.com"
      ? {}
      : { host: url.hostname.toLowerCase() }),
    owner: decodeURIComponent(owner),
    repository: decodeURIComponent(repository),
    pullRequestNumber: Number(match[3]),
    commentId: Number(fragment[1]),
  };
}
