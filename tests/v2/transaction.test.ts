import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commitTransaction,
  type TransactionPlan,
} from "../../src/transaction.js";
import { ProcessCommandRunner } from "../../src/utils/command.js";

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "review-to-rule-transaction-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "owned.txt"), "original\n");
  execFileSync("git", ["add", "owned.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("durable transaction", () => {
  it("rolls every target back when a later replacement fails", async () => {
    const root = await repository();
    const plan: TransactionPlan = {
      outputDir: ".review-to-rule",
      collision: "replace_same_source",
      files: [
        {
          path: "owned.txt",
          content: "replacement\n",
          kind: "artifact",
          action: "replace",
        },
        {
          path: ".review-to-rule/new.txt",
          content: "new\n",
          kind: "artifact",
          action: "create",
        },
      ],
      ownedFiles: ["owned.txt", ".review-to-rule/new.txt"],
      ownerManifest: {
        ownedFiles: ["owned.txt", ".review-to-rule/new.txt"],
      },
    };
    await expect(
      commitTransaction({
        repositoryDir: root,
        plan,
        runner: new ProcessCommandRunner(),
        inject: ({ phase, index }) => {
          if (phase === "after_backup" && index === 1)
            return Promise.reject(new Error("injected failure"));
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/rolled back/i);
    expect(await readFile(join(root, "owned.txt"), "utf8")).toBe("original\n");
    await expect(
      readFile(join(root, ".review-to-rule/new.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
