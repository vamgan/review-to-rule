# Rule generation and integrity validation

A host agent or optional standalone adapter records one accepted correction in
a versioned review-memory bundle. Semantic analysis may propose a rule, but the
deterministic `apply` core owns acceptance.

One candidate correction may produce one namespaced rule. IDs are deterministic
`review-to-rule.<slug>` values. The rule declares its instruction, rationale,
priority, path/language scope, triggers, guidance, exceptions, and one or more
before/after examples.

The core then verifies strict structure, credential absence, exact accepted
example anchoring, path/language scope, source identity, and confidence. It does
not compile the rule into an analyzer pattern: architectural, behavioral,
testing, style, maintainability, and product rules remain useful context for a
future reasoning agent.

Only then does the planner choose a collision-safe artifact identity. Preview
shows every discovered store, policy file, path, scope, collision, diff, and
write command. A write needs interactive confirmation after preview or explicit
`--yes`; EOF, non-TTY without `--yes`, or any answer other than `yes` leaves the
repository unchanged.

`.review-to-rule` remains authoritative. Optional `AGENTS.md` and `CLAUDE.md`
integration is only a managed pointer to the shared index and rule directory; it
never duplicates rule logic. Replay verifies hashes, source identity,
deterministic Markdown, accepted evidence, and pointers. Duplicate or malformed
markers, symlinks, concurrent instruction changes, dirty overlap, path
traversal, signals, and I/O failure fail within the durable rollback-capable
transaction.
