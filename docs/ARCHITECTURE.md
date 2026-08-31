# Architecture

The domain layer owns Zod schemas and typed errors. Analysis performs language detection and deterministic source reconstruction without importing provider or process libraries. The provider boundary accepts only bounded correction context. Official OpenAI and Anthropic adapters request JSON Schema output and validate it locally. The Semgrep boundary parses a strict one-rule schema before invoking the injected command runner. The CLI composes these ports and renders the versioned result.

External execution is centralized in `ProcessCommandRunner`. It accepts only `git`, `gh`, or `semgrep`, always passes an argument array, disables the shell, and redacts diagnostics. GitHub retrieval combines the supplied REST comment, PR metadata, paginated review comments and files, plus paginated GraphQL review threads. Repository resolution verifies normalized origin identity and cleans temporary clones.

Persistence is entered only after schema and Semgrep validation. It plans hashes, preflights paths, symlinks, and dirty overlap, stages all files, durably journals each transition, verifies previewed policy hashes, and renames files with backups. Exceptions and graceful signals restore prior files; a later run can recover a journal left by abrupt termination. Policy discovery reads bounded tracked filenames and reports bounded manifest ownership health; managed pointer code treats prose as opaque bytes. Manifest replay verifies stored hashes and behavior without GitHub, a provider, or repository mutation.

Validation, aggregate validation, and scan are read-only consumers of that same
canonical manifest and one-rule parser. CI installation is an independent
single-file atomic transaction. PR publication starts from an isolated clone,
generates a complete plan before approval, stages only that allowlist, disables
hooks and signing, and retains recovery state after post-commit failure. No
component invokes a target repository package script.
