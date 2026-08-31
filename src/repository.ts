import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { ConfigurationError, UnsafeRepositoryError } from "./domain/errors.js";
import {
  assertSafeExactPath,
  containedPath,
  hasUnsafeFilenameSyntax,
} from "./security/path.js";
import type { CommandRunner } from "./utils/command.js";

export interface RepositoryIdentity {
  host: string;
  owner: string;
  name: string;
}

export function normalizeGitRemote(value: string): string {
  const trimmed = value
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/$/, "");
  let host: string;
  let path: string;
  if (/^[^/@\s]+@[^/:\s]+:[^\s]+$/.test(trimmed)) {
    const match = /^[^@]+@([^:]+):(.+)$/.exec(trimmed);
    host = match?.[1] ?? "";
    path = match?.[2] ?? "";
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new ConfigurationError(`Unsupported git remote: ${value}`);
    }
    if (!new Set(["https:", "http:", "ssh:", "git:"]).has(url.protocol))
      throw new ConfigurationError(
        `Unsupported git remote protocol: ${url.protocol}`,
      );
    host = url.hostname;
    path = url.pathname.replace(/^\//, "");
  }
  const parts = path.split("/");
  if (!host || parts.length !== 2 || parts.some((part) => !part))
    throw new ConfigurationError(`Unsupported git remote: ${value}`);
  return `${host.toLowerCase()}/${parts[0]?.toLowerCase()}/${parts[1]?.toLowerCase()}`;
}

function expectedIdentity(identity: RepositoryIdentity): string {
  return `${identity.host}/${identity.owner}/${identity.name}`.toLowerCase();
}

async function repositoryRoot(
  runner: CommandRunner,
  cwd: string,
): Promise<string | undefined> {
  const result = await runner.run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  return result.exitCode === 0 && result.stdout.trim()
    ? resolve(result.stdout.trim())
    : undefined;
}

async function assertIdentity(
  runner: CommandRunner,
  root: string,
  identity: RepositoryIdentity,
): Promise<void> {
  const result = await runner.run(
    "git",
    ["config", "--get", "remote.origin.url"],
    { cwd: root },
  );
  if (result.exitCode !== 0 || !result.stdout.trim())
    throw new UnsafeRepositoryError(
      "The repository has no readable origin remote.",
    );
  if (normalizeGitRemote(result.stdout) !== expectedIdentity(identity))
    throw new UnsafeRepositoryError(
      `Repository identity mismatch: expected ${expectedIdentity(identity)}, got ${normalizeGitRemote(result.stdout)}.`,
    );
}

export interface ResolvedRepository {
  path: string;
  source: "explicit" | "cwd" | "temporary_clone";
  cleanup(): Promise<void>;
}

export async function resolveRepository(
  identity: RepositoryIdentity,
  options: { repoDir?: string; cwd?: string; runner: CommandRunner },
): Promise<ResolvedRepository> {
  const noop = () => Promise.resolve();
  if (options.repoDir) {
    const root = await repositoryRoot(options.runner, resolve(options.repoDir));
    if (!root)
      throw new UnsafeRepositoryError(
        "--repo-dir is not inside a git repository.",
      );
    await assertIdentity(options.runner, root, identity);
    return { path: root, source: "explicit", cleanup: noop };
  }
  const cwdRoot = await repositoryRoot(
    options.runner,
    options.cwd ?? process.cwd(),
  );
  if (cwdRoot) {
    try {
      await assertIdentity(options.runner, cwdRoot, identity);
      return { path: cwdRoot, source: "cwd", cleanup: noop };
    } catch (error) {
      if (!(error instanceof UnsafeRepositoryError)) throw error;
    }
  }
  const parent = await mkdtemp(join(tmpdir(), "review-to-rule-repo-"));
  const destination = join(parent, "repository");
  const result = await options.runner.run("gh", [
    "repo",
    "clone",
    `${identity.host}/${identity.owner}/${identity.name}`,
    destination,
    "--",
    "--config",
    "core.hooksPath=/dev/null",
    "--no-checkout",
  ]);
  if (result.exitCode !== 0) {
    await rm(parent, { recursive: true, force: true });
    throw new ConfigurationError(
      `Could not create temporary read-only clone: ${result.stderr}`,
    );
  }
  try {
    await assertIdentity(options.runner, destination, identity);
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
  return {
    path: destination,
    source: "temporary_clone",
    cleanup: async () => rm(parent, { recursive: true, force: true }),
  };
}

export async function readHistoricalContent(input: {
  runner: CommandRunner;
  repositoryDir: string;
  identity: RepositoryIdentity;
  sha: string;
  path: string;
  allowFetch?: boolean;
}): Promise<{
  content: string;
  source: "historical_content" | "github_content";
}> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.sha))
    throw new UnsafeRepositoryError(
      "Historical content requires a full validated commit SHA.",
    );
  assertSafeExactPath(input.path, "source path");
  if (hasUnsafeFilenameSyntax(basename(input.path)))
    throw new UnsafeRepositoryError(`Unsafe candidate filename: ${input.path}`);
  const local = await input.runner.run(
    "git",
    ["show", `${input.sha}:${input.path}`],
    { cwd: input.repositoryDir },
  );
  if (local.exitCode === 0)
    return { content: local.stdout, source: "historical_content" };
  if (input.allowFetch) {
    await input.runner.run(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "fetch",
        "--no-tags",
        "--depth=1",
        "origin",
        input.sha,
      ],
      { cwd: input.repositoryDir },
    );
    const fetched = await input.runner.run(
      "git",
      ["show", `${input.sha}:${input.path}`],
      { cwd: input.repositoryDir },
    );
    if (fetched.exitCode === 0)
      return { content: fetched.stdout, source: "historical_content" };
  }
  const response = await input.runner.run("gh", [
    "api",
    "--hostname",
    input.identity.host,
    "--method",
    "GET",
    `/repos/${input.identity.owner}/${input.identity.name}/contents/${input.path}?ref=${input.sha}`,
  ]);
  if (response.exitCode !== 0)
    throw new ConfigurationError("Historical source content is unavailable.");
  const payload = z
    .object({ encoding: z.literal("base64"), content: z.string() })
    .parse(JSON.parse(response.stdout));
  return {
    content: Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString(
      "utf8",
    ),
    source: "github_content",
  };
}

export async function assertRegularContainedFile(
  root: string,
  relativePath: string,
): Promise<string> {
  const path = containedPath(root, relativePath);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new UnsafeRepositoryError(`Expected a regular file: ${relativePath}`);
  const real = await realpath(path);
  if (real !== path)
    throw new UnsafeRepositoryError(
      `File resolves outside its exact path: ${relativePath}`,
    );
  return path;
}
