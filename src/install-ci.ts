import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { GENERATOR_VERSION } from "./version.js";
import { UnsafeRepositoryError } from "./domain/errors.js";
import {
  assertSafeExactPath,
  containedPath,
  inspectContainedPathNoFollow,
} from "./security/path.js";
import { ProcessCommandRunner, type CommandRunner } from "./utils/command.js";

export const CI_WORKFLOW_PATH = ".github/workflows/review-to-rule.yml";
export const CI_WORKFLOW = `name: review-to-rule\non:\n  pull_request:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  review-memory-integrity:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n      - run: npx --yes review-to-rule@${GENERATOR_VERSION} validate-all .review-to-rule --repo-dir . --json\n`;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const installCiResultSchema = z.object({
  schemaVersion: z.literal(2),
  status: z.literal("success"),
  path: z.literal(CI_WORKFLOW_PATH),
  action: z.enum(["create", "unchanged"]),
  sha256: z.string().length(64),
  written: z.boolean(),
  tracked: z.boolean(),
  gitState: z.string(),
  preview: z.string(),
});
export type InstallCiResult = z.infer<typeof installCiResultSchema>;

async function gitState(repositoryDir: string, runner: CommandRunner) {
  const trackedResult = await runner.run(
    "git",
    ["ls-files", "--error-unmatch", "--", CI_WORKFLOW_PATH],
    { cwd: repositoryDir },
  );
  const headResult = await runner.run(
    "git",
    ["ls-tree", "--name-only", "HEAD", "--", CI_WORKFLOW_PATH],
    { cwd: repositoryDir },
  );
  const status = await runner.run(
    "git",
    ["status", "--porcelain=v1", "--", CI_WORKFLOW_PATH],
    { cwd: repositoryDir },
  );
  if (status.exitCode !== 0)
    throw new UnsafeRepositoryError(
      "CI installation requires an explicit Git repository.",
    );
  return {
    tracked:
      trackedResult.exitCode === 0 ||
      (headResult.exitCode === 0 &&
        headResult.stdout.trim() === CI_WORKFLOW_PATH),
    status: status.stdout.trim(),
  };
}

export async function planCiInstall(
  repositoryDir: string,
  runner: CommandRunner = new ProcessCommandRunner(),
) {
  const state = await inspectContainedPathNoFollow(
    repositoryDir,
    CI_WORKFLOW_PATH,
  );
  if (state.kind === "symlink" || (state.exists && state.kind !== "file"))
    throw new UnsafeRepositoryError(
      "CI workflow target must not be a symlink or non-file.",
    );
  const git = await gitState(repositoryDir, runner);
  if (git.tracked && git.status)
    throw new UnsafeRepositoryError(
      `CI workflow overlaps tracked Git changes: ${git.status}.`,
      "Restore or commit the workflow before retrying; review-to-rule will not overwrite or recreate it.",
    );
  let current: string | undefined;
  if (state.kind === "file")
    current = await readFile(
      containedPath(repositoryDir, CI_WORKFLOW_PATH),
      "utf8",
    );
  if (current !== undefined && current !== CI_WORKFLOW)
    throw new UnsafeRepositoryError(
      "Existing review-to-rule CI workflow differs; refusing to overwrite it.",
      "Review the existing workflow and remove it explicitly before installation.",
    );
  return installCiResultSchema.parse({
    schemaVersion: 2,
    status: "success",
    path: CI_WORKFLOW_PATH,
    action: current === CI_WORKFLOW ? "unchanged" : "create",
    sha256: sha256(CI_WORKFLOW),
    written: false,
    tracked: git.tracked,
    gitState: git.status,
    preview: `${current === CI_WORKFLOW ? "UNCHANGED" : "CREATE"} ${CI_WORKFLOW_PATH}\nPinned review-to-rule: ${GENERATOR_VERSION}\nGit overlap: ${git.status || "clean"}\n${CI_WORKFLOW}`,
  });
}

export async function installCi(
  repositoryDir: string,
  approvedPlan?: InstallCiResult,
  runner: CommandRunner = new ProcessCommandRunner(),
) {
  assertSafeExactPath(CI_WORKFLOW_PATH, "CI workflow path");
  const plan = approvedPlan ?? (await planCiInstall(repositoryDir, runner));
  const latest = await planCiInstall(repositoryDir, runner);
  if (
    latest.sha256 !== plan.sha256 ||
    latest.action !== plan.action ||
    latest.tracked !== plan.tracked ||
    latest.gitState !== plan.gitState
  )
    throw new UnsafeRepositoryError(
      "CI workflow bytes or Git state changed after preview; no write was attempted.",
    );
  if (plan.action === "unchanged") return { ...plan, written: false };
  const destination = containedPath(repositoryDir, CI_WORKFLOW_PATH);
  await mkdir(dirname(destination), { recursive: true });
  const temp = `${destination}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, CI_WORKFLOW, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    const beforeRename = await inspectContainedPathNoFollow(
      repositoryDir,
      CI_WORKFLOW_PATH,
    );
    const finalGit = await gitState(repositoryDir, runner);
    if (
      beforeRename.exists ||
      finalGit.tracked !== plan.tracked ||
      finalGit.status !== plan.gitState
    )
      throw new UnsafeRepositoryError(
        "CI workflow or Git state changed during installation; no overwrite was attempted.",
      );
    await rename(temp, destination);
    return installCiResultSchema.parse({ ...plan, written: true });
  } finally {
    await rm(temp, { force: true });
  }
}
