# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Jaka1603/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Jaka1603/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only. One
in-memory store sits behind four surfaces, so an object created on any of them is the
same object on all of them:

- **git smart HTTP** — `info/refs` advertisements in protocol v0 and v2, v2 `ls-refs`
  with ref-prefix filtering and peeled tags, `fetch` with have negotiation, shallow
  clones and deepen, and `receive-pack` pushes with fast-forward enforcement and a
  side-band report-status. Packfiles are read and written from scratch (SHA-1 object
  ids, OFS/REF delta resolution, tree ordering), never via a git binary.
- **REST v3** — repositories, refs, branches, commits, the contents API (create,
  update with sha checks, delete, directory listings), labels, issues and comments,
  and pull requests with file diffs and three-way merges. JSON everywhere, a
  `message` on every error, `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** — the documents `gh` and github-mcp-server send: viewer and
  repository reads, issue/pull-request connections with cursor pagination, the
  create/close/merge/comment mutations, Relay `node(id:)` with opaque stable global
  ids, batched operations, and the `__type` introspection those clients
  feature-detect with.
- **MCP** — `POST /mcp` speaking JSON-RPC 2.0: `server/discover` (2026-07-28) plus
  the legacy `initialize` handshake, and the github-mcp-server core tools
  (create/get repository, create/list/get issue, create/list/merge pull request,
  comment), all over the same store as REST.

Everything is deterministic: timestamps come from a logical clock, so a replayed
trial produces byte-identical answers. Authentication is the trial's bearer token;
the same repository name under another owner reads as 404, never 403.

## Run it

```sh
node main.ts
# The harness provides $MAKEFUN_ENV_URL; the server binds an ephemeral port,
# registers it, serves until the env says done, and exits 0.
```

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, wait for done). Unchanged starter.
- `app.ts` — the HTTP server: routing, the auth gate, request ids.
- `forge.ts` — the shared in-memory store and domain logic (graph walks, merges, fetch selection).
- `gitstore.ts` — the git object model and packfile codec.
- `githttp.ts` — git smart HTTP (advertisements, ls-refs, fetch, receive-pack).
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — the GraphQL v4 parser and executor.
- `mcp.ts` — the MCP endpoint and tools.

MIT licensed.

---

<sub>Entered on [make.fun](https://make.fun/?ref=md16tqa0&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
