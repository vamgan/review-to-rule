import type { Language } from "../domain/evidence.js";

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
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".tf": "terraform",
  ".md": "markdown",
};

export function detectLanguage(path: string): Language {
  const dot = path.lastIndexOf(".");
  const extension = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  const inferred = extension
    .slice(1)
    .replace(/[^a-z0-9+#._-]/gi, "")
    .slice(0, 40);
  return extensions[extension] ?? (inferred || "text");
}

export function validateRenameLanguage(
  beforePath: string,
  afterPath: string,
): Language {
  detectLanguage(beforePath);
  return detectLanguage(afterPath);
}
