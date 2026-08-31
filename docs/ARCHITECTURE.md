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
               +---- ReviewLearningBundle v1 ------------+
                                  |
                    strict schema and source identity
                                  |
                     one-rule Semgrep parser
                                  |
                syntax / before / after / allowed
                    / mutations / repository scan
                                  |
                   policy discovery and full preview
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

The review learning bundle is the only handoff. It uses generic `source.change`,
`review`, and `snapshots` fields rather than GitHub-specific pull-request types.
The bundle is bounded, versioned, credential-free, and validated before any
repository scan or write. See [REVIEW_BUNDLE.md](REVIEW_BUNDLE.md).

The deterministic core owns all acceptance decisions after that handoff. It
parses one strict rule, runs real Semgrep on the negative and corrected
fixtures, checks an allowed alternative when supplied, exercises
meaning-preserving mutations, scans the current repository, discovers existing
rule/policy locations, resolves collisions, and creates a complete write plan.
No model response can bypass those gates.

The standalone `generate` adapter is deliberately outside the core. It uses
read-only `gh` calls and a configured OpenAI or Anthropic adapter to reconstruct
the same bundle, then calls the same core. Provider configuration therefore has
no effect on `apply`, replay, validation, scanning, or agent-mode doctor checks.
Programmatic integrations can import `review-to-rule/core` without loading the
standalone model adapters.

## Persistence

`.review-to-rule/` is the only canonical store. A manifest records the source
identity, evidence and fixture hashes, rule identity, validation expectations,
generator version, selected policy files, and approval mode. `AGENTS.md` and
`CLAUDE.md` integrations are managed pointers to that store, never independent
copies of rule logic.

Writes begin only after validation and preview. The planner checks containment,
every path component, symlinks, dirty overlap, collisions, manifest ownership,
and policy ambiguity. The transaction stages all content, journals each
transition, verifies policy hashes again, then renames with backups. Exceptions
and graceful signals restore originals; a later invocation can recover a
journal left by abrupt termination.

Replay is read-only. It verifies exact manifest ownership and hashes before
rerunning the stored rule against its fixtures. It needs neither review-system
access nor a model.

## External processes and publication

`ProcessCommandRunner` invokes only allowlisted `git`, `gh`, and `semgrep`
binaries with argument arrays and no shell. Core `apply` uses `git` for bounded
repository discovery and Semgrep for validation; it does not use `gh`.
Repository builds, tests, hooks, package scripts, and model-suggested commands
are never executed.

In agent mode, PR/MR/change-request publication belongs to the host agent and
requires its own preview and approval. The optional standalone GitHub publisher
runs in an isolated clone, stages only the approved allowlist, disables hooks
and signing, never force-pushes, and never merges.
