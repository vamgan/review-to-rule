import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { UnsafeRepositoryError } from "./domain/errors.js";
import type {
  GeneratedRuleProposal,
  ReviewEvidence,
} from "./domain/schemas.js";
import {
  assertSafeExactPath,
  containedPath,
  inspectContainedPathNoFollow,
} from "./security/path.js";
import type { CommandRunner } from "./utils/command.js";
import type { PolicyUpdate } from "./policy.js";
import { canonicalReviewIdentity, parseReviewUrl } from "./github/url.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const artifactManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatorVersion: z
      .string()
      .regex(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
        "generatorVersion must be a valid semantic version",
      ),
    source: z.object({ url: z.url(), identity: z.string() }),
    ruleId: z.string(),
    approval: z.object({
      mode: z.enum(["interactive", "yes"]),
      policyTarget: z.enum(["agents", "claude", "both", "neither"]),
      policyExplicit: z.boolean(),
    }),
    expectations: z.object({
      beforeMatches: z.literal(true),
      afterMatches: z.literal(false),
      allowedMatches: z.literal(false),
    }),
    ownedFiles: z.array(z.string()).min(5),
    writtenFiles: z.array(
      z.object({ path: z.string(), sha256: z.string().length(64) }),
    ),
  })
  .strict();
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export const GENERATOR_VERSION = "0.1.0";

export interface CanonicalManifestLayout {
  outputDir: string;
  artifactId: string;
  rulePath: string;
  evidencePath: string;
  beforePath: string;
  afterPath: string;
  allowedPath?: string;
  policyPaths: string[];
}

function samePathSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === new Set(left).size &&
    right.length === new Set(right).size &&
    [...left]
      .sort()
      .every((path, index) => path === [...right].sort()[index]) &&
    left.length === right.length
  );
}

export function canonicalManifestLayout(
  manifest: ArtifactManifest,
  manifestPath: string,
): CanonicalManifestLayout {
  assertSafeExactPath(manifestPath, "manifest path");
  for (const path of [
    ...manifest.ownedFiles,
    ...manifest.writtenFiles.map((item) => item.path),
  ])
    assertSafeExactPath(path, "manifest artifact path");
  const match = /^(.*)\/manifests\/([^/]+)\.json$/.exec(manifestPath);
  if (!match?.[1] || !match[2])
    throw new UnsafeRepositoryError(
      "Manifest path must be <output-root>/manifests/<artifact-id>.json.",
    );
  const outputDir = match[1];
  const artifactId = match[2];
  const writtenPaths = manifest.writtenFiles.map((file) => file.path);
  const expectedWritten = manifest.ownedFiles.filter(
    (path) => path !== manifestPath,
  );
  if (
    manifest.ownedFiles.filter((path) => path === manifestPath).length !== 1 ||
    !samePathSet(writtenPaths, expectedWritten)
  )
    throw new UnsafeRepositoryError(
      "Manifest hashed paths must exactly equal owned paths minus the manifest itself, without duplicates.",
    );
  const rulePath = `${outputDir}/rules/${artifactId}.yml`;
  const evidencePath = `${outputDir}/evidence/${artifactId}.json`;
  const fixtureRoot = `${outputDir}/fixtures/${artifactId}`;
  const fixturePaths = writtenPaths.filter((path) =>
    path.startsWith(`${fixtureRoot}/`),
  );
  const before = fixturePaths.filter((path) =>
    /^before\.(?:ts|js|py)$/.test(path.slice(fixtureRoot.length + 1)),
  );
  const after = fixturePaths.filter((path) =>
    /^after\.(?:ts|js|py)$/.test(path.slice(fixtureRoot.length + 1)),
  );
  const allowed = fixturePaths.filter((path) =>
    /^allowed\.(?:ts|js|py)$/.test(path.slice(fixtureRoot.length + 1)),
  );
  if (
    !writtenPaths.includes(rulePath) ||
    !writtenPaths.includes(evidencePath) ||
    before.length !== 1 ||
    after.length !== 1 ||
    allowed.length > 1
  )
    throw new UnsafeRepositoryError(
      "Manifest must own exactly one canonical rule, evidence file, before fixture, after fixture, and optional allowed fixture.",
    );
  const extensions = [before[0], after[0], allowed[0]]
    .filter((path): path is string => Boolean(path))
    .map((path) => path.slice(path.lastIndexOf(".") + 1));
  if (new Set(extensions).size !== 1)
    throw new UnsafeRepositoryError("Manifest fixture extensions must agree.");
  const canonicalArtifacts = new Set([
    rulePath,
    evidencePath,
    before[0],
    after[0],
    ...(allowed[0] ? [allowed[0]] : []),
  ]);
  const policyPaths = writtenPaths.filter(
    (path) => !canonicalArtifacts.has(path),
  );
  if (policyPaths.some((path) => path.startsWith(`${outputDir}/`)))
    throw new UnsafeRepositoryError(
      "Manifest contains a foreign path beneath its artifact output root.",
    );
  const agents = policyPaths.filter((path) => /(^|\/)AGENTS\.md$/i.test(path));
  const claude = policyPaths.filter((path) => /(^|\/)CLAUDE\.md$/i.test(path));
  const expectedPolicyCounts = {
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
    agents.length !== expectedPolicyCounts[0] ||
    claude.length !== expectedPolicyCounts[1] ||
    agents.length + claude.length !== policyPaths.length
  )
    throw new UnsafeRepositoryError(
      "Manifest policy files do not match the selected policy target.",
    );
  return {
    outputDir,
    artifactId,
    rulePath,
    evidencePath,
    beforePath: before[0] ?? "",
    afterPath: after[0] ?? "",
    ...(allowed[0] ? { allowedPath: allowed[0] } : {}),
    policyPaths,
  };
}

