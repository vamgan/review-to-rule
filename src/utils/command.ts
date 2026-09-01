import { spawn } from "node:child_process";
import { ConfigurationError } from "../domain/errors.js";
import { redact } from "../security/redact.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface CommandRunner {
  run(
    binary: "git" | "gh",
    args: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<CommandResult>;
}

const allowlist = new Set(["git", "gh"]);
export class ProcessCommandRunner implements CommandRunner {
  run(
    binary: "git" | "gh",
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<CommandResult> {
    if (!allowlist.has(binary))
      throw new ConfigurationError(`Executable is not allowlisted: ${binary}`);
    return new Promise((resolve, reject) => {
      const child = spawn(binary, [...args], {
        cwd: options.cwd,
        shell: false,
        env: { ...process.env, ...options.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) =>
        reject(
          new ConfigurationError(
            `Could not execute ${binary}: ${redact(error.message)}`,
            `Install ${binary} and make it available on PATH.`,
          ),
        ),
      );
      child.once("close", (code) =>
        resolve({
          exitCode: code ?? 1,
          stdout: redact(stdout),
          stderr: redact(stderr),
        }),
      );
    });
  }
}
