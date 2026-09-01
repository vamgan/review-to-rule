import { z } from "zod";
import {
  resolveConfig,
  resolveCoreConfig,
  providerCredential,
  type ConfigOverrides,
} from "./memory-config.js";
import type { CommandRunner } from "./utils/command.js";
import { inspectContainedPathNoFollow } from "./security/path.js";

const checkSchema = z
  .object({
    name: z.string(),
    status: z.enum(["pass", "warn", "fail", "skip"]),
    diagnostic: z.string(),
    remediation: z.string().nullable(),
  })
  .strict();
export const doctorResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    status: z.enum(["success", "dependency_failed"]),
    mode: z.enum(["agent", "standalone"]),
    checks: z.array(checkSchema),
  })
  .strict();

export async function runDoctor(input: {
  runner: CommandRunner;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  config?: ConfigOverrides;
  mode?: "agent";
}) {
  const env = input.env ?? process.env;
  const mode = input.mode === "agent" ? "agent" : "standalone";
  const checks: Array<z.infer<typeof checkSchema>> = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: nodeMajor >= 24 ? "pass" : "fail",
    diagnostic: `Node ${process.versions.node}`,
    remediation: nodeMajor >= 24 ? null : "Install Node.js 24 or newer.",
  });
  try {
    const git = await input.runner.run("git", ["--version"], {
      cwd: input.cwd,
    });
    checks.push({
      name: "git",
      status: git.exitCode === 0 ? "pass" : "fail",
      diagnostic: (git.stdout || git.stderr).trim().slice(0, 300),
      remediation: git.exitCode === 0 ? null : "Install Git.",
    });
  } catch (error) {
    checks.push({
      name: "git",
      status: "fail",
      diagnostic: error instanceof Error ? error.message : String(error),
      remediation: "Install Git.",
    });
  }
  if (mode === "agent") {
    checks.push(
      {
        name: "review-provider",
        status: "skip",
        diagnostic:
          "The host agent retrieves review evidence with whatever tools it already has.",
        remediation: null,
      },
      {
        name: "model-credential",
        status: "skip",
        diagnostic:
          "The active host agent performs analysis; no separate provider configuration is required.",
        remediation: null,
      },
    );
  } else {
    try {
      const gh = await input.runner.run("gh", ["--version"], {
        cwd: input.cwd,
      });
      checks.push({
        name: "github-cli",
        status: gh.exitCode === 0 ? "pass" : "fail",
        diagnostic: (gh.stdout || gh.stderr).trim().slice(0, 300),
        remediation: gh.exitCode === 0 ? null : "Install GitHub CLI.",
      });
      const auth = await input.runner.run("gh", ["auth", "status"], {
        cwd: input.cwd,
      });
      checks.push({
        name: "github-auth",
        status: auth.exitCode === 0 ? "pass" : "fail",
        diagnostic:
          auth.exitCode === 0
            ? "GitHub CLI authentication is available."
            : "GitHub CLI authentication is unavailable.",
        remediation:
          auth.exitCode === 0
            ? null
            : "Run gh auth login only if you want the optional standalone GitHub adapter.",
      });
    } catch (error) {
      checks.push({
        name: "github-cli",
        status: "fail",
        diagnostic: error instanceof Error ? error.message : String(error),
        remediation: "Install and authenticate GitHub CLI.",
      });
    }
  }
  try {
    let outputDir: string;
    if (mode === "agent") {
      const raw = input.config ?? {};
      const config = await resolveCoreConfig(
        {
          ...(raw.config ? { config: raw.config } : {}),
          ...(raw.outputDir ? { outputDir: raw.outputDir } : {}),
          ...(raw.confidenceFloor !== undefined
            ? { confidenceFloor: raw.confidenceFloor }
            : {}),
          ...(raw.policyTarget ? { policyTarget: raw.policyTarget } : {}),
          ...(raw.agentsPath ? { agentsPath: raw.agentsPath } : {}),
          ...(raw.claudePath ? { claudePath: raw.claudePath } : {}),
        },
        { cwd: input.cwd, env },
      );
      outputDir = config.outputDir;
      checks.push({
        name: "config",
        status: "pass",
        diagnostic: `mode=agent; output=${config.outputDir}`,
        remediation: null,
      });
    } else {
      const config = await resolveConfig(input.config ?? {}, {
        cwd: input.cwd,
        env,
      });
      outputDir = config.outputDir;
      checks.push({
        name: "config",
        status: "pass",
        diagnostic: `provider=${config.provider}; model=${config.model}; output=${config.outputDir}`,
        remediation: null,
      });
      const credential = providerCredential(config.provider, env);
      checks.push({
        name: "model-credential",
        status:
          config.provider === "fake" ? "skip" : credential ? "pass" : "fail",
        diagnostic:
          config.provider === "fake"
            ? "Deterministic test provider selected."
            : credential
              ? `${config.provider} credential is present (value hidden).`
              : `${config.provider} credential is missing.`,
        remediation:
          config.provider === "fake" || credential
            ? null
            : `Set the credential required by ${config.provider}.`,
      });
    }
    const output = await inspectContainedPathNoFollow(input.cwd, outputDir);
    const outputSafe =
      output.kind !== "symlink" &&
      (!output.exists || output.kind === "directory");
    checks.push({
      name: "output-root",
      status: outputSafe ? "pass" : "fail",
      diagnostic: `${outputDir}: ${output.kind}`,
      remediation: outputSafe
        ? null
        : "Choose a contained non-symlink output directory.",
    });
  } catch (error) {
    checks.push({
      name: "config",
      status: "fail",
      diagnostic: error instanceof Error ? error.message : String(error),
      remediation:
        mode === "agent"
          ? "Validate the optional repository core settings."
          : "Select a provider for standalone generation.",
    });
  }
  const repo = await input.runner
    .run("git", ["rev-parse", "--show-toplevel"], { cwd: input.cwd })
    .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  checks.push({
    name: "repository",
    status: repo.exitCode === 0 ? "pass" : "warn",
    diagnostic:
      repo.exitCode === 0
        ? "Git repository detected."
        : "Current directory is not a Git repository.",
    remediation:
      repo.exitCode === 0 ? null : "Run from a repository or pass --repo-dir.",
  });
  return doctorResultSchema.parse({
    schemaVersion: 2,
    status: checks.some((check) => check.status === "fail")
      ? "dependency_failed"
      : "success",
    mode,
    checks,
  });
}
