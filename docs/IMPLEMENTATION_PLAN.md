# review-to-rule Implementation Plan

## Objective

Build a release-ready, open-source Node.js CLI that turns one resolved and merged GitHub review thread into one validated Semgrep rule. The implementation must preserve the narrow product loop—review comment to tested guardrail—while making refusal, dry-run safety, provenance, and offline testability first-class behavior.

## Architecture

### Runtime shape

The product is one strict-TypeScript npm package with one executable CLI. Commander owns argument parsing only; a command service composes domain workflows through injected ports. No command handler should directly call provider SDKs, GitHub, Git, Semgrep, or the filesystem.

```text
CLI parsing and rendering
          |
          v
  application workflows
          |
  +-------+---------+-----------+-------------+
  |                 |           |             |
GitHub/Git       LLM ports   Semgrep port   persistence/PR
adapters         + fakes     + runner       safety adapters
          \          |          /             /
           +---- versioned domain schemas ----+
```

### Planned source layout

```text
src/
  cli/
    index.ts
    commands/{generate,doctor,validate,validate-all,scan,install-ci}.ts
    output/{human-renderer,json-renderer}.ts
  config/{defaults,schema,load-config}.ts
  domain/
    review-evidence.ts
    correction-candidate.ts
    enforceability.ts
    generated-rule.ts
    validation-report.ts
    result.ts
    errors.ts
  github/{parse-review-url,github-client,review-thread,pull-request,graphql}.ts
  repository/
    repository-resolver.ts
    local-repository.ts
    temporary-clone.ts
    git-client.ts
    source-reader.ts
    diff-builder.ts
  analysis/
    evidence-collector.ts
    correction-reconstructor.ts
    candidate-extractor.ts
    enforceability-classifier.ts
  llm/
    provider.ts
    provider-factory.ts
    openai-provider.ts
    anthropic-provider.ts
    fake-provider.ts
    schemas.ts
    prompts/{correction-analysis,rule-generation,rule-repair}.ts
  semgrep/
    rule-parser.ts
    rule-generator.ts
    semgrep-runner.ts
    fixture-builder.ts
    validator.ts
    repository-scanner.ts
    match-normalizer.ts
  persistence/{artifact-writer,manifest,atomic-write}.ts
  pull-request/{branch-manager,pull-request-creator,pr-body}.ts
  security/{path-safety,secret-redaction,prompt-boundaries}.ts
  utils/{logger,command-runner,temporary-directory}.ts
tests/{unit,integration,e2e,evaluation,fixtures}/
examples/injected-clock/
docs/
```

This layout may be compressed where modules stay cohesive, but the boundaries between domain logic and external effects must remain explicit.

### Core contracts

- `GithubPort`: retrieve comments, PR metadata, threads, changed files, and historical file content.
- `GitPort`: identify remotes/state, read historical files, build scoped diffs, create worktrees/branches, commit, and push through allowlisted commands.
- `StructuredLlmProvider`: analyze a correction and propose or repair one structured rule.
- `SemgrepPort`: validate syntax and return structured findings for files/repositories.
- `ArtifactStore`: inspect conflicts and atomically write contained artifact sets.
- `ConfirmationPort`: isolate interactive approval from workflows and make `--yes` testable.
- `Clock` and `TemporaryDirectoryPort`: keep manifests, filenames, and cleanup deterministic in tests.

Every external result crosses a Zod-validated boundary. Domain errors carry stable exit-code metadata but do not depend on CLI rendering.

### Data flow

1. Parse options, environment, and config into one validated effective configuration.
2. Parse the GitHub discussion URL.
3. Retrieve and reconstruct the root review thread and PR; apply merged/resolved gates.
4. Resolve a matching local repository or lifecycle-managed temporary clone.
5. Recover original and final files, handle renames, and build a bounded path diff.
6. Extract deterministic correction candidates; refuse if evidence remains ambiguous.
7. Ask the selected provider for structured intent/enforceability, treating snippets as untrusted data.
8. Refuse non-static or low-confidence feedback with exit code 2.
9. Ask for exactly one rule proposal, parse its YAML, and enforce the safe Semgrep schema.
10. Build fixtures and run syntax, before, after, alternative, mutation, and repository validations.
11. Retry generation/repair up to three total attempts using only bounded failure context.
12. Produce a renderer-neutral result. Dry run stops here without repository writes.
13. With approval, atomically write artifacts. With `--open-pr`, perform the same write inside an isolated clean Git context, commit, push, and open a PR without merging.

## Major Technical Decisions

### 1. Deterministic evidence before model inference

The LLM will never be asked to invent the before/after correction. Historical SHAs, diff hunks, scoped Git diffs, GitHub content fallback, rename metadata, and bounded similarity establish candidates first. Model analysis may disambiguate a collected candidate, but missing evidence is a refusal.

