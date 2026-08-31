import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPublicCli } from "../build-public-cli.js";
import { generationResultSchema } from "../../src/domain/schemas.js";
import {
  semgrepAvailable,
  semgrepSkipReason,
} from "../semgrep-availability.js";

const root = new URL("../..", import.meta.url).pathname;
const cli = new URL("../../dist/cli.js", import.meta.url).pathname;
const review = "https://github.com/acme/clock/pull/42#discussion_r1001";
const reviewBundle = new URL(
  "../../examples/review-bundle/gitlab-tenant-scope.json",
  import.meta.url,
).pathname;
const env = {
  ...process.env,
  GITHUB_TOKEN: undefined,
  GH_TOKEN: undefined,
  OPENAI_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
};

function run(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd ?? root,
      env: options.env ?? env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("built public CLI", () => {
  beforeAll(() => buildPublicCli());

  it("has executable help/version and all generation options", async () => {
    const help = await run(["generate", "--help"]);
    expect(help.status).toBe(0);
    for (const flag of [
      "--repo-dir",
      "--provider",
      "--model",
      "--write",
      "--open-pr",
      "--yes",
      "--json",
      "--debug",
      "--allow-open-pr",
      "--allow-unresolved",
      "--output-dir",
      "--config",
    ])
      expect(help.stdout).toContain(flag);
    expect((await run(["--version"])).stdout.trim()).toBe("0.2.0");
    const replayHelp = await run(["replay", "--help"]);
    expect(replayHelp.status).toBe(0);
    expect(replayHelp.stdout).toContain("<manifest-path>");
    const evidenceHelp = await run(["evidence", "--help"]);
    expect(evidenceHelp.status).toBe(0);
    expect(evidenceHelp.stdout).toContain("<review-comment-url>");
    const applyHelp = await run(["apply", "--help"]);
    expect(applyHelp.status).toBe(0);
    expect(applyHelp.stdout).toContain("<bundle-path>");
    expect(applyHelp.stdout).not.toContain("--provider");
    const doctorHelp = await run(["doctor", "--help"]);
    expect(doctorHelp.status).toBe(0);
    expect(doctorHelp.stdout).toContain("--agent");
    expect(statSync(cli).mode & 0o111).not.toBe(0);
  });

  it.skipIf(!semgrepAvailable)(
    semgrepAvailable
      ? "makes root and explicit generate forms deeply equivalent"
      : `makes root and explicit generate forms deeply equivalent (${semgrepSkipReason})`,
    async () => {
      const [explicit, alias] = await Promise.all([
        run(["generate", review, "--fixture", "injected-clock", "--json"]),
        run([review, "--fixture", "injected-clock", "--json"]),
      ]);
      expect(explicit.status).toBe(0);
      expect(alias.status).toBe(0);
      expect(JSON.parse(explicit.stdout)).toEqual(JSON.parse(alias.stdout));
      generationResultSchema.parse(JSON.parse(explicit.stdout));
      const human = await run([
        "generate",
        review,
        "--fixture",
        "injected-clock",
      ]);
      expect(human.stdout).toContain(
        `Replay this successful dry run: review-to-rule generate '${review}' --fixture 'injected-clock'`,
      );
      expect(human.stdout).toContain("Suggested write command:");
      expect(human.stdout).toContain("--write --policy-target 'neither'");
    },
    60_000,
  );

  it.skipIf(!semgrepAvailable)(
    semgrepAvailable
      ? "validates host-agent evidence without GitHub or model credentials"
      : `validates host-agent evidence (${semgrepSkipReason})`,
    async () => {
      const repository = mkdtempSync(join(tmpdir(), "rtr-agent-cli-"));
      mkdirSync(join(repository, "src"), { recursive: true });
      writeFileSync(
        join(repository, "src/invoices.ts"),
        "const invoices = db.invoice.findMany({ where: { tenantId } });\n",
      );
      execFileSync("git", ["init", "-q"], { cwd: repository });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repository,
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: repository,
      });
      execFileSync("git", ["add", "src/invoices.ts"], { cwd: repository });
      execFileSync("git", ["commit", "-qm", "accepted correction"], {
        cwd: repository,
      });

      const generated = await run(
        ["apply", reviewBundle, "--repo-dir", repository, "--json"],
        { cwd: repository },
      );
      expect(generated.status, generated.stderr).toBe(0);
      const result = generationResultSchema.parse(JSON.parse(generated.stdout));
      expect(result.provider).toEqual({
        name: "host-agent",
        model: "agent-context",
      });
      expect(result.source?.source?.reviewSystem).toBe("gitlab");
      expect(
        result.validation?.checks.every((check) => check.status !== "failed"),
      ).toBe(true);
      expect(existsSync(join(repository, ".review-to-rule"))).toBe(false);

      const doctor = await run(
        ["doctor", "--agent", "--repo-dir", repository, "--json"],
        { cwd: repository },
      );
      expect(doctor.status, doctor.stderr).toBe(0);
      const checks = (
        JSON.parse(doctor.stdout) as {
          checks: Array<{ name: string; status: string }>;
        }
      ).checks;
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "gh", status: "skip" }),
          expect.objectContaining({ name: "github-auth", status: "skip" }),
          expect.objectContaining({
            name: "provider-credential",
            status: "skip",
          }),
        ]),
      );
    },
    60_000,
  );

  it("rejects malformed URLs without creating artifacts", async () => {
    const failure = await run([
      "https://github.com/acme/clock/issues/42#discussion_r1001",
      "--fixture",
      "injected-clock",
      "--json",
    ]);
    expect(failure.status).toBe(6);
    expect(
      generationResultSchema.parse(JSON.parse(failure.stdout)).status,
    ).toBe("unsupported");
    expect(existsSync(`${root}/.review-to-rule`)).toBe(false);
  });

  it("keeps early configuration failures machine-readable", async () => {
    const failure = await run([
      "generate",
      review,
      "--provider",
      "fake",
      "--json",
    ]);
    expect(failure.status).toBe(4);
    expect(failure.stderr).toBe("");
    expect(
      generationResultSchema.parse(JSON.parse(failure.stdout)).errors[0]?.kind,
    ).toBe("configuration");
  });

  it("rejects effective paths and models before provider selection", async () => {
    for (const args of [
      ["--output-dir", "../outside"],
      ["--agents-path", "policies/*.md"],
      ["--claude-path", "C:\\CLAUDE.md"],
      ["--model", "   "],
    ]) {
      const failure = await run(["generate", review, ...args, "--json"]);
      expect(failure.status).toBe(4);
      const error = generationResultSchema.parse(JSON.parse(failure.stdout))
        .errors[0];
      expect(error?.message).toMatch(/outputDir|agentsPath|claudePath|model/i);
      expect(error?.message).not.toMatch(/api key|provider.*selected/i);
    }
  });

  it("reports concise missing and extra argument usage errors", async () => {
    expect((await run(["generate"])).status).not.toBe(0);
    expect((await run(["generate", review, "extra"])).status).not.toBe(0);
  });

  it("routes Commander usage failures through one versioned JSON object", async () => {
    for (const args of [
      ["generate", "--json"],
      ["validate-all", "one", "two", "--json"],
      ["scan", "--json"],
      ["unknown-command", "extra", "--json"],
    ]) {
      const result = await run(args);
      expect(result.status).toBe(6);
      expect(result.stderr).toBe("");
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        schemaVersion: 1,
        status: "unsupported",
        errors: [{ kind: "usage" }],
      });
    }
  });

  it("commits command output and a sanitized debug bundle as one public transaction", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rtr-debug-bundle-public-"));
    const seeded = {
      ...env,
      NODE_ENV: "test",
      OPENAI_API_KEY: "seeded-secret-must-not-appear",
    };
    const failed = await run(
      [
        "doctor",
        "--json",
        "--debug-bundle",
        "diagnostics/report.json",
        "--yes",
      ],
      {
        cwd,
        env: {
          ...seeded,
          REVIEW_TO_RULE_TEST_DEBUG_BUNDLE_FAILURE: "after-write",
        },
      },
    );
    expect(failed.status).toBe(5);
    expect(failed.stderr).toBe("");
    expect(failed.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      schemaVersion: 1,
      status: "unsafe_repository",
      errors: [{ kind: "unsafe_repository" }],
    });
    expect(existsSync(join(cwd, "diagnostics/report.json"))).toBe(false);
    expect(existsSync(join(cwd, "diagnostics"))).toBe(false);

    const declined = await run(
      ["doctor", "--json", "--debug-bundle", "declined.json"],
      { cwd, env: seeded },
    );
    expect(declined.status).toBe(5);
    expect(declined.stdout.trim().split("\n")).toHaveLength(1);

    writeFileSync(join(cwd, "existing.json"), "user-owned\n");
    const outside = mkdtempSync(join(tmpdir(), "rtr-debug-outside-"));
    symlinkSync(outside, join(cwd, "linked"));
    for (const path of ["../escape.json", "existing.json", "linked/out.json"]) {
      const unsafe = await run(
        ["doctor", "--json", "--debug-bundle", path, "--yes"],
        { cwd, env: seeded },
      );
      expect(unsafe.status, path).toBe(5);
      expect(unsafe.stderr, path).toBe("");
      expect(unsafe.stdout.trim().split("\n"), path).toHaveLength(1);
      expect(JSON.parse(unsafe.stdout), path).toMatchObject({
        schemaVersion: 1,
        status: "unsafe_repository",
      });
    }

    const success = await run(
      [
        "doctor",
        "--json",
        "--debug-bundle",
        "diagnostics/success.json",
        "--yes",
      ],
      { cwd, env: seeded },
    );
    expect(success.stdout.trim().split("\n")).toHaveLength(1);
    const bundle = readFileSync(join(cwd, "diagnostics/success.json"), "utf8");
    expect(bundle).toContain('"status": "sanitized"');
    expect(bundle).not.toContain("seeded-secret-must-not-appear");
  });

  it.skipIf(!semgrepAvailable)(
    semgrepAvailable
      ? "requires current-CLI policy consent and exposes the complete structured preview"
      : semgrepSkipReason,
    async () => {
      const makeRepo = () => {
        const directory = mkdtempSync(join(tmpdir(), "rtr-public-cli-"));
        execFileSync("git", ["init", "-q"], { cwd: directory });
        execFileSync("git", ["config", "user.email", "test@example.com"], {
          cwd: directory,
        });
        execFileSync("git", ["config", "user.name", "Test"], {
          cwd: directory,
        });
        writeFileSync(join(directory, "README.md"), "target\n");
        execFileSync("git", ["add", "README.md"], { cwd: directory });
        execFileSync("git", ["commit", "-qm", "initial"], {
          cwd: directory,
        });
        return directory;
      };
      const implicit = makeRepo();
      const config = join(implicit, "config.yml");
      writeFileSync(
        config,
        "version: 1\nprovider: fake\npolicyTarget: agents\n",
      );
      const refused = await run([
        "generate",
        review,
        "--fixture",
        "injected-clock",
        "--repo-dir",
        implicit,
        "--config",
        config,
        "--write",
        "--yes",
        "--json",
      ]);
      expect(refused.status).toBe(5);
      expect(existsSync(join(implicit, "AGENTS.md"))).toBe(false);

      const explicit = makeRepo();
      const accepted = await run([
        "generate",
        review,
        "--fixture",
        "injected-clock",
        "--repo-dir",
        explicit,
        "--write",
        "--yes",
        "--policy-target",
        "agents",
        "--json",
      ]);
      expect(accepted.status).toBe(0);
      const parsed = generationResultSchema.parse(JSON.parse(accepted.stdout));
      expect(parsed.preview?.policyExplicit).toBe(true);
      expect(
        parsed.preview?.artifacts.some((file) => file.path === "AGENTS.md"),
      ).toBe(true);
      expect(parsed.preview?.discovery.artifactState.path).toBe(
        ".review-to-rule",
      );
      expect(parsed.preview?.policyFiles[0]?.diff).toContain("+++ b/AGENTS.md");
      rmSync(implicit, { recursive: true, force: true });
      rmSync(explicit, { recursive: true, force: true });
    },
    60_000,
  );

  it.skipIf(!semgrepAvailable)(
    semgrepAvailable
      ? "refuses a symlinked artifact root without traversing external ownership"
      : semgrepSkipReason,
    async () => {
      const repository = mkdtempSync(join(tmpdir(), "rtr-symlink-root-"));
      execFileSync("git", ["init", "-q"], { cwd: repository });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repository,
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: repository,
      });
      writeFileSync(join(repository, "README.md"), "target\n");
      execFileSync("git", ["add", "README.md"], { cwd: repository });
      execFileSync("git", ["commit", "-qm", "initial"], { cwd: repository });
      const outside = mkdtempSync(join(tmpdir(), "rtr-external-root-"));
      mkdirSync(join(outside, "manifests"));
      const sentinel = join(outside, "manifests", "external.json");
      writeFileSync(sentinel, '{"canary":"must-not-be-read-or-changed"}\n');
      const before = readFileSync(sentinel);
      symlinkSync(outside, join(repository, ".review-to-rule"));
      const result = await run([
        "generate",
        review,
        "--fixture",
        "injected-clock",
        "--repo-dir",
        repository,
        "--json",
      ]);
      expect(result.status).toBe(5);
      const parsed = generationResultSchema.parse(JSON.parse(result.stdout));
      expect(parsed.status).toBe("unsafe_repository");
      expect(parsed.errors[0]?.message).toMatch(/symlink/i);
      expect(result.stdout).not.toContain("canary");
      expect(readFileSync(sentinel)).toEqual(before);
      rmSync(repository, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
    60_000,
  );
});
