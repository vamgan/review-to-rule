import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig, resolveCoreConfig } from "../../src/config.js";
import {
  OpenAIProvider,
  AnthropicProvider,
  type JsonTransport,
} from "../../src/llm/adapters.js";
import { buildAnalysisRequest, FakeProvider } from "../../src/llm/provider.js";
import { correctionCandidateSchema } from "../../src/domain/schemas.js";

const candidate = correctionCandidateSchema.parse({
  path: "src/a.ts",
  language: "typescript",
  intentSummary: "inject clock",
  before: "Date.now()",
  after: "clock.now()",
  evidence: ["diff"],
  confidence: 1,
});

describe("configuration precedence and provider selection", () => {
  it("keeps agent mode independent from standalone provider configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rtr-core-config-"));
    await writeFile(
      join(directory, ".review-to-rule.yml"),
      "version: 1\nprovider: private-enterprise-model\nmodel: [stale]\nbaseUrl: not-a-url\nbranchPrefix: false\nlabels: stale\noutputDir: quality/reviews\n",
    );
    await expect(
      resolveCoreConfig(
        {},
        {
          cwd: directory,
          env: {
            OPENAI_API_KEY: "present",
            ANTHROPIC_API_KEY: "also-present",
            REVIEW_TO_RULE_MODEL: "   ",
            REVIEW_TO_RULE_BASE_URL: "not-a-url",
          },
        },
      ),
    ).resolves.toMatchObject({
      outputDir: "quality/reviews",
      policyTarget: "neither",
    });
  });

  it.each(["outputDir", "agentsPath", "claudePath"] as const)(
    "rejects unsafe %s values from CLI, file, and environment before provider work",
    async (field) => {
      const environmentName = {
        outputDir: "REVIEW_TO_RULE_OUTPUT_DIR",
        agentsPath: "REVIEW_TO_RULE_AGENTS_PATH",
        claudePath: "REVIEW_TO_RULE_CLAUDE_PATH",
      }[field];
      for (const invalid of [
        "../outside",
        "/absolute/path",
        "C:\\drive",
        "rules/*.yml",
        "rules/unsafe\u202Ename",
      ]) {
        await expect(
          resolveConfig(
            { fixture: "injected-clock", [field]: invalid },
            { env: {} },
          ),
        ).rejects.toThrow(new RegExp(field, "i"));
        const directory = await mkdtemp(join(tmpdir(), "rtr-config-path-"));
        await writeFile(
          join(directory, ".review-to-rule.yml"),
          `version: 1\n${field}: ${JSON.stringify(invalid)}\n`,
        );
        await expect(
          resolveConfig(
            { fixture: "injected-clock" },
            { cwd: directory, env: {} },
          ),
        ).rejects.toThrow(new RegExp(field, "i"));
        await expect(
          resolveConfig(
            { fixture: "injected-clock" },
            { env: { [environmentName]: invalid } },
          ),
        ).rejects.toThrow(new RegExp(field, "i"));
      }
    },
  );

  it("rejects whitespace-only models from every configuration source", async () => {
    await expect(
      resolveConfig({ fixture: "injected-clock", model: "   " }, { env: {} }),
    ).rejects.toThrow(/model/i);
    const directory = await mkdtemp(join(tmpdir(), "rtr-config-model-"));
    await writeFile(
      join(directory, ".review-to-rule.yml"),
      'version: 1\nmodel: "   "\n',
    );
    await expect(
      resolveConfig({ fixture: "injected-clock" }, { cwd: directory, env: {} }),
    ).rejects.toThrow(/model/i);
    await expect(
      resolveConfig(
        { fixture: "injected-clock" },
        { env: { REVIEW_TO_RULE_MODEL: "   " } },
      ),
    ).rejects.toThrow(/model/i);
  });

  it("applies CLI over config over env over defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rtr-config-"));
    await writeFile(
      join(directory, "config.yml"),
      "version: 1\nprovider: openai\nmodel: from-file\nconfidenceFloor: 0.7\n",
    );
    const config = await resolveConfig(
      { config: "config.yml", model: "from-cli" },
      {
        cwd: directory,
        env: { OPENAI_API_KEY: "secret", REVIEW_TO_RULE_MODEL: "from-env" },
      },
    );
    expect(config).toMatchObject({
      provider: "openai",
      model: "from-cli",
      confidenceFloor: 0.7,
      configPath: join(directory, "config.yml"),
    });
  });

  it("uses validated environment settings below file and CLI values", async () => {
    const config = await resolveConfig(
      { fixture: "injected-clock" },
      {
        env: {
          REVIEW_TO_RULE_OUTPUT_DIR: "generated/review-rules",
          REVIEW_TO_RULE_CONFIDENCE_FLOOR: "0.91",
          REVIEW_TO_RULE_MATCH_LIMIT: "25",
          REVIEW_TO_RULE_POLICY_TARGET: "neither",
        },
      },
    );
    expect(config).toMatchObject({
      outputDir: "generated/review-rules",
      confidenceFloor: 0.91,
      matchLimit: 25,
    });
  });

  it("fails closed on ambiguous credentials and fake live use", async () => {
    await expect(
      resolveConfig(
        {},
        { env: { OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" } },
      ),
    ).rejects.toThrow(/ambiguous/i);
    await expect(
      resolveConfig({ provider: "fake" }, { env: {} }),
    ).rejects.toThrow(/fixture/i);
    await expect(
      resolveConfig(
        { provider: "openai", model: "claude-sonnet-4" },
        { env: { OPENAI_API_KEY: "present" } },
      ),
    ).rejects.toThrow(/incompatible/i);
    await expect(
      resolveConfig(
        { provider: "anthropic", model: "gpt-5" },
        { env: { ANTHROPIC_API_KEY: "present" } },
      ),
    ).rejects.toThrow(/incompatible/i);
  });
});

describe("official provider adapters", () => {
  it.each([OpenAIProvider, AnthropicProvider])(
    "requests schema-constrained JSON and validates it",
    async (Provider) => {
      const calls: Parameters<JsonTransport["request"]>[0][] = [];
      const fake = new FakeProvider();
      const decision = await fake.analyze(
        buildAnalysisRequest("Inject clock", candidate),
      );
      const transport: JsonTransport = {
        request: (input) => {
          calls.push(input);
          return Promise.resolve(JSON.stringify(decision));
        },
      };
      const provider = new Provider({ model: "test-model", transport });
      await expect(
        provider.analyze(buildAnalysisRequest("Inject clock", candidate)),
      ).resolves.toEqual(decision);
      expect(calls[0]).toMatchObject({ model: "test-model", name: "decision" });
      expect(calls[0]?.schema).toHaveProperty("type", "object");
    },
  );

  it("rejects malformed structured output without leaking credentials", async () => {
    const transport: JsonTransport = {
      request: () =>
        Promise.resolve('{"enforceable":"yes","token":"sk-secret"}'),
    };
    const provider = new OpenAIProvider({ model: "test", transport });
    await expect(
      provider.analyze(buildAnalysisRequest("Inject clock", candidate)),
    ).rejects.toThrow(/invalid decision JSON/i);
  });
});
