import { readFile, readdir } from "node:fs/promises";
import { z } from "zod";
import { ValidationError } from "./domain/errors.js";
import { parseMemoryManifest } from "./memory-artifacts.js";
import { replayResultSchema, replayMemoryManifest } from "./memory-replay.js";
import { renderRuleIndex, type RuleIndexEntry } from "./rules/render.js";
import {
  assertSafeExactPath,
  containedPath,
  inspectContainedPathNoFollow,
} from "./security/path.js";

export const validationItemSchema = z
  .object({
    inputPath: z.string(),
    manifestPath: z.string().nullable(),
    status: z.enum(["passed", "failed"]),
    result: replayResultSchema.nullable(),
    error: z.string().nullable(),
  })
  .strict();
export const validateAllResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    status: z.enum(["success", "validation_failed"]),
    outputDir: z.string(),
    indexPath: z.string(),
    items: z.array(validationItemSchema),
    unownedRules: z.array(z.string()),
    duplicateRuleIds: z.array(z.string()),
    errors: z.array(z.string()),
  })
  .strict();

async function safeDirectoryEntries(
  repositoryDir: string,
  relativePath: string,
): Promise<string[]> {
  const state = await inspectContainedPathNoFollow(repositoryDir, relativePath);
  if (!state.exists) return [];
  if (state.kind !== "directory")
    throw new ValidationError(
      `${relativePath} must be a non-symlink directory.`,
    );
  return (await readdir(containedPath(repositoryDir, relativePath))).sort();
}

export function resolveMemoryManifestInput(input: {
  inputPath: string;
  outputDir?: string;
}): string {
  assertSafeExactPath(input.inputPath, "validation input path");
  if (/\/manifests\/[^/]+\.json$/.test(input.inputPath)) return input.inputPath;
  const rule = /^(.*)\/rules\/([^/]+)\.md$/.exec(input.inputPath);
  if (!rule?.[1] || !rule[2])
    throw new ValidationError(
      "Validation input must be a canonical manifest JSON or generated Markdown rule path.",
    );
  const expectedRoot = input.outputDir ?? rule[1];
  if (rule[1] !== expectedRoot)
    throw new ValidationError(
      "Rule path is outside the configured review-memory root.",
    );
  return `${expectedRoot}/manifests/${rule[2]}.json`;
}

export async function validateMemoryArtifact(input: {
  repositoryDir: string;
  inputPath: string;
  outputDir?: string;
}) {
  return replayMemoryManifest({
    repositoryDir: input.repositoryDir,
    manifestPath: resolveMemoryManifestInput(input),
  });
}

export async function validateAllMemory(input: {
  repositoryDir: string;
  outputDir: string;
}) {
  assertSafeExactPath(input.outputDir, "output directory");
  const manifestDir = `${input.outputDir}/manifests`;
  const ruleDir = `${input.outputDir}/rules`;
  const indexPath = `${input.outputDir}/INDEX.md`;
  const manifestNames = (
    await safeDirectoryEntries(input.repositoryDir, manifestDir)
  ).filter((name) => name.endsWith(".json"));
  const items: Array<z.infer<typeof validationItemSchema>> = [];
  const ownedRules = new Map<string, number>();
  const ruleIds = new Map<string, number>();
  const indexEntries: RuleIndexEntry[] = [];
  const errors: string[] = [];
  for (const name of manifestNames) {
    const manifestPath = `${manifestDir}/${name}`;
    try {
      const raw = JSON.parse(
        await readFile(
          containedPath(input.repositoryDir, manifestPath),
          "utf8",
        ),
      ) as unknown;
      const parsed = parseMemoryManifest(raw, manifestPath);
      const result = await replayMemoryManifest({
        repositoryDir: input.repositoryDir,
        manifestPath,
      });
      ownedRules.set(
        result.rulePath,
        (ownedRules.get(result.rulePath) ?? 0) + 1,
      );
      const rule = parsed.manifest.rule;
      ruleIds.set(rule.id, (ruleIds.get(rule.id) ?? 0) + 1);
      indexEntries.push({
        id: rule.id,
        title: rule.title,
        priority: rule.priority,
        paths: rule.scope.paths,
        languages: rule.scope.languages,
      });
      items.push({
        inputPath: manifestPath,
        manifestPath,
        status: "passed",
        result,
        error: null,
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      items.push({
        inputPath: manifestPath,
        manifestPath,
        status: "failed",
        result: null,
        error,
      });
      errors.push(`${manifestPath}: ${error}`);
    }
  }
  const ruleNames = (
    await safeDirectoryEntries(input.repositoryDir, ruleDir)
  ).filter((name) => name.endsWith(".md"));
  const unownedRules: string[] = [];
  for (const name of ruleNames) {
    const path = `${ruleDir}/${name}`;
    const state = await inspectContainedPathNoFollow(input.repositoryDir, path);
    if (state.kind !== "file" || !ownedRules.has(path)) unownedRules.push(path);
  }
  const duplicateRuleIds = [...ruleIds.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  if (unownedRules.length)
    errors.push(`Unowned rules: ${unownedRules.join(", ")}`);
  if (duplicateRuleIds.length)
    errors.push(`Duplicate rule IDs: ${duplicateRuleIds.join(", ")}`);
  if (!manifestNames.length)
    errors.push(`No manifests found beneath ${manifestDir}.`);
  const indexState = await inspectContainedPathNoFollow(
    input.repositoryDir,
    indexPath,
  );
  if (indexState.kind !== "file")
    errors.push(`Review-memory index is missing or unsafe: ${indexPath}`);
  else {
    const actual = await readFile(
      containedPath(input.repositoryDir, indexPath),
      "utf8",
    );
    const expected = renderRuleIndex(indexEntries);
    if (actual !== expected)
      errors.push(
        `Review-memory index does not match the canonical manifest set: ${indexPath}`,
      );
  }
  return validateAllResultSchema.parse({
    schemaVersion: 2,
    status: errors.length ? "validation_failed" : "success",
    outputDir: input.outputDir,
    indexPath,
    items,
    unownedRules,
    duplicateRuleIds,
    errors,
  });
}
