# Rule generation and validation

One candidate correction may produce one namespaced rule. IDs are deterministic `review-to-rule.<slug>` values. YAML must have exactly one rule, one supported language, required metadata, a supported pattern operator, and no autofix or unknown fields.

Real Semgrep then validates syntax, requires at least one match on the original fixture, requires zero on the corrected and allowed fixtures, and exercises whitespace, variable-renaming, and surrounding-statement mutations. A repository scan is normalized to relative paths and bounded excerpts. A failed candidate can be repaired at most twice after the initial proposal; all three failure diagnostics remain visible and no artifacts are written.

Only then does the planner choose a collision-safe artifact identity. Preview shows every path, scope, policy target, and write command. A write needs interactive confirmation after preview or explicit `--yes`; EOF, non-TTY without `--yes`, or any answer other than `yes` leaves the repository unchanged.

`.review-to-rule` remains authoritative. Optional `AGENTS.md` and `CLAUDE.md` integration is only a managed pointer to the final manifest/rule directory, its exact Semgrep validation command, and `review-to-rule replay <manifest>`. It never duplicates rule logic. Replay verifies hashes before recreating the rule's exact include scope in a temporary directory and rerunning syntax/before/after/allowed expectations. Duplicate or malformed markers, symlinks, concurrent policy changes, dirty overlap, path traversal, signals, and I/O failure fail within the durable rollback-capable transaction.
