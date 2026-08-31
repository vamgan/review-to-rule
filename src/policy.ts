import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "yaml";
import {
  ConfigurationError,
  UnsafeRepositoryError,
  ValidationError,
} from "./domain/errors.js";
import {
  assertSafeExactPath,
  containedPath,
  inspectContainedPathNoFollow,
} from "./security/path.js";
import { parseCanonicalArtifactManifest } from "./artifacts.js";
import type { CommandRunner } from "./utils/command.js";
import type { PolicyTarget } from "./config.js";

export const MANAGED_START = "<!-- review-to-rule:managed:start -->";
export const MANAGED_END = "<!-- review-to-rule:managed:end -->";
const maxPolicyBytes = 256_000;

export interface PolicyDiscovery {
  trackedFiles: string[];
  semgrepFiles: string[];
  agentsFiles: string[];
  claudeFiles: string[];
  artifactState?: {
    path: string;
    exists: boolean;
    symlink: boolean;
    trackedFiles: string[];
    manifests?: Array<{
      path: string;
      status: "valid" | "malformed" | "unsupported_version" | "symlink";
      ruleId: string | null;
      sourceIdentity: string | null;
      ownedFileCount: number | null;
    }>;
  };
  semgrepCandidates?: Array<{
    path: string;
    scope: string;
    status: "valid" | "malformed" | "symlink" | "too_large" | "missing";
    diagnostic: string;
  }>;
  policyFiles?: Array<{
    path: string;
    kind: "agents" | "claude";
    scope: string;
    nested: boolean;
    exists: boolean;
    symlink: boolean;
    managed: "absent" | "valid" | "malformed";
  }>;
  ambiguities?: string[];
}

