# Contributing

Open an issue before a broad behavioral change. Keep pull requests focused and
include regression tests for public output, exit codes, filesystem safety, and
real Semgrep behavior where relevant. Never add a provider call or mutation to a
read-only command. Generated artifacts remain owned by their canonical manifest.

Run the clean-clone release gate before requesting review:

```sh
python3 -m venv .venv && .venv/bin/pip install semgrep==1.175.0
PATH="$PWD/.venv/bin:$PATH" npm ci && PATH="$PWD/.venv/bin:$PATH" npm run release:check
```

Use conventional, meaningful commits. By contributing, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
