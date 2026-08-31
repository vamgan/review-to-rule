# Implementation plan

## Objective

Turn one accepted code-review correction into one validated repository
guardrail without coupling the core to a review vendor or model provider.

The product invariant is:

```text
accepted review -> bounded evidence -> one candidate rule
                -> deterministic proof -> explicit write
```

## Architecture

The provider-neutral `ReviewLearningBundle` is the public input contract. A host
agent retrieves and reasons over review context using its existing tools. The
core validates and persists the result. The legacy GitHub plus model workflow is
retained only as an optional adapter that emits the same bundle.

Core contracts:

- `ReviewLearningBundle`: strict, versioned, bounded review/correction handoff.
- `CommandRunner`: shell-free allowlisted Git, GitHub CLI, and Semgrep process
  execution.
- `ConfirmationPort`: interactive approval isolated from application logic.
- artifact planner/transaction: collision-aware, symlink-safe, rollback-capable
  persistence.
- versioned manifest: exact ownership, hashes, validation expectations, source
  identity, and replay contract.

The deterministic core has no review-system client and no model SDK dependency
in its execution path. `apply` and `doctor --agent` never resolve provider
configuration or read model credentials.

## Delivery phases

### 1. Provider-neutral core

- Define generic `source.change`, `review`, and `snapshots` bundle fields.
- Validate bundle size, object strictness, exact paths, credential-free URLs,
  cross-field revisions, correction containment, and rule consistency.
- Map the public bundle into the versioned stored evidence representation.
- Accept non-numeric change and comment IDs for enterprise review systems.

### 2. Deterministic validation and persistence

- Parse one allowlisted Semgrep rule and reject autofix/unknown fields.
- Require syntax, before, corrected, allowed, mutation, and repository checks.
- Discover existing `.review-to-rule`, Semgrep, `AGENTS.md`, and `CLAUDE.md`
  state before planning.
- Preview all paths/diffs/collisions before journaled transactional writes.
- Replay complete artifact sets without review or model access.

### 3. Agent-first skill

- Use host tools for GitHub, GitLab, Bitbucket, Gerrit, Azure Repos, and private
  review systems.
- Use a temporary user-only bundle and run `apply` as the authority.
- Offer `AGENTS.md`, `CLAUDE.md`, both, or neither after repository discovery.
- Keep change-request publication in host tools behind a separate preview and
  approval.
- Use a PATH binary or `npx` fallback; never require a global CLI install.

### 4. Optional standalone adapters

- Preserve GitHub retrieval through bounded read-only `gh` calls.
- Preserve OpenAI and Anthropic structured-output adapters.
- Convert their result into the same bundle and call the same core.
- Keep GitHub publication isolated, allowlisted, non-force, and non-merging.

### 5. Release gate

- Typecheck, lint, formatting, unit, integration, end-to-end, evaluation, build,
  packed-package smoke, CI-bootstrap verification, demo, and dry-run pack.
- Run real Semgrep in CI even when a developer machine lacks it.
- Publish only from the protected release workflow using npm trusted publishing.

## Verification strategy

Unit tests cover bundle consistency, URL normalization, credential rejection,
strict rule shape, path safety, config separation, redaction, and typed failures.
Integration tests cover provider-neutral enterprise provenance, policy discovery,
artifact collisions, replay, rollback, and command allowlists. End-to-end tests
prove agent mode works without GitHub or model credentials and that dry runs do
not mutate repositories. Fixture evaluations retain enforceable and refusal
cases across TypeScript, JavaScript, and Python.

## Intentional limits

- Semgrep is the enforcement engine; TypeScript, JavaScript, and Python are the
  supported rule languages today.
- The host agent must be able to retrieve trustworthy review and revision
  evidence, or the user must provide it. Missing evidence is a refusal.
- A rule must express one local static invariant. Behavioral, subjective,
  architectural, ambiguous, and overly broad feedback is refused.
- The core does not infer organization policy, activate rules automatically,
  run target code, generate autofixes, publish change requests, or merge.
