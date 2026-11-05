# @warden/uniswap-agent-mcp

Warden's own Uniswap MCP server: a [Model Context Protocol](https://modelcontextprotocol.io)
server over streamable HTTP that exposes Uniswap read tools (quotes, pools, hooks, positions)
and build tools (unsigned swap / LP / transfer transactions) to the Warden agent.

Design rules (from `PHASE_00_CONTEXT.md` §8):

- **Never holds keys and never signs.** Build tools that need an EIP-712 signature return
  `status: "NEEDS_SIGNATURE"` with the typed data; the backend signs at execution time and calls
  the same tool again with `signature`.
- Uses the Uniswap Trading API, the Uniswap LP API, Uniswap v4 contracts and the official v4
  subgraph.
- Every tool input and output is validated with Zod.

Status: package placeholder — the server and its 16 tools are implemented in **PHASE 02**.