export async function discoverPolicy(
  repositoryDir: string,
  runner: CommandRunner,
  outputDir = ".review-to-rule",
): Promise<PolicyDiscovery> {
  const result = await runner.run("git", ["ls-files", "-z"], {
    cwd: repositoryDir,
  });
  if (result.exitCode !== 0)
    throw new UnsafeRepositoryError(
      "Could not discover tracked repository policy files.",
    );
  const trackedFiles = result.stdout.split("\0").filter(Boolean);
  if (trackedFiles.length > 50_000)
    throw new UnsafeRepositoryError(
      "Tracked policy discovery exceeded 50,000 files.",
    );
  const agentsFiles = trackedFiles.filter((path) =>
    /(^|\/)AGENTS\.md$/i.test(path),
  );
  const claudeFiles = trackedFiles.filter((path) =>
    /(^|\/)CLAUDE\.md$/i.test(path),
  );
  const candidatePattern = new RegExp(
    `(^|/)(?:\\.semgrep\\.(?:ya?ml)|semgrep\\.(?:ya?ml))$|(^|/)\\.semgrep/[^/]+\\.(?:ya?ml)$|^${outputDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/rules/[^/]+\\.(?:ya?ml)$`,
    "i",
  );
  const semgrepFiles = trackedFiles.filter((path) =>
    candidatePattern.test(path),
  );
  const semgrepCandidates = await Promise.all(
    semgrepFiles.map(async (path) => {
      const absolute = containedPath(repositoryDir, path);
      const scope = dirname(path) === "." ? "." : dirname(path);
      const state = await inspectContainedPathNoFollow(repositoryDir, path);
      if (!state.exists)
        return {
          path,
          scope,
          status: "missing" as const,
          diagnostic: "Tracked Semgrep candidate is missing from the worktree.",
        };
      if (state.kind === "symlink")
        return {
          path,
          scope,
          status: "symlink" as const,
          diagnostic:
            "Tracked Semgrep candidate is a symlink and was not read.",
        };
      if (state.kind !== "file" || (state.size ?? 0) > maxPolicyBytes)
        return {
          path,
          scope,
          status: "too_large" as const,
          diagnostic: `Candidate exceeds the bounded ${maxPolicyBytes}-byte read limit or is not regular.`,
        };
      try {
        const document = parse(await readFile(absolute, "utf8")) as unknown;
        if (
          !document ||
          typeof document !== "object" ||
          !("rules" in document) ||
          !Array.isArray(document.rules)
        )
          throw new Error("top-level rules array is missing");
        return {
          path,
          scope,
          status: "valid" as const,
          diagnostic: `${document.rules.length} rule(s) declared.`,
        };
      } catch (error) {
        return {
          path,
          scope,
          status: "malformed" as const,
          diagnostic:
            error instanceof Error
              ? error.message.slice(0, 300)
              : "Malformed YAML.",
        };
      }
    }),
  );
  const policyFiles = await Promise.all(
    [
      ...agentsFiles.map((path) => ({ path, kind: "agents" as const })),
      ...claudeFiles.map((path) => ({ path, kind: "claude" as const })),
    ].map(async ({ path, kind }) => {
      const scope = dirname(path) === "." ? "." : dirname(path);
      const state = await inspectContainedPathNoFollow(repositoryDir, path);
      let managed: "absent" | "valid" | "malformed" = "absent";
      if (state.kind === "file" && (state.size ?? 0) <= maxPolicyBytes) {
        const content = await readFile(
          containedPath(repositoryDir, path),
          "utf8",
        );
        const starts = occurrences(content, MANAGED_START);
        const ends = occurrences(content, MANAGED_END);
        managed =
          starts === 0 && ends === 0
            ? "absent"
            : starts === 1 && ends === 1
              ? "valid"
              : "malformed";
      }
      return {
        path,
        kind,
        scope,
        nested: path.includes("/"),
        exists: state.exists,
        symlink: state.kind === "symlink",
        managed,
      };
    }),
  );
  const artifactState = await inspectContainedPathNoFollow(
    repositoryDir,
    outputDir,
  );
  const ambiguities = [
    ...(agentsFiles.length > 1
      ? ["Multiple tracked AGENTS.md files require an exact path."]
      : []),
    ...(claudeFiles.length > 1
      ? ["Multiple tracked CLAUDE.md files require an exact path."]
      : []),
    ...(policyFiles.some((file) => file.managed === "malformed")
      ? ["At least one managed pointer is malformed."]
      : []),
    ...(artifactState.kind === "symlink"
      ? [
          `Artifact output root traverses a symlink at ${artifactState.symlinkPath ?? outputDir} and is unusable.`,
        ]
      : []),
  ];
  const manifestDirectoryPath = `${outputDir}/manifests`;
  let manifestNames: string[] = [];
  if (artifactState.kind === "directory") {
    const manifestDirectoryState = await inspectContainedPathNoFollow(
      repositoryDir,
      manifestDirectoryPath,
    );
    if (manifestDirectoryState.kind === "directory")
      manifestNames = (
        await readdir(containedPath(repositoryDir, manifestDirectoryPath))
      )
        .filter((name) => name.endsWith(".json"))
        .sort()
        .slice(0, 1_000);
  }
  const manifests = await Promise.all(
    manifestNames.map(async (name) => {
      const path = `${outputDir}/manifests/${name}`;
      try {
        const state = await inspectContainedPathNoFollow(repositoryDir, path);
        if (state.kind === "symlink")
          return {
            path,
            status: "symlink" as const,
            ruleId: null,
            sourceIdentity: null,
            ownedFileCount: null,
          };
        if (state.kind !== "file" || (state.size ?? 0) > maxPolicyBytes)
          throw new Error("manifest is oversized or non-regular");
        const raw = JSON.parse(
          await readFile(containedPath(repositoryDir, path), "utf8"),
        ) as unknown;
        if (
          raw &&
          typeof raw === "object" &&
          "schemaVersion" in raw &&
          raw.schemaVersion !== 1
        )
          return {
            path,
            status: "unsupported_version" as const,
            ruleId: null,
            sourceIdentity: null,
            ownedFileCount: null,
          };
        const value = parseCanonicalArtifactManifest(raw, path).manifest;
        return {
          path,
          status: "valid" as const,
          ruleId: value.ruleId,
          sourceIdentity: value.source.identity,
          ownedFileCount: value.ownedFiles.length,
        };
      } catch {
        return {
          path,
          status: "malformed" as const,
          ruleId: null,
          sourceIdentity: null,
          ownedFileCount: null,
        };
      }
    }),
  );
  return {
    trackedFiles,
    semgrepFiles,
    agentsFiles,
    claudeFiles,
    artifactState: {
      path: outputDir,
      exists: artifactState.exists,
      symlink: artifactState.kind === "symlink",
      trackedFiles: trackedFiles.filter(
        (path) => path === outputDir || path.startsWith(`${outputDir}/`),
      ),
      manifests,
    },
    semgrepCandidates,
    policyFiles,
    ambiguities,
  };
}

function selectedKinds(target: PolicyTarget): Array<"agents" | "claude"> {
  return target === "both"
    ? ["agents", "claude"]
    : target === "neither"
      ? []
      : [target];
}

