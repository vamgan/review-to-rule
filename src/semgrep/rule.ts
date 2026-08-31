import { parse, stringify } from "yaml";
import { z } from "zod";
import { ValidationError } from "../domain/errors.js";
import {
  proposalSchema,
  type GeneratedRuleProposal,
} from "../domain/schemas.js";

const metadataSchema = z.strictObject({
  source: z.literal("review-to-rule"),
  generator: z.literal("review-to-rule@0.1.0"),
  review: z.string().min(1).max(500),
});
const pathsSchema = z.strictObject({
  include: z.array(z.string().min(1)).min(1),
  exclude: z.array(z.string().min(1)),
});
const ruleSchema = z.strictObject({
  id: z.string().regex(/^review-to-rule\.[a-z0-9]+(?:-[a-z0-9]+)*$/),
  message: z.string().min(1),
  severity: z.enum(["INFO", "WARNING", "ERROR"]),
  languages: z.array(z.enum(["typescript", "javascript", "python"])).length(1),
  metadata: metadataSchema,
  pattern: z.string().min(1).optional(),
  "pattern-either": z.array(z.unknown()).min(1).optional(),
  patterns: z.array(z.unknown()).min(1).optional(),
  "pattern-regex": z.string().min(1).optional(),
  paths: pathsSchema,
});

const stringClauseKeys = new Set([
  "pattern",
  "pattern-not",
  "pattern-inside",
  "pattern-not-inside",
  "pattern-regex",
]);

function validateNestedClause(value: unknown, location: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError(`${location} must be a pattern object.`);
  const entries = Object.entries(value);
  if (entries.length !== 1)
    throw new ValidationError(
      `${location} must contain exactly one supported operator.`,
    );
  const [key, nested] = entries[0] ?? [];
  if (!key) throw new ValidationError(`${location} has no operator.`);
  if (stringClauseKeys.has(key)) {
    if (typeof nested !== "string" || nested.length === 0)
      throw new ValidationError(
        `${location}.${key} must be a non-empty string.`,
      );
    return;
  }
  if (key === "patterns" || key === "pattern-either") {
    if (!Array.isArray(nested) || nested.length === 0)
      throw new ValidationError(
        `${location}.${key} must be a non-empty array.`,
      );
    nested.forEach((clause, index) =>
      validateNestedClause(clause, `${location}.${key}[${index}]`),
    );
    return;
  }
  if (key === "metavariable-regex") {
    const parsed = z
      .strictObject({
        metavariable: z.string().regex(/^\$[A-Z][A-Z0-9_]*$/),
        regex: z.string().min(1),
      })
      .safeParse(nested);
    if (!parsed.success)
      throw new ValidationError(
        `${location}.${key} is unsafe: ${parsed.error.message}`,
      );
    return;
  }
  throw new ValidationError(
    `${location} contains unsupported nested operator '${key}'.`,
  );
}

function safeRelativeScope(scope: string): boolean {
  return (
    !scope.startsWith("/") &&
    !/^[A-Za-z]:/.test(scope) &&
    !scope.includes("\\") &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(scope) &&
    !scope
      .split("/")
      .some((part) => part === "." || part === ".." || part === "")
  );
}

export function validateRuleYaml(
  proposal: GeneratedRuleProposal,
): Record<string, unknown> {
  let document: unknown;
  try {
    document = parse(proposal.yaml);
  } catch (error) {
    throw new ValidationError(
      `Rule YAML does not parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const outer = z
    .strictObject({ rules: z.array(z.unknown()).length(1) })
    .safeParse(document);
  if (!outer.success)
    throw new ValidationError(
      `Rule YAML must contain exactly one rule: ${outer.error.message}`,
    );
  const parsed = ruleSchema.safeParse(outer.data.rules[0]);
  if (!parsed.success)
    throw new ValidationError(
      `Unsafe Semgrep rule schema: ${parsed.error.message}`,
    );
  const operators = [
    parsed.data.pattern,
    parsed.data["pattern-either"],
    parsed.data.patterns,
    parsed.data["pattern-regex"],
  ].filter((value) => value !== undefined);
  if (operators.length !== 1)
    throw new ValidationError(
      "Rule must contain exactly one supported top-level pattern operator.",
    );
  for (const key of ["patterns", "pattern-either"] as const) {
    parsed.data[key]?.forEach((clause, index) =>
      validateNestedClause(clause, `${key}[${index}]`),
    );
  }
  if (
    [...parsed.data.paths.include, ...parsed.data.paths.exclude].some(
      (scope) => !safeRelativeScope(scope),
    )
  )
    throw new ValidationError(
      "Rule contains an unsafe or non-relative path scope.",
    );
  if (
    parsed.data.id !== proposal.id ||
    parsed.data.languages[0] !== proposal.language ||
    parsed.data.message !== proposal.message ||
    parsed.data.severity !== proposal.severity ||
    JSON.stringify(parsed.data.paths.include) !==
      JSON.stringify(proposal.include) ||
    JSON.stringify(parsed.data.paths.exclude) !==
      JSON.stringify(proposal.exclude)
  )
    throw new ValidationError(
      "Proposal ID, message, severity, language, metadata, include, or exclude fields do not match the embedded rule.",
    );
  return parsed.data;
}

export function applyRuleConfiguration(
  proposal: GeneratedRuleProposal,
  config: {
    severity?: GeneratedRuleProposal["severity"];
    include?: string[];
    exclude?: string[];
  },
): GeneratedRuleProposal {
  const validated = validateRuleYaml(proposal);
  const severity = config.severity ?? proposal.severity;
  const include = config.include?.length ? config.include : proposal.include;
  const exclude = config.exclude?.length ? config.exclude : proposal.exclude;
  const configured = proposalSchema.parse({
    ...proposal,
    severity,
    include,
    exclude,
    yaml: stringify(
      {
        rules: [
          {
            ...validated,
            severity,
            paths: { include, exclude },
          },
        ],
      },
      { lineWidth: 0 },
    ),
  });
  validateRuleYaml(configured);
  return configured;
}
