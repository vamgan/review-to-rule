import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ConfigurationError } from "./domain/errors.js";
import { redact } from "./security/redact.js";
import { assertSafeExactPath } from "./security/path.js";

export const policyTargetSchema = z.enum([
  "agents",
  "claude",
  "both",
  "neither",
]);
export type PolicyTarget = z.infer<typeof policyTargetSchema>;

export interface CoreConfigOverrides {
  config?: string;
  outputDir?: string;
  confidenceFloor?: number;
  policyTarget?: PolicyTarget;
  agentsPath?: string;
  claudePath?: string;
}

export interface CoreConfig {
  outputDir: string;
  confidenceFloor: number;
  policyTarget: PolicyTarget;
  agentsPath?: string;
  claudePath?: string;
  configPath?: string;
}

const coreFileConfigSchema = z
  .object({
    version: z.literal(2),
    outputDir: z.string().min(1).optional(),
    confidenceFloor: z.number().min(0).max(1).optional(),
    policyTarget: policyTargetSchema.optional(),
    agentsPath: z.string().min(1).optional(),
    claudePath: z.string().min(1).optional(),
  })
  .strict();
type CoreFileConfig = z.infer<typeof coreFileConfigSchema>;

const coreEnvelopeSchema = coreFileConfigSchema
  .extend({
    provider: z.unknown().optional(),
    model: z.unknown().optional(),
    baseUrl: z.unknown().optional(),
    contextLines: z.unknown().optional(),
    branchPrefix: z.unknown().optional(),
    labels: z.unknown().optional(),
  })
  .strict();

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

async function loadCoreConfig(path: string): Promise<CoreFileConfig> {
  try {
    const envelope = coreEnvelopeSchema.parse(
      parse(await readFile(path, "utf8")),
    );
    return coreFileConfigSchema.parse({
      version: envelope.version,
      ...(envelope.outputDir ? { outputDir: envelope.outputDir } : {}),
      ...(envelope.confidenceFloor !== undefined
        ? { confidenceFloor: envelope.confidenceFloor }
        : {}),
      ...(envelope.policyTarget ? { policyTarget: envelope.policyTarget } : {}),
      ...(envelope.agentsPath ? { agentsPath: envelope.agentsPath } : {}),
      ...(envelope.claudePath ? { claudePath: envelope.claudePath } : {}),
    });
  } catch (error) {
    throw new ConfigurationError(
      `Invalid core configuration ${path}: ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

async function optionalCoreConfig(input: {
  path: string;
  explicit: boolean;
}): Promise<CoreFileConfig | undefined> {
  try {
    return await loadCoreConfig(input.path);
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

function environmentConfig(env: NodeJS.ProcessEnv) {
  return {
    ...(env.REVIEW_TO_RULE_OUTPUT_DIR
      ? { outputDir: env.REVIEW_TO_RULE_OUTPUT_DIR }
      : {}),
    ...(env.REVIEW_TO_RULE_CONFIDENCE_FLOOR
      ? { confidenceFloor: Number(env.REVIEW_TO_RULE_CONFIDENCE_FLOOR) }
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

export async function resolveCoreConfig(
  cli: CoreConfigOverrides,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CoreConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configPath = resolve(cwd, cli.config ?? ".review-to-rule.yml");
  const file = await optionalCoreConfig({
    path: configPath,
    explicit: Boolean(cli.config),
  });
  const merged = {
    ...environmentConfig(env),
    ...file,
    ...Object.fromEntries(
      Object.entries(cli).filter(
        ([key, value]) => key !== "config" && value !== undefined,
      ),
    ),
  };
  const effective: CoreConfig = {
    outputDir: merged.outputDir ?? ".review-to-rule",
    confidenceFloor: merged.confidenceFloor ?? 0.8,
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
