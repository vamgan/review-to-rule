# Security model

Review prose, replies, patches, source, provider responses, GitHub JSON, Semgrep JSON, configuration, and filesystem paths cross explicit validation boundaries. Review content is bounded, labeled inert, and hashed before an official provider adapter receives only the selected correction. Credentials use dedicated environment variables and diagnostics are redacted.

`gh` commands are fixed read-only REST/GraphQL argument arrays. No shell is involved. Open, unresolved, or unmapped evidence is refused unless its dedicated opt-in flag is present. Repository origins are normalized across HTTPS and SSH before local content is trusted. Historical reads try the local object database, one narrow hook-disabled fetch, then a read-only content endpoint.

Writes reject absolute/traversing paths, exact paths with glob metacharacters, unsafe control/format/separator characters, symlinked ancestors, dirty overlap, changed-after-preview policy files, malformed markers, and injected I/O failures. Discovery, collision planning, replay, and journal recovery inspect every path component without following symlinks; a symlinked artifact root is reported but never traversed. The transaction durably journals each backup/replacement transition, restores backups on exceptions or SIGINT/SIGTERM, and recovers a journal left by abrupt process termination before collision planning. Generated artifacts never become active automatically.

Replay accepts only the complete versioned manifest shape and enforces exact owned/hashed path-set equality, canonical artifact root and fixture identity, explicit semantic policy consent, selected policy membership, parsed versioned evidence, a supported GitHub/GitHub Enterprise review URL with canonical identity, valid generator SemVer, and equality between the manifest rule ID and the stored single-rule YAML. Every selected managed pointer must exactly name the canonical manifest, rule directory, validation command, and replay command. Corrupt or redirected sets fail with exit 3 and no writes.

Branch push, pull-request creation, and CI installation exist only behind their
separate explicit previews and approvals. PR work occurs in an isolated clone,
never force-pushes or merges, and retains recovery state after a committed
partial failure. CI installation writes exactly one conflict-checked workflow.
The project never adds comments, merges pull requests, publishes packages,
executes target-repository package scripts, sends telemetry, or transmits
repository policy files to a model.
