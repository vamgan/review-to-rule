import { RefusalError } from "../domain/errors.js";
import {
  correctionCandidateSchema,
  reviewEvidenceSchema,
  type CorrectionCandidate,
  type ReviewEvidence,
} from "../domain/schemas.js";
import { detectLanguage, validateRenameLanguage } from "./language.js";
import { assertSafeExactPath } from "../security/path.js";

export interface SourceRevision {
  path: string;
  sha: string;
  content?: string;
  source: ReviewEvidence["original"]["source"];
  renamedFrom?: string;
  deleted?: boolean;
}
export interface ReconstructionInput {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  commentId: number;
  reviewBody: string;
  threadRoot?: { id: number; body: string };
  replies?: Array<{ id: number; body: string }>;
  before: SourceRevision[];
  after: SourceRevision;
  contextLines?: number;
  resolved?: boolean;
  merged?: boolean;
  provenance?: string[];
  pullRequestDetails?: { mergedAt: string | null; mergeSha: string | null };
  reviewDetails?: {
    path: string;
    line: number | null;
    side: string | null;
    createdAt: string;
    updatedAt: string;
  };
}

const MAX_REVIEW_CHARS = 4_000;
const MAX_EXCERPT_CHARS = 4_000;
const MAX_CANDIDATE_CHARS = 8_000;
const MAX_FILE_CHARS = 200_000;
const MAX_DIFF_LINES = 1_500;
const sourcePriority: Record<SourceRevision["source"], number> = {
  original_commit: 0,
  comment_commit: 1,
  diff_preimage: 2,
  historical_content: 3,
  fixture: 4,
};

interface DiffOperation {
  kind: "equal" | "delete" | "insert";
  value: string;
  beforeLine: number;
  afterLine: number;
}
interface ChangeHunk {
  removed: string[];
  added: string[];
  beforeLine: number;
  afterLine: number;
  moveSimilarity?: number;
}

function clip(
  value: string,
  max: number,
): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return {
    value: `${value.slice(0, Math.max(0, max - 16))}\n…[truncated]`,
    truncated: true,
  };
}

