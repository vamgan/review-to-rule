# Review memory bundle v2

Create UTF-8 JSON smaller than 128 KB. The root object and every nested object
are strict: do not add fields. Evidence paths are exact portable repository-
relative paths; only `rule.scope.paths` may contain globs. IDs may be positive
integers or non-empty strings.

The bundle has these root fields:

- `schemaVersion`: `2`.
- `source`: review system, credential-free HTTP(S) review URL, repository
  identity, and generic change identity/revisions/merged state.
- `review`: comment, thread root/replies, resolved state, and optional location.
- `snapshots`: bounded before and accepted-after excerpts with exact revisions.
- `correction`: one exact before/after edit and its confidence.
- `applicability`: whether the accepted feedback is concrete and reusable,
  including category, intent, limitations, rationale, and confidence.
- `rule`: one structured agent-readable rule, or `null` when the feedback is
  not reusable. Its examples must preserve the exact accepted correction.
- `provenance`: how the host agent retrieved and verified the evidence.
- `warnings`: any incomplete or explicitly allowed evidence caveats.

Use this shape:

```json
{
  "schemaVersion": 2,
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
  "applicability": {
    "reusable": true,
    "category": "SECURITY",
    "reviewerIntent": "Require tenant scope on invoice list queries.",
    "rationale": "The accepted correction establishes a durable data-isolation boundary.",
    "limitations": ["Apply only to tenant-owned invoice data."],
    "confidence": 0.98
  },
  "rule": {
    "id": "review-to-rule.require-tenant-scoped-invoice-query",
    "title": "Require tenant-scoped invoice queries",
    "instruction": "Every invoice list query must constrain results to the active tenant.",
    "rationale": "Unscoped reads can expose another tenant's invoices.",
    "priority": "critical",
    "scope": {
      "paths": ["src/invoices.ts"],
      "languages": ["typescript"],
      "description": "Apply when reviewing invoice reads in src/invoices.ts."
    },
    "triggers": [
      "An invoice query can run without the active tenant identifier."
    ],
    "guidance": ["Request a tenantId constraint from trusted request context."],
    "exceptions": [],
    "examples": [
      {
        "language": "typescript",
        "bad": "const rows = db.invoice.findMany();\n",
        "good": "const rows = db.invoice.findMany({ where: { tenantId } });\n"
      }
    ],
    "confidence": 0.98
  },
  "provenance": [
    "Host agent retrieved the accepted thread and both revisions."
  ],
  "warnings": []
}
```

Rule IDs start with `review-to-rule.`. Scope paths are portable repository-
relative paths or globs. The correction path and language must be covered by
the rule scope. Instructions, triggers, guidance, rationale, and examples must
be concrete enough for a future coding agent to decide when the rule applies.
Do not claim success from inspection: the writer's `apply` dry run and its
integrity, scope, provenance, collision, and policy-pointer checks are
authoritative.
