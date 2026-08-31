import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import { matchSchema, type GeneratedRuleProposal } from "./domain/schemas.js";
import { ValidationError } from "./domain/errors.js";
import { proposalFromYaml } from "./replay.js";
import {
  assertSafeExactPath,
  containedPath,
  inspectContainedPathNoFollow,
} from "./security/path.js";
import { scanWithSemgrep } from "./semgrep/runner.js";
import type { CommandRunner } from "./utils/command.js";

export const scanResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("success"),
  rulePath: z.string(),
  target: z.string(),
  matches: z.array(
    matchSchema.extend({
      ruleId: z.string(),
      severity: z.enum(["INFO", "WARNING", "ERROR"]),
    }),
  ),
});

export async function scanRule(input: {
  repositoryDir: string;
  rulePath: string;
  target?: string;
  runner: CommandRunner;
  matchLimit?: number;
}) {
  assertSafeExactPath(input.rulePath, "rule path");
  const state = await inspectContainedPathNoFollow(
    input.repositoryDir,
    input.rulePath,
  );
  if (state.kind !== "file")
    throw new ValidationError("Rule must be a regular non-symlink file.");
  const yaml = await readFile(
    containedPath(input.repositoryDir, input.rulePath),
    "utf8",
  );
  let proposal: GeneratedRuleProposal;
  try {
    proposal = proposalFromYaml(yaml);
  } catch (error) {
    throw new ValidationError(
      `Rule is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const target = input.target ?? ".";
  if (target !== ".") assertSafeExactPath(target, "scan target");
  let targetKind: "directory" | "file" | "other" | "symlink" | "missing";
  if (target === ".") {
    const state = await lstat(input.repositoryDir);
    targetKind = state.isSymbolicLink()
      ? "symlink"
      : state.isDirectory()
        ? "directory"
        : state.isFile()
          ? "file"
          : "other";
  } else {
    targetKind = (
      await inspectContainedPathNoFollow(input.repositoryDir, target)
    ).kind;
  }
  if (targetKind !== "file" && targetKind !== "directory")
    throw new ValidationError(
      "Scan target must be a regular file or directory without symlink traversal.",
    );
  const rawMatches = await scanWithSemgrep({
    proposal,
    rulePath: containedPath(input.repositoryDir, input.rulePath),
    target:
      target === "."
        ? input.repositoryDir
        : containedPath(input.repositoryDir, target),
    runner: input.runner,
    ...(input.matchLimit ? { matchLimit: input.matchLimit } : {}),
  });
  const matches = rawMatches.map((match) => ({
    ...match,
    ruleId: proposal.id,
    severity: proposal.severity,
  }));
  return scanResultSchema.parse({
    schemaVersion: 1,
    status: "success",
    rulePath: input.rulePath,
    target,
    matches,
  });
}