export function parseCanonicalArtifactManifest(
  value: unknown,
  manifestPath: string,
): { manifest: ArtifactManifest; layout: CanonicalManifestLayout } {
  const manifest = artifactManifestSchema.parse(value);
  const parsedSource = parseReviewUrl(manifest.source.url);
  if (manifest.source.identity !== canonicalReviewIdentity(parsedSource))
    throw new UnsafeRepositoryError(
      "Manifest source identity is not canonical for its supported review URL.",
    );
  return { manifest, layout: canonicalManifestLayout(manifest, manifestPath) };
}

export interface PlannedWrite {
  path: string;
  content: string;
  kind: "artifact" | "policy";
  action: "create" | "replace" | "update";
}
export interface ArtifactPlan {
  outputDir: string;
  collision: "new" | "replace_same_source" | "suffixed";
  ruleId: string;
  manifestPath: string;
  files: PlannedWrite[];
  ownedFiles: string[];
  ownerManifest: ArtifactManifest | null;
}

interface FoundManifest {
  id: string;
  path: string;
  manifest: ArtifactManifest;
}

async function pathExists(
  repositoryDir: string,
  path: string,
): Promise<boolean> {
  try {
    await lstat(containedPath(repositoryDir, path));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function findExistingManifests(
  repositoryDir: string,
  outputDir: string,
  ruleId: string,
): Promise<FoundManifest[]> {
  const relativeDir = `${outputDir}/manifests`;
  const outputState = await inspectContainedPathNoFollow(
    repositoryDir,
    outputDir,
  );
  if (outputState.kind === "symlink") return [];
  if (!outputState.exists) return [];
  if (outputState.kind !== "directory")
    throw new UnsafeRepositoryError("Artifact output root is not a directory.");
  const directoryState = await inspectContainedPathNoFollow(
    repositoryDir,
    relativeDir,
  );
  if (directoryState.kind === "symlink") return [];
  if (!directoryState.exists) return [];
  if (directoryState.kind !== "directory")
    throw new UnsafeRepositoryError(
      "Artifact manifest path is not a directory.",
    );
  const dir = containedPath(repositoryDir, relativeDir);
  const found: FoundManifest[] = [];
  try {
    const names = await readdir(dir);
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        const path = `${relativeDir}/${name}`;
        const state = await inspectContainedPathNoFollow(repositoryDir, path);
        if (state.kind !== "file") continue;
        const manifest = parseCanonicalArtifactManifest(
          JSON.parse(
            await readFile(containedPath(repositoryDir, path), "utf8"),
          ),
          path,
        ).manifest;
        if (manifest.ruleId === ruleId)
          found.push({
            id: name.slice(0, -5),
            path,
            manifest,
          });
      } catch {
        // Invalid manifests never grant ownership.
      }
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  return found;
}

function extension(language: GeneratedRuleProposal["language"]): string {
  return language === "python" ? "py" : language === "javascript" ? "js" : "ts";
}

function artifactPaths(input: {
  outputDir: string;
  id: string;
  extension: string;
  hasAllowed: boolean;
}): string[] {
  return [
    `${input.outputDir}/rules/${input.id}.yml`,
    `${input.outputDir}/evidence/${input.id}.json`,
    `${input.outputDir}/fixtures/${input.id}/before.${input.extension}`,
    `${input.outputDir}/fixtures/${input.id}/after.${input.extension}`,
    ...(input.hasAllowed
      ? [`${input.outputDir}/fixtures/${input.id}/allowed.${input.extension}`]
      : []),
    `${input.outputDir}/manifests/${input.id}.json`,
  ];
}

function equalPathSets(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((path, index) => path === sortedRight[index])
  );
}

async function selectIdentity(input: {
  repositoryDir: string;
  outputDir: string;
  proposal: GeneratedRuleProposal;
  sourceIdentity: string;
  hasAllowed: boolean;
  policyPaths: string[];
}): Promise<{
  id: string;
  collision: ArtifactPlan["collision"];
  ownerManifest: ArtifactManifest | null;
}> {
  const ext = extension(input.proposal.language);
  const manifests = await findExistingManifests(
    input.repositoryDir,
    input.outputDir,
    input.proposal.id,
  );
  const sameSource = manifests.find((candidate) => {
    const expected = [
      ...artifactPaths({
        outputDir: input.outputDir,
        id: candidate.id,
        extension: ext,
        hasAllowed: input.hasAllowed,
      }),
      ...input.policyPaths,
    ];
    return (
      candidate.manifest.source.identity === input.sourceIdentity &&
      equalPathSets(candidate.manifest.ownedFiles, expected)
    );
  });
  if (sameSource)
    return {
      id: sameSource.id,
      collision: "replace_same_source",
      ownerManifest: sameSource.manifest,
    };

  for (let suffix = 1; suffix < 10_000; suffix++) {
    const id =
      suffix === 1 ? input.proposal.id : `${input.proposal.id}-${suffix}`;
    const paths = artifactPaths({
      outputDir: input.outputDir,
      id,
      extension: ext,
      hasAllowed: input.hasAllowed,
    });
    const occupied = await Promise.all(
      paths.map((path) => pathExists(input.repositoryDir, path)),
    );
    if (!occupied.some(Boolean))
      return {
        id,
        collision: suffix === 1 ? "new" : "suffixed",
        ownerManifest: null,
      };
  }
  throw new UnsafeRepositoryError(
    "No free deterministic artifact suffix remains.",
  );
}

export async function planArtifacts(input: {
  repositoryDir: string;
  outputDir: string;
  sourceUrl: string;
  sourceIdentity: string;
  proposal: GeneratedRuleProposal;
  evidence: ReviewEvidence;
  before: string;
  after: string;
  allowed?: string;
  approvalMode: "interactive" | "yes";
  policyTarget: string;
  policyExplicit?: boolean;
  policyPaths?: string[];
  policyUpdates?: PolicyUpdate[];
  provisional?: boolean;
}): Promise<ArtifactPlan> {
  const parsedSource = parseReviewUrl(input.sourceUrl);
  if (input.sourceIdentity !== canonicalReviewIdentity(parsedSource))
    throw new UnsafeRepositoryError(
      "Artifact source identity is not canonical for its supported review URL.",
    );
  assertSafeExactPath(input.outputDir, "output directory");
  const outputState = await inspectContainedPathNoFollow(
    input.repositoryDir,
    input.outputDir,
  );
  if (outputState.kind === "symlink")
    throw new UnsafeRepositoryError(
      `Refusing symlink in artifact output path: ${outputState.symlinkPath ?? input.outputDir}`,
    );
  if (outputState.exists && outputState.kind !== "directory")
    throw new UnsafeRepositoryError("Artifact output root is not a directory.");
  const policyPaths = [
    ...(input.policyPaths ??
      input.policyUpdates?.map((update) => update.path) ??
      []),
  ].sort();
  for (const path of policyPaths) assertSafeExactPath(path, "policy path");
  const selected = await selectIdentity({
    repositoryDir: input.repositoryDir,
    outputDir: input.outputDir,
    proposal: input.proposal,
    sourceIdentity: input.sourceIdentity,
    hasAllowed: input.allowed !== undefined,
    policyPaths,
  });
  const ext = extension(input.proposal.language);
  const artifact = artifactPaths({
    outputDir: input.outputDir,
    id: selected.id,
    extension: ext,
    hasAllowed: input.allowed !== undefined,
  });
  const [rulePath, evidencePath, beforePath, afterPath, ...tail] = artifact;
  if (!rulePath || !evidencePath || !beforePath || !afterPath)
    throw new UnsafeRepositoryError("Artifact path planning was incomplete.");
  const manifestPath = artifact.at(-1);
  if (!manifestPath)
    throw new UnsafeRepositoryError("Manifest path planning was incomplete.");
  const allowedPath = input.allowed === undefined ? undefined : tail[0];
  const artifactAction: PlannedWrite["action"] = selected.ownerManifest
    ? "replace"
    : "create";
  const baseFiles: PlannedWrite[] = [
    {
      path: rulePath,
      content: input.proposal.yaml,
      kind: "artifact",
      action: artifactAction,
    },
    {
      path: evidencePath,
      content: `${JSON.stringify(input.evidence, null, 2)}\n`,
      kind: "artifact",
      action: artifactAction,
    },
    {
      path: beforePath,
      content: input.before,
      kind: "artifact",
      action: artifactAction,
    },
    {
      path: afterPath,
      content: input.after,
      kind: "artifact",
      action: artifactAction,
    },
    ...(input.allowed === undefined || !allowedPath
      ? []
      : [
          {
            path: allowedPath,
            content: input.allowed,
            kind: "artifact" as const,
            action: artifactAction,
          },
        ]),
  ];
  const policyRecords = (input.policyUpdates ?? []).map((update) => ({
    path: update.path,
    content: update.content,
    kind: "policy" as const,
    action:
      update.action === "create" ? ("create" as const) : ("update" as const),
  }));
  if (
    !input.provisional &&
    !equalPathSets(
      policyRecords.map((file) => file.path),
      policyPaths,
    )
  )
    throw new UnsafeRepositoryError("Planned policy paths and updates differ.");
  const ownedFiles = [...artifact, ...policyPaths].sort();
  const hashedFiles = [...baseFiles, ...policyRecords].map((file) => ({
    path: file.path,
    sha256: sha256(file.content),
  }));
  const manifest = artifactManifestSchema.parse({
    schemaVersion: 1,
    generatorVersion: GENERATOR_VERSION,
    source: { url: input.sourceUrl, identity: input.sourceIdentity },
    ruleId: input.proposal.id,
    approval: {
      mode: input.approvalMode,
      policyTarget: input.policyTarget,
      policyExplicit: input.policyExplicit ?? false,
    },
    expectations: {
      beforeMatches: true,
      afterMatches: false,
      allowedMatches: false,
    },
    ownedFiles,
    writtenFiles: hashedFiles,
  });
  if (!input.provisional) canonicalManifestLayout(manifest, manifestPath);
  const files: PlannedWrite[] = [
    ...baseFiles,
    {
      path: manifestPath,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      kind: "artifact",
      action: selected.ownerManifest ? "replace" : "create",
    },
    ...policyRecords.filter(
      (_, index) => input.policyUpdates?.[index]?.action !== "unchanged",
    ),
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
  };
}

async function assertNoSymlinkAncestors(
  repositoryDir: string,
  path: string,
): Promise<void> {
  const parts = path.split("/");
  for (let index = 1; index <= parts.length; index++) {
    const relative = parts.slice(0, index).join("/");
    const candidate = containedPath(repositoryDir, relative);
    try {
      if ((await lstat(candidate)).isSymbolicLink())
        throw new UnsafeRepositoryError(
          `Refusing symlink in write path: ${relative}`,
        );
    } catch (error) {
      if (error instanceof UnsafeRepositoryError) throw error;
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      break;
    }
  }
}

function dirtyPaths(output: string): Set<string> {
  const entries = output.split("\0").filter(Boolean);
  const result = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    result.add(entry.slice(3));
    if (entry.startsWith("R") || entry.startsWith("C")) {
      const previous = entries[index + 1];
      if (previous) result.add(previous);
      index++;
    }
  }
  return result;
}

