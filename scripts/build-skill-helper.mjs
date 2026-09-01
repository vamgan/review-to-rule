import { build } from "esbuild";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(repositoryRoot, "src/skill-helper.ts");
const output = resolve(
  repositoryRoot,
  ".agents/skills/review-to-rule-write/scripts/review-to-rule.mjs",
);
const check = process.argv.includes("--check");

if (!check) await mkdir(dirname(output), { recursive: true });

const result = await build({
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  minify: true,
  legalComments: "inline",
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  write: !check,
});

if (check) {
  const generated = result.outputFiles?.[0]?.contents;
  if (!generated) throw new Error("esbuild returned no skill helper output");
  const committed = await readFile(output);
  if (!committed.equals(generated))
    throw new Error(
      "Bundled skill helper is stale. Run npm run build:skill-helper.",
    );
} else {
  await chmod(output, 0o755);
}
