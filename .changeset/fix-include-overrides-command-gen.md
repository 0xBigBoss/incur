---
'@0xbigboss/incur': patch
---

fix(SyncSkills): `sync.include` now fully overrides a command-generated
skill with the same frontmatter name.

Before this fix, `Skill.split` wrote the command-generated file to a
`tmpDir` directory named after the bucket key (e.g. `tmpDir/auth/SKILL.md`
for a subcommand group `<cli> auth ...`), while `sync.include` wrote the
hand-authored file to a directory named after the frontmatter slug (e.g.
`tmpDir/<cli>-auth/SKILL.md`). Two files with the same frontmatter
`name:` then landed in the staging tree, and `Agents.install()`'s
`discoverSkills` walk picked up both — emitting a duplicate entry in
`result.paths` and a mismatched description in the `skills add` progress
display. The tracking array also short-circuited on `skills.some(...)`,
so the hand-authored description was silently shadowed by the
command-generated one.

Command generation now stages files under the frontmatter name, so a
later `include` match overwrites the staged file in place; and the
include loop replaces the corresponding `skills[]` entry instead of
skipping it. The `Agents.install()` return value is now a single path
per skill, and `result.skills` reflects the hand-authored description
and `external: true` flag.
