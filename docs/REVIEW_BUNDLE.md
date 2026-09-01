# Review memory bundle

The versioned review-memory bundle is the provider-neutral boundary between
review understanding and durable repository context.

The producer can be Codex, Claude Code, another coding agent, an internal bot,
or the optional standalone GitHub adapter. The consumer is always the same
`apply` core. That separation lets enterprises use their existing access to
GitLab, Bitbucket, Gerrit, Azure Repos, or private systems without teaching the
core how to authenticate to each one.

## Contract

A version-2 bundle records:

- `source`: review system, credential-free review URL, repository identity, and
  generic change revisions/state;
- `review`: accepted comment/thread content, resolution state, and location;
- `snapshots`: bounded reviewed-before and accepted-after excerpts;
- `correction`: one exact local before/after change;
- `applicability`: whether the accepted intent is concrete and reusable, plus
  category, rationale, limitations, and confidence;
- `rule`: either one scoped agent-readable rule or `null` for a refusal;
- `provenance` and `warnings`: how evidence was obtained and any caveats.

Objects are strict, the complete file is limited to 128 KB, excerpts are
individually bounded, and source paths must be exact portable
repository-relative paths. URLs with embedded credentials are rejected. The
base/head revisions must match the snapshots, correction text must occur in
those snapshots, and the rule scope must cover the correction path and language.

See the complete checked-in
[GitLab agent-memory example](../examples/review-bundle/gitlab-agent-memory.json).

## Lifecycle

```bash
# 1. Inspect local prerequisites; no GitHub or model credentials are checked.
npx review-to-rule@latest doctor --mode agent --repo-dir .

# 2. Validate evidence, scope, and repository state. Writes nothing.
npx review-to-rule@latest apply /secure/tmp/review-bundle.json --repo-dir .

# 3. After reviewing the exact policy target and plan.
npx review-to-rule@latest apply /secure/tmp/review-bundle.json \
  --repo-dir . \
  --policy-target agents \
  --write \
  --yes
```

The temporary bundle is transport, not repository state. Delete it after the
run. The validated Markdown rule, bounded evidence, shared index, and replay
manifest live in `.review-to-rule/`.

## Trust model

A valid bundle is not automatically a valid rule. `apply` reparses every strict
object, permits exactly one rule, checks accepted example anchoring, source
identity, credential boundaries, path/language scope, collision ownership,
instruction-file ambiguity, and shared-index output before producing a write
plan. A dry run is therefore the first authoritative result.
