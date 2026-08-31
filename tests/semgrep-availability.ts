import { spawnSync } from "node:child_process";

export const semgrepAvailable =
  spawnSync("semgrep", ["--version"], { stdio: "ignore", shell: false })
    .status === 0;

export const semgrepSkipReason =
  "Semgrep is not installed locally; install it with `pipx install semgrep`. CI runs this suite mandatorily.";
