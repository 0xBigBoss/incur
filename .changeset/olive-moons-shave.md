---
'@0xbigboss/incur': patch
---

Pin `@modelcontextprotocol/server` to an exact version instead of a caret range
over a prerelease.

The dependency was declared as `^2.0.0-alpha.2` — a caret range on a
prerelease, which permits resolution to drift across *any* 2.x prerelease. It
landed on `2.0.0-beta.5`, which no longer exports `StdioServerTransport`, so
`src/Mcp.ts` failed at import with:

```
SyntaxError: Export named 'StdioServerTransport' not found in module
  @modelcontextprotocol/server@2.0.0-beta.5
```

Every consumer's test suite broke on module load, not just MCP usage.

Widening to `^2.0.0` would not have fixed it. Stable `2.0.0` does not keep
`StdioServerTransport` on the package root either — it relocated the symbol
behind a `./stdio` subpath, leaving only `McpServer` on the root — so the
import would still have thrown, just for a different reason.

The range itself is the defect, so this pins `2.0.0-alpha.2` exactly: the one
version whose export shape matches what `src/Mcp.ts` imports. No range means
no drift.
