import { describe, expect, it } from "vitest";
import { parseReviewUrl } from "../../src/github/url.js";
import {
  detectLanguage,
  validateRenameLanguage,
} from "../../src/analysis/language.js";
import { UnsupportedError } from "../../src/domain/errors.js";

describe("review URL parsing", () => {
  it.each([
    [
      "https://github.com/acme/repo/pull/1#discussion_r2",
      { owner: "acme", repository: "repo", pullRequestNumber: 1, commentId: 2 },
    ],
    [
      "https://github.com/private-org/private-repo/pull/987#discussion_r654",
      {
        owner: "private-org",
        repository: "private-repo",
        pullRequestNumber: 987,
        commentId: 654,
      },
    ],
  ])("parses %s without network access", (url, expected) =>
    expect(parseReviewUrl(url)).toEqual(expected),
  );

  it.each([
    "http://github.com/a/b/pull/1#discussion_r2",
    "https://gitlab.com/a/b/pull/1#discussion_r2",
    "https://github.com/a/b/issues/1#discussion_r2",
    "https://github.com/a/b/pull/0#discussion_r2",
    "https://github.com/a/b/pull/1",
    "not-a-url",
  ])("rejects invalid input %s", (url) =>
    expect(() => parseReviewUrl(url)).toThrow(UnsupportedError),
  );
});

describe("language mapping", () => {
  it.each([
    ["x.ts", "typescript"],
    ["x.tsx", "typescript"],
    ["x.mjs", "javascript"],
    ["x.jsx", "javascript"],
    ["x.py", "python"],
    ["x.pyi", "python"],
  ])("maps %s", (path, expected) =>
    expect(detectLanguage(path)).toBe(expected),
  );
  it("rejects unsupported files and language-changing renames", () => {
    expect(() => detectLanguage("main.go")).toThrow(UnsupportedError);
    expect(() => validateRenameLanguage("main.ts", "main.py")).toThrow(
      UnsupportedError,
    );
  });
});
