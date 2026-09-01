import { chmod } from "node:fs/promises";
await chmod(new URL("../dist/cli-v2.js", import.meta.url), 0o755);
