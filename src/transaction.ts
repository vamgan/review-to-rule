import { randomUUID, createHash } from "node:crypto";
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
import {
  assertSafeExactPath,
  containedPath,
  inspectContainedPathNoFollow,
} from "./security/path.js";
import type { CommandRunner } from "./utils/command.js";

export interface PlannedWrite {
  path: string;
  content: string;
  kind: "artifact" | "policy";
  action: "create" | "replace" | "update";
}

export interface TransactionPlan {
  outputDir: string;
  collision: "new" | "replace_same_source" | "suffixed";
  files: PlannedWrite[];
  ownedFiles: string[];
  ownerManifest: { ownedFiles: string[] } | null;
  sharedFiles?: Array<{ path: string; previousHash: string | null }>;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

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

async function absoluteExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function assertNoSymlinkAncestors(repositoryDir: string, path: string) {
  const parts = path.split("/");
  for (let index = 1; index <= parts.length; index++) {
    const relative = parts.slice(0, index).join("/");
    try {
      if (
        (await lstat(containedPath(repositoryDir, relative))).isSymbolicLink()
      )
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
  plan: TransactionPlan;
  runner: CommandRunner;
}) {
  const shared = new Map(
    (input.plan.sharedFiles ?? []).map(
      (file) => [file.path, file.previousHash] as const,
    ),
  );
  const targetPaths = [
    ...new Set([
      ...input.plan.ownedFiles,
      ...input.plan.files.map((file) => file.path),
      ...(input.plan.sharedFiles ?? []).map((file) => file.path),
    ]),
  ];
  for (const path of targetPaths)
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
    ["ls-files", "-z", "--", ...targetPaths],
    { cwd: input.repositoryDir },
  );
  if (trackedResult.exitCode !== 0)
    throw new UnsafeRepositoryError("Could not inspect planned tracked paths.");
  const tracked = new Set(trackedResult.stdout.split("\0").filter(Boolean));
  const owned = new Set(input.plan.ownerManifest?.ownedFiles ?? []);
  const writes = new Map(input.plan.files.map((file) => [file.path, file]));
  for (const path of targetPaths) {
    const exists = await pathExists(input.repositoryDir, path);
    if (shared.has(path)) {
      const expected = shared.get(path) ?? null;
      const actual = exists
        ? sha256(
            await readFile(containedPath(input.repositoryDir, path), "utf8"),
          )
        : null;
      if (actual !== expected)
        throw new UnsafeRepositoryError(
          `Shared review-memory file changed after preview: ${path}`,
        );
      continue;
    }
    const authorized =
      input.plan.collision === "replace_same_source" && owned.has(path);
    if ((exists || tracked.has(path)) && !authorized)
      throw new UnsafeRepositoryError(
        `Planned target is occupied without same-source ownership: ${path}`,
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

const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    outputDir: z.string(),
    entries: z.array(
      z
        .object({
          path: z.string(),
          originalExisted: z.boolean(),
          replacementMayExist: z.boolean(),
        })
        .strict(),
    ),
    createdDirectories: z.array(z.string()),
    progress: z
      .object({ phase: z.string(), index: z.number().int().nonnegative() })
      .strict()
      .nullable(),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;

async function persistJournal(root: string, journal: Journal) {
  await mkdir(root, { recursive: true });
  const path = `${root}/journal.json`;
  const temporary = `${root}/journal.next`;
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
  const directory = await open(root, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function restoreJournal(
  repositoryDir: string,
  transactionRoot: string,
  journal: Journal,
) {
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
      } else if (!entry.originalExisted && entry.replacementMayExist)
        await rm(target, { force: true });
      else if (entry.originalExisted && !(await absoluteExists(target)))
        throw new Error(`Original and backup are both missing: ${entry.path}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length)
    throw new UnsafeRepositoryError(
      `Rollback could not restore every original target: ${errors.join("; ")}`,
    );
}

async function missingParentDirectories(repositoryDir: string, path: string) {
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
) {
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
  const state = await inspectContainedPathNoFollow(
    input.repositoryDir,
    input.outputDir,
  );
  if (state.kind === "symlink")
    throw new UnsafeRepositoryError(
      `Refusing symlink in transaction recovery path: ${state.symlinkPath ?? input.outputDir}`,
    );
  if (!state.exists) return [];
  if (state.kind !== "directory")
    throw new UnsafeRepositoryError(
      "Review-memory output root is not a directory.",
    );
  const names = await readdir(
    containedPath(input.repositoryDir, input.outputDir),
  );
  const recovered: string[] = [];
  for (const name of names
    .filter((value) => value.startsWith(".transaction-"))
    .sort()) {
    const relative = `${input.outputDir}/${name}`;
    assertSafeExactPath(relative, "transaction recovery path");
    const root = containedPath(input.repositoryDir, relative);
    const transactionState = await lstat(root);
    if (!transactionState.isDirectory() || transactionState.isSymbolicLink())
      throw new UnsafeRepositoryError(
        `Pending transaction is not a regular directory: ${relative}`,
      );
    let journal: Journal;
    try {
      journal = journalSchema.parse(
        JSON.parse(await readFile(`${root}/journal.json`, "utf8")),
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
    await restoreJournal(input.repositoryDir, root, journal);
    await rm(root, { recursive: true, force: true });
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
    super(`Review-memory transaction interrupted by ${signal}.`);
  }
}

export async function commitTransaction(input: {
  repositoryDir: string;
  plan: TransactionPlan;
  runner: CommandRunner;
  inject?: TransactionInjector;
  beforeCommit?: (index: number) => Promise<void>;
  onInterrupt?: () => Promise<void>;
}): Promise<string[]> {
  await recoverPendingTransactions({
    repositoryDir: input.repositoryDir,
    outputDir: input.plan.outputDir,
  });
  await preflightTargets(input);
  const transactionRoot = containedPath(
    input.repositoryDir,
    `${input.plan.outputDir}/.transaction-${randomUUID()}`,
  );
  const staged = `${transactionRoot}/staged`;
  const backups = `${transactionRoot}/backups`;
  const journal: Journal = {
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
  const progress = async (
    phase: TransactionPhase,
    index: number,
    file: PlannedWrite,
  ) => {
    journal.progress = { phase, index };
    await persistJournal(transactionRoot, journal);
    await input.inject?.({ phase, index, file });
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
      await progress("before_backup", index, file);
      const target = containedPath(input.repositoryDir, file.path);
      const backup = resolve(backups, file.path);
      journal.createdDirectories.push(
        ...(await missingParentDirectories(input.repositoryDir, file.path)),
      );
      const entry = {
        path: file.path,
        originalExisted: await pathExists(input.repositoryDir, file.path),
        replacementMayExist: false,
      };
      journal.entries.push(entry);
      await persistJournal(transactionRoot, journal);
      await mkdir(dirname(target), { recursive: true });
      if (entry.originalExisted) {
        await mkdir(dirname(backup), { recursive: true });
        await rename(target, backup);
      }
      await progress("after_backup", index, file);
      entry.replacementMayExist = true;
      await progress("during_replace", index, file);
      await rename(resolve(staged, file.path), target);
      await persistJournal(transactionRoot, journal);
    }
    for (const [index, file] of input.plan.files.entries())
      await progress("cleanup", index, file);
    await rm(transactionRoot, { recursive: true, force: true });
    cleaned = true;
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
    if (error instanceof TransactionSignalError) {
      await input.onInterrupt?.();
      if (rollbackError instanceof Error) throw rollbackError;
      process.kill(process.pid, error.signal);
      throw new UnsafeRepositoryError(
        `Review-memory transaction interrupted by ${error.signal} and rolled back.`,
      );
    }
    if (rollbackError instanceof Error) throw rollbackError;
    throw error instanceof UnsafeRepositoryError
      ? error
      : new UnsafeRepositoryError(
          `Review-memory transaction failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        );
  } finally {
    disarm();
    if (!cleaned)
      await rm(transactionRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
  }
}
