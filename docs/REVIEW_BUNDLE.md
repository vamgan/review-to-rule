# Review learning bundle

The versioned review learning bundle is the provider-neutral boundary between
review understanding and deterministic enforcement.

The producer can be Codex, Claude Code, another coding agent, an internal bot,
or the optional standalone GitHub adapter. The consumer is always the same
`apply` core. That separation lets enterprises use their existing access to
GitLab, Bitbucket, Gerrit, Azure Repos, or private systems without teaching the
core how to authenticate to each one.

## Contract

A version-1 bundle records:

- `source`: review system, credential-free review URL, repository identity, and
  generic change revisions/state;
- `review`: accepted comment/thread content, resolution state, and location;
- `snapshots`: bounded reviewed-before and accepted-after excerpts;
- `correction`: one exact local before/after change;
- `enforceability`: the static-local decision, rationale, limitations, and
  confidence;
- `rule`: either one structured Semgrep proposal or `null` for a refusal;
- `fixtures`: parseable before/after and optional allowed examples;
- `provenance` and `warnings`: how evidence was obtained and any caveats.

Objects are strict, the complete file is limited to 128 KB, excerpts are
individually bounded, and source paths must be exact portable
repository-relative paths. URLs with embedded credentials are rejected. The
base/head revisions must match the snapshots, correction text must occur in
those snapshots and fixtures, and the rule language must match the correction.

See the complete checked-in
[GitLab tenant-scope example](../examples/review-bundle/gitlab-tenant-scope.json).

## Lifecycle

```bash
# 1. Inspect local prerequisites; no GitHub or model credentials are checked.
npx review-to-rule@latest doctor --agent --repo-dir .

# 2. Validate, scan, discover policy files, and preview. Writes nothing.
npx review-to-rule@latest apply /secure/tmp/review-bundle.json --repo-dir .

# 3. After reviewing the exact policy target and plan.
npx review-to-rule@latest apply /secure/tmp/review-bundle.json \
  --repo-dir . \
  --policy-target agents \
  --write \
  --yes
```

The temporary bundle is transport, not repository state. Delete it after the
run. The validated rule, bounded evidence, fixtures, and replay manifest live in
`.review-to-rule/`.

## Trust model

A valid bundle is not automatically a valid rule. `apply` reparses the embedded
YAML, permits exactly one rule and one allowlisted pattern operator, checks all
structured/YAML fields agree, executes real Semgrep against the fixtures and
mutations, scans the repository, and only then produces a write plan. A dry run
is therefore the first authoritative result.
