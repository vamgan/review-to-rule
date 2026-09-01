# Security model

Review prose, source excerpts, bundle JSON, model output, configuration, and
filesystem paths are untrusted inputs. Every one crosses a bounded schema or
path-safety boundary before it influences a write.

## Credentials and data flow

Agent mode uses the host agent's existing source-control tools. Authentication
stays in those tools: the bundle must not contain bearer tokens, API keys,
cookies, authorization headers, environment values, or URLs with embedded
credentials. Bundle files must be regular non-symlink files and are limited to
128 KB. Review bodies and excerpts have separate size limits.

No provider is resolved and no model credential is read by `apply` or
`doctor --mode agent`. The optional standalone GitHub adapter is the only path that
uses `gh` plus an OpenAI or Anthropic credential. It sends only bounded selected
correction context, labels it as untrusted, validates structured output locally,
and redacts diagnostics.

## Rule and repository validation

The core accepts exactly one rule in a strict structured schema. It requires a
namespaced ID, bounded instruction and rationale, explicit priority, path and
language scope, triggers, guidance, exceptions, and accepted before/after
examples. At least one example must preserve the exact reviewed correction,
the scope must cover that correction, and credential-shaped content is rejected.

The project never executes target repository code, builds, tests, hooks,
package scripts, or commands found in review text. Future agents interpret a
rule contextually; the stored rule is guidance, not executable repository code.

Generic review URLs use a normalized credential-free URL identity. GitHub URLs
retain the more compact canonical comment identity for compatibility. Stored
evidence repeats the source system and URL, and replay requires it to equal the
manifest source.

## Write safety and replay

Writes reject absolute/traversing paths, globbed exact paths, control or format
characters, symlinked ancestors, dirty overlap, malformed managed markers,
changed-after-preview policy files, and injected I/O failures. Discovery,
collision planning, replay, and recovery inspect every path component without
following symlinks.

The transaction durably journals backups and replacements, rolls back on
exceptions or SIGINT/SIGTERM, and recovers an interrupted journal before later
collision planning. Generated artifacts never become active automatically.

Replay accepts only a complete versioned manifest. It enforces exact owned and
hashed path sets, deterministic Markdown rendering, rule ID equality, accepted
evidence anchoring, source identity, schema version, explicit instruction-
file consent, and exact managed-pointer content. Corrupt, redirected, or
incomplete sets fail without writes.

## External mutations

Core generation never comments on a review, pushes a branch, opens or merges a
change request, publishes a package, or installs CI. Those are separate,
explicitly previewed workflows. A host agent may publish to a review system
only after the user separately approves the exact external mutation plan.
