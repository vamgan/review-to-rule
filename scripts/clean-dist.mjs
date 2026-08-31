import { rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedDirectory = resolve(repositoryRoot, "dist");

if (relative(repositoryRoot, generatedDirectory) !== "dist")
  throw new Error(
    "Refusing to clean a path other than the generated dist directory.",
  );

rmSync(generatedDirectory, { recursive: true, force: true });
