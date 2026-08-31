import { z } from "zod";
import {
  resolveConfig,
  providerCredential,
  type ConfigOverrides,
} from "./config.js";
import type { CommandRunner } from "./utils/command.js";
import { inspectContainedPathNoFollow } from "./security/path.js";
import { normalizeGitRemote } from "./repository.js";

const checkSchema = z.object({
  name: z.string(),
  status: z.enum(["pass", "warn", "fail", "skip"]),
  diagnostic: z.string(),
  remediation: z.string().nullable(),
});
export const doctorResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["success", "dependency_failed"]),
  checks: z.array(checkSchema),
});

export async function runDoctor(input: {
  runner: CommandRunner;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  config?: ConfigOverrides;
}) {
  const env = input.env ?? process.env;
  const checks: Array<z.infer<typeof checkSchema>> = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: nodeMajor >= 24 ? "pass" : "fail",
    diagnostic: `Node ${process.versions.node}`,
    remediation: nodeMajor >= 24 ? null : "Install Node.js 24 or newer.",
  });
  for (const [name, binary, args] of [
    ["git", "git", ["--version"]],
    ["gh", "gh", ["--version"]],
    ["semgrep", "semgrep", ["--version"]],
  ] as const) {
    try {
      const result = await input.runner.run(binary, args, { cwd: input.cwd });
      checks.push({
        name,
        status: result.exitCode === 0 ? "pass" : "fail",
        diagnostic: (result.stdout || result.stderr).trim().slice(0, 300),
        remediation:
          result.exitCode === 0 ? null : `Install and configure ${name}.`,
      });
    } catch (error) {
      checks.push({
        name,
        status: "fail",
        diagnostic: error instanceof Error ? error.message : String(error),
        remediation: `Install and configure ${name}.`,
      });
    }
  }
  try {
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
        auth.exitCode === 0 ? null : "Run gh auth login or provide GH_TOKEN.",
    });
  } catch (error) {
    checks.push({
      name: "github-auth",
      status: "fail",
      diagnostic: error instanceof Error ? error.message : String(error),
      remediation: "Run gh auth login or provide GH_TOKEN.",
    });
  }
  try {
    const config = await resolveConfig(input.config ?? {}, {
      cwd: input.cwd,
      env,
    });
    checks.push({
      name: "config",
      status: "pass",
      diagnostic: `provider=${config.provider}; model=${config.model}; output=${config.outputDir}`,
      remediation: null,
    });
    try {
      const output = await inspectContainedPathNoFollow(
        input.cwd,
        config.outputDir,
      );
      checks.push({
        name: "output-root",
        status:
          output.kind === "symlink" ||
          (output.exists && output.kind !== "directory")
            ? "fail"
            : "pass",
        diagnostic: `${config.outputDir}: ${output.kind}`,
        remediation:
          output.kind === "symlink" ||
          (output.exists && output.kind !== "directory")
            ? "Choose a contained non-symlink output directory."
            : null,
      });
    } catch (error) {
      checks.push({
        name: "output-root",
        status: "fail",
        diagnostic: error instanceof Error ? error.message : String(error),
        remediation: "Choose a contained non-symlink output directory.",
      });
    }
    const credential = providerCredential(config.provider, env);
    checks.push({
      name: "provider-credential",
      status:
        config.provider === "fake" ? "skip" : credential ? "pass" : "fail",
      diagnostic:
        config.provider === "fake"
          ? "Offline fixture provider does not use credentials."
          : credential
            ? `${config.provider} credential is present (value hidden).`
            : `${config.provider} credential is missing.`,
      remediation:
        config.provider === "fake" || credential
          ? null
          : `Set the credential required by ${config.provider}.`,
    });
  } catch (error) {
    checks.push({
      name: "config",
      status: "fail",
      diagnostic: error instanceof Error ? error.message : String(error),
      remediation:
        "Select a provider and validate .review-to-rule.yml before generation.",
    });
    checks.push({
      name: "provider-credential",
      status: "skip",
      diagnostic: "Skipped because no effective provider was resolved.",
      remediation: null,
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
  if (repo.exitCode === 0) {
    const origin = await input.runner
      .run("git", ["config", "--get", "remote.origin.url"], { cwd: input.cwd })
      .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    let identity = "missing origin";
    let valid = false;
    if (origin.exitCode === 0)
      try {
        identity = normalizeGitRemote(origin.stdout);
        valid = true;
      } catch {
        identity = "unsupported origin";
      }
    checks.push({
      name: "repository-identity",
      status: valid ? "pass" : "warn",
      diagnostic: `${repo.stdout.trim()} (${identity})`,
      remediation: valid
        ? null
        : "Configure a supported GitHub origin or select the matching repository explicitly.",
    });
  }
  return doctorResultSchema.parse({
    schemaVersion: 1,
    status: checks.some((check) => check.status === "fail")
      ? "dependency_failed"
      : "success",
    checks,
  });
}
