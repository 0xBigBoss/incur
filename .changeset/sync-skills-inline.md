---
'@0xbigboss/incur': minor
---

Add `sync.skills` option for inline SKILL.md content

`Cli.create({ sync: { skills: [{ name, content }] } })` now accepts
pre-resolved SKILL.md entries alongside the existing `include` globs.
This is the build-time escape hatch for CLIs compiled into single-file
executables (e.g. `bun build --compile`): the caller bakes the SKILL.md
body in via a text import and passes the string through, so
`skills add` can install it without needing the source tree at runtime.

Inline entries yield to same-name skills produced by the command
generator or by `include`, so dev-mode filesystem edits stay
authoritative.
