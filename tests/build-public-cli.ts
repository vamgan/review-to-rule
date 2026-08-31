import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = new URL("..", import.meta.url).pathname;
const lock = join(
  tmpdir(),
  `review-to-rule-build-${createHash("sha256").update(project).digest("hex").slice(0, 16)}.lock`,
);

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function buildPublicCli(): Promise<void> {
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
      try {
        const lockStat = await stat(lock);
        if (Date.now() - lockStat.mtimeMs > 300_000) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      await wait(25);
    }
  }
  try {
    execFileSync("npm", ["run", "build", "--silent"], {
      cwd: project,
      stdio: "pipe",
    });
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