export function resolvePolicyPaths(
  discovery: PolicyDiscovery,
  target: PolicyTarget,
  explicit: { agentsPath?: string; claudePath?: string },
): string[] {
  const result: string[] = [];
  for (const kind of selectedKinds(target)) {
    const provided =
      kind === "agents" ? explicit.agentsPath : explicit.claudePath;
    const candidates =
      kind === "agents" ? discovery.agentsFiles : discovery.claudeFiles;
    if (provided) {
      assertSafeExactPath(provided, `${kind} policy path`);
      if (provided.split("/").at(-1)?.toLowerCase() !== `${kind}.md`)
        throw new ConfigurationError(
          `--${kind}-path must name ${kind.toUpperCase()}.md.`,
        );
      result.push(provided);
      continue;
    }
    if (candidates.length > 1)
      throw new ConfigurationError(
        `Multiple ${kind.toUpperCase()}.md files exist; select an exact path.`,
      );
    result.push(candidates[0] ?? `${kind.toUpperCase()}.md`);
  }
  return result;
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

export interface PolicyUpdate {
  path: string;
  previousHash: string | null;
  nextHash: string;
  content: string;
  action: "create" | "update" | "unchanged";
  diff: string;
}

export interface ManagedPointerTarget {
  manifestPath: string;
  rulePath: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function managedPointerBlock(
  target: ManagedPointerTarget,
  eol = "\n",
): string {
  assertSafeExactPath(target.manifestPath, "manifest path");
  assertSafeExactPath(target.rulePath, "rule path");
  return [
    MANAGED_START,
    "Review-to-rule guardrails are indexed by the generated manifest:",
    `- Manifest: \`${target.manifestPath}\``,
    `- Rules: \`${dirname(target.rulePath)}/\``,
    `- Validate: \`semgrep scan --validate --config ${shellQuote(target.rulePath)}\``,
    `- Replay: \`review-to-rule replay ${shellQuote(target.manifestPath)}\``,
    MANAGED_END,
  ].join(eol);
}

export function validateManagedPolicyPointer(
  content: string,
  target: ManagedPointerTarget,
  path: string,
): void {
  const starts = occurrences(content, MANAGED_START);
  const ends = occurrences(content, MANAGED_END);
  if (starts !== 1 || ends !== 1)
    throw new ValidationError(
      `Selected policy file must contain exactly one managed pointer: ${path}`,
    );
  const start = content.indexOf(MANAGED_START);
  const end = content.indexOf(MANAGED_END, start);
  if (end < start)
    throw new ValidationError(
      `Selected policy file has malformed managed marker order: ${path}`,
    );
  const actual = content
    .slice(start, end + MANAGED_END.length)
    .replaceAll("\r\n", "\n");
  const expected = managedPointerBlock(target);
  if (actual !== expected)
    throw new ValidationError(
      `Selected policy pointer does not exactly reference the canonical manifest, rule directory, validate command, and replay command: ${path}`,
    );
}

function managedDiff(path: string, previous: string, next: string): string {
  if (previous === next) return "";
  const managed = (value: string): string => {
    const start = value.indexOf(MANAGED_START);
    const end = value.indexOf(MANAGED_END, Math.max(0, start));
    return start < 0 || end < 0
      ? ""
      : value.slice(start, end + MANAGED_END.length);
  };
  const removed = managed(previous)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => `-${line}`);
  const added = managed(next)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => `+${line}`);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ managed pointer @@",
    ...removed,
    ...added,
  ].join("\n");
}

export async function planManagedPolicyUpdate(
  repositoryDir: string,
  path: string,
  target: string | ManagedPointerTarget,
  read: typeof readFile = readFile,
): Promise<PolicyUpdate> {
  assertSafeExactPath(path, "policy path");
  const resolvedTarget =
    typeof target === "string"
      ? {
          manifestPath: target,
          rulePath: `${target.includes("/manifests/") ? `${target.slice(0, target.indexOf("/manifests/"))}/` : ""}rules/${
            target
              .split("/")
              .at(-1)
              ?.replace(/\.json$/, ".yml") ?? "rule.yml"
          }`,
        }
      : target;
  assertSafeExactPath(resolvedTarget.manifestPath, "manifest path");
  assertSafeExactPath(resolvedTarget.rulePath, "rule path");
  let original: string | undefined;
  try {
    const stat = await lstat(`${repositoryDir}/${path}`);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new UnsafeRepositoryError(
        `Policy target must be a regular non-symlink file: ${path}`,
      );
    if (stat.size > maxPolicyBytes)
      throw new UnsafeRepositoryError(
        `Policy file is larger than ${maxPolicyBytes} bytes: ${path}`,
      );
  } catch (error) {
    if (
      error instanceof UnsafeRepositoryError ||
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  try {
    original = await read(`${repositoryDir}/${path}`, "utf8");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  if (original && Buffer.byteLength(original) > maxPolicyBytes)
    throw new UnsafeRepositoryError(
      `Policy file is larger than ${maxPolicyBytes} bytes: ${path}`,
    );
  const startCount = occurrences(original ?? "", MANAGED_START);
  const endCount = occurrences(original ?? "", MANAGED_END);
  if (startCount !== endCount || startCount > 1)
    throw new UnsafeRepositoryError(
      `Malformed or duplicate managed markers in ${path}.`,
    );
  const eol = original?.includes("\r\n") ? "\r\n" : "\n";
  const block = managedPointerBlock(resolvedTarget, eol);
  let content: string;
  if (startCount === 1) {
    const start = (original ?? "").indexOf(MANAGED_START);
    const end =
      (original ?? "").indexOf(MANAGED_END, start) + MANAGED_END.length;
    content = `${(original ?? "").slice(0, start)}${block}${(original ?? "").slice(end)}`;
  } else {
    const prefix = original ?? "";
    const separator =
      prefix.length === 0 ? "" : prefix.endsWith("\n") ? eol : `${eol}${eol}`;
    content = `${prefix}${separator}${block}${eol}`;
  }
  const previousHash =
    original === undefined
      ? null
      : createHash("sha256").update(original).digest("hex");
  return {
    path,
    previousHash,
    nextHash: createHash("sha256").update(content).digest("hex"),
    content,
    diff: managedDiff(path, original ?? "", content),
    action:
      original === undefined
        ? "create"
        : original === content
          ? "unchanged"
          : "update",
  };
}
