# Architecture

`review-to-rule` has one provider-neutral deterministic core and two ways to
feed it. The host-agent path is primary. The standalone GitHub path is an
optional adapter.

```text
Host agent + any review tools                 Optional standalone adapter
  retrieve accepted review                      gh + OpenAI/Anthropic
  recover before and after                                |
  propose one narrow rule                                 |
              \                                           /
               +----- ReviewMemoryBundle v2 -------------+
                                  |
                    strict schema + source identity
                                  |
                    reusable-intent + scoped rule
                                  |
                 evidence / credentials / scope
                                  |
                  repository discovery + preview
                                  |
                     explicit transactional write
                                  |
                    canonical .review-to-rule store
```

## Boundary ownership

The host agent owns access to GitHub, GitLab, Bitbucket, Gerrit, Azure Repos,
or a private review system. It also owns the semantic judgment needed to turn
the accepted correction into one candidate rule. Its credentials stay inside
the host's tools.

The review-memory bundle is the only handoff. It uses generic `source.change`,
`review`, and `snapshots` fields rather than GitHub-specific pull-request types.
The bundle is bounded, versioned, credential-free, and validated before any
repository write. See [REVIEW_BUNDLE.md](REVIEW_BUNDLE.md).

The deterministic core owns all acceptance decisions after that handoff. The
agent skill carries a bundled, dependency-free-at-runtime build of that core,
so installing the skill or Claude Code plugin is sufficient; no separate npm
package or global CLI is required. It
parses one strict agent-readable rule, requires examples anchored to the
accepted correction, rejects credentials, verifies path and language scope,
discovers existing memory and instruction locations, resolves collisions, and
creates a complete write plan. No model response can bypass those gates.

The standalone `generate` adapter is deliberately outside the core. It uses
read-only `gh` calls and a configured OpenAI or Anthropic adapter to reconstruct
the same bundle, then calls the same core. Provider configuration therefore has
no effect on `apply`, replay, validation, or agent-mode doctor checks.
Programmatic integrations can import `review-to-rule/core` without loading the
standalone model adapters. The npm CLI remains an optional terminal and CI
surface over the same core.

## Persistence

`.review-to-rule/` is the only canonical store. A manifest records the source
identity, structured rule, evidence hashes, generator version, selected
instruction files, and approval mode. A shared `INDEX.md` lets future agents
select only rules matching the files involved. `AGENTS.md` and `CLAUDE.md`
integrations are managed pointers to that store, never independent copies.

Writes begin only after validation and preview. The planner checks containment,
every path component, symlinks, dirty overlap, collisions, manifest ownership,
and policy ambiguity. The transaction stages all content, journals each
transition, verifies policy hashes again, then renames with backups. Exceptions
and graceful signals restore originals; a later invocation can recover a
journal left by abrupt termination.

Replay is read-only. It verifies exact manifest ownership, hashes, deterministic
Markdown rendering, accepted evidence anchoring, source identity, and managed
instruction pointers. It needs neither review-system access nor a model.

## External processes and publication

`ProcessCommandRunner` invokes only allowlisted `git` and `gh` binaries with
argument arrays and no shell. Core `apply` uses only `git` for bounded
repository discovery; it does not use `gh`.
Repository builds, tests, hooks, package scripts, and model-suggested commands
are never executed.

In agent mode, PR/MR/change-request publication belongs to the host agent and
requires its own preview and approval. Core generation never pushes, comments,
opens, or merges a change request.
