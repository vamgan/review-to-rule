import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ConfigurationError } from "./domain/errors.js";
import { redact } from "./security/redact.js";
import { assertSafeExactPath } from "./security/path.js";

export const providerNameSchema = z.enum(["openai", "anthropic", "fake"]);
export type ProviderName = z.infer<typeof providerNameSchema>;
export const policyTargetSchema = z.enum([
  "agents",
  "claude",
  "both",
  "neither",
]);
export type PolicyTarget = z.infer<typeof policyTargetSchema>;

const urlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "must be an HTTP(S) URL");

export const fileConfigSchema = z
  .object({
    version: z.literal(1),
    provider: providerNameSchema.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    baseUrl: urlSchema.optional(),
    outputDir: z.string().min(1).optional(),
    confidenceFloor: z.number().min(0).max(1).optional(),
    severity: z.enum(["INFO", "WARNING", "ERROR"]).optional(),
    contextLines: z.number().int().min(1).max(20).optional(),
    matchLimit: z.number().int().min(1).max(1000).optional(),
    include: z.array(z.string().min(1)).max(100).optional(),
    exclude: z.array(z.string().min(1)).max(100).optional(),
    branchPrefix: z
      .string()
      .regex(/^[A-Za-z0-9._/-]+$/)
      .optional(),
    labels: z.array(z.string().min(1).max(100)).max(20).optional(),
    policyTarget: policyTargetSchema.optional(),
    agentsPath: z.string().min(1).optional(),
    claudePath: z.string().min(1).optional(),
  })
  .strict();
export type FileConfig = z.infer<typeof fileConfigSchema>;

export interface ConfigOverrides extends Partial<Omit<FileConfig, "version">> {
  config?: string;
  fixture?: string;
}
export interface EffectiveConfig {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  outputDir: string;
  confidenceFloor: number;
  severity: "INFO" | "WARNING" | "ERROR";
  contextLines: number;
  matchLimit: number;
  include: string[];
  exclude: string[];
  branchPrefix: string;
  labels: string[];
  policyTarget: PolicyTarget;
  agentsPath?: string;
  claudePath?: string;
  configPath?: string;
}

const defaults = {
  openai: { model: "gpt-5-mini", baseUrl: "https://api.openai.com/v1" },
  anthropic: {
    model: "claude-sonnet-4-20250514",
    baseUrl: "https://api.anthropic.com",
  },
  fake: { model: "deterministic-fixture", baseUrl: undefined },
} as const;

