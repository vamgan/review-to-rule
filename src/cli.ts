#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";
import { errorOutcome, generate } from "./pipeline.js";
import { renderHuman } from "./cli/render.js";
import { createInterface } from "node:readline/promises";
import { stdin, stderr as output } from "node:process";
import { resolveConfig, providerCredential } from "./config.js";
import { FakeProvider } from "./llm/provider.js";
import { AnthropicProvider, OpenAIProvider } from "./llm/adapters.js";
import { ProcessCommandRunner } from "./utils/command.js";
import {
  ConfigurationError,
  DomainError,
  UnsafeRepositoryError,
} from "./domain/errors.js";
import { redact } from "./security/redact.js";
import { resolve } from "node:path";
import { replayArtifactManifest } from "./replay.js";
import { ValidationError } from "./domain/errors.js";
import { collectReviewEvidence } from "./evidence.js";
import { GENERATOR_VERSION } from "./artifacts.js";
import { validateArtifact, validateAllArtifacts } from "./validation.js";
import { scanRule } from "./scan.js";
import { runDoctor } from "./doctor.js";
import { installCi, planCiInstall } from "./install-ci.js";
import { openPullRequest } from "./open-pr.js";
import { preflightDebugBundle, writeDebugBundle } from "./debug-bundle.js";

interface CliOptions {
  repoDir?: string;
  provider?: string;
  model?: string;
  write?: boolean;
  openPr?: boolean;
  yes?: boolean;
  json?: boolean;
  debug?: boolean;
  debugBundle?: string;
  allowOpenPr?: boolean;
  allowUnresolved?: boolean;
  outputDir?: string;
  config?: string;
  fixture?: string;
  policyTarget?: "agents" | "claude" | "both" | "neither";
  agentsPath?: string;
  claudePath?: string;
  allowUnmapped?: boolean;
}

let activeBundleCapture:
  | {
      stdout: string;
      stderr: string;
      restore(): void;
    }
  | undefined;