function meaningfulLines(content: string): string[] {
  const lines = content.split("\n");
  while (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function clipContextLine(value: string): { value: string; truncated: boolean } {
  const limit = 320;
  if (value.length <= limit) return { value, truncated: false };
  return {
    value: `${value.slice(0, limit - 22)}…[truncated context]`,
    truncated: true,
  };
}

function linesAround(
  content: string,
  line: number,
  selectedLineCount: number,
  context: number,
): { excerpt: string; line: number; endLine: number; truncated: boolean } {
  const all = meaningfulLines(content);
  const index = Math.max(0, Math.min(line - 1, all.length - 1));
  const selectedEnd = Math.min(
    all.length,
    index + Math.max(1, selectedLineCount),
  );
  const selected = all.slice(index, selectedEnd);
  const selectedText = selected.join("\n");
  if (selectedText.length > MAX_EXCERPT_CHARS - 80)
    throw new RefusalError(
      "The selected correction cannot fit in a trustworthy bounded excerpt.",
      "Choose a smaller local correction whose complete changed lines can be shown.",
    );
  const before: string[] = [];
  const after: string[] = [];
  let used = selectedText.length;
  let contextWasClipped = false;
  for (let distance = 1; distance <= context; distance++) {
    for (const side of ["before", "after"] as const) {
      const candidateIndex =
        side === "before" ? index - distance : selectedEnd + distance - 1;
      const raw = all[candidateIndex];
      if (raw === undefined) continue;
      const bounded = clipContextLine(raw);
      const cost = bounded.value.length + 1;
      if (used + cost > MAX_EXCERPT_CHARS - 64) {
        contextWasClipped = true;
        continue;
      }
      used += cost;
      contextWasClipped ||= bounded.truncated;
      if (side === "before") before.unshift(bounded.value);
      else after.push(bounded.value);
    }
  }
  const start = index - before.length;
  const end = selectedEnd + after.length;
  const omittedMeaningfulContext = start > 0 || end < all.length;
  const excerpt = [...before, ...selected, ...after];
  if (start > 0) excerpt.unshift("…[earlier context omitted]");
  if (end < all.length) excerpt.push("…[later context omitted]");
  return {
    excerpt: excerpt.join("\n"),
    line: start + 1,
    endLine: Math.max(start + 1, end),
    truncated: omittedMeaningfulContext || contextWasClipped,
  };
}

function normalizeLineSet(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function lcsDiff(before: string[], after: string[]): DiffOperation[] {
  const width = after.length + 1;
  const matrix = new Uint32Array((before.length + 1) * width);
  for (let left = before.length - 1; left >= 0; left--) {
    for (let right = after.length - 1; right >= 0; right--) {
      const index = left * width + right;
      matrix[index] =
        before[left] === after[right]
          ? (matrix[(left + 1) * width + right + 1] ?? 0) + 1
          : Math.max(
              matrix[(left + 1) * width + right] ?? 0,
              matrix[left * width + right + 1] ?? 0,
            );
    }
  }
  const operations: DiffOperation[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (
      left < before.length &&
      right < after.length &&
      before[left] === after[right]
    ) {
      operations.push({
        kind: "equal",
        value: before[left] ?? "",
        beforeLine: left + 1,
        afterLine: right + 1,
      });
      left++;
      right++;
    } else if (
      right < after.length &&
      (left >= before.length ||
        (matrix[left * width + right + 1] ?? 0) >
          (matrix[(left + 1) * width + right] ?? 0))
    ) {
      operations.push({
        kind: "insert",
        value: after[right] ?? "",
        beforeLine: left + 1,
        afterLine: right + 1,
      });
      right++;
    } else {
      operations.push({
        kind: "delete",
        value: before[left] ?? "",
        beforeLine: left + 1,
        afterLine: right + 1,
      });
      left++;
    }
  }
  return operations;
}

function collectHunks(operations: DiffOperation[]): ChangeHunk[] {
  const hunks: ChangeHunk[] = [];
  let current: ChangeHunk | undefined;
  for (const operation of operations) {
    if (operation.kind === "equal") {
      if (current) hunks.push(current);
      current = undefined;
      continue;
    }
    current ??= {
      removed: [],
      added: [],
      beforeLine: operation.beforeLine,
      afterLine: operation.afterLine,
    };
    if (operation.kind === "delete") current.removed.push(operation.value);
    else current.added.push(operation.value);
  }
  if (current) hunks.push(current);
  return hunks.filter(
    (hunk) =>
      hunk.removed.join("\n").trim().length > 0 ||
      hunk.added.join("\n").trim().length > 0,
  );
}

function codeTokens(value: string): Set<string> {
  const ignored = new Set([
    "const",
    "let",
    "var",
    "return",
    "export",
    "function",
    "def",
    "none",
    "true",
    "false",
  ]);
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z_$][a-z0-9_$]*/g)
      ?.filter((token) => token.length > 1 && !ignored.has(token)) ?? [],
  );
}

function movedEditSimilarity(removed: string[], added: string[]): number {
  const before = removed.join("\n");
  const after = added.join("\n");
  const beforeTokens = codeTokens(before);
  const afterTokens = codeTokens(after);
  const shared = [...beforeTokens].filter((token) =>
    afterTokens.has(token),
  ).length;
  const tokenScore =
    shared / Math.max(1, Math.min(beforeTokens.size, afterTokens.size));
  const shape = (value: string) =>
    value
      .replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, "$X")
      .replace(/\s+/g, " ")
      .trim();
  // Token-disjoint renames such as legacy() -> modern() still carry strong
  // structural evidence when the edited line moved. Multiple equal shapes
  // remain ambiguous and are refused by the ranking stage below.
  const shapeScore = shape(before) === shape(after) ? 0.55 : 0;
  return Math.min(1, tokenScore + shapeScore);
}

function pairEditedMoves(hunks: ChangeHunk[]): ChangeHunk[] {
  const deletions = hunks.filter(
    (hunk) => hunk.removed.length > 0 && hunk.added.length === 0,
  );
  const insertions = hunks.filter(
    (hunk) => hunk.added.length > 0 && hunk.removed.length === 0,
  );
  const pairs: ChangeHunk[] = [];
  for (const deletion of deletions) {
    for (const insertion of insertions) {
      const linePairs: ChangeHunk[] = [];
      deletion.removed.forEach((removed, removedIndex) => {
        insertion.added.forEach((added, addedIndex) => {
          const similarity = movedEditSimilarity([removed], [added]);
          if (similarity < 0.45) return;
          linePairs.push({
            removed: [removed],
            added: [added],
            beforeLine: deletion.beforeLine + removedIndex,
            afterLine: insertion.afterLine + addedIndex,
            moveSimilarity: similarity,
          });
        });
      });
      if (linePairs.length > 0) pairs.push(...linePairs);
      else {
        const similarity = movedEditSimilarity(
          deletion.removed,
          insertion.added,
        );
        if (similarity < 0.45) continue;
        pairs.push({
          removed: deletion.removed,
          added: insertion.added,
          beforeLine: deletion.beforeLine,
          afterLine: insertion.afterLine,
          moveSimilarity: similarity,
        });
      }
    }
  }
  return pairs;
}

