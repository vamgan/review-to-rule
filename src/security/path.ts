import { isAbsolute, relative, resolve, sep } from "node:path";
import { lstat } from "node:fs/promises";
import { ConfigurationError, UnsafeRepositoryError } from "../domain/errors.js";

const unsafeUnicode = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const globSyntax = /[*?[\]{}]/;

export function assertSafeExactPath(value: string, label = "path"): string {
  const normalized = value.normalize("NFC");
  if (
    normalized !== value ||
    value.length === 0 ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    unsafeUnicode.test(value) ||
    globSyntax.test(value) ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new ConfigurationError(
      `Unsafe exact ${label}: ${JSON.stringify(value)}`,
    );
  return value;
}

export function containedPath(root: string, child: string): string {
  assertSafeExactPath(child);
  const absoluteRoot = resolve(root);
  const absoluteChild = resolve(absoluteRoot, child);
  const rel = relative(absoluteRoot, absoluteChild);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new UnsafeRepositoryError(`Path escapes repository: ${child}`);
  return absoluteChild;
}

export interface NoFollowPathState {
  exists: boolean;
  kind: "missing" | "file" | "directory" | "symlink" | "other";
  symlinkPath?: string;
  size?: number;
}

/** Inspect a contained path without ever resolving through a symlink ancestor. */
export async function inspectContainedPathNoFollow(
  root: string,
  child: string,
): Promise<NoFollowPathState> {
  assertSafeExactPath(child);
  const parts = child.split("/");
  for (let index = 1; index <= parts.length; index++) {
    const relativePath = parts.slice(0, index).join("/");
    let stat;
    try {
      stat = await lstat(containedPath(root, relativePath));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { exists: false, kind: "missing" };
      throw error;
    }
    if (stat.isSymbolicLink())
      return {
        exists: true,
        kind: "symlink",
        symlinkPath: relativePath,
      };
    if (index < parts.length && !stat.isDirectory())
      return { exists: true, kind: "other", size: stat.size };
    if (index === parts.length)
      return {
        exists: true,
        kind: stat.isFile()
          ? "file"
          : stat.isDirectory()
            ? "directory"
            : "other",
        size: stat.size,
      };
  }
  return { exists: false, kind: "missing" };
}

export function hasUnsafeFilenameSyntax(value: string): boolean {
  return unsafeUnicode.test(value) || globSyntax.test(value);
}