function beginBundleCapture() {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const capture = {
    stdout: "",
    stderr: "",
    restore: () => {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    },
  };
  process.stdout.write = (chunk: string | Uint8Array) => {
    capture.stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    capture.stderr +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  activeBundleCapture = capture;
}

function finishBundleCapture(flush: boolean) {
  const capture = activeBundleCapture;
  if (!capture) return;
  capture.restore();
  activeBundleCapture = undefined;
  if (flush) {
    if (capture.stdout) process.stdout.write(capture.stdout);
    if (capture.stderr) process.stderr.write(capture.stderr);
  }
}

export function normalizeCliOptions(options: CliOptions): CliOptions {
  return options.openPr ? { ...options, write: true } : { ...options };
}

function emitEarlyError(options: CliOptions, error: unknown): void {
  const domain =
    error instanceof DomainError
      ? error
      : new ConfigurationError(
          redact(error instanceof Error ? error.message : String(error)),
        );
  const outcome = errorOutcome(domain);
  const result = options.debug
    ? { ...outcome.result, debug: { diagnostic: domain.name } }
    : outcome.result;
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stderr.write(`${renderHuman(outcome.result)}\n`);
  if (options.debug && !options.json)
    process.stderr.write(`Diagnostic: ${domain.name}\n`);
  process.exitCode = outcome.exitCode;
}

function emitSimpleFailure(
  options: { json?: boolean; debug?: boolean },
  error: unknown,
  operation: string,
  forcedExitCode?: number,
): void {
  const domain =
    error instanceof DomainError
      ? error
      : new ValidationError(
          redact(error instanceof Error ? error.message : String(error)),
        );
  const failure = {
    schemaVersion: 1,
    status:
      domain.code === 4
        ? "dependency_failed"
        : domain.code === 5
          ? "unsafe_repository"
          : "validation_failed",
    errors: [
      {
        kind: domain.kind,
        message: domain.message,
        remediation: domain.remediation,
      },
    ],
    ...(options.debug ? { debug: { diagnostic: domain.name } } : {}),
  };
  if (options.json) process.stdout.write(`${JSON.stringify(failure)}\n`);
  else
    process.stderr.write(
      `${operation} failed [${domain.kind}]: ${domain.message}\nRemediation: ${domain.remediation}\n`,
    );
  process.exitCode = forcedExitCode ?? domain.code;
}

function addGenerateOptions(command: Command): Command {
  return command
    .option("--repo-dir <path>", "explicit target repository directory")
    .option(
      "--provider <name>",
      "structured provider (openai or anthropic; fake requires --fixture)",
    )
    .option("--model <id>", "provider model identifier")
    .option(
      "--write",
      "transactionally write validated artifacts after preview",
    )
    .option(
      "--open-pr",
      "write artifacts and open a pull request (implies --write)",
    )
    .option("--yes", "approve non-interactive mutations")
    .option("--json", "emit one schema-versioned JSON object")
    .option("--debug", "show sanitized diagnostics")
    .option(
      "--debug-bundle <path>",
      "write an approved sanitized diagnostic bundle",
    )
    .option("--allow-open-pr", "permit analysis of an unmerged pull request")
    .option("--allow-unresolved", "permit analysis of an unresolved thread")
    .option(
      "--allow-unmapped",
      "permit explicitly warned incomplete review mapping",
    )
    .option("--output-dir <path>", "artifact output directory")
    .option("--config <path>", "configuration file")
    .addOption(
      new Option("--policy-target <target>", "managed pointer target").choices([
        "agents",
        "claude",
        "both",
        "neither",
      ]),
    )
    .option("--agents-path <path>", "exact AGENTS.md path for managed pointer")
    .option("--claude-path <path>", "exact CLAUDE.md path for managed pointer")
    .addOption(
      new Option(
        "--fixture <name>",
        "use a deterministic offline fixture",
      ).hideHelp(),
    );
}

export function buildProgram(): Command {
  const program = new Command()
    .name("review-to-rule")
    .description(
      "Convert accepted GitHub review feedback into a tested Semgrep rule.",
    )
    .version(GENERATOR_VERSION)
    .exitOverride()
    .configureOutput({ writeErr: () => undefined });
  addGenerateOptions(
    program
      .command("generate")
      .description("generate one validated rule")
      .argument(
        "<review-comment-url>",
        "GitHub pull-request review comment URL",
      )
      .action(async (reviewUrl: string, raw: CliOptions, command: Command) => {
        const options = normalizeCliOptions(raw);
        let config;
        try {
          config = await resolveConfig({
            ...(options.provider
              ? {
                  provider: options.provider as "openai" | "anthropic" | "fake",
                }
              : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.outputDir ? { outputDir: options.outputDir } : {}),
            ...(options.config ? { config: options.config } : {}),
            ...(options.fixture ? { fixture: options.fixture } : {}),
            ...(options.policyTarget
              ? { policyTarget: options.policyTarget }
              : {}),
            ...(options.agentsPath ? { agentsPath: options.agentsPath } : {}),
            ...(options.claudePath ? { claudePath: options.claudePath } : {}),
          });
        } catch (error) {
          emitEarlyError(options, error);
          return;
        }
        const credential = providerCredential(config.provider, process.env);
        let provider;
        try {
          provider =
            config.provider === "fake"
              ? new FakeProvider()
              : config.provider === "openai"
                ? new OpenAIProvider({
                    model: config.model,
                    ...(credential ? { apiKey: credential } : {}),
                    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
                  })
                : new AnthropicProvider({
                    model: config.model,
                    ...(credential ? { apiKey: credential } : {}),
                    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
                  });
        } catch (error) {
          emitEarlyError(options, error);
          return;
        }
        const repositoryDir =
          options.repoDir ??
          (options.fixture === "injected-clock"
            ? new URL("../examples/injected-clock/repository", import.meta.url)
                .pathname
            : undefined);
        const confirmation = {
          isTTY: stdin.isTTY && output.isTTY,
          confirm: async (summary: string) => {
            const prompt = createInterface({ input: stdin, output });
            try {
              const answer = await prompt.question(
                `${summary}\nType 'yes' to continue: `,
              );
              return answer.trim().toLowerCase() === "yes";
            } finally {
              prompt.close();
            }
          },
        };
        const generateOptions = {
          ...(options.fixture ? { fixture: options.fixture } : {}),
          ...(repositoryDir ? { repositoryDir } : {}),
          provider,
          runner: new ProcessCommandRunner(),
          confidenceFloor: config.confidenceFloor,
          contextLines: config.contextLines,
          severity: config.severity,
          include: config.include,
          exclude: config.exclude,
          matchLimit: config.matchLimit,
          outputDir: config.outputDir,
          policyTarget: config.policyTarget,
          policyTargetExplicit:
            command.getOptionValueSource("policyTarget") === "cli",
          ...(config.agentsPath ? { agentsPath: config.agentsPath } : {}),
          agentsPathExplicit:
            command.getOptionValueSource("agentsPath") === "cli",
          ...(config.claudePath ? { claudePath: config.claudePath } : {}),
          claudePathExplicit:
            command.getOptionValueSource("claudePath") === "cli",
          ...(options.write ? { write: true } : {}),
          ...(options.yes ? { yes: true } : {}),
          ...(options.allowOpenPr ? { allowOpenPr: true } : {}),
          ...(options.allowUnresolved ? { allowUnresolved: true } : {}),
          ...(options.allowUnmapped ? { allowUnmapped: true } : {}),
          providerInfo: { name: config.provider, model: config.model },
          confirmation,
        };
        let outcome;
        try {
          outcome = options.openPr
            ? await openPullRequest({
                reviewUrl,
                sourceRepositoryDir:
                  repositoryDir ??
                  (() => {
                    throw new ConfigurationError(
                      "--open-pr requires --repo-dir so the source checkout and remote are explicit.",
                    );
                  })(),
                runner: new ProcessCommandRunner(),
                generateOptions,
                branchPrefix: config.branchPrefix,
                labels: config.labels,
                approved: Boolean(options.yes),
                ...(confirmation.isTTY
                  ? { confirm: confirmation.confirm }
                  : {}),
              })
            : await generate(reviewUrl, generateOptions);
        } catch (error) {
          emitEarlyError(options, error);
          return;
        }
        process.stdout.write(
          options.json
            ? `${JSON.stringify(outcome.result)}\n`
            : `${renderHuman(outcome.result)}\n`,
        );
        process.exitCode = outcome.exitCode;
      }),
  );
  program
    .command("evidence")
    .description("collect sanitized review evidence through read-only gh calls")
    .argument("<review-comment-url>", "GitHub pull-request review comment URL")
    .option("--json", "emit one schema-versioned JSON object")
    .option("--allow-open-pr", "permit an unmerged pull request")
    .option("--allow-unresolved", "permit an unresolved review thread")
    .option("--allow-unmapped", "permit incomplete thread mapping")
    .action(
      async (
        reviewUrl: string,
        options: {
          json?: boolean;
          allowOpenPr?: boolean;
          allowUnresolved?: boolean;
          allowUnmapped?: boolean;
        },
      ) => {
        try {
          const result = await collectReviewEvidence({
            reviewUrl,
            runner: new ProcessCommandRunner(),
            ...(options.allowOpenPr ? { allowOpenPr: true } : {}),
            ...(options.allowUnresolved ? { allowUnresolved: true } : {}),
            ...(options.allowUnmapped ? { allowUnmapped: true } : {}),
          });
          process.stdout.write(
            options.json
              ? `${JSON.stringify(result)}\n`
              : [
                  `Collected read-only evidence for ${result.repository.host}/${result.repository.owner}/${result.repository.name}#${result.review.id}`,
                  `Pull request: ${result.pullRequest.number} (${result.pullRequest.merged ? "merged" : "not merged"})`,
                  `Review: ${result.review.path} (${result.review.resolved ? "resolved" : "unresolved"})`,
                ].join("\n") + "\n",
          );
          process.exitCode = 0;
        } catch (error) {
          const domain =
            error instanceof DomainError
              ? error
              : new ValidationError(
                  redact(
                    error instanceof Error ? error.message : String(error),
                  ),
                );
          const failure = {
            schemaVersion: 1,
            status: "dependency_failed",
            errors: [
              {
                kind: domain.kind,
                message: domain.message,
                remediation: domain.remediation,
              },
            ],
          };
          if (options.json)
            process.stdout.write(`${JSON.stringify(failure)}\n`);
          else
            process.stderr.write(
              `Evidence collection failed [${domain.kind}]: ${domain.message}\nRemediation: ${domain.remediation}\n`,
            );
          process.exitCode = domain.code;
        }
      },
    );
  program
    .command("validate")
    .description("validate one generated manifest or rule")
    .argument("<artifact-path>", "canonical manifest or rule path")
    .option("--repo-dir <path>", "repository containing artifacts")
    .option("--output-dir <path>", "canonical artifact root")
    .option("--json", "emit one schema-versioned JSON object")
    .action(
      async (
        artifactPath: string,
        options: { repoDir?: string; outputDir?: string; json?: boolean },
      ) => {
        try {
          const result = await validateArtifact({
            repositoryDir: resolve(options.repoDir ?? process.cwd()),
            inputPath: artifactPath,
            ...(options.outputDir ? { outputDir: options.outputDir } : {}),
            runner: new ProcessCommandRunner(),
          });
          process.stdout.write(
            options.json
              ? `${JSON.stringify(result)}\n`
              : `Validation passed: ${result.manifestPath}\nRule: ${result.rulePath}\nVerified files: ${result.verifiedFiles.length}\n`,
          );
          process.exitCode = 0;
        } catch (error) {
          emitSimpleFailure(options, error, "Validation");
        }
      },
    );
  program
    .command("validate-all")
    .description("validate every owned artifact set")
    .argument("[directory]", "artifact directory", ".review-to-rule")
    .option("--repo-dir <path>", "repository containing artifacts")
    .option("--json", "emit one schema-versioned JSON object")
    .action(
      async (
        directory: string,
        options: { repoDir?: string; json?: boolean },
      ) => {
        try {
          const result = await validateAllArtifacts({
            repositoryDir: resolve(options.repoDir ?? process.cwd()),
            outputDir: directory,
            runner: new ProcessCommandRunner(),
          });
          process.stdout.write(
            options.json
              ? `${JSON.stringify(result)}\n`
              : [
                  `Validated ${result.items.length} artifact set(s).`,
                  ...result.items.map(
                    (item) =>
                      `- ${item.status.toUpperCase()} ${item.inputPath}${item.error ? `: ${item.error}` : ""}`,
                  ),
                  ...result.errors.map((error) => `Error: ${error}`),
                  `Status: ${result.status}`,
                ].join("\n") + "\n",
          );
          process.exitCode = result.status === "success" ? 0 : 3;
        } catch (error) {
          emitSimpleFailure(options, error, "Validation");
        }
      },
    );
  program
    .command("scan")
    .description("scan a repository with one generated rule")
    .argument("<rule-path>", "generated rule YAML path")
    .argument("[repository-path]", "repository to scan")
    .option("--repo-dir <path>", "repository to scan")
    .option("--target <path>", "contained file or directory", ".")
    .option("--match-limit <number>", "maximum accepted matches", "200")
    .option("--json", "emit one schema-versioned JSON object")
    .action(
      async (
        rulePath: string,
        repositoryPath: string | undefined,
        options: {
          repoDir?: string;
          target: string;
          matchLimit: string;
          json?: boolean;
        },
      ) => {
        try {
          const result = await scanRule({
            repositoryDir: resolve(
              options.repoDir ?? repositoryPath ?? process.cwd(),
            ),
            rulePath,
            target: options.target,
            matchLimit: Number(options.matchLimit),
            runner: new ProcessCommandRunner(),
          });
          process.stdout.write(
            options.json
              ? `${JSON.stringify(result)}\n`
              : [
                  `Scan passed: ${result.rulePath}`,
                  `Target: ${result.target}`,
                  `Matches: ${result.matches.length}`,
                  ...result.matches.map(
                    (match) =>
                      `- ${match.path}:${match.startLine}-${match.endLine} ${match.message}`,
                  ),
                ].join("\n") + "\n",
          );
          process.exitCode = 0;
        } catch (error) {
          emitSimpleFailure(options, error, "Scan");
        }
      },
    );
  program
    .command("doctor")
    .description("diagnose local prerequisites without mutation")
    .option("--repo-dir <path>", "repository to inspect")
    .option("--config <path>", "configuration file")
    .option("--fixture <name>", "select offline fixture mode")
    .option("--json", "emit one schema-versioned JSON object")
    .action(
      async (options: {
        repoDir?: string;
        config?: string;
        fixture?: string;
        json?: boolean;
      }) => {
        const result = await runDoctor({
          runner: new ProcessCommandRunner(),
          cwd: resolve(options.repoDir ?? process.cwd()),
          config: {
            ...(options.config ? { config: options.config } : {}),
            ...(options.fixture ? { fixture: options.fixture } : {}),
          },
        });
        process.stdout.write(
          options.json
            ? `${JSON.stringify(result)}\n`
            : [
                ...result.checks.map(
                  (check) =>
                    `${check.status.toUpperCase()} ${check.name}: ${check.diagnostic}${check.remediation ? `\n  ${check.remediation}` : ""}`,
                ),
                `Status: ${result.status}`,
              ].join("\n") + "\n",
        );
        process.exitCode = result.status === "success" ? 0 : 4;
      },
    );
  program
    .command("install-ci")
    .description("preview or install the review-to-rule CI workflow")
    .argument("[repository-path]", "repository to update")
    .option("--repo-dir <path>", "repository to update")
    .option("--write", "install after preview")
    .option("--yes", "approve non-interactive installation")
    .option("--json", "emit one schema-versioned JSON object")
    .action(
      async (
        repositoryPath: string | undefined,
        options: {
          repoDir?: string;
          write?: boolean;
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          const repositoryDir = resolve(
            options.repoDir ?? repositoryPath ?? process.cwd(),
          );
          let result = await planCiInstall(repositoryDir);
          if (options.write) {
            if (!options.yes) {
              if (!(stdin.isTTY && output.isTTY))
                throw new UnsafeRepositoryError(
                  "Interactive CI confirmation requires a TTY; use --yes after reviewing the preview.",
                );
              const prompt = createInterface({ input: stdin, output });
              try {
                const answer = await prompt.question(
                  `${result.preview}\nType 'yes' to install CI: `,
                );
                if (answer.trim().toLowerCase() !== "yes")
                  throw new UnsafeRepositoryError(
                    "CI installation declined; no files were changed.",
                  );
              } finally {
                prompt.close();
              }
            }
            result = await installCi(repositoryDir, result);
          }
          process.stdout.write(
            options.json
              ? `${JSON.stringify(result)}\n`
              : `${result.preview}\nWritten: ${result.written ? "yes" : "no"}\n`,
          );
          process.exitCode = 0;
        } catch (error) {
          emitSimpleFailure(options, error, "CI installation");
        }
      },
    );
  program
    .command("replay")
    .description("verify manifest hashes and replay fixture expectations")
    .argument("<manifest-path>", "relative generated manifest path")
    .option("--repo-dir <path>", "repository containing the manifest")
    .option("--json", "emit one schema-versioned JSON object")
    .action(
      async (
        manifestPath: string,
        options: { repoDir?: string; json?: boolean },
      ) => {
        try {
          const result = await replayArtifactManifest({
            repositoryDir: resolve(options.repoDir ?? process.cwd()),
            manifestPath,
            runner: new ProcessCommandRunner(),
          });
          process.stdout.write(
            options.json
              ? `${JSON.stringify(result)}\n`
              : [
                  `review-to-rule replay passed: ${result.manifestPath}`,
                  `Rule: ${result.rulePath}`,
                  `Verified files: ${result.verifiedFiles.length}`,
                  ...result.validation.checks.map(
                    (check) =>
                      `- ${check.status.toUpperCase()} ${check.name}: ${check.diagnostic}`,
                  ),
                ].join("\n") + "\n",
          );
          process.exitCode = 0;
        } catch (error) {
          const domain =
            error instanceof DomainError
              ? error
              : new ValidationError(
                  redact(
                    error instanceof Error ? error.message : String(error),
                  ),
                );
          const failure = {
            schemaVersion: 1,
            status: "validation_failed",
            manifestPath,
            rulePath: null,
            verifiedFiles: [],
            validation: null,
            errors: [
              {
                kind: domain.kind,
                message: domain.message,
                remediation: domain.remediation,
              },
            ],
          };
          if (options.json)
            process.stdout.write(`${JSON.stringify(failure)}\n`);
          else
            process.stderr.write(
              `Replay failed [${domain.kind}]: ${domain.message}\nRemediation: ${domain.remediation}\n`,
            );
          process.exitCode = domain.code;
        }
      },
    );
  for (const command of program.commands) {
    if (!command.options.some((option) => option.long === "--debug"))
      command.option("--debug", "show sanitized diagnostics");
    if (!command.options.some((option) => option.long === "--debug-bundle"))
      command.option(
        "--debug-bundle <path>",
        "write an approved sanitized diagnostic bundle",
      );
    if (!command.options.some((option) => option.long === "--yes"))
      command.option("--yes", "approve diagnostic bundle writes");
  }
  program.hook("preAction", async (_root, action) => {
    const options: { debugBundle?: string; yes?: boolean } = action.opts();
    if (!options.debugBundle) return;
    await preflightDebugBundle(process.cwd(), options.debugBundle);
    if (!options.yes) {
      if (!(stdin.isTTY && output.isTTY))
        throw new UnsafeRepositoryError(
          "Debug bundle creation requires TTY approval or --yes.",
        );
      const prompt = createInterface({ input: stdin, output });
      try {
        const answer = await prompt.question(
          `Create sanitized debug bundle ${options.debugBundle}? Type 'yes': `,
        );
        if (answer.trim().toLowerCase() !== "yes")
          throw new UnsafeRepositoryError("Debug bundle creation declined.");
      } finally {
        prompt.close();
      }
    }
    beginBundleCapture();
  });
  program.hook("postAction", async (_root, action) => {
    const options: { debugBundle?: string } = action.opts();
    if (options.debugBundle) {
      try {
        await writeDebugBundle(
          process.cwd(),
          options.debugBundle,
          action.name(),
        );
        finishBundleCapture(true);
      } catch (error) {
        finishBundleCapture(false);
        throw error;
      }
    }
  });
  return program;
}

const args = process.argv.slice(2);
const commandNames = new Set([
  "generate",
  "evidence",
  "replay",
  "validate",
  "validate-all",
  "scan",
  "doctor",
  "install-ci",
  "help",
]);
const first = args[0];
const normalizedArgs =
  first && !first.startsWith("-") && !commandNames.has(first)
    ? ["generate", ...args]
    : args;
try {
  await buildProgram().parseAsync([
    "node",
    "review-to-rule",
    ...normalizedArgs,
  ]);
} catch (error) {
  finishBundleCapture(false);
  if (
    error instanceof CommanderError &&
    new Set(["commander.helpDisplayed", "commander.version"]).has(error.code)
  ) {
    process.exitCode = 0;
  } else {
    const json = normalizedArgs.includes("--json");
    const debug = normalizedArgs.includes("--debug");
    const message = redact(
      error instanceof Error ? error.message : String(error),
    );
    const remediation =
      "Run review-to-rule --help and correct the command arguments.";
    const failure = {
      schemaVersion: 1,
      status:
        error instanceof UnsafeRepositoryError
          ? "unsafe_repository"
          : "unsupported",
      errors: [
        {
          kind: error instanceof DomainError ? error.kind : "usage",
          message,
          remediation,
        },
      ],
      ...(debug
        ? {
            debug: {
              diagnostic: error instanceof Error ? error.name : "Error",
            },
          }
        : {}),
    };
    if (json) process.stdout.write(`${JSON.stringify(failure)}\n`);
    else
      process.stderr.write(
        `Command failed: ${message}\nRemediation: ${remediation}\n`,
      );
    process.exitCode = error instanceof DomainError ? error.code : 6;
  }
}
