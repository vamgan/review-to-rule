const secretPatterns = [
  /\b(?:sk|sk-ant|sk-ant-api\d+)-[A-Za-z0-9_-]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{12,}\b/g,
  /(authorization\s*:\s*)(?:bearer\s+)?\S+/gi,
  /\b((?:OPENAI|ANTHROPIC|GITHUB|GH|AWS|AZURE)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)[^\s,;]+/gi,
];

export function redact(input: string): string {
  return secretPatterns.reduce((value, pattern) => {
    pattern.lastIndex = 0;
    return value.replace(pattern, (_match, prefix?: string) =>
      prefix ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }, input);
}

export function boundUntrusted(
  input: string,
  max = 4000,
): { value: string; truncated: boolean } {
  return { value: input.slice(0, max), truncated: input.length > max };
}
