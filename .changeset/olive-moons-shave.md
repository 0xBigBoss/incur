---
'@0xbigboss/incur': patch
---

Pin `@modelcontextprotocol/server` to stable 2.x instead of a prerelease range.

The dependency was declared as `^2.0.0-alpha.2` — a caret range on a
prerelease, which permits resolution to drift across *any* 2.x prerelease. It
landed on `2.0.0-beta.5`, which no longer exports `StdioServerTransport`, so
`src/Mcp.ts` failed at import with:

```
SyntaxError: Export named 'StdioServerTransport' not found in module
  @modelcontextprotocol/server@2.0.0-beta.5
```

Every consumer's test suite broke on module load, not just MCP usage.
`^2.0.0` excludes prereleases and resolves to stable `2.0.0`, which exports the
symbol.
