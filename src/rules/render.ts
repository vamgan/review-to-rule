import type { AgentReviewRule } from "../domain/memory.js";

function inline(value: string): string {
  return value.replaceAll("`", "\\`").replace(/\s+/g, " ").trim();
}

function listItem(value: string): string {
  return value.replace(/\r?\n/g, "\n  ").trim();
}

function codeBlock(language: string, value: string): string[] {
  const runs = value.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return [
    `${fence}${language === "text" ? "" : language}`,
    value.replace(/\s+$/, ""),
    fence,
  ];
}

export function renderAgentReviewRule(
  rule: AgentReviewRule,
  sourceUrl: string,
): string {
  const lines = [
    `# ${inline(rule.title)}`,
    "",
    `- ID: \`${rule.id}\``,
    `- Priority: **${rule.priority}**`,
    `- Paths: ${rule.scope.paths.map((path) => `\`${inline(path)}\``).join(", ")}`,
    `- Languages: ${rule.scope.languages.map((language) => `\`${inline(language)}\``).join(", ")}`,
    `- Source review: <${sourceUrl}>`,
    `- Confidence: ${rule.confidence.toFixed(2)}`,
    "",
    "## Instruction",
    "",
    rule.instruction.trim(),
    "",
    "## Scope",
    "",
    rule.scope.description.trim(),
    "",
    "## Flag during review when",
    "",
    ...rule.triggers.map((trigger) => `- ${listItem(trigger)}`),
    "",
    "## Preferred review guidance",
    "",
    ...rule.guidance.map((guidance) => `- ${listItem(guidance)}`),
  ];
  if (rule.exceptions.length)
    lines.push(
      "",
      "## Exceptions",
      "",
      ...rule.exceptions.map((exception) => `- ${listItem(exception)}`),
    );
  lines.push("", "## Examples");
  for (const [index, example] of rule.examples.entries())
    lines.push(
      "",
      rule.examples.length > 1 ? `### Example ${index + 1}` : "### Flag",
      "",
      ...codeBlock(example.language, example.bad),
      "",
      rule.examples.length > 1 ? "Accepted:" : "### Accept",
      "",
      ...codeBlock(example.language, example.good),
    );
  lines.push("", "## Why this exists", "", rule.rationale.trim(), "");
  return lines.join("\n");
}

export interface RuleIndexEntry {
  id: string;
  title: string;
  priority: AgentReviewRule["priority"];
  paths: string[];
  languages: string[];
}

export function renderRuleIndex(entries: readonly RuleIndexEntry[]): string {
  const lines = [
    "# Repository review rules",
    "",
    "Before reviewing or changing code, read the rules whose declared scope matches the files involved. These are repository-specific instructions learned from accepted code review feedback.",
    "",
    "## Rules",
    "",
  ];
  if (!entries.length) lines.push("No review rules have been recorded yet.");
  else
    for (const entry of [...entries].sort((left, right) =>
      left.id.localeCompare(right.id),
    ))
      lines.push(
        `- [${inline(entry.title)}](rules/${entry.id}.md) — **${entry.priority}**; paths ${entry.paths.map((path) => `\`${inline(path)}\``).join(", ")}; languages ${entry.languages.map((language) => `\`${inline(language)}\``).join(", ")}`,
      );
  lines.push("");
  return lines.join("\n");
}
