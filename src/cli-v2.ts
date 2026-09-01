#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stderr as promptOutput } from "node:process";
import { resolve } from "node:path";
import {
  resolveConfig,
  resolveCoreConfig,
  providerCredential,
} from "./memory-config.js";
import { FakeMemoryProvider } from "./agent-rule-provider.js";
import { AnthropicProvider, OpenAIProvider } from "./agent-rule-adapters.js";
import { generate } from "./memory-pipeline.js";
import {
  applyReviewMemoryBundle,
  errorOutcome,
  type ConfirmationPort,
} from "./memory-core.js";
import { loadReviewMemoryBundle } from "./review-memory-bundle.js";
import { renderHuman } from "./memory-render.js";
import { ProcessCommandRunner } from "./utils/command.js";
import {
  ConfigurationError,
  DomainError,
  UnsafeRepositoryError,
  ValidationError,
} from "./domain/errors.js";
import { redact } from "./security/redact.js";
import { replayMemoryManifest } from "./memory-replay.js";
import {
  validateAllMemory,
  validateMemoryArtifact,
} from "./memory-validation.js";
import { runDoctor } from "./memory-doctor.js";
import { collectReviewEvidence } from "./evidence.js";
import { installCi, planCiInstall } from "./install-ci.js";
import { GENERATOR_VERSION } from "./version.js";

interface CommonOptions {
  repoDir?: string;
  outputDir?: string;
  config?: string;
  json?: boolean;
  debug?: boolean;
  yes?: boolean;
  write?: boolean;
  policyTarget?: "agents" | "claude" | "both" | "neither";
  agentsPath?: string;
  claudePath?: string;
}

