---
'@0xbigboss/incur': patch
---

fix(Parser): accept `--no-<x>` as a literal `noX` boolean field when `--<x>` is not registered

Schemas declaring a literal `noConnect: z.boolean()` (or any `no<X>` field) could not be
set via `--no-connect` on the CLI, even though `--help` rendered the flag in kebab-case.
The parser now tries both resolutions:

1. If `<x>` is a registered boolean, `--no-<x>` negates it (existing behavior, preserved).
2. Otherwise, if `no<X>` is registered, `--no-<x>` sets it to `true` (new path).
3. Otherwise, throw `Unknown flag: --no-<x>` (existing behavior, preserved).

When both `<x>` and `no<X>` exist, the negation shortcut wins for backwards compatibility.
