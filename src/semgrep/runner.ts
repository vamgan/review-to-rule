import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { ValidationError } from "../domain/errors.js";
import {
  matchSchema,
  validationReportSchema,
  type GeneratedRuleProposal,
  type Language,
} from "../domain/schemas.js";
import type { CommandRunner } from "../utils/command.js";
import { validateRuleYaml } from "./rule.js";

export interface SemgrepResult {
  results?: Array<{
    path?: string;
    start?: { line?: number };
    end?: { line?: number };
    extra?: { lines?: string; message?: string };
  }>;
  errors?: unknown[];
}
function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function resolveReportedPath(
  reported: string,
  target: string,
  targetIsFile: boolean,
): Promise<{ absolute: string; root: string; display: string }> {
  if (!reported)
    throw new ValidationError("Semgrep returned a match without a path.");
  const targetAbsolute = await realpath(resolve(target));
  const root = targetIsFile
    ? await realpath(dirname(targetAbsolute))
    : targetAbsolute;
  const candidates = isAbsolute(reported)
    ? [resolve(reported)]
    : [resolve(process.cwd(), reported), resolve(root, reported)];
  let absolute: string | undefined;
  for (const candidate of candidates) {
    try {
      absolute = await realpath(candidate);
      break;
    } catch {
      // Try the next deterministic resolution base.
    }
  }
  if (!absolute)
    throw new ValidationError(
      `Semgrep reported a missing or unreadable path: ${reported}`,
    );
  if (!isContained(root, absolute))
    throw new ValidationError(
      `Semgrep reported a path outside the scan root: ${reported}`,
    );
  if (targetIsFile && absolute !== targetAbsolute)
    throw new ValidationError(
      `Semgrep reported a different file than the explicit target: ${reported}`,
    );
  return {
    absolute,
    root,
    display: targetIsFile
      ? basename(targetAbsolute)
      : relative(root, absolute).replaceAll("\\", "/"),
  };
}

async function excerptFor(
  path: string,
  startLine: number,
  endLine: number,
): Promise<string> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new ValidationError(`Matched file is missing or unreadable: ${path}`);
  }
  const lines = content.split("\n");
  if (
    startLine < 1 ||
    endLine < startLine ||
    startLine > lines.length ||
    endLine > lines.length
  )
    throw new ValidationError(
      `Semgrep returned invalid line bounds ${startLine}-${endLine} for ${path}.`,
    );
  const value = lines.slice(startLine - 1, endLine).join("\n");
  return value.length <= 1_000 ? value : `${value.slice(0, 984)}\n…[truncated]`;
}

export async function normalizeSemgrepMatches(
  data: SemgrepResult,
  target: string,
): Promise<ReturnType<typeof matchSchema.parse>[]> {
  const targetStat = await stat(target).catch(() => undefined);
  if (!targetStat)
    throw new ValidationError(
      `Semgrep scan target is missing or unreadable: ${target}`,
    );
  const targetIsFile = targetStat.isFile();
  if (!targetIsFile && !targetStat.isDirectory())
    throw new ValidationError(
      `Semgrep scan target is not a file or directory: ${target}`,
    );
  const matches = await Promise.all(
    (data.results ?? []).map(async (item) => {
      const resolved = await resolveReportedPath(
        item.path ?? "",
        target,
        targetIsFile,
      );
      const startLine = item.start?.line ?? 0;
      const endLine = item.end?.line ?? startLine;
      return matchSchema.parse({
        path: resolved.display,
        startLine,
        endLine,
        excerpt: await excerptFor(resolved.absolute, startLine, endLine),
        message: item.extra?.message ?? "review-to-rule match",
      });
    }),
  );
  return matches.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.startLine - right.startLine,
  );
}

async function invoke(
  runner: CommandRunner,
  rulePath: string,
  target: string,
): Promise<{ count: number; matches: ReturnType<typeof matchSchema.parse>[] }> {
  const run = await runner.run("semgrep", [
    "scan",
    "--config",
    rulePath,
    "--json",
    "--quiet",
    "--no-git-ignore",
    target,
  ]);
  if (run.exitCode !== 0 && run.exitCode !== 1)
    throw new ValidationError(
      `Semgrep execution failed: ${run.stderr || run.stdout}`,
    );
  let data: SemgrepResult;
  try {
    data = JSON.parse(run.stdout) as SemgrepResult;
  } catch {
    throw new ValidationError(
      `Semgrep returned malformed JSON: ${run.stderr || run.stdout}`,
    );
  }
  if (data.errors?.length)
    throw new ValidationError(
      `Semgrep reported configuration errors: ${JSON.stringify(data.errors).slice(0, 1_000)}`,
    );
  const matches = await normalizeSemgrepMatches(data, target);
  return { count: matches.length, matches };
}

export async function scanWithSemgrep(input: {
  proposal: GeneratedRuleProposal;
  rulePath: string;
  target: string;
  runner: CommandRunner;
  matchLimit?: number;
}): Promise<ReturnType<typeof matchSchema.parse>[]> {
  validateRuleYaml(input.proposal);
  const syntax = await input.runner.run("semgrep", [
    "scan",
    "--validate",
    "--config",
    input.rulePath,
  ]);
  if (syntax.exitCode !== 0)
    throw new ValidationError(
      `Semgrep syntax validation failed: ${syntax.stderr || syntax.stdout}`,
    );
  const result = await invoke(input.runner, input.rulePath, input.target);
  const limit = input.matchLimit ?? 200;
  if (result.count > limit)
    throw new ValidationError(
      `Repository scan produced ${result.count} matches, exceeding the configured limit ${limit}.`,
    );
  return result.matches;
}

interface Mutation {
  name: string;
  value?: string;
  omission?: string;
}

