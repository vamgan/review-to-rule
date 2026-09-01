import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const marketplace = readJson(".claude-plugin/marketplace.json");
const plugin = readJson(
  ".agents/skills/review-to-rule-write/.claude-plugin/plugin.json",
);
const sourceVersion = readFileSync(join(root, "src/version.ts"), "utf8").match(
  /GENERATOR_VERSION = "([^"]+)"/,
)?.[1];
const writerVersion = execFileSync(
  process.execPath,
  [
    join(
      root,
      ".agents/skills/review-to-rule-write/scripts/review-to-rule.mjs",
    ),
    "--version",
  ],
  { encoding: "utf8" },
).trim();
const marketplaceVersion = marketplace.plugins.find(
  (entry) => entry.name === "review-to-rule",
)?.version;

const versions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json root package", packageLock.packages?.[""]?.version],
  ["Claude marketplace", marketplaceVersion],
  ["Claude plugin", plugin.version],
  ["source generator", sourceVersion],
  ["installed-skill writer", writerVersion],
]);
const expected = packageJson.version;

if (
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
    expected,
  )
)
  throw new Error(`Invalid package version: ${expected}`);

const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length > 0)
  throw new Error(
    `Release version mismatch; expected ${expected}:\n${mismatches
      .map(([location, version]) => `- ${location}: ${String(version)}`)
      .join("\n")}`,
  );

console.log(`release versions match ${expected}`);
