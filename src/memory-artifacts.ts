import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { z } from "zod";
import { UnsafeRepositoryError } from "./domain/errors.js";
import { reviewRuleSchema, type AgentReviewRule } from "./domain/memory.js";
import type { ReviewEvidence } from "./domain/evidence.js";
import type { PlannedWrite, TransactionPlan } from "./transaction.js";
import type { PolicyUpdate } from "./memory-policy.js";
import {
  assertSafeExactPath,
  containedPath,
  inspectContainedPathNoFollow,
} from "./security/path.js";
import { canonicalReviewSourceIdentity } from "./source.js";
import { renderAgentReviewRule, renderRuleIndex } from "./rules/render.js";
import { GENERATOR_VERSION } from "./version.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const maxArtifactBytes = 2_000_000;

export const memoryManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    generatorVersion: z.string(),
    source: z.object({ url: z.url(), identity: z.string() }).strict(),
    rule: reviewRuleSchema,
    approval: z
      .object({
        mode: z.enum(["interactive", "yes"]),
        policyTarget: z.enum(["agents", "claude", "both", "neither"]),
        policyExplicit: z.boolean(),
      })
      .strict(),
    indexPath: z.string(),
    policyFiles: z.array(z.string()).max(2),
    ownedFiles: z.array(z.string()).length(3),
    writtenFiles: z
      .array(
        z.object({ path: z.string(), sha256: z.string().length(64) }).strict(),
      )
      .length(2),
  })
  .strict();
export type MemoryManifest = z.infer<typeof memoryManifestSchema>;

export interface MemoryManifestLayout {
  outputDir: string;
  artifactId: string;
  rulePath: string;
  evidencePath: string;
  manifestPath: string;
  indexPath: string;
  policyPaths: string[];
}

function samePathSet(left: readonly string[], right: readonly string[]) {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((path, index) => path === rightSorted[index])
  );
}

export function canonicalMemoryManifestLayout(
  manifest: MemoryManifest,
  manifestPath: string,
): MemoryManifestLayout {
  assertSafeExactPath(manifestPath, "manifest path");
  for (const path of [
    manifest.indexPath,
    ...manifest.policyFiles,
    ...manifest.ownedFiles,
    ...manifest.writtenFiles.map((file) => file.path),
  ])
    assertSafeExactPath(path, "manifest path");
  const match = /^(.*)\/manifests\/([^/]+)\.json$/.exec(manifestPath);
  if (!match?.[1] || !match[2])
    throw new UnsafeRepositoryError(
      "Manifest path must be <output-root>/manifests/<rule-id>.json.",
    );
  const outputDir = match[1];
  const artifactId = match[2];
  const rulePath = `${outputDir}/rules/${artifactId}.md`;
  const evidencePath = `${outputDir}/evidence/${artifactId}.json`;
  const expectedOwned = [rulePath, evidencePath, manifestPath];
  if (!samePathSet(manifest.ownedFiles, expectedOwned))
    throw new UnsafeRepositoryError(
      "Manifest must own exactly one Markdown rule, evidence file, and itself.",
    );
  if (
    !samePathSet(
      manifest.writtenFiles.map((file) => file.path),
      [rulePath, evidencePath],
    )
  )
    throw new UnsafeRepositoryError(
      "Manifest hashes must cover exactly its Markdown rule and evidence file.",
    );
  if (manifest.rule.id !== artifactId)
    throw new UnsafeRepositoryError(
      "Manifest rule ID must match its canonical artifact filename.",
    );
  if (manifest.indexPath !== `${outputDir}/INDEX.md`)
    throw new UnsafeRepositoryError(
      "Manifest index path must be the canonical output-root INDEX.md.",
    );
  const agents = manifest.policyFiles.filter((path) =>
    /(^|\/)AGENTS\.md$/i.test(path),
  );
  const claude = manifest.policyFiles.filter((path) =>
    /(^|\/)CLAUDE\.md$/i.test(path),
  );
  const expectedCounts = {
    neither: [0, 0],
    agents: [1, 0],
    claude: [0, 1],
    both: [1, 1],
  }[manifest.approval.policyTarget];
  if (
    manifest.approval.policyTarget !== "neither" &&
    !manifest.approval.policyExplicit
  )
    throw new UnsafeRepositoryError(
      "Manifest policy consent must be explicit when policy files are selected.",
    );
  if (
    agents.length !== expectedCounts[0] ||
    claude.length !== expectedCounts[1] ||
    agents.length + claude.length !== manifest.policyFiles.length
  )
    throw new UnsafeRepositoryError(
      "Manifest policy files do not match the selected policy target.",
    );
  return {
    outputDir,
    artifactId,
    rulePath,
    evidencePath,
    manifestPath,
    indexPath: manifest.indexPath,
    policyPaths: [...manifest.policyFiles],
  };
}