const runner = new ProcessCommandRunner();

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function confirmationPort(): ConfirmationPort {
  return {
    isTTY: stdin.isTTY && promptOutput.isTTY,
    confirm: async (summary: string) => {
      const prompt = createInterface({ input: stdin, output: promptOutput });
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
}

function emitGeneration(
  outcome: ReturnType<typeof errorOutcome>,
  options: { json?: boolean },
) {
  process.stdout.write(
    options.json
      ? `${JSON.stringify(outcome.result)}\n`
      : `${renderHuman(outcome.result)}\n`,
  );
  process.exitCode = outcome.exitCode;
}

function asDomain(error: unknown): DomainError {
  return error instanceof DomainError
    ? error
    : new ValidationError(
        redact(error instanceof Error ? error.message : String(error)),
      );
}

function emitFailure(
  options: { json?: boolean; debug?: boolean },
  error: unknown,
  operation: string,
) {
  const domain = asDomain(error);
  const result = {
    schemaVersion: 2,
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
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else
    process.stderr.write(
      `${operation} failed [${domain.kind}]: ${domain.message}\nRemediation: ${domain.remediation}\n`,
    );
  process.exitCode = domain.code;
}

function addCoreOptions(command: Command): Command {
  return command
    .option("--repo-dir <path>", "target repository directory")
    .option("--output-dir <path>", "review-memory output directory")
    .option("--config <path>", "optional version-2 configuration file")
    .option("--write", "transactionally write after preview")
    .option("--yes", "approve the preview non-interactively")
    .option("--json", "emit one schema-versioned JSON object")
    .option("--debug", "show sanitized diagnostics")
    .addOption(
      new Option(
        "--policy-target <target>",
        "managed instruction pointer target",
      ).choices(["agents", "claude", "both", "neither"]),
    )
    .option("--agents-path <path>", "exact AGENTS.md path")
    .option("--claude-path <path>", "exact CLAUDE.md path");
}

async function coreConfig(options: CommonOptions, cwd: string) {
  return resolveCoreConfig(
    {
      ...(options.outputDir ? { outputDir: options.outputDir } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.policyTarget ? { policyTarget: options.policyTarget } : {}),
      ...(options.agentsPath ? { agentsPath: options.agentsPath } : {}),
      ...(options.claudePath ? { claudePath: options.claudePath } : {}),
    },
    { cwd },
  );
}

export function buildProgram(): Command {
  const program = new Command()
    .name("review-to-rule")
    .description(
      "Turn accepted code-review feedback into durable repository memory for coding agents.",
    )
    .version(GENERATOR_VERSION)
    .exitOverride()
    .configureOutput({ writeErr: () => undefined });

  addCoreOptions(
    program
      .command("apply")
      .description(
        "validate and optionally write a provider-neutral review-memory bundle",
      )
      .argument("<bundle-path>", "version-2 review-memory bundle JSON")
      .option("--allow-open-review", "permit an unmerged code review")
      .option("--allow-unresolved", "permit an unresolved review thread"),
  ).action(
    async (
      bundlePath: string,
      options: CommonOptions & {
        allowOpenReview?: boolean;
        allowUnresolved?: boolean;
      },
      command: Command,
    ) => {
      const repositoryDir = resolve(options.repoDir ?? process.cwd());
      try {
        const [bundle, config] = await Promise.all([
          loadReviewMemoryBundle(resolve(bundlePath)),
          coreConfig(options, repositoryDir),
        ]);
        const invocation = [
          "review-to-rule apply",
          shellQuote(resolve(bundlePath)),
          "--repo-dir",
          shellQuote(repositoryDir),
          ...(options.outputDir
            ? ["--output-dir", shellQuote(options.outputDir)]
            : []),
          ...(options.policyTarget
            ? ["--policy-target", options.policyTarget]
            : []),
          ...(options.agentsPath
            ? ["--agents-path", shellQuote(options.agentsPath)]
            : []),
          ...(options.claudePath
            ? ["--claude-path", shellQuote(options.claudePath)]
            : []),
        ].join(" ");
        const outcome = await applyReviewMemoryBundle(bundle, {
          repositoryDir,
          repositorySource: options.repoDir
            ? "agent_explicit"
            : "agent_current",
          runner,
          ...(options.write ? { write: true } : {}),
          ...(options.yes ? { yes: true } : {}),
          outputDir: config.outputDir,
          policyTarget: config.policyTarget,
          policyTargetExplicit:
            command.getOptionValueSource("policyTarget") === "cli",
          ...(config.agentsPath ? { agentsPath: config.agentsPath } : {}),
          ...(config.claudePath ? { claudePath: config.claudePath } : {}),
          confidenceFloor: config.confidenceFloor,
          confirmation: confirmationPort(),
          providerInfo: { name: "host-agent", model: "active-context" },
          invocation,
          ...(options.allowOpenReview ? { allowOpenReview: true } : {}),
          ...(options.allowUnresolved ? { allowUnresolved: true } : {}),
        });
        emitGeneration(outcome, options);
      } catch (error) {
        emitGeneration(errorOutcome(asDomain(error)), options);
      }
    },
  );

  addCoreOptions(
    program
      .command("generate")
      .description(
        "optional standalone GitHub adapter: retrieve, analyze, and propose",
      )
      .argument("<review-comment-url>", "GitHub review-comment URL")
      .option("--provider <name>", "openai or anthropic")
      .option("--model <id>", "provider model")
      .option("--allow-open-pr", "permit an unmerged pull request")
      .option("--allow-unresolved", "permit an unresolved review thread")
      .option("--allow-unmapped", "permit incomplete GitHub mapping"),
  ).action(
    async (
      reviewUrl: string,
      options: CommonOptions & {
        provider?: "openai" | "anthropic" | "fake";
        model?: string;
        allowOpenPr?: boolean;
        allowUnresolved?: boolean;
        allowUnmapped?: boolean;
      },
      command: Command,
    ) => {
      const commandDirectory = process.cwd();
      const configuredRepositoryDir = options.repoDir
        ? resolve(options.repoDir)
        : undefined;
      try {
        const config = await resolveConfig(
          {
            ...(options.provider ? { provider: options.provider } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.outputDir ? { outputDir: options.outputDir } : {}),
            ...(options.config ? { config: options.config } : {}),
            ...(options.policyTarget
              ? { policyTarget: options.policyTarget }
              : {}),
            ...(options.agentsPath ? { agentsPath: options.agentsPath } : {}),
            ...(options.claudePath ? { claudePath: options.claudePath } : {}),
          },
          { cwd: configuredRepositoryDir ?? commandDirectory },
        );
        const credential = providerCredential(config.provider, process.env);
        const provider =
          config.provider === "fake"
            ? new FakeMemoryProvider()
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
        const outcome = await generate(reviewUrl, {
          ...(configuredRepositoryDir
            ? { repositoryDir: configuredRepositoryDir }
            : {}),
          provider,
          runner,
          ...(options.write ? { write: true } : {}),
          ...(options.yes ? { yes: true } : {}),
          outputDir: config.outputDir,
          confidenceFloor: config.confidenceFloor,
          contextLines: config.contextLines,
          policyTarget: config.policyTarget,
          policyTargetExplicit:
            command.getOptionValueSource("policyTarget") === "cli",
          ...(config.agentsPath ? { agentsPath: config.agentsPath } : {}),
          ...(config.claudePath ? { claudePath: config.claudePath } : {}),
          ...(options.allowOpenPr ? { allowOpenPr: true } : {}),
          ...(options.allowUnresolved ? { allowUnresolved: true } : {}),
          ...(options.allowUnmapped ? { allowUnmapped: true } : {}),
          providerInfo: { name: config.provider, model: config.model },
          confirmation: confirmationPort(),
        });
        emitGeneration(outcome, options);
      } catch (error) {
        emitGeneration(errorOutcome(asDomain(error)), options);
      }
    },
  );

  program
    .command("evidence")
    .description("optional GitHub adapter: inspect mapped review evidence")
    .argument("<review-comment-url>", "GitHub review-comment URL")
    .option("--json", "emit JSON")
    .option("--allow-open-pr")
    .option("--allow-unresolved")
    .option("--allow-unmapped")
    .action(async (reviewUrl: string, options: Record<string, boolean>) => {
      try {
        const result = await collectReviewEvidence({
          reviewUrl,
          runner,
          ...(options.allowOpenPr ? { allowOpenPr: true } : {}),
          ...(options.allowUnresolved ? { allowUnresolved: true } : {}),
          ...(options.allowUnmapped ? { allowUnmapped: true } : {}),
        });
        process.stdout.write(
          options.json
            ? `${JSON.stringify(result)}\n`
            : `Collected ${result.repository.owner}/${result.repository.name} review ${result.review.id}.\n`,
        );
        process.exitCode = 0;
      } catch (error) {
        emitFailure(options, error, "Evidence collection");
      }
    });

  program
    .command("validate")
    .description("validate one review-memory manifest or Markdown rule")
    .argument("<path>", "manifest JSON or generated Markdown rule")
    .option("--repo-dir <path>")
    .option("--output-dir <path>")
    .option("--json")
    .action(
      async (
        inputPath: string,
        options: { repoDir?: string; outputDir?: string; json?: boolean },
      ) => {
        try {
          const result = await validateMemoryArtifact({
            repositoryDir: resolve(options.repoDir ?? process.cwd()),
            inputPath,
            ...(options.outputDir ? { outputDir: options.outputDir } : {}),
          });
          process.stdout.write(
            options.json
              ? `${JSON.stringify(result)}\n`
              : `Validated ${result.rulePath} (${result.verifiedFiles.length} files).\n`,
          );
          process.exitCode = 0;
        } catch (error) {
          emitFailure(options, error, "Validation");
        }
      },
    );

  program
    .command("validate-all")
    .description("validate the complete repository review-memory index")
    .argument("[output-dir]", "review-memory directory", ".review-to-rule")
    .option("--repo-dir <path>")
    .option("--json")
    .action(
      async (
        outputDir: string,
        options: { repoDir?: string; json?: boolean },
      ) => {
        try {
          const result = await validateAllMemory({
            repositoryDir: resolve(options.repoDir ?? process.cwd()),
            outputDir,
          });
          process.stdout.write(
            options.json
              ? `${JSON.stringify(result)}\n`
              : `${result.status}: ${result.items.length} manifest(s), ${result.errors.length} error(s).\n`,
          );
          process.exitCode = result.status === "success" ? 0 : 3;
        } catch (error) {
          emitFailure(options, error, "Validation");
        }
      },
    );

  program
    .command("replay")
    .description("replay integrity checks from one manifest")
    .argument("<manifest-path>")
    .option("--repo-dir <path>")
    .option("--json")
    .action(
      async (
        manifestPath: string,
        options: { repoDir?: string; json?: boolean },
      ) => {
        try {
          const result = await replayMemoryManifest({
            repositoryDir: resolve(options.repoDir ?? process.cwd()),
            manifestPath,
          });
          process.stdout.write(
            options.json
              ? `${JSON.stringify(result)}\n`
              : `Replay passed: ${result.rulePath}.\n`,
          );
          process.exitCode = 0;
        } catch (error) {
          emitFailure(options, error, "Replay");
        }
      },
    );

  program
    .command("doctor")
    .description("check prerequisites; agent mode is the default")
    .addOption(
      new Option("--mode <mode>", "agent or standalone")
        .choices(["agent", "standalone"])
        .default("agent"),
    )
    .option("--repo-dir <path>")
    .option("--config <path>")
    .option("--json")
    .action(
      async (options: {
        mode: "agent" | "standalone";
        repoDir?: string;
        config?: string;
        json?: boolean;
      }) => {
        try {
          const result = await runDoctor({
            runner,
            cwd: resolve(options.repoDir ?? process.cwd()),
            ...(options.config ? { config: { config: options.config } } : {}),
            ...(options.mode === "agent" ? { mode: "agent" as const } : {}),
          });
          process.stdout.write(
            options.json
              ? `${JSON.stringify(result)}\n`
              : [
                  ...result.checks.map(
                    (check) =>
                      `${check.status.toUpperCase()} ${check.name}: ${check.diagnostic}`,
                  ),
                  `Status: ${result.status}`,
                ].join("\n") + "\n",
          );
          process.exitCode = result.status === "success" ? 0 : 4;
        } catch (error) {
          emitFailure(options, error, "Doctor");
        }
      },
    );

  program
    .command("install-ci")
    .description("install integrity validation for checked-in review memory")
    .option("--repo-dir <path>")
    .option("--write")
    .option("--yes")
    .option("--json")
    .action(
      async (options: {
        repoDir?: string;
        write?: boolean;
        yes?: boolean;
        json?: boolean;
      }) => {
        const repositoryDir = resolve(options.repoDir ?? process.cwd());
        try {
          const plan = await planCiInstall(repositoryDir, runner);
          let result = plan;
          if (options.write) {
            const confirmation = confirmationPort();
            const confirmed =
              options.yes === true ||
              (confirmation.isTTY &&
                (await confirmation.confirm(plan.preview)));
            if (!confirmed)
              throw new UnsafeRepositoryError(
                "CI installation requires preview approval.",
              );
            result = await installCi(repositoryDir, plan, runner);
          }
          process.stdout.write(
            options.json
              ? `${JSON.stringify(result)}\n`
              : `${result.action.toUpperCase()} ${result.path}${result.written ? " (written)" : ""}\n`,
          );
          process.exitCode = 0;
        } catch (error) {
          emitFailure(options, error, "CI installation");
        }
      },
    );
  return program;
}

const args = process.argv.slice(2);
const commandNames = new Set([
  "apply",
  "generate",
  "evidence",
  "validate",
  "validate-all",
  "replay",
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
  if (
    error instanceof CommanderError &&
    new Set(["commander.helpDisplayed", "commander.version"]).has(error.code)
  )
    process.exitCode = 0;
  else {
    const domain =
      error instanceof DomainError
        ? error
        : new ConfigurationError(
            redact(error instanceof Error ? error.message : String(error)),
          );
    emitFailure({ json: normalizedArgs.includes("--json") }, domain, "Command");
  }
}
