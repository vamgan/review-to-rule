import type { GenerationResult } from "./domain/memory.js";

export function renderHuman(result: GenerationResult): string {
  const lines: string[] = [
    result.writtenFiles.length
      ? "review-to-rule wrote repository review memory"
      : "review-to-rule validated a dry run",
    "",
  ];
  if (result.source)
    lines.push(
      `Repository: ${result.source.repository.owner}/${result.source.repository.name}`,
      `Source review: ${result.source.source?.url ?? "provider-neutral bundle"}`,
      "",
    );
  if (result.applicability)
    lines.push(
      `Reusable: ${result.applicability.reusable ? "yes" : "no"} (${result.applicability.category}, confidence ${result.applicability.confidence.toFixed(2)})`,
      `Reviewer intent: ${result.applicability.reviewerIntent}`,
      `Rationale: ${result.applicability.rationale}`,
      "",
    );
  if (result.rule)
    lines.push(
      `Rule: ${result.rule.id}`,
      `Instruction: ${result.rule.instruction}`,
      `Scope: ${result.rule.scope.paths.join(", ")} (${result.rule.scope.languages.join(", ")})`,
      "",
    );
  if (result.validation) {
    lines.push("Integrity and context validation:");
    for (const check of result.validation.checks)
      lines.push(
        `- ${check.status.toUpperCase()} ${check.name}: ${check.diagnostic}`,
      );
    lines.push("");
  }
  if (result.plannedFiles.length) {
    lines.push(
      result.writtenFiles.length
        ? "Written files:"
        : "Planned files (nothing written):",
      ...result.plannedFiles.map((path) => `- ${path}`),
    );
    if (result.preview) {
      lines.push(
        "",
        `Collision: ${result.preview.collision}`,
        `Instruction target: ${result.preview.policyTarget} (explicit: ${result.preview.policyExplicit ? "yes" : "no"})`,
      );
      for (const candidate of result.preview.discovery.ruleCandidates)
        lines.push(
          `- Existing rule ${candidate.path}: ${candidate.status} — ${candidate.diagnostic}`,
        );
      for (const policy of result.preview.policyFiles)
        lines.push(
          `- Instruction ${policy.action}: ${policy.path}`,
          ...(policy.diff ? [policy.diff] : []),
        );
      for (const warning of result.preview.scopeWarnings)
        lines.push(`- Scope warning: ${warning}`);
      if (!result.writtenFiles.length)
        lines.push(
          "",
          `Write after review: ${result.preview.suggestedWriteCommand}`,
        );
    }
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  for (const error of result.errors)
    lines.push(
      `Error [${error.kind}]: ${error.message}`,
      `Remediation: ${error.remediation}`,
    );
  lines.push("", `Status: ${result.status}`);
  return lines.join("\n");
}
