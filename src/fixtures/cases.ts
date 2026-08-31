import type { Language } from "../domain/schemas.js";

export interface OfflineCase {
  name: string;
  url: string;
  review: string;
  path: string;
  language: Language;
  before: string;
  after: string;
  allowed: string;
  enforceable: boolean;
}

const url = (id: number) =>
  `https://github.com/acme/clock/pull/42#discussion_r${id}`;
export const offlineCases: OfflineCase[] = [
  {
    name: "typescript-injected-clock",
    url: url(1001),
    review:
      "Inject Clock instead of calling Date.now() directly so time is testable.",
    path: "src/token.ts",
    language: "typescript",
    before: `export function expiresAt(ttl: number) {\n  return Date.now() + ttl;\n}\n`,
    after: `export interface Clock { now(): number }\nexport function expiresAt(ttl: number, clock: Clock) {\n  return clock.now() + ttl;\n}\n`,
    allowed: `export function expiresAt(ttl: number, clock: { now(): number }) {\n  return clock.now() + ttl;\n}\n`,
    enforceable: true,
  },
  {
    name: "typescript-no-console-log",
    url: url(1002),
    review: "Use the injected logger instead of console.log.",
    path: "src/log.ts",
    language: "typescript",
    before: `export function log(value: string) { console.log(value); }\n`,
    after: `export function log(value: string, logger: Logger) { logger.info(value); }\n`,
    allowed: `export function log(value: string, logger: Logger) { logger.debug(value); }\n`,
    enforceable: true,
  },
  {
    name: "typescript-no-eval",
    url: url(1003),
    review: "Do not use eval; call the parser.",
    path: "src/parse.ts",
    language: "typescript",
    before: `export const parse = (value: string) => eval(value);\n`,
    after: `export const parse = (value: string) => parser.parse(value);\n`,
    allowed: `export const parse = (value: string) => JSON.parse(value);\n`,
    enforceable: true,
  },
  {
    name: "typescript-no-math-random",
    url: url(1004),
    review: "Inject the random source instead of Math.random().",
    path: "src/id.ts",
    language: "typescript",
    before: `export const id = () => Math.random();\n`,
    after: `export const id = (random: Random) => random.next();\n`,
    allowed: `export const id = (crypto: Crypto) => crypto.randomUUID();\n`,
    enforceable: true,
  },
  {
    name: "typescript-no-var",
    url: url(1005),
    review: "Use const instead of var for this binding.",
    path: "src/value.ts",
    language: "typescript",
    before: `export function value() { var result = 1; return result; }\n`,
    after: `export function value() { const result = 1; return result; }\n`,
    allowed: `export function value() { let result = 1; result++; return result; }\n`,
    enforceable: true,
  },
  {
    name: "typescript-no-any-cast",
    url: url(1006),
    review: "Use the typed boundary instead of casting as any.",
    path: "src/input.ts",
    language: "typescript",
    before: `export const input = value as any;\n`,
    after: `export const input: Input = parseInput(value);\n`,
    allowed: `export const input: unknown = value;\n`,
    enforceable: true,
  },
  {
    name: "python-no-eval",
    url: url(1007),
    review: "Use the safe parser instead of eval.",
    path: "src/parser.py",
    language: "python",
    before: `def parse(value):\n    return eval(value)\n`,
    after: `def parse(value):\n    return json.loads(value)\n`,
    allowed: `def parse(value):\n    return ast.literal_eval(value)\n`,
    enforceable: true,
  },
  {
    name: "python-none-identity",
    url: url(1008),
    review: "Use identity comparison for None.",
    path: "src/check.py",
    language: "python",
    before: `def missing(value):\n    return value == None\n`,
    after: `def missing(value):\n    return value is None\n`,
    allowed: `def present(value):\n    return value is not None\n`,
    enforceable: true,
  },
  {
    name: "subjective-style",
    url: url(1009),
    review: "This would look nicer and I prefer the style.",
    path: "src/a.ts",
    language: "typescript",
    before: `export const a = Date.now();\n`,
    after: `export const a = clock.now();\n`,
    allowed: `export const a = clock.now();\n`,
    enforceable: false,
  },
  {
    name: "product-decision",
    url: url(1010),
    review: "The product should have a different user experience.",
    path: "src/a.ts",
    language: "typescript",
    before: `export const a = Date.now();\n`,
    after: `export const a = clock.now();\n`,
    allowed: `export const a = clock.now();\n`,
    enforceable: false,
  },
  {
    name: "performance-speculation",
    url: url(1011),
    review: "This might be faster; optimize it.",
    path: "src/a.ts",
    language: "typescript",
    before: `export const a = Date.now();\n`,
    after: `export const a = clock.now();\n`,
    allowed: `export const a = clock.now();\n`,
    enforceable: false,
  },
  {
    name: "cross-file-architecture",
    url: url(1012),
    review: "Change the architecture across the repo and all services.",
    path: "src/a.ts",
    language: "typescript",
    before: `export const a = Date.now();\n`,
    after: `export const a = clock.now();\n`,
    allowed: `export const a = clock.now();\n`,
    enforceable: false,
  },
];

export function getOfflineCase(name: string): OfflineCase {
  const item = offlineCases.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Unknown offline fixture: ${name}`);
  return item;
}
