import type { GenerationResult } from "../domain/schemas.js";

export function renderHuman(result: GenerationResult): string {
  const lines: string[] = [
    result.writtenFiles.length
      ? "review-to-rule committed artifact transaction"
      : "review-to-rule validated dry run",
    "",
  ];
  if (result.source) {
    lines.push(
      `Source review: ${result.source.review.body}`,
      `Repository: ${result.source.repository.owner}/${result.source.repository.name} PR #${result.source.pullRequest.number}`,
      "",
      "Bounded before evidence:",
      result.source.original.excerpt,
      "",
      "Bounded after evidence:",
      result.source.final.excerpt,
      "",
    );
  }
  if (result.enforceability)
    lines.push(
      `Enforceability: ${result.enforceability.enforceable ? "enforceable" : "refused"} (${result.enforceability.category}, confidence ${result.enforceability.confidence.toFixed(2)})`,
      `Reviewer intent: ${result.enforceability.reviewerIntent}`,
      `Rationale: ${result.enforceability.rationale}`,
      "",
    );
  if (result.rule)
    lines.push(
      `Generated rule: ${result.rule.id}`,
      result.rule.yaml.trimEnd(),
      "",
    );
  if (result.validation) {
    lines.push("Independent Semgrep validation:");
    for (const check of result.validation.checks)
      lines.push(
        `- ${check.status.toUpperCase()} ${check.name}: ${check.diagnostic}`,
      );
    lines.push("", `Normalized current matches: ${result.matches.length}`);
    for (const match of result.matches)
      lines.push(
        `- ${match.path}:${match.startLine}-${match.endLine} ${match.message}`,
        `  ${match.excerpt.trim()}`,
      );
    lines.push("");
  }
  if (result.plannedFiles.length) {
    lines.push(
      result.writtenFiles.length
        ? "Written artifact paths:"
        : "Planned artifact paths (not written):",
    );
    for (const path of result.plannedFiles) lines.push(`- ${path}`);
    if (result.preview) {
      lines.push(
        "",
        `Collision decision: ${result.preview.collision}`,
        `Policy target: ${result.preview.policyTarget} (explicit this invocation: ${result.preview.policyExplicit ? "yes" : "no"})`,
        `Rule scope: ${result.preview.broadness}`,
        `Existing artifact root: ${result.preview.discovery.artifactState.path} (${result.preview.discovery.artifactState.exists ? "present" : "absent"}${result.preview.discovery.artifactState.symlink ? ", symlink" : ""})`,
      );
      for (const warning of result.preview.broadnessWarnings)
        lines.push(`- Scope warning: ${warning}`);
      for (const artifact of result.preview.artifacts)
        lines.push(
          `- ${artifact.action} ${artifact.path} (${artifact.bytes} bytes, sha256 ${artifact.sha256.slice(0, 12)}): ${artifact.summary}`,
        );
      for (const manifest of result.preview.discovery.artifactState.manifests ??
        [])
        lines.push(
          `- Existing manifest ${manifest.path}: ${manifest.status}${manifest.ruleId ? `, rule ${manifest.ruleId}, ${manifest.ownedFileCount ?? 0} owned files` : ""}`,
        );
      for (const candidate of result.preview.discovery.semgrepCandidates)
        lines.push(
          `- Semgrep candidate ${candidate.path}: ${candidate.status} (${candidate.scope}) — ${candidate.diagnostic}`,
        );
      for (const policy of result.preview.discovery.policyFiles)
        lines.push(
          `- Existing ${policy.kind} policy ${policy.path}: managed ${policy.managed}, scope ${policy.scope}${policy.symlink ? ", symlink" : ""}`,
        );
      for (const ambiguity of result.preview.discovery.ambiguities)
        lines.push(`- Discovery ambiguity: ${ambiguity}`);
      for (const policy of result.preview.policyFiles)
        lines.push(
          `- Policy ${policy.action}: ${policy.path} (${policy.previousHash?.slice(0, 12) ?? "new"} -> ${policy.nextHash.slice(0, 12)})`,
          ...(policy.diff ? [policy.diff] : []),
        );
      if (!result.writtenFiles.length)
        lines.push(
          "",
          `Suggested write command: ${result.preview.suggestedWriteCommand}`,
        );
    }
    if (result.nextCommand && !result.writtenFiles.length)
      lines.push("", `Replay this successful dry run: ${result.nextCommand}`);
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  if (result.pullRequestPlan)
    lines.push(
      "",
      "Pull request plan:",
      `- Branch: ${result.pullRequestPlan.branch}`,
      `- Base: ${result.pullRequestPlan.base}`,
      `- Remote: ${result.pullRequestPlan.remote}`,
      `- Push: ${result.pullRequestPlan.pushRefspec}`,
      `- Commit: ${result.pullRequestPlan.title}`,
      `- Labels: ${result.pullRequestPlan.labels.join(", ") || "none"}`,
      ...result.pullRequestPlan.artifacts.map(
        (item) => `- ${item.action} ${item.path} (${item.sha256.slice(0, 12)})`,
      ),
      "PR body:",
      result.pullRequestPlan.body,
    );
  for (const error of result.errors)
    lines.push(
      `Error [${error.kind}]: ${error.message}`,
      `Remediation: ${error.remediation}`,
    );
  lines.push("", `Status: ${result.status}`);
  return lines.join("\n");
}