function reviewTerms(review: string): string[] {
  const ignored = new Set([
    "this",
    "that",
    "with",
    "from",
    "instead",
    "should",
    "please",
    "directly",
  ]);
  return [
    ...new Set(
      review
        .toLowerCase()
        .match(/[a-z_$][a-z0-9_$.]{3,}/g)
        ?.filter((term) => !ignored.has(term)) ?? [],
    ),
  ];
}

function selectCorrection(
  before: string,
  after: string,
  review: string,
): ChangeHunk {
  if (before === after)
    throw new RefusalError(
      "The accepted source is identical to the reviewed source; no correction exists.",
    );
  if (
    JSON.stringify(normalizeLineSet(before)) ===
    JSON.stringify(normalizeLineSet(after))
  )
    throw new RefusalError(
      "The path-scoped change only moves existing lines and provides no semantic correction.",
    );
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  if (beforeLines.length > MAX_DIFF_LINES || afterLines.length > MAX_DIFF_LINES)
    throw new RefusalError(
      `Source exceeds the bounded ${MAX_DIFF_LINES}-line reconstruction limit.`,
      "Narrow the reviewed change or provide a smaller historical excerpt.",
    );
  const rawHunks = collectHunks(lcsDiff(beforeLines, afterLines));
  const hunks = [
    ...rawHunks.filter(
      (hunk) => hunk.removed.length > 0 && hunk.added.length > 0,
    ),
    ...pairEditedMoves(rawHunks),
  ];
  if (hunks.length === 0)
    throw new RefusalError(
      "No trustworthy replacement hunk was found in the path-scoped change.",
    );
  const onlyHunk = hunks[0];
  if (hunks.length === 1 && onlyHunk) return onlyHunk;
  const terms = reviewTerms(review);
  const ranked = hunks
    .map((hunk) => ({
      hunk,
      score:
        terms.filter((term) =>
          `${hunk.removed.join("\n")}\n${hunk.added.join("\n")}`
            .toLowerCase()
            .includes(term),
        ).length *
          10 +
        (hunk.moveSimilarity ?? 0) * 5,
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score === 0 || best.score === second?.score)
    throw new RefusalError(
      `The path contains ${hunks.length} equally plausible correction hunks.`,
      "Choose a review comment tied to one local correction or provide a narrower diff.",
    );
  return best.hunk;
}

export function reconstruct(input: ReconstructionInput): {
  evidence: ReviewEvidence;
  candidate: CorrectionCandidate;
} {
  try {
    assertSafeExactPath(input.after.path, "candidate source path");
    for (const before of input.before)
      assertSafeExactPath(before.path, "historical source path");
  } catch (error) {
    throw new RefusalError(
      error instanceof Error ? error.message : "Unsafe source path.",
    );
  }
  if (input.after.deleted || input.after.content === undefined)
    throw new RefusalError(
      "The reviewed file was deleted without a reliable replacement.",
    );
  if (input.after.renamedFrom)
    validateRenameLanguage(input.after.renamedFrom, input.after.path);
  const original = [...input.before]
    .filter((item) => item.content !== undefined)
    .sort(
      (left, right) =>
        sourcePriority[left.source] - sourcePriority[right.source],
    )[0];
  if (!original?.content)
    throw new RefusalError(
      "Historical source was unavailable after all deterministic fallbacks.",
    );
  if (
    original.content.length > MAX_FILE_CHARS ||
    input.after.content.length > MAX_FILE_CHARS
  )
    throw new RefusalError(
      `Historical source exceeds the bounded ${MAX_FILE_CHARS}-character reconstruction limit.`,
      "Provide a smaller historical excerpt around the reviewed hunk.",
    );
  const language = detectLanguage(input.after.path);
  if ((input.replies?.length ?? 0) > 100)
    throw new RefusalError(
      "Review thread exceeds the bounded 100-reply evidence limit.",
      "Provide the relevant bounded review thread.",
    );
  const rootInput = input.threadRoot ?? {
    id: input.commentId,
    body: input.reviewBody,
  };
  const root = { id: rootInput.id, ...clip(rootInput.body, MAX_REVIEW_CHARS) };
  const replies = [...(input.replies ?? [])]
    .map((reply, index) => ({
      id: reply.id,
      index,
      ...clip(reply.body, MAX_REVIEW_CHARS),
    }))
    .sort((left, right) => left.id - right.id || left.index - right.index);
  const rankingParts: string[] = [];
  for (const value of [
    root.value,
    clip(input.reviewBody, MAX_REVIEW_CHARS).value,
    ...replies.map((reply) => reply.value),
  ])
    if (!rankingParts.includes(value)) rankingParts.push(value);
  const rankingContext = rankingParts.join("\n");
  const hunk = selectCorrection(
    original.content,
    input.after.content,
    rankingContext,
  );
  const beforeText = hunk.removed.join("\n").trim();
  const afterText = hunk.added.join("\n").trim();
  if (
    beforeText.length > MAX_CANDIDATE_CHARS ||
    afterText.length > MAX_CANDIDATE_CHARS
  )
    throw new RefusalError(
      "The correction hunk exceeds the bounded candidate size.",
      "Choose a smaller local correction rather than generating from a broad edit.",
    );
  const context = Math.max(0, Math.min(input.contextLines ?? 3, 20));
  const oldBound = linesAround(
    original.content,
    hunk.beforeLine,
    hunk.removed.length,
    context,
  );
  const newBound = linesAround(
    input.after.content,
    hunk.afterLine,
    hunk.added.length,
    context,
  );
  const review = clip(input.reviewBody, MAX_REVIEW_CHARS);
  const warnings = [
    ...(oldBound.truncated || newBound.truncated
      ? [
          "Source excerpts were truncated to configured context and character bounds.",
        ]
      : []),
    ...(review.truncated
      ? ["Review text was truncated to the configured character bound."]
      : []),
    ...(root.truncated || replies.some((reply) => reply.truncated)
      ? ["Review thread replies were truncated to bounded character limits."]
      : []),
    ...(input.after.renamedFrom
      ? [`Renamed from ${input.after.renamedFrom}`]
      : []),
  ];
  try {
    const evidence = reviewEvidenceSchema.parse({
      schemaVersion: 1,
      repository: { owner: input.owner, name: input.repository },
      pullRequest: {
        number: input.pullRequestNumber,
        headSha: input.after.sha,
        baseSha: original.sha,
        ...(input.pullRequestDetails
          ? {
              mergedAt: input.pullRequestDetails.mergedAt,
              mergeSha: input.pullRequestDetails.mergeSha,
            }
          : {}),
      },
      review: {
        commentId: input.commentId,
        body: review.value,
        resolved: input.resolved ?? true,
        merged: input.merged ?? true,
        ...(input.reviewDetails
          ? {
              path: input.reviewDetails.path,
              line: input.reviewDetails.line,
              side: input.reviewDetails.side,
              createdAt: input.reviewDetails.createdAt,
              updatedAt: input.reviewDetails.updatedAt,
            }
          : {}),
      },
      threadRoot: { id: root.id, body: root.value },
      replies: replies.map((reply) => ({ id: reply.id, body: reply.value })),
      original: {
        path: original.path,
        sha: original.sha,
        source: original.source,
        excerpt: oldBound.excerpt,
        startLine: oldBound.line,
        endLine: oldBound.endLine,
        truncated: oldBound.truncated,
      },
      final: {
        path: input.after.path,
        sha: input.after.sha,
        source: input.after.source,
        excerpt: newBound.excerpt,
        startLine: newBound.line,
        endLine: newBound.endLine,
        truncated: newBound.truncated,
      },
      rename: input.after.renamedFrom
        ? { from: input.after.renamedFrom, to: input.after.path }
        : null,
      provenance: [
        `${original.source}:${original.sha}`,
        `${input.after.source}:${input.after.sha}`,
        "bounded-path-scoped-hunk",
        ...(input.provenance ?? []),
      ],
      warnings,
    });
    const candidate = correctionCandidateSchema.parse({
      path: input.after.path,
      language,
      intentSummary: clip(rankingContext, 240).value,
      before: beforeText,
      after: afterText,
      beforeLine: hunk.beforeLine,
      afterLine: hunk.afterLine,
      evidence: [
        "deterministic bounded path-scoped hunk",
        `historical source ${original.source}`,
        "accepted PR head",
        `review thread root ${root.id} with ${replies.length} repl${replies.length === 1 ? "y" : "ies"}`,
      ],
      confidence: 0.96,
    });
    return { evidence, candidate };
  } catch (error) {
    throw new RefusalError(
      `Reconstructed evidence could not be bounded safely: ${error instanceof Error ? error.message.slice(0, 300) : "invalid evidence"}`,
      "Provide a smaller, well-formed review correction.",
    );
  }
}
