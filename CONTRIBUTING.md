# Contributing

Open an issue before a broad behavioral change. Keep pull requests focused and
include regression tests for public output, exit codes, filesystem safety,
evidence integrity, and scope behavior. Never add a provider call or mutation
to a read-only command. Generated artifacts remain owned by their manifest.

Run the clean-clone release gate before requesting review:

```sh
npm ci
npm run release:check
```

Use conventional, meaningful commits. By contributing, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

Do not mix a package version change into a feature or fix. Maintainers release
from a dedicated version-only pull request after the product change has landed.
