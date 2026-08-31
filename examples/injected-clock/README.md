# Injected clock offline fixture

The accepted correction replaces direct `Date.now()` access with an injected `Clock`. The small `repository/` tree intentionally retains one legacy match under `src/token.ts` so the demo can show normalized repository scanning. A second direct call under `other/` proves that the generated rule executes only its declared include scope.