async function readConfig(path: string): Promise<FileConfig> {
  try {
    const text = await readFile(path, "utf8");
    return fileConfigSchema.parse(parse(text));
  } catch (error) {
    throw new ConfigurationError(
      `Invalid configuration ${path}: ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

function inferProvider(
  explicit: ProviderName | undefined,
  env: NodeJS.ProcessEnv,
  fixture: string | undefined,
): ProviderName {
  if (explicit) return providerNameSchema.parse(explicit);
  if (env.REVIEW_TO_RULE_PROVIDER)
    return providerNameSchema.parse(env.REVIEW_TO_RULE_PROVIDER);
  const openai = Boolean(env.OPENAI_API_KEY);
  const anthropic = Boolean(env.ANTHROPIC_API_KEY);
  if (openai && anthropic)
    throw new ConfigurationError(
      "Provider is ambiguous because both OpenAI and Anthropic credentials are present.",
      "Select --provider or REVIEW_TO_RULE_PROVIDER explicitly.",
    );
  if (openai) return "openai";
  if (anthropic) return "anthropic";
  if (fixture) return "fake";
  throw new ConfigurationError(
    "No provider could be selected.",
    "Set --provider and its credential, or use an explicit checked-in fixture.",
  );
}

function commaList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function environmentConfig(env: NodeJS.ProcessEnv): FileConfig {
  const numeric = (value: string | undefined) =>
    value === undefined ? undefined : Number(value);
  return fileConfigSchema.parse({
    version: 1,
    ...(env.REVIEW_TO_RULE_MODEL ? { model: env.REVIEW_TO_RULE_MODEL } : {}),
    ...(env.REVIEW_TO_RULE_BASE_URL
      ? { baseUrl: env.REVIEW_TO_RULE_BASE_URL }
      : {}),
    ...(env.REVIEW_TO_RULE_OUTPUT_DIR
      ? { outputDir: env.REVIEW_TO_RULE_OUTPUT_DIR }
      : {}),
    ...(env.REVIEW_TO_RULE_CONFIDENCE_FLOOR
      ? { confidenceFloor: numeric(env.REVIEW_TO_RULE_CONFIDENCE_FLOOR) }
      : {}),
    ...(env.REVIEW_TO_RULE_SEVERITY
      ? { severity: env.REVIEW_TO_RULE_SEVERITY }
      : {}),
    ...(env.REVIEW_TO_RULE_CONTEXT_LINES
      ? { contextLines: numeric(env.REVIEW_TO_RULE_CONTEXT_LINES) }
      : {}),
    ...(env.REVIEW_TO_RULE_MATCH_LIMIT
      ? { matchLimit: numeric(env.REVIEW_TO_RULE_MATCH_LIMIT) }
      : {}),
    ...(commaList(env.REVIEW_TO_RULE_INCLUDE)
      ? { include: commaList(env.REVIEW_TO_RULE_INCLUDE) }
      : {}),
    ...(commaList(env.REVIEW_TO_RULE_EXCLUDE)
      ? { exclude: commaList(env.REVIEW_TO_RULE_EXCLUDE) }
      : {}),
    ...(env.REVIEW_TO_RULE_BRANCH_PREFIX
      ? { branchPrefix: env.REVIEW_TO_RULE_BRANCH_PREFIX }
      : {}),
    ...(commaList(env.REVIEW_TO_RULE_LABELS)
      ? { labels: commaList(env.REVIEW_TO_RULE_LABELS) }
      : {}),
    ...(env.REVIEW_TO_RULE_POLICY_TARGET
      ? { policyTarget: env.REVIEW_TO_RULE_POLICY_TARGET }
      : {}),
    ...(env.REVIEW_TO_RULE_AGENTS_PATH
      ? { agentsPath: env.REVIEW_TO_RULE_AGENTS_PATH }
      : {}),
    ...(env.REVIEW_TO_RULE_CLAUDE_PATH
      ? { claudePath: env.REVIEW_TO_RULE_CLAUDE_PATH }
      : {}),
  });
}

export async function resolveConfig(
  cli: ConfigOverrides,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<EffectiveConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const fromEnvironment = environmentConfig(env);
  const configPath = cli.config
    ? resolve(cwd, cli.config)
    : resolve(cwd, ".review-to-rule.yml");
  let file: FileConfig | undefined;
  try {
    file = await readConfig(configPath);
  } catch (error) {
    if (cli.config) throw error;
    if (
      !(error instanceof ConfigurationError) ||
      !error.message.includes("ENOENT")
    )
      throw error;
  }
  const merged = {
    ...fromEnvironment,
    ...file,
    ...Object.fromEntries(
      Object.entries(cli).filter(([, v]) => v !== undefined),
    ),
  };
  const effective = fileConfigSchema.safeParse({
    version: 1,
    ...Object.fromEntries(
      Object.entries(merged).filter(
        ([key]) => key !== "config" && key !== "fixture" && key !== "version",
      ),
    ),
  });
  if (!effective.success)
    throw new ConfigurationError(
      `Invalid effective configuration: ${effective.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
      "Correct the named CLI, config-file, or environment field.",
    );
  for (const [field, value] of [
    ["outputDir", effective.data.outputDir],
    ["agentsPath", effective.data.agentsPath],
    ["claudePath", effective.data.claudePath],
  ] as const) {
    if (!value) continue;
    try {
      assertSafeExactPath(value, field);
    } catch {
      throw new ConfigurationError(
        `Invalid ${field}: expected a contained exact relative path without traversal, glob syntax, unsafe Unicode, drive syntax, or an absolute prefix.`,
        `Correct ${field} in the highest-precedence configuration source.`,
      );
    }
  }
  const mergedConfig = effective.data;
  const provider = inferProvider(mergedConfig.provider, env, cli.fixture);
  if (provider === "fake" && !cli.fixture)
    throw new ConfigurationError(
      "The fake provider is only available with an explicit fixture.",
    );
  const model = mergedConfig.model ?? defaults[provider].model;
  if (
    (provider === "openai" && /^claude-/i.test(model)) ||
    (provider === "anthropic" && /^(?:gpt-|o[134](?:-|$))/i.test(model))
  )
    throw new ConfigurationError(
      `Model ${model} is incompatible with provider ${provider}.`,
      "Select a model issued by the configured provider.",
    );
  const envBase =
    provider === "openai"
      ? env.OPENAI_BASE_URL
      : provider === "anthropic"
        ? env.ANTHROPIC_BASE_URL
        : undefined;
  const baseUrl =
    cli.baseUrl ??
    file?.baseUrl ??
    envBase ??
    fromEnvironment.baseUrl ??
    defaults[provider].baseUrl;
  return {
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    outputDir: mergedConfig.outputDir ?? ".review-to-rule",
    confidenceFloor: mergedConfig.confidenceFloor ?? 0.8,
    severity: mergedConfig.severity ?? "WARNING",
    contextLines: mergedConfig.contextLines ?? 3,
    matchLimit: mergedConfig.matchLimit ?? 200,
    include: mergedConfig.include ?? [],
    exclude: mergedConfig.exclude ?? [],
    branchPrefix: mergedConfig.branchPrefix ?? "review-to-rule/",
    labels: mergedConfig.labels ?? [],
    policyTarget: mergedConfig.policyTarget ?? "neither",
    ...(mergedConfig.agentsPath ? { agentsPath: mergedConfig.agentsPath } : {}),
    ...(mergedConfig.claudePath ? { claudePath: mergedConfig.claudePath } : {}),
    ...(file ? { configPath } : {}),
  };
}

export function providerCredential(
  provider: ProviderName,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return provider === "openai"
    ? env.OPENAI_API_KEY
    : provider === "anthropic"
      ? env.ANTHROPIC_API_KEY
      : undefined;
}
