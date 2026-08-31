import type { Language } from "../domain/schemas.js";
import { UnsupportedError } from "../domain/errors.js";

const extensions: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
};
export const semgrepLanguage: Record<Language, string> = {
  typescript: "typescript",
  javascript: "javascript",
  python: "python",
};

export function detectLanguage(path: string): Language {
  const dot = path.lastIndexOf(".");
  const language = extensions[path.slice(dot).toLowerCase()];
  if (!language)
    throw new UnsupportedError(
      `Unsupported or ambiguous source language for ${path}.`,
      "Choose a TypeScript, JavaScript, or Python review correction.",
    );
  return language;
}

export function validateRenameLanguage(
  beforePath: string,
  afterPath: string,
): Language {
  const before = detectLanguage(beforePath);
  const after = detectLanguage(afterPath);
  if (before !== after)
    throw new UnsupportedError(
      `Rename changes language from ${before} to ${after}.`,
      "Use a rename that preserves a supported language.",
    );
  return after;
}