async function preflightTargets(input: {
  repositoryDir: string;
  plan: ArtifactPlan;
  runner: CommandRunner;
  expectedPolicyHashes: Map<string, string | null>;
}): Promise<void> {
  for (const path of input.plan.ownedFiles)
    await assertNoSymlinkAncestors(input.repositoryDir, path);
  const status = await input.runner.run(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: input.repositoryDir },
  );
  if (status.exitCode !== 0)
    throw new UnsafeRepositoryError("Could not inspect repository status.");
  const dirty = dirtyPaths(status.stdout);
  const trackedResult = await input.runner.run(
    "git",
    ["ls-files", "-z", "--", ...input.plan.ownedFiles],
    { cwd: input.repositoryDir },
  );
  if (trackedResult.exitCode !== 0)
    throw new UnsafeRepositoryError("Could not inspect planned tracked paths.");
  const tracked = new Set(trackedResult.stdout.split("\0").filter(Boolean));
  const owned = new Set(input.plan.ownerManifest?.ownedFiles ?? []);
  const writes = new Map(input.plan.files.map((file) => [file.path, file]));
  for (const path of input.plan.ownedFiles) {
    const isPolicy = input.expectedPolicyHashes.has(path);
    const exists = await pathExists(input.repositoryDir, path);
    if (isPolicy) {
      const expected = input.expectedPolicyHashes.get(path) ?? null;
      let actual: string | null = null;
      if (exists)
        actual = sha256(
          await readFile(containedPath(input.repositoryDir, path), "utf8"),
        );
      if (actual !== expected)
        throw new UnsafeRepositoryError(
          `Policy file changed after preview: ${path}`,
        );
      continue;
    }
    const authorized =
      input.plan.collision === "replace_same_source" && owned.has(path);
    if ((exists || tracked.has(path)) && !authorized)
      throw new UnsafeRepositoryError(
        `Planned target is already managed or occupied without complete same-source ownership: ${path}`,
      );
    if (authorized && dirty.has(path)) {
      const planned = writes.get(path);
      const current = exists
        ? await readFile(containedPath(input.repositoryDir, path), "utf8")
        : undefined;
      if (!planned || current !== planned.content)
        throw new UnsafeRepositoryError(
          `Planned write overlaps a dirty path: ${path}`,
        );
    }
  }
}

