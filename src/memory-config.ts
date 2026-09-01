import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ConfigurationError } from "./domain/errors.js";
import { policyTargetSchema, type PolicyTarget } from "./memory-core-config.js";
import { redact } from "./security/redact.js";
import { assertSafeExactPath } from "./security/path.js";

export { policyTargetSchema, resolveCoreConfig } from "./memory-core-config.js";
export type {
  CoreConfig,
  CoreConfigOverrides,
  PolicyTarget,
} from "./memory-core-config.js";

export const providerNameSchema = z.enum(["openai", "anthropic", "fake"]);
export type ProviderName = z.infer<typeof providerNameSchema>;

const urlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "must be an HTTP(S) URL");

export const fileConfigSchema = z
  .object({
    version: z.literal(2),
    provider: providerNameSchema.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    baseUrl: urlSchema.optional(),
    outputDir: z.string().min(1).optional(),
    confidenceFloor: z.number().min(0).max(1).optional(),
    contextLines: z.number().int().min(1).max(20).optional(),
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
}
export interface EffectiveConfig {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  outputDir: string;
  confidenceFloor: number;
  contextLines: number;
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

function validatePaths(input: {
  outputDir?: string;
  agentsPath?: string;
  claudePath?: string;
}) {
  for (const [field, value] of Object.entries(input)) {
    if (!value) continue;
    try {
      assertSafeExactPath(value, field);
    } catch {
      throw new ConfigurationError(
        `Invalid ${field}: expected a contained exact repository-relative path.`,
      );
    }
  }
}

async function loadConfig(path: string): Promise<FileConfig> {
  try {
    return fileConfigSchema.parse(parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new ConfigurationError(
      `Invalid configuration ${path}: ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

async function optionalConfig<T>(input: {
  path: string;
  explicit: boolean;
  read(path: string): Promise<T>;
}): Promise<T | undefined> {
  try {
    return await input.read(input.path);
  } catch (error) {
    if (input.explicit) throw error;
    if (
      error instanceof ConfigurationError &&
      /ENOENT|no such file/i.test(error.message)
    )
      return undefined;
    throw error;
  }
}

function inferProvider(
  explicit: ProviderName | undefined,
  env: NodeJS.ProcessEnv,
): ProviderName {
  if (explicit) return providerNameSchema.parse(explicit);
  if (env.REVIEW_TO_RULE_PROVIDER)
    return providerNameSchema.parse(env.REVIEW_TO_RULE_PROVIDER);
  const openai = Boolean(env.OPENAI_API_KEY);
  const anthropic = Boolean(env.ANTHROPIC_API_KEY);
  if (openai && anthropic)
    throw new ConfigurationError(
      "Provider is ambiguous because both OpenAI and Anthropic credentials are present.",
      "Select --provider for standalone generation. Agent-mode apply needs no provider.",
    );
  if (openai) return "openai";
  if (anthropic) return "anthropic";
  throw new ConfigurationError(
    "No standalone provider could be selected.",
    "Set --provider and its credential, or use the agent skill and apply a provider-neutral bundle.",
  );
}

function envConfig(env: NodeJS.ProcessEnv): Partial<FileConfig> {
  return {
    ...(env.REVIEW_TO_RULE_PROVIDER
      ? { provider: providerNameSchema.parse(env.REVIEW_TO_RULE_PROVIDER) }
      : {}),
    ...(env.REVIEW_TO_RULE_MODEL ? { model: env.REVIEW_TO_RULE_MODEL } : {}),
    ...(env.REVIEW_TO_RULE_BASE_URL
      ? { baseUrl: urlSchema.parse(env.REVIEW_TO_RULE_BASE_URL) }
      : {}),
    ...(env.REVIEW_TO_RULE_OUTPUT_DIR
      ? { outputDir: env.REVIEW_TO_RULE_OUTPUT_DIR }
      : {}),
    ...(env.REVIEW_TO_RULE_CONFIDENCE_FLOOR
      ? { confidenceFloor: Number(env.REVIEW_TO_RULE_CONFIDENCE_FLOOR) }
      : {}),
    ...(env.REVIEW_TO_RULE_CONTEXT_LINES
      ? { contextLines: Number(env.REVIEW_TO_RULE_CONTEXT_LINES) }
      : {}),
    ...(env.REVIEW_TO_RULE_BRANCH_PREFIX
      ? { branchPrefix: env.REVIEW_TO_RULE_BRANCH_PREFIX }
      : {}),
    ...(env.REVIEW_TO_RULE_LABELS
      ? {
          labels: env.REVIEW_TO_RULE_LABELS.split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        }
      : {}),
    ...(env.REVIEW_TO_RULE_POLICY_TARGET
      ? {
          policyTarget: policyTargetSchema.parse(
            env.REVIEW_TO_RULE_POLICY_TARGET,
          ),
        }
      : {}),
    ...(env.REVIEW_TO_RULE_AGENTS_PATH
      ? { agentsPath: env.REVIEW_TO_RULE_AGENTS_PATH }
      : {}),
    ...(env.REVIEW_TO_RULE_CLAUDE_PATH
      ? { claudePath: env.REVIEW_TO_RULE_CLAUDE_PATH }
      : {}),
  };
}

export async function resolveConfig(
  cli: ConfigOverrides,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<EffectiveConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configPath = resolve(cwd, cli.config ?? ".review-to-rule.yml");
  const file = await optionalConfig({
    path: configPath,
    explicit: Boolean(cli.config),
    read: loadConfig,
  });
  const merged = {
    ...envConfig(env),
    ...file,
    ...Object.fromEntries(
      Object.entries(cli).filter(
        ([key, value]) => key !== "config" && value !== undefined,
      ),
    ),
  };
  const provider = inferProvider(merged.provider, env);
  const selectedBaseUrl = merged.baseUrl ?? defaults[provider].baseUrl;
  const effective: EffectiveConfig = {
    provider,
    model: merged.model ?? defaults[provider].model,
    ...(selectedBaseUrl ? { baseUrl: selectedBaseUrl } : {}),
    outputDir: merged.outputDir ?? ".review-to-rule",
    confidenceFloor: merged.confidenceFloor ?? 0.8,
    contextLines: merged.contextLines ?? 3,
    branchPrefix: merged.branchPrefix ?? "review-to-rule/",
    labels: merged.labels ?? ["review-memory"],
    policyTarget: merged.policyTarget ?? "neither",
    ...(merged.agentsPath ? { agentsPath: merged.agentsPath } : {}),
    ...(merged.claudePath ? { claudePath: merged.claudePath } : {}),
    ...(file ? { configPath } : {}),
  };
  validatePaths({
    outputDir: effective.outputDir,
    ...(effective.agentsPath ? { agentsPath: effective.agentsPath } : {}),
    ...(effective.claudePath ? { claudePath: effective.claudePath } : {}),
  });
  return effective;
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