export function parseMemoryManifest(value: unknown, manifestPath: string) {
  const manifest = memoryManifestSchema.parse(value);
  if (
    manifest.source.identity !==
    canonicalReviewSourceIdentity(manifest.source.url)
  )
    throw new UnsafeRepositoryError(
      "Manifest source identity is not canonical for its review URL.",
    );
  return {
    manifest,
    layout: canonicalMemoryManifestLayout(manifest, manifestPath),
  };
}

interface FoundManifest {
  path: string;
  manifest: MemoryManifest;
}

async function pathExists(repositoryDir: string, path: string) {
  try {
    await lstat(containedPath(repositoryDir, path));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function readExistingManifests(
  repositoryDir: string,
  outputDir: string,
): Promise<FoundManifest[]> {
  const root = await inspectContainedPathNoFollow(repositoryDir, outputDir);
  if (!root.exists) return [];
  if (root.kind !== "directory")
    throw new UnsafeRepositoryError(
      "Review-memory output root must be a non-symlink directory.",
    );
  const directoryPath = `${outputDir}/manifests`;
  const directory = await inspectContainedPathNoFollow(
    repositoryDir,
    directoryPath,
  );
  if (!directory.exists) return [];
  if (directory.kind !== "directory")
    throw new UnsafeRepositoryError(
      "Review-memory manifest root must be a non-symlink directory.",
    );
  const found: FoundManifest[] = [];
  for (const name of (
    await readdir(containedPath(repositoryDir, directoryPath))
  )
    .filter((value) => value.endsWith(".json"))
    .sort()) {
    const path = `${directoryPath}/${name}`;
    const state = await inspectContainedPathNoFollow(repositoryDir, path);
    if (state.kind !== "file" || (state.size ?? 0) > maxArtifactBytes)
      throw new UnsafeRepositoryError(
        `Existing review-memory manifest is unsafe or oversized: ${path}`,
      );
    try {
      found.push({
        path,
        manifest: parseMemoryManifest(
          JSON.parse(
            await readFile(containedPath(repositoryDir, path), "utf8"),
          ),
          path,
        ).manifest,
      });
    } catch (error) {
      throw new UnsafeRepositoryError(
        `Existing review-memory manifest is malformed: ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return found;
}

async function selectIdentity(input: {
  repositoryDir: string;
  outputDir: string;
  rule: AgentReviewRule;
  sourceIdentity: string;
  existing: FoundManifest[];
}) {
  const sameSource = input.existing.find(
    (item) => item.manifest.source.identity === input.sourceIdentity,
  );
  if (sameSource)
    return {
      id: sameSource.manifest.rule.id,
      collision: "replace_same_source" as const,
      ownerManifest: sameSource.manifest,
    };
  for (let suffix = 1; suffix < 10_000; suffix++) {
    const id = suffix === 1 ? input.rule.id : `${input.rule.id}-${suffix}`;
    const paths = [
      `${input.outputDir}/rules/${id}.md`,
      `${input.outputDir}/evidence/${id}.json`,
      `${input.outputDir}/manifests/${id}.json`,
    ];
    if (
      !(
        await Promise.all(
          paths.map((path) => pathExists(input.repositoryDir, path)),
        )
      ).some(Boolean)
    )
      return {
        id,
        collision: suffix === 1 ? ("new" as const) : ("suffixed" as const),
        ownerManifest: null,
      };
  }
  throw new UnsafeRepositoryError(
    "No free deterministic review-rule suffix remains.",
  );
}

async function sharedFile(input: {
  repositoryDir: string;
  path: string;
  content: string;
  kind: "artifact" | "policy";
}): Promise<{
  write: PlannedWrite | null;
  previousHash: string | null;
  action: "create" | "update" | "unchanged";
}> {
  const state = await inspectContainedPathNoFollow(
    input.repositoryDir,
    input.path,
  );
  if (state.kind === "symlink" || (state.exists && state.kind !== "file"))
    throw new UnsafeRepositoryError(
      `Shared review-memory target must be a regular non-symlink file: ${input.path}`,
    );
  const previous =
    state.kind === "file"
      ? await readFile(containedPath(input.repositoryDir, input.path), "utf8")
      : undefined;
  const previousHash = previous === undefined ? null : sha256(previous);
  const action =
    previous === undefined
      ? ("create" as const)
      : previous === input.content
        ? ("unchanged" as const)
        : ("update" as const);
  return {
    previousHash,
    action,
    write:
      action === "unchanged"
        ? null
        : {
            path: input.path,
            content: input.content,
            kind: input.kind,
            action,
          },
  };
}

export interface MemoryArtifactPlan extends TransactionPlan {
  ruleId: string;
  manifestPath: string;
  ownerManifest: MemoryManifest | null;
  index: {
    path: string;
    content: string;
    previousHash: string | null;
    action: "create" | "update" | "unchanged";
  };
}

export async function planMemoryArtifacts(input: {
  repositoryDir: string;
  outputDir: string;
  sourceUrl: string;
  sourceIdentity: string;
  rule: AgentReviewRule;
  evidence: ReviewEvidence;
  approvalMode: "interactive" | "yes";
  policyTarget: string;
  policyExplicit?: boolean;
  policyPaths?: string[];
  policyUpdates?: PolicyUpdate[];
}): Promise<MemoryArtifactPlan> {
  if (input.sourceIdentity !== canonicalReviewSourceIdentity(input.sourceUrl))
    throw new UnsafeRepositoryError(
      "Artifact source identity is not canonical for its review URL.",
    );
  assertSafeExactPath(input.outputDir, "output directory");
  const outputState = await inspectContainedPathNoFollow(
    input.repositoryDir,
    input.outputDir,
  );
  if (outputState.kind === "symlink")
    throw new UnsafeRepositoryError(
      `Refusing symlink in review-memory output path: ${outputState.symlinkPath ?? input.outputDir}`,
    );
  if (outputState.exists && outputState.kind !== "directory")
    throw new UnsafeRepositoryError(
      "Review-memory output root is not a directory.",
    );
  const policyPaths = [...(input.policyPaths ?? [])].sort();
  const policyUpdates = input.policyUpdates ?? [];
  if (
    !samePathSet(
      policyPaths,
      policyUpdates.map((update) => update.path),
    )
  )
    throw new UnsafeRepositoryError("Planned policy paths and updates differ.");
  const existing = await readExistingManifests(
    input.repositoryDir,
    input.outputDir,
  );
  const selected = await selectIdentity({
    repositoryDir: input.repositoryDir,
    outputDir: input.outputDir,
    rule: input.rule,
    sourceIdentity: input.sourceIdentity,
    existing,
  });
  const rule = reviewRuleSchema.parse({ ...input.rule, id: selected.id });
  const rulePath = `${input.outputDir}/rules/${selected.id}.md`;
  const evidencePath = `${input.outputDir}/evidence/${selected.id}.json`;
  const manifestPath = `${input.outputDir}/manifests/${selected.id}.json`;
  const indexPath = `${input.outputDir}/INDEX.md`;
  const ruleContent = renderAgentReviewRule(rule, input.sourceUrl);
  const evidenceContent = `${JSON.stringify(input.evidence, null, 2)}\n`;
  const entries = existing
    .filter((item) => item.manifest.source.identity !== input.sourceIdentity)
    .map((item) => ({
      id: item.manifest.rule.id,
      title: item.manifest.rule.title,
      priority: item.manifest.rule.priority,
      paths: item.manifest.rule.scope.paths,
      languages: item.manifest.rule.scope.languages,
    }));
  entries.push({
    id: rule.id,
    title: rule.title,
    priority: rule.priority,
    paths: rule.scope.paths,
    languages: rule.scope.languages,
  });
  const indexContent = renderRuleIndex(entries);
  const index = await sharedFile({
    repositoryDir: input.repositoryDir,
    path: indexPath,
    content: indexContent,
    kind: "artifact",
  });
  const artifactAction = selected.ownerManifest ? "replace" : "create";
  const baseFiles: PlannedWrite[] = [
    {
      path: rulePath,
      content: ruleContent,
      kind: "artifact",
      action: artifactAction,
    },
    {
      path: evidencePath,
      content: evidenceContent,
      kind: "artifact",
      action: artifactAction,
    },
  ];
  const ownedFiles = [rulePath, evidencePath, manifestPath].sort();
  const manifest = memoryManifestSchema.parse({
    schemaVersion: 2,
    generatorVersion: GENERATOR_VERSION,
    source: { url: input.sourceUrl, identity: input.sourceIdentity },
    rule,
    approval: {
      mode: input.approvalMode,
      policyTarget: input.policyTarget,
      policyExplicit: input.policyExplicit ?? false,
    },
    indexPath,
    policyFiles: policyPaths,
    ownedFiles,
    writtenFiles: baseFiles.map((file) => ({
      path: file.path,
      sha256: sha256(file.content),
    })),
  });
  canonicalMemoryManifestLayout(manifest, manifestPath);
  const policyRecords = policyUpdates
    .filter((update) => update.action !== "unchanged")
    .map((update) => ({
      path: update.path,
      content: update.content,
      kind: "policy" as const,
      action:
        update.action === "create" ? ("create" as const) : ("update" as const),
    }));
  const files: PlannedWrite[] = [
    ...baseFiles,
    ...(index.write ? [index.write] : []),
    {
      path: manifestPath,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      kind: "artifact",
      action: artifactAction,
    },
    ...policyRecords,
  ];
  for (const file of files) assertSafeExactPath(file.path, `${file.kind} path`);
  return {
    outputDir: input.outputDir,
    collision: selected.collision,
    ruleId: selected.id,
    manifestPath,
    files,
    ownedFiles,
    ownerManifest: selected.ownerManifest,
    sharedFiles: [
      { path: indexPath, previousHash: index.previousHash },
      ...policyUpdates.map((update) => ({
        path: update.path,
        previousHash: update.previousHash,
      })),
    ],
    index: {
      path: indexPath,
      content: indexContent,
      previousHash: index.previousHash,
      action: index.action,
    },
  };
}
