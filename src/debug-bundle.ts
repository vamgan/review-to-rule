import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { UnsafeRepositoryError } from "./domain/errors.js";
import {
  assertSafeExactPath,
  containedPath,
  inspectContainedPathNoFollow,
} from "./security/path.js";

export const debugBundleSchema = z.object({
  schemaVersion: z.literal(1),
  command: z.string(),
  status: z.literal("sanitized"),
  diagnostics: z.array(z.string()),
});

export async function preflightDebugBundle(root: string, path: string) {
  try {
    assertSafeExactPath(path, "debug bundle path");
  } catch {
    throw new UnsafeRepositoryError(
      "Debug bundle path is unsafe or escapes its root.",
    );
  }
  const state = await inspectContainedPathNoFollow(root, path).catch(() => {
    throw new UnsafeRepositoryError(
      "Debug bundle path has an unsafe ancestor.",
    );
  });
  if (state.exists)
    throw new UnsafeRepositoryError(
      "Debug bundle path already exists; refusing to overwrite it.",
    );
}

export async function writeDebugBundle(
  root: string,
  path: string,
  command: string,
) {
  await preflightDebugBundle(root, path);
  const destination = containedPath(root, path);
  const parent = dirname(destination);
  const createdParents: string[] = [];
  let relativeParent = dirname(path);
  while (relativeParent !== ".") {
    const state = await inspectContainedPathNoFollow(root, relativeParent);
    if (state.exists) break;
    createdParents.push(containedPath(root, relativeParent));
    relativeParent = dirname(relativeParent);
  }
  await mkdir(parent, { recursive: true });
  const temp = `${destination}.tmp-${randomUUID()}`;
  const content = `${JSON.stringify(debugBundleSchema.parse({ schemaVersion: 1, command, status: "sanitized", diagnostics: ["Secrets, environment values, source, review prose, policy text, authorization headers, stacks, and home paths are intentionally excluded."] }), null, 2)}\n`;
  try {
    await writeFile(temp, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (
      process.env.NODE_ENV === "test" &&
      process.env.REVIEW_TO_RULE_TEST_DEBUG_BUNDLE_FAILURE === "after-write"
    )
      throw new Error("injected debug bundle write failure");
    const latest = await inspectContainedPathNoFollow(root, path);
    if (latest.exists)
      throw new UnsafeRepositoryError(
        "Debug bundle path changed after approval; refusing to overwrite it.",
      );
    await rename(temp, destination);
  } catch (error) {
    throw error instanceof UnsafeRepositoryError
      ? error
      : new UnsafeRepositoryError(
          `Debug bundle write failed and no bundle was committed: ${error instanceof Error ? error.message : String(error)}`,
        );
  } finally {
    await rm(temp, { force: true });
    for (const createdParent of createdParents)
      await rmdir(createdParent).catch(() => undefined);
  }
}
