---
name: review-to-rule-write
description: Preview and explicitly persist or publish one validated review-to-rule artifact set from a GitHub pull-request review comment. Use when the user asks to convert accepted review feedback into a repository Semgrep guardrail; do not use for general code review or arbitrary policy editing.
---

# Review to rule write

Delegate all evidence retrieval, rule generation, validation, collision handling, and writes to the built `review-to-rule` CLI. Do not reproduce its logic in the skill.

## CLI runner

Use `review-to-rule` when it is already on `PATH`. Otherwise use
`npx --yes review-to-rule@latest`; do not require or perform a global install.
Tell the user before the fallback downloads and executes the published package,
and honor any approval required by the host. Use the selected command prefix for
the complete workflow.

Before the first generation in a session, run `<rtr> doctor`. If it reports a
failed dependency, surface its remediation and stop. Never authenticate GitHub
or add model credentials on the user's behalf.

## Workflow

1. Run `<rtr> generate '<review-comment-url>'` and surface its complete preview, warnings, collision decision, policy discovery, and suggested write command.
2. Ask the user to explicitly approve writing and choose `agents`, `claude`, `both`, or `neither` for `--policy-target`. If discovery reports multiple nested policy files, also require exact `--agents-path` or `--claude-path` selections.
3. Only after approval, run the previewed arguments through `<rtr>` with `--write`, the explicit policy target, and the selected exact paths. Use `--yes` only when the user has already approved the displayed plan.
4. If the user explicitly requests a pull request, preview `<rtr> generate '<review-comment-url>' --repo-dir '<repository>' --open-pr` and obtain approval for its complete artifact, branch, commit, push, body, and label plan. Only then rerun the same arguments with `--yes`. The CLI owns isolation and recovery; never reproduce Git operations or merge the PR.
5. Surface the CLI's final written-file list, manifest path, PR URL when present, recovery state, warnings, and typed failure unchanged.