### 2. Schema-first domain boundaries

Zod schemas will define configuration, provider payloads, GitHub shapes used by the tool, Semgrep proposal structure, manifests, and JSON output. Provider SDK objects and raw `gh`/Semgrep results do not propagate into domain services.

### 3. Small injected ports instead of framework abstractions

There is no autonomous-agent framework. Narrow interfaces for GitHub, Git, LLMs, Semgrep, writes, confirmation, clock, and temporary directories are sufficient for offline tests and protect command orchestration from adapter details.

### 4. Shell-free allowlisted process execution

Execa will receive executable and argument arrays. The common command runner will allow only intended binaries in core flows, centralize timeout/error redaction, and make tests assert exact invocations. Target repository scripts and model-suggested commands are never run.

### 5. Semgrep is the final authority on rule behavior

Provider confidence cannot make a rule valid. Acceptance requires safe YAML shape, Semgrep syntax, a before match, zero corrected matches, zero allowed-alternative matches when available, bounded mutation resilience, and a normalized repository scan.

### 6. One result model, two renderers

Workflows return a versioned `GenerationResult`; human and JSON renderers consume it. Progress and diagnostics go through mode-aware output so JSON stdout remains a single clean object.

### 7. Explicit mutation boundary

The generation workflow builds an in-memory artifact plan. Persistence is a separate commit step reached only by `--write`; PR creation is a further isolated step reached only by `--open-pr` after confirmation. Atomic, contained writes and collision inspection precede mutations.

### 8. Testable PR creation in isolation

`--open-pr` will never operate in a dirty user checkout. A clean worktree is preferred when safe; otherwise a clean temporary clone is used. Push failure leaves a usable local branch when safe and prints recovery commands. The tool has no merge capability.

### 9. Fixture mode is a supported product path

The demo and evaluation suites use the same application workflow with fake GitHub and fake LLM ports, rather than a hard-coded output script. This keeps the README demonstration honest and provides deterministic offline coverage.

### 10. Centralized provider defaults and secure prompts

Model names live in one defaults module. Provider prompts share one boundary builder that labels review/code blocks as untrusted, applies truncation, and makes prompt-injection tests straightforward. Error redaction is applied before rendering or debug persistence.

## Milestones and Phases

### Phase 0: Scaffold and safety foundations

Deliverables:

- npm package metadata, active-LTS engine, strict TypeScript, executable bin.
- Commander command skeletons and root alias.
- Vitest, ESLint, Prettier, CI, Dependabot, and package scripts.
- Domain error hierarchy with stable exit codes.
- Zod config/defaults/precedence.
- Allowlisted injectable command runner, logger, redaction, safe path, and temporary-resource utilities.
- Documentation skeleton and open-source policy files.

Gate:

- Build, typecheck, lint, unit tests, CLI help/version smoke test, and published-package-style smoke test pass.
- Config precedence, exit mapping, secret redaction, and shell-free invocation tests pass.

### Phase 1: Deterministic GitHub evidence collection

Deliverables:

- Review URL parser.
- Injectable `gh api` REST/GraphQL adapter with pagination.
- PR metadata and changed-file retrieval.
- Root/reply thread reconstruction and resolved-state mapping.
- Merged/resolved policy gates and override warnings.
- Repository remote normalization/resolution and temporary clone lifecycle.
- Historical source reads, narrow SHA fetches, GitHub fallback, rename handling, scoped diff builder.
- Bounded correction candidate extraction.
- Ten required fake GitHub scenarios and temporary Git integration fixtures.

Gate:

- An entirely offline flow emits a schema-valid `ReviewEvidence` object before any LLM is introduced.
- Tests prove fallback ordering, pagination, open/unresolved rejection, reply mapping, rename behavior, unchanged-code refusal, and cleanup.

### Phase 2: Analysis and enforceability

Deliverables:

- `StructuredLlmProvider` and provider factory.
- Official OpenAI and Anthropic adapters plus configurable base URL/model.
- Deterministic fake provider.
- Correction-analysis and enforceability schemas.
- Prompt boundary/truncation utilities and injection-resistance tests.
- Confidence threshold and category-based refusal.
- Twelve required offline evaluation definitions.

Gate:

- The workflow classifies all eight enforceable and four non-enforceable cases deterministically.
- Non-enforceable and low-confidence cases emit useful exit-code-2 results and produce no write plan.
- No default test requires network or credentials.

### Phase 3: Semgrep generation and deterministic validation

Deliverables:

- Structured rule generation and repair prompts.
- Safe YAML parser/schema and ID sanitization.
- Before, after, and allowed-alternative fixture builder.
- Injectable Semgrep runner, result normalizer, and current-repository scanner.
- Syntax/fixture/mutation/broadness validations.
- Three-attempt bounded repair loop with visible attempt summaries.
- `validate`, `validate-all`, and `scan` core services.

