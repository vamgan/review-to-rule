import { readdir, readFile } from "node:fs/promises";
import { z } from "zod";
import { ValidationError } from "./domain/errors.js";
import {
  proposalFromYaml,
  replayResultSchema,
  replayArtifactManifest,
} from "./replay.js";
import {
  assertSafeExactPath,
  containedPath,
  inspectContainedPathNoFollow,
} from "./security/path.js";
import type { CommandRunner } from "./utils/command.js";

export const validationItemSchema = z.object({
  inputPath: z.string(),
  manifestPath: z.string().nullable(),
  status: z.enum(["passed", "failed"]),
  result: replayResultSchema.nullable(),
  error: z.string().nullable(),
});
export const validateAllResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["success", "validation_failed"]),
  outputDir: z.string(),
  items: z.array(validationItemSchema),
  unownedRules: z.array(z.string()),
  duplicateRuleIds: z.array(z.string()),
  errors: z.array(z.string()),
});

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

export function resolveManifestInput(input: {
  repositoryDir: string;
  inputPath: string;
  outputDir?: string;
}): string {
  assertSafeExactPath(input.inputPath, "validation input path");
  if (/\/manifests\/[^/]+\.json$/.test(input.inputPath)) return input.inputPath;
  const rule = /^(.*)\/rules\/([^/]+)\.ya?ml$/.exec(input.inputPath);
  if (!rule?.[1] || !rule[2])
    throw new ValidationError(
      "Validation input must be a canonical manifest JSON or generated rule YAML path.",
    );
  const expectedRoot = input.outputDir ?? rule[1];
  if (rule[1] !== expectedRoot)
    throw new ValidationError(
      "Rule path is outside the configured artifact root.",
    );
  return `${expectedRoot}/manifests/${rule[2]}.json`;
}

export async function validateArtifact(input: {
  repositoryDir: string;
  inputPath: string;
  outputDir?: string;
  runner: CommandRunner;
}) {
  const manifestPath = resolveManifestInput(input);
  return replayArtifactManifest({
    repositoryDir: input.repositoryDir,
    manifestPath,
    runner: input.runner,
  });
}

export async function validateAllArtifacts(input: {
  repositoryDir: string;
  outputDir: string;
  runner: CommandRunner;
}) {
  assertSafeExactPath(input.outputDir, "output directory");
  const manifestDir = `${input.outputDir}/manifests`;
  const ruleDir = `${input.outputDir}/rules`;
  const manifestNames = (
    await safeDirectoryEntries(input.repositoryDir, manifestDir)
  ).filter((name) => name.endsWith(".json"));
  const items: Array<z.infer<typeof validationItemSchema>> = [];
  const ownedRules = new Map<string, number>();
  const ruleIds = new Map<string, number>();
  const errors: string[] = [];
  for (const name of manifestNames) {
    const manifestPath = `${manifestDir}/${name}`;
    const state = await inspectContainedPathNoFollow(
      input.repositoryDir,
      manifestPath,
    );
    if (state.kind !== "file") {
      const error = `${manifestPath} is not a regular non-symlink file.`;
      items.push({
        inputPath: manifestPath,
        manifestPath,
        status: "failed",
        result: null,
        error,
      });
      errors.push(error);
      continue;
    }
    try {
      const result = await replayArtifactManifest({
        repositoryDir: input.repositoryDir,
        manifestPath,
        runner: input.runner,
      });
      ownedRules.set(
        result.rulePath,
        (ownedRules.get(result.rulePath) ?? 0) + 1,
      );
      const proposal = proposalFromYaml(
        await readFile(
          containedPath(input.repositoryDir, result.rulePath),
          "utf8",
        ),
      );
      ruleIds.set(proposal.id, (ruleIds.get(proposal.id) ?? 0) + 1);
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
  ).filter((name) => /\.ya?ml$/.test(name));
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
  return validateAllResultSchema.parse({
    schemaVersion: 1,
    status: errors.length ? "validation_failed" : "success",
    outputDir: input.outputDir,
    items,
    unownedRules,
    duplicateRuleIds,
    errors,
  });
}