function mutations(source: string, language: Language): Mutation[] {
  const whitespace = source.replace(/ = /g, "  =  ").replace(/;$/gm, " ;");
  const renamed = source.replace(/\b(value|result|ttl)\b/g, "renamedValue");
  const surrounded =
    language === "python"
      ? `marker = 1\n${source}\nmarker = 2\n`
      : `const markerBefore = 1;\n${source}\nconst markerAfter = 2;\n`;
  const literal = source.replace(/(?<![\w$.])(\d+)(?![\w$])/u, (value) =>
    String(Number(value) + 1),
  );
  return [
    { name: "whitespace", value: whitespace },
    { name: "variable rename", value: renamed },
    { name: "surrounding statements", value: surrounded },
    literal === source
      ? {
          name: "irrelevant literal",
          omission: "No reliable irrelevant literal exists in this fixture.",
        }
      : { name: "irrelevant literal", value: literal },
  ];
}

export interface ValidationInput {
  proposal: GeneratedRuleProposal;
  before: string;
  after: string;
  allowed?: string;
  repositoryDir?: string;
  matchLimit?: number;
  fixturePath?: string;
}

async function writeScopedFixture(
  directory: string,
  label: string,
  path: string,
  content: string,
): Promise<string> {
  const root = join(directory, label);
  const destination = join(root, path);
  if (!isContained(root, destination))
    throw new ValidationError(`Unsafe fixture scope path: ${path}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
  return root;
}

export async function validateWithSemgrep(
  input: ValidationInput,
  runner: CommandRunner,
  attempts = 1,
): Promise<ReturnType<typeof validationReportSchema.parse>> {
  validateRuleYaml(input.proposal);
  const directory = await mkdtemp(join(tmpdir(), "review-to-rule-semgrep-"));
  const rulePath = join(directory, "rule.yml");
  const fixtureScope = input.fixturePath ?? input.proposal.include[0];
  if (!fixtureScope || /[*?[\]{}]/.test(fixtureScope))
    throw new ValidationError(
      "Fixture validation requires one exact relative include path.",
    );
  try {
    await writeFile(rulePath, input.proposal.yaml, "utf8");
    const syntax = await runner.run("semgrep", [
      "scan",
      "--validate",
      "--config",
      rulePath,
    ]);
    if (syntax.exitCode !== 0)
      throw new ValidationError(
        `Semgrep syntax validation failed: ${syntax.stderr || syntax.stdout}`,
      );
    const checks: Array<{
      name: string;
      status: "passed" | "failed" | "omitted";
      diagnostic: string;
    }> = [
      {
        name: "syntax",
        status: "passed",
        diagnostic: "Semgrep accepted the rule configuration.",
      },
    ];
    const beforeRoot = await writeScopedFixture(
      directory,
      "before",
      fixtureScope,
      input.before,
    );
    const afterRoot = await writeScopedFixture(
      directory,
      "after",
      fixtureScope,
      input.after,
    );
    const before = await invoke(runner, rulePath, beforeRoot);
    const after = await invoke(runner, rulePath, afterRoot);
    if (before.count < 1)
      throw new ValidationError("Before fixture produced zero matches.");
    checks.push({
      name: "before fixture",
      status: "passed",
      diagnostic: `${before.count} match(es); expected at least one.`,
    });
    if (after.count !== 0)
      throw new ValidationError(
        `Corrected fixture produced ${after.count} false-positive match(es).`,
      );
    checks.push({
      name: "corrected fixture",
      status: "passed",
      diagnostic: "0 matches; expected exactly zero.",
    });
    if (input.allowed) {
      const allowedRoot = await writeScopedFixture(
        directory,
        "allowed",
        fixtureScope,
        input.allowed,
      );
      const allowed = await invoke(runner, rulePath, allowedRoot);
      if (allowed.count !== 0)
        throw new ValidationError(
          `Allowed alternative produced ${allowed.count} false-positive match(es).`,
        );
      checks.push({
        name: "allowed alternative",
        status: "passed",
        diagnostic: "0 matches; expected exactly zero.",
      });
    } else
      checks.push({
        name: "allowed alternative",
        status: "omitted",
        diagnostic:
          "No reliable alternative was available; recorded as a limitation.",
      });
    for (const mutation of mutations(input.before, input.proposal.language)) {
      if (mutation.omission) {
        checks.push({
          name: `mutation: ${mutation.name}`,
          status: "omitted",
          diagnostic: mutation.omission,
        });
        continue;
      }
      const root = await writeScopedFixture(
        directory,
        `mutation-${mutation.name.replaceAll(" ", "-")}`,
        fixtureScope,
        mutation.value ?? input.before,
      );
      const result = await invoke(runner, rulePath, root);
      if (result.count < 1)
        throw new ValidationError(
          `Meaning-preserving mutation '${mutation.name}' escaped the rule.`,
        );
      checks.push({
        name: `mutation: ${mutation.name}`,
        status: "passed",
        diagnostic: `${result.count} match(es).`,
      });
    }
    let matches: ReturnType<typeof matchSchema.parse>[] = [];
    if (input.repositoryDir) {
      const scanned = await invoke(runner, rulePath, input.repositoryDir);
      if (scanned.count > (input.matchLimit ?? 200))
        throw new ValidationError(
          `Repository scan produced ${scanned.count} matches, exceeding the configured limit ${input.matchLimit ?? 200}.`,
        );
      matches = scanned.matches;
      checks.push({
        name: "repository scan",
        status: "passed",
        diagnostic: `${matches.length} normalized current match(es).`,
      });
    }
    return validationReportSchema.parse({ attempts, checks, matches });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function readCurrentExcerpt(path: string): Promise<string> {
  return (await readFile(path, "utf8")).slice(0, 1_000);
}