Gate:

- All eight enforceable offline evaluations generate exactly one rule.
- Each rule passes Semgrep syntax, detects before, and avoids corrected/allowed fixtures.
- Invalid/multi-rule/autofix/overbroad proposals fail predictably.
- TypeScript and Python paths pass real Semgrep execution when installed; CI always installs it.

### Phase 4: Persistence and pull-request workflow

Deliverables:

- Versioned evidence and manifest schemas.
- Artifact planning, collision resolution, atomic contained writes, and dirty-tree checks.
- Broadness confirmation flow.
- Clean worktree/clone branch manager.
- Commit, push, structured PR body, and `gh pr create` adapter.
- Push-permission recovery instructions and retained-state reporting.

Gate:

- Dry-run mutation tests prove byte-for-byte repository stability.
- `--write` produces deterministic complete artifact sets and preserves unrelated files.
- Traversal/symlink/conflict/dirty-tree cases are covered.
- Offline Git integration creates the expected branch and commit without pushing.
- No code path invokes PR merge.

### Phase 5: Product polish and release gate

Deliverables:

- Human renderer, versioned JSON renderer, truncation and `NO_COLOR` behavior.
- `doctor` diagnostics and actionable remediation.
- Separate `install-ci` command and generated workflow.
- Real fixture-backed `examples/injected-clock` and stable `npm run demo`.
- Complete README, architecture, rule-generation, security, contributing, conduct, license, and release docs.
- E2E tests for root alias, all commands, errors, JSON cleanliness, and package installation.

Gate:

- `npm run build`, `lint`, `typecheck`, unit, integration, E2E, evaluation, validate, and demo pass from a clean checkout.
- Semgrep tests pass in CI.
- README first screen and one demo explain the product in under 30 seconds.
- No core-path TODO remains and no workflow publishes automatically.

## Verification Strategy

### Unit tests

Pure tests cover URL parsing, remote normalization, config precedence/schema, thread mapping, diffs/candidate selection, rename handling, provider schemas, injection boundaries, YAML/schema checks, IDs, safe paths, matches, renderers, atomic write planning, error mapping, and redaction.

### Integration tests

Temporary repositories model historical commits, path-specific diffs, missing local objects, worktree creation, dirty files, safe artifact persistence, manifests, and branch creation. Process ports are faked except where a real local `git` or opt-in Semgrep run is specifically under test.

### Offline end-to-end evaluation

Fake GitHub and fake provider fixtures exercise the same generate workflow for the eight enforceable and four refusal cases. These tests assert results, exit codes, validation reports, planned/written artifacts, and dry-run non-mutation.

### Live integration tests

Live GitHub and provider tests are opt-in and skipped without explicit credentials and fixture URLs. They may confirm API compatibility but are never required for unit or offline integration gates. Logs and failure artifacts remain redacted.

### Release gate

CI installs Node dependencies and Semgrep, runs formatting checks, lint, typecheck, build, all offline tests, real Semgrep fixture validation, demo, and a packed-package smoke test. Publishing is a manual documented action.

## Known Limitations

- Only GitHub review discussion URLs, Semgrep, and TypeScript/JavaScript/Python are supported.
- A resolved thread is only useful when historical code and an unambiguous accepted correction remain recoverable.
- Static local/import/call/argument/construction patterns are supported; behavioral, architectural, subjective, product, and speculative feedback is intentionally refused.
- Semgrep rules can still have project-specific false positives outside fixtures; current-repository scanning and broadness confirmation reduce but cannot eliminate this risk.
- Shallow or rewritten Git history may require GitHub content APIs and network access.
- GitHub GraphQL response details and provider structured-output APIs can evolve; schemas and adapter integration tests will need maintenance.
- Allowed-alternative fixtures cannot always be created reliably; omission is permitted only with an explicit recorded limitation.
- Basic mutation checks are bounded examples, not general mutation testing or formal proof.
- `--open-pr` depends on local `git`, authenticated `gh`, remote push permission, and network access; offline tests stop at local branch/commit behavior.
- The CLI will not infer organization policy, activate rules automatically, install CI during normal generation, run target-repository code, generate autofixes, or merge pull requests.
- Local Semgrep tests may skip when the binary is absent, though the release CI gate must install and execute Semgrep.

## Sequencing and Dependency Notes

- Phase 0 domain schemas and ports must land before adapters to prevent external response shapes from becoming architecture.
- Phase 1 must prove complete deterministic evidence before Phase 2 model inference begins.
- Phase 3 must be complete before any Phase 4 mutation is enabled.
- Renderers should consume a stable result model established during Phases 1-3; they must not contain workflow decisions.
- Documentation examples and the demo should be finalized against the packaged CLI in Phase 5, not hand-authored ahead of behavior.