export type TransactionPhase =
  "before_backup" | "after_backup" | "during_replace" | "cleanup";
export type TransactionInjector = (event: {
  phase: TransactionPhase;
  index: number;
  file: PlannedWrite;
}) => Promise<void>;

const durableJournalSchema = z.object({
  schemaVersion: z.literal(1),
  outputDir: z.string(),
  entries: z.array(
    z.object({
      path: z.string(),
      originalExisted: z.boolean(),
      replacementMayExist: z.boolean(),
    }),
  ),
  createdDirectories: z.array(z.string()),
  progress: z
    .object({ phase: z.string(), index: z.number().int().nonnegative() })
    .nullable(),
});
type DurableJournal = z.infer<typeof durableJournalSchema>;

async function absoluteExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function persistJournal(
  transactionRoot: string,
  journal: DurableJournal,
): Promise<void> {
  await mkdir(transactionRoot, { recursive: true });
  const path = `${transactionRoot}/journal.json`;
  const temporary = `${transactionRoot}/journal.next`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const file = await open(temporary, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(transactionRoot, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function restoreJournal(
  repositoryDir: string,
  transactionRoot: string,
  journal: DurableJournal,
): Promise<void> {
  const errors: string[] = [];
  for (const entry of [...journal.entries].reverse()) {
    try {
      assertSafeExactPath(entry.path, "journal target path");
      const target = containedPath(repositoryDir, entry.path);
      const backup = resolve(transactionRoot, "backups", entry.path);
      if (await absoluteExists(backup)) {
        await rm(target, { force: true });
        await mkdir(dirname(target), { recursive: true });
        await rename(backup, target);
      } else if (!entry.originalExisted && entry.replacementMayExist) {
        await rm(target, { force: true });
      } else if (entry.originalExisted && !(await absoluteExists(target))) {
        throw new Error(`Original and backup are both missing: ${entry.path}`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length)
    throw new UnsafeRepositoryError(
      `Rollback could not restore every original target: ${errors.join("; ")}`,
    );
}

async function missingParentDirectories(
  repositoryDir: string,
  path: string,
): Promise<string[]> {
  const parts = path.split("/").slice(0, -1);
  const missing: string[] = [];
  for (let index = 1; index <= parts.length; index++) {
    const relative = parts.slice(0, index).join("/");
    if (relative && !(await pathExists(repositoryDir, relative)))
      missing.push(relative);
  }
  return missing;
}

async function removeCreatedDirectories(
  repositoryDir: string,
  paths: readonly string[],
): Promise<void> {
  for (const path of [...new Set(paths)].sort(
    (left, right) => right.length - left.length,
  )) {
    try {
      await rmdir(containedPath(repositoryDir, path));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]).has(String(error.code))
      )
        throw error;
    }
  }
}

export async function recoverPendingTransactions(input: {
  repositoryDir: string;
  outputDir: string;
}): Promise<string[]> {
  const outputRoot = containedPath(input.repositoryDir, input.outputDir);
  const outputState = await inspectContainedPathNoFollow(
    input.repositoryDir,
    input.outputDir,
  );
  if (outputState.kind === "symlink")
    throw new UnsafeRepositoryError(
      `Refusing symlink in transaction recovery path: ${outputState.symlinkPath ?? input.outputDir}`,
    );
  if (!outputState.exists) return [];
  if (outputState.kind !== "directory")
    throw new UnsafeRepositoryError("Artifact output root is not a directory.");
  let names: string[];
  try {
    names = await readdir(outputRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
  const recovered: string[] = [];
  for (const name of names
    .filter((value) => value.startsWith(".transaction-"))
    .sort()) {
    const relative = `${input.outputDir}/${name}`;
    assertSafeExactPath(relative, "transaction recovery path");
    const transactionRoot = containedPath(input.repositoryDir, relative);
    const stat = await lstat(transactionRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new UnsafeRepositoryError(
        `Pending transaction is not a regular directory: ${relative}`,
      );
    let journal: DurableJournal;
    try {
      journal = durableJournalSchema.parse(
        JSON.parse(await readFile(`${transactionRoot}/journal.json`, "utf8")),
      );
    } catch (error) {
      throw new UnsafeRepositoryError(
        `Pending transaction journal is malformed: ${relative}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (journal.outputDir !== input.outputDir)
      throw new UnsafeRepositoryError(
        `Pending transaction output root does not match: ${relative}`,
      );
    await restoreJournal(input.repositoryDir, transactionRoot, journal);
    await rm(transactionRoot, { recursive: true, force: true });
    await removeCreatedDirectories(
      input.repositoryDir,
      journal.createdDirectories,
    );
    recovered.push(relative);
  }
  return recovered;
}

class TransactionSignalError extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`Artifact transaction interrupted by ${signal}.`);
  }
}

export async function commitArtifactPlan(input: {
  repositoryDir: string;
  plan: ArtifactPlan;
  runner: CommandRunner;
  expectedPolicyHashes?: Map<string, string | null>;
  inject?: TransactionInjector;
  beforeCommit?: (index: number) => Promise<void>;
  onInterrupt?: () => Promise<void>;
}): Promise<string[]> {
  const expectedPolicyHashes =
    input.expectedPolicyHashes ?? new Map<string, string | null>();
  await recoverPendingTransactions({
    repositoryDir: input.repositoryDir,
    outputDir: input.plan.outputDir,
  });
  await preflightTargets({
    repositoryDir: input.repositoryDir,
    plan: input.plan,
    runner: input.runner,
    expectedPolicyHashes,
  });
  const transactionRoot = containedPath(
    input.repositoryDir,
    `${input.plan.outputDir}/.transaction-${randomUUID()}`,
  );
  const staged = `${transactionRoot}/staged`;
  const backups = `${transactionRoot}/backups`;
  const journal: DurableJournal = {
    schemaVersion: 1,
    outputDir: input.plan.outputDir,
    entries: [],
    createdDirectories: await missingParentDirectories(
      input.repositoryDir,
      `${input.plan.outputDir}/.transaction-placeholder/journal.json`,
    ),
    progress: null,
  };
  let cleaned = false;
  let interrupted: NodeJS.Signals | undefined;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      interrupted ??= signal;
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const disarm = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    handlers.clear();
  };
  const checkpoint = () => {
    if (interrupted) throw new TransactionSignalError(interrupted);
  };
  const reportProgress = async (
    phase: TransactionPhase,
    index: number,
  ): Promise<void> => {
    journal.progress = { phase, index };
    await persistJournal(transactionRoot, journal);
    const delay =
      process.env.NODE_ENV === "test"
        ? Number(process.env.REVIEW_TO_RULE_TEST_TRANSACTION_DELAY_MS ?? 0)
        : 0;
    if (phase === "during_replace" && delay > 0 && delay <= 2_000)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    checkpoint();
  };
  try {
    await persistJournal(transactionRoot, journal);
    for (const file of input.plan.files) {
      const stage = resolve(staged, file.path);
      await mkdir(dirname(stage), { recursive: true });
      await writeFile(stage, file.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
    }
    for (const [index, file] of input.plan.files.entries()) {
      await input.beforeCommit?.(index);
      await reportProgress("before_backup", index);
      await input.inject?.({ phase: "before_backup", index, file });
      const target = containedPath(input.repositoryDir, file.path);
      const backup = resolve(backups, file.path);
      const newlyRequired = await missingParentDirectories(
        input.repositoryDir,
        file.path,
      );
      journal.createdDirectories.push(...newlyRequired);
      await persistJournal(transactionRoot, journal);
      await mkdir(dirname(target), { recursive: true });
      const entry = {
        path: file.path,
        originalExisted: await pathExists(input.repositoryDir, file.path),
        replacementMayExist: false,
      };
      journal.entries.push(entry);
      await persistJournal(transactionRoot, journal);
      if (entry.originalExisted) {
        await mkdir(dirname(backup), { recursive: true });
        await rename(target, backup);
      }
      await reportProgress("after_backup", index);
      await input.inject?.({ phase: "after_backup", index, file });
      entry.replacementMayExist = true;
      await reportProgress("during_replace", index);
      await input.inject?.({ phase: "during_replace", index, file });
      checkpoint();
      await rename(resolve(staged, file.path), target);
      await persistJournal(transactionRoot, journal);
    }
    for (const [index, file] of input.plan.files.entries()) {
      await reportProgress("cleanup", index);
      await input.inject?.({ phase: "cleanup", index, file });
    }
    await rm(transactionRoot, { recursive: true, force: true });
    cleaned = true;
    disarm();
    return input.plan.files.map((file) => file.path);
  } catch (error) {
    let rollbackError: unknown;
    try {
      await restoreJournal(input.repositoryDir, transactionRoot, journal);
    } catch (caught) {
      rollbackError = caught;
    }
    try {
      await rm(transactionRoot, { recursive: true, force: true });
      await removeCreatedDirectories(
        input.repositoryDir,
        journal.createdDirectories,
      );
      cleaned = true;
    } catch (cleanupError) {
      rollbackError ??= cleanupError;
    }
    disarm();
    if (error instanceof TransactionSignalError) {
      await input.onInterrupt?.();
      if (rollbackError instanceof Error) throw rollbackError;
      process.kill(process.pid, error.signal);
      throw new UnsafeRepositoryError(
        `Artifact transaction interrupted by ${error.signal} and rolled back.`,
      );
    }
    if (rollbackError instanceof Error) throw rollbackError;
    throw error instanceof UnsafeRepositoryError
      ? error
      : new UnsafeRepositoryError(
          `Artifact transaction failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        );
  } finally {
    disarm();
    if (!cleaned)
      await rm(transactionRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
  }
}
