# Review learning bundle v1

Create UTF-8 JSON smaller than 128 KB. The root object and every nested object
are strict: do not add fields. Paths are exact portable repository-relative
paths, never globs. IDs may be positive integers or non-empty strings.

The bundle has these root fields:

- `schemaVersion`: `1`.
- `source`: review system, credential-free HTTP(S) review URL, repository
  identity, and generic change identity/revisions/merged state.
- `review`: comment, thread root/replies, resolved state, and optional location.
- `snapshots`: bounded before and accepted-after excerpts with exact revisions.
- `correction`: one exact before/after edit and its confidence.
- `enforceability`: one static-local decision. For a refusal, set `rule` to
  `null`; for an enforceable decision, provide exactly one rule.
- `rule`: structured proposal plus exactly one strict Semgrep rule in `yaml`.
- `fixtures`: parseable before/after snippets and, when reliable, one allowed
  alternative. Each fixture must contain its corresponding correction text.
- `provenance`: how the host agent retrieved and verified the evidence.
- `warnings`: any incomplete or explicitly allowed evidence caveats.

Use this shape:

```json
{
  "schemaVersion": 1,
  "source": {
    "reviewSystem": "gitlab",
    "url": "https://gitlab.example/acme/billing/-/merge_requests/482#note_189234",
    "repository": {
      "host": "gitlab.example",
      "owner": "acme",
      "name": "billing"
    },
    "change": {
      "id": 482,
      "baseRevision": "base-revision",
      "headRevision": "accepted-revision",
      "merged": true,
      "mergedAt": "2026-08-30T12:00:00Z",
      "mergeRevision": "merge-revision"
    }
  },
  "review": {
    "id": 189234,
    "body": "This query must be tenant-scoped.",
    "resolved": true,
    "path": "src/invoices.ts",
    "root": {
      "id": 189234,
      "body": "This query must be tenant-scoped."
    },
    "replies": []
  },
  "snapshots": {
    "before": {
      "path": "src/invoices.ts",
      "revision": "base-revision",
      "excerpt": "const rows = db.invoice.findMany();\n",
      "truncated": false
    },
    "after": {
      "path": "src/invoices.ts",
      "revision": "accepted-revision",
      "excerpt": "const rows = db.invoice.findMany({ where: { tenantId } });\n",
      "truncated": false
    }
  },
  "correction": {
    "path": "src/invoices.ts",
    "language": "typescript",
    "intentSummary": "Require tenant scoping on invoice list queries.",
    "before": "const rows = db.invoice.findMany();\n",
    "after": "const rows = db.invoice.findMany({ where: { tenantId } });\n",
    "evidence": ["The accepted change added the tenant filter."],
    "confidence": 0.98
  },
  "enforceability": {
    "enforceable": true,
    "category": "API_USAGE",
    "reviewerIntent": "Reject the reviewed unscoped call.",
    "prohibitedPattern": "$DB.invoice.findMany()",
    "preferredPattern": "$DB.invoice.findMany({ where: { tenantId: $ID } })",
    "rationale": "The prohibited call is a local AST pattern.",
    "limitations": [
      "This intentionally catches only the reviewed zero-argument form."
    ],
    "confidence": 0.96
  },
  "rule": {
    "id": "review-to-rule.require-tenant-scoped-invoice-query",
    "title": "Require tenant-scoped invoice queries",
    "message": "Invoice queries must include tenant scope.",
    "language": "typescript",
    "severity": "ERROR",
    "yaml": "rules:\n  - id: review-to-rule.require-tenant-scoped-invoice-query\n    message: Invoice queries must include tenant scope.\n    severity: ERROR\n    languages: [typescript]\n    metadata:\n      source: review-to-rule\n      generator: review-to-rule@0.2.0\n      review: gitlab.example/acme/billing!482#note_189234\n    pattern: $DB.invoice.findMany()\n    paths:\n      include: [src/invoices.ts]\n      exclude: [node_modules/**, dist/**, build/**, .git/**, '**/generated/**', '**/fixtures/**']\n",
    "include": ["src/invoices.ts"],
    "exclude": [
      "node_modules/**",
      "dist/**",
      "build/**",
      ".git/**",
      "**/generated/**",
      "**/fixtures/**"
    ],
    "rationale": "The rule blocks the exact unscoped API form.",
    "limitations": [
      "This intentionally catches only the reviewed zero-argument form."
    ],
    "confidence": 0.96
  },
  "fixtures": {
    "before": "const rows = db.invoice.findMany();\n",
    "after": "const rows = db.invoice.findMany({ where: { tenantId } });\n"
  },
  "provenance": [
    "Host agent retrieved the accepted thread and both revisions."
  ],
  "warnings": []
}
```

The rule YAML must contain exactly one rule and exactly one supported top-level
operator: `pattern`, `patterns`, `pattern-either`, or `pattern-regex`. Languages
are `typescript`, `javascript`, or `python`. Do not use autofix, metavariable
comparisons, arbitrary metadata, absolute paths, or unknown fields. The YAML ID,
message, severity, language, include, and exclude values must exactly equal the
enclosing structured fields. Do not claim success from inspection: `apply` and
real Semgrep are authoritative.
