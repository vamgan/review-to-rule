import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ConfigurationError,
  UnsafeRepositoryError,
  ValidationError,
} from "./domain/errors.js";
import { parseMemoryManifest } from "./memory-artifacts.js";
import {
  assertSafeExactPath,
  containedPath,
  inspectContainedPathNoFollow,
} from "./security/path.js";
import type { CommandRunner } from "./utils/command.js";
import type { PolicyTarget } from "./memory-config.js";

export const MANAGED_START = "<!-- review-to-rule:managed:start -->";
export const MANAGED_END = "<!-- review-to-rule:managed:end -->";
const MAX_POLICY_BYTES = 256_000;

export interface RuleCandidate {
  path: string;
  scope: string;
  status: "valid" | "malformed" | "symlink" | "too_large" | "missing";
  diagnostic: string;
}

export interface PolicyDiscovery {
  trackedFiles: string[];
  ruleFiles: string[];
  agentsFiles: string[];
  claudeFiles: string[];
  artifactState: {
    path: string;
    exists: boolean;
    symlink: boolean;
    trackedFiles: string[];
    manifests: Array<{
      path: string;
      status: "valid" | "malformed" | "unsupported_version" | "symlink";
      ruleId: string | null;
      sourceIdentity: string | null;
      ownedFileCount: number | null;
    }>;
  };
  ruleCandidates: RuleCandidate[];
  policyFiles: Array<{
    path: string;
    kind: "agents" | "claude";
    scope: string;
    nested: boolean;
    exists: boolean;
    symlink: boolean;
    managed: "absent" | "valid" | "malformed";
  }>;
  ambiguities: string[];
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function managedState(content: string): "absent" | "valid" | "malformed" {
  const starts = occurrences(content, MANAGED_START);
  const ends = occurrences(content, MANAGED_END);
  if (starts === 0 && ends === 0) return "absent";
  if (starts !== 1 || ends !== 1) return "malformed";
  return content.indexOf(MANAGED_START) < content.indexOf(MANAGED_END)
    ? "valid"
    : "malformed";
}

export async function discoverMemoryPolicy(
  repositoryDir: string,
  runner: CommandRunner,
  outputDir = ".review-to-rule",
): Promise<PolicyDiscovery> {
  const result = await runner.run("git", ["ls-files", "-z"], {
    cwd: repositoryDir,
  });
  if (result.exitCode !== 0)
    throw new UnsafeRepositoryError(
      "Could not discover tracked repository instruction files.",
    );
  const trackedFiles = result.stdout.split("\0").filter(Boolean);
  if (trackedFiles.length > 50_000)
    throw new UnsafeRepositoryError(
      "Tracked instruction discovery exceeded 50,000 files.",
    );
  const agentsFiles = trackedFiles.filter((path) =>
    /(^|\/)AGENTS\.md$/i.test(path),
  );
  const claudeFiles = trackedFiles.filter((path) =>
    /(^|\/)CLAUDE\.md$/i.test(path),
  );
  const escapedOutput = outputDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rulePattern = new RegExp(`^${escapedOutput}/rules/[^/]+\\.md$`, "i");
  const ruleFiles = trackedFiles.filter((path) => rulePattern.test(path));
  const ruleCandidates = await Promise.all(
    ruleFiles.map(async (path): Promise<RuleCandidate> => {
      const state = await inspectContainedPathNoFollow(repositoryDir, path);
      const scope = dirname(path) === "." ? "." : dirname(path);
      if (!state.exists)
        return {
          path,
          scope,
          status: "missing",
          diagnostic: "Tracked review rule is missing from the worktree.",
        };
      if (state.kind === "symlink")
        return {
          path,
          scope,
          status: "symlink",
          diagnostic: "Tracked review rule is a symlink and was not read.",
        };
      if (state.kind !== "file" || (state.size ?? 0) > MAX_POLICY_BYTES)
        return {
          path,
          scope,
          status: "too_large",
          diagnostic: `Rule exceeds the bounded ${MAX_POLICY_BYTES}-byte read limit or is not regular.`,
        };
      const content = await readFile(
        containedPath(repositoryDir, path),
        "utf8",
      );
      const valid = /^# .+/m.test(content) && /^## Instruction$/m.test(content);
      return {
        path,
        scope,
        status: valid ? "valid" : "malformed",
        diagnostic: valid
          ? "Agent-readable instruction and scope document detected."
          : "Rule is missing its title or Instruction section.",
      };
    }),
  );

  const policyFiles = await Promise.all(
    [
      ...agentsFiles.map((path) => ({ path, kind: "agents" as const })),
      ...claudeFiles.map((path) => ({ path, kind: "claude" as const })),
    ].map(async ({ path, kind }) => {
      const state = await inspectContainedPathNoFollow(repositoryDir, path);
      let managed: "absent" | "valid" | "malformed" = "absent";
      if (state.kind === "file" && (state.size ?? 0) <= MAX_POLICY_BYTES)
        managed = managedState(
          await readFile(containedPath(repositoryDir, path), "utf8"),
        );
      return {
        path,
        kind,
        scope: dirname(path) === "." ? "." : dirname(path),
        nested: path.includes("/"),
        exists: state.exists,
        symlink: state.kind === "symlink",
        managed,
      };
    }),
  );

  const outputState = await inspectContainedPathNoFollow(
    repositoryDir,
    outputDir,
  );
  const manifestDirectory = `${outputDir}/manifests`;
  let manifestNames: string[] = [];
  if (outputState.kind === "directory") {
    const state = await inspectContainedPathNoFollow(
      repositoryDir,
      manifestDirectory,
    );
    if (state.kind === "directory")
      manifestNames = (
        await readdir(containedPath(repositoryDir, manifestDirectory))
      )
        .filter((name) => name.endsWith(".json"))
        .sort()
        .slice(0, 1_000);
  }
  const manifests = await Promise.all(
    manifestNames.map(async (name) => {
      const path = `${manifestDirectory}/${name}`;
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
        if (state.kind !== "file" || (state.size ?? 0) > MAX_POLICY_BYTES)
          throw new Error("manifest is oversized or non-regular");
        const raw = JSON.parse(
          await readFile(containedPath(repositoryDir, path), "utf8"),
        ) as unknown;
        if (
          raw &&
          typeof raw === "object" &&
          "schemaVersion" in raw &&
          raw.schemaVersion !== 2
        )
          return {
            path,
            status: "unsupported_version" as const,
            ruleId: null,
            sourceIdentity: null,
            ownedFileCount: null,
          };
        const manifest = parseMemoryManifest(raw, path).manifest;
        return {
          path,
          status: "valid" as const,
          ruleId: manifest.rule.id,
          sourceIdentity: manifest.source.identity,
          ownedFileCount: manifest.ownedFiles.length,
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
  const ambiguities = [
    ...(agentsFiles.length > 1
      ? ["Multiple tracked AGENTS.md files require an exact path."]
      : []),
    ...(claudeFiles.length > 1
      ? ["Multiple tracked CLAUDE.md files require an exact path."]
      : []),
    ...(policyFiles.some((file) => file.managed === "malformed")
      ? ["At least one managed instruction pointer is malformed."]
      : []),
    ...(outputState.kind === "symlink"
      ? [
          `Review-memory root traverses a symlink at ${outputState.symlinkPath ?? outputDir}.`,
        ]
      : []),
  ];
  return {
    trackedFiles,
    ruleFiles,
    agentsFiles,
    claudeFiles,
    artifactState: {
      path: outputDir,
      exists: outputState.exists,
      symlink: outputState.kind === "symlink",
      trackedFiles: trackedFiles.filter(
        (path) => path === outputDir || path.startsWith(`${outputDir}/`),
      ),
      manifests,
    },
    ruleCandidates,
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

export function resolveMemoryPolicyPaths(
  discovery: PolicyDiscovery,
  target: PolicyTarget,
  explicit: { agentsPath?: string; claudePath?: string },
): string[] {
  const paths: string[] = [];
  for (const kind of selectedKinds(target)) {
    const provided =
      kind === "agents" ? explicit.agentsPath : explicit.claudePath;
    const candidates =
      kind === "agents" ? discovery.agentsFiles : discovery.claudeFiles;
    if (provided) {
      assertSafeExactPath(provided, `${kind} instruction path`);
      if (provided.split("/").at(-1)?.toLowerCase() !== `${kind}.md`)
        throw new ConfigurationError(
          `--${kind}-path must name ${kind.toUpperCase()}.md.`,
        );
      paths.push(provided);
    } else {
      if (candidates.length > 1)
        throw new ConfigurationError(
          `Multiple ${kind.toUpperCase()}.md files exist; select an exact path.`,
        );
      paths.push(candidates[0] ?? `${kind.toUpperCase()}.md`);
    }
  }
  return paths;
}

export interface ManagedPointerTarget {
  indexPath: string;
  rulesDir: string;
}

export function managedMemoryPointerBlock(
  target: ManagedPointerTarget,
  eol = "\n",
): string {
  assertSafeExactPath(target.indexPath, "review-memory index path");
  assertSafeExactPath(target.rulesDir, "review-memory rule directory");
  return [
    MANAGED_START,
    "Repository-specific code-review memory:",
    `- Before reviewing or changing code, read \`${target.indexPath}\`.`,
    `- Load only the Markdown rules in \`${target.rulesDir}/\` whose declared scope matches the files involved.`,
    MANAGED_END,
  ].join(eol);
}

export function validateManagedMemoryPointer(
  content: string,
  target: ManagedPointerTarget,
  path: string,
): void {
  if (managedState(content) !== "valid")
    throw new ValidationError(
      `Selected instruction file must contain exactly one ordered managed pointer: ${path}`,
    );
  const start = content.indexOf(MANAGED_START);
  const end = content.indexOf(MANAGED_END, start);
  const actual = content
    .slice(start, end + MANAGED_END.length)
    .replaceAll("\r\n", "\n");
  if (actual !== managedMemoryPointerBlock(target))
    throw new ValidationError(
      `Selected instruction pointer does not reference the canonical review-memory index and rule directory: ${path}`,
    );
}

export interface PolicyUpdate {
  path: string;
  previousHash: string | null;
  nextHash: string;
  content: string;
  action: "create" | "update" | "unchanged";
  diff: string;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function managedDiff(path: string, previous: string, next: string): string {
  if (previous === next) return "";
  const managed = (value: string) => {
    const start = value.indexOf(MANAGED_START);
    const end = value.indexOf(MANAGED_END, Math.max(0, start));
    return start < 0 || end < 0
      ? ""
      : value.slice(start, end + MANAGED_END.length);
  };
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ managed review-memory pointer @@",
    ...managed(previous)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `-${line}`),
    ...managed(next)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `+${line}`),
  ].join("\n");
}

export async function planManagedMemoryUpdate(
  repositoryDir: string,
  path: string,
  target: ManagedPointerTarget,
): Promise<PolicyUpdate> {
  assertSafeExactPath(path, "instruction file path");
  const state = await inspectContainedPathNoFollow(repositoryDir, path);
  if (state.kind === "symlink" || (state.exists && state.kind !== "file"))
    throw new UnsafeRepositoryError(
      `Instruction target must be a regular non-symlink file: ${path}`,
    );
  if ((state.size ?? 0) > MAX_POLICY_BYTES)
    throw new UnsafeRepositoryError(
      `Instruction target exceeds ${MAX_POLICY_BYTES} bytes: ${path}`,
    );
  const previous =
    state.kind === "file"
      ? await readFile(containedPath(repositoryDir, path), "utf8")
      : "";
  if (managedState(previous) === "malformed")
    throw new UnsafeRepositoryError(
      `Instruction target contains malformed review-to-rule markers: ${path}`,
    );
  const eol = previous.includes("\r\n") ? "\r\n" : "\n";
  const block = managedMemoryPointerBlock(target, eol);
  let content: string;
  const start = previous.indexOf(MANAGED_START);
  const end = previous.indexOf(MANAGED_END, Math.max(0, start));
  if (start >= 0 && end >= 0)
    content = `${previous.slice(0, start)}${block}${previous.slice(end + MANAGED_END.length)}`;
  else if (!previous) content = `${block}${eol}`;
  else content = `${previous.replace(/\s*$/, "")}${eol}${eol}${block}${eol}`;
  const action = !state.exists
    ? ("create" as const)
    : content === previous
      ? ("unchanged" as const)
      : ("update" as const);
  return {
    path,
    previousHash: state.exists ? sha256(previous) : null,
    nextHash: sha256(content),
    content,
    action,
    diff: managedDiff(path, previous, content),
  };
}
