# The MCP layer

Plan §50 and Phase 8. Turning the API into the tool layer an agent reaches for.

```
POST /mcp        JSON-RPC 2.0 over Streamable HTTP
GET  /mcp        endpoint metadata, no key required
Authorization    Bearer sk_live_… — the same API key as everything else
```

## Every tool call re-enters the API through its own front door

`createMcpRoute` is wired with `app.fetch`. A `create_post` tool call becomes a real
`POST /v1/posts` against this same application: the same request-context middleware, the
same authentication, the same scope check, the same tenancy resolution, the same handler.

Plan §50 says "do not create new business logic inside MCP." Dispatching through the app
makes that a structural property rather than a convention somebody has to keep remembering.
It also means an agent cannot get a capability a REST caller could not: a key with only
`profiles:read` gets `INSUFFICIENT_SCOPE` from a tool call, and a profile-restricted key
restricts an agent exactly as it restricts a script.

## Two protocol revisions, one implementation

| Revision     | Shape                                                              |
| ------------ | ------------------------------------------------------------------ |
| `2026-07-28` | Stateless. No handshake, no session id. Version and client info in `_meta`, `resultType` on results, cache hints on lists. |
| `2025-06-18` | The `initialize` / `notifications/initialized` handshake.          |

Negotiated **per request**, which is the point of the newer revision — a stateless server
never has to remember which era a caller belongs to, and can sit behind a plain round-robin
load balancer.

Detection, in order:

1. An `initialize` call is conclusive. The 2026 revision deleted that method, so a client
   sending it is older, regardless of any header an intermediary added.
2. `_meta["io.modelcontextprotocol/protocolVersion"]` — the source of truth per the 2026
   transport spec.
3. The `MCP-Protocol-Version` header, which mirrors the body for intermediaries that route
   without parsing it.
4. Nothing declared → assume the newest. That is right far more often than assuming the
   oldest, and a stateless response is a superset an older client tolerates.

The legacy handshake is answered rather than refused. A client on 2025-06-18 is not
misconfigured, it is older than the revision that removed the method, and rejecting it would
break a working integration on our schedule instead of theirs.

## Errors reach the model, not the transport

A failing tool call returns a **tool error**, not a JSON-RPC error:

```json
{
  "content": [{ "type": "text", "text": "{ \"error\": { \"code\": \"MEDIA_TOO_LARGE\", \"agent_action\": \"compress_the_media\" } }" }],
  "isError": true,
  "resultType": "complete"
}
```

A JSON-RPC error is a transport fault. Some clients never surface one to the model, and none
of them let it act on the contents. Our error envelope carries a stable code and an
`agent_action` naming the next step — handing that through as tool output is what makes
recovery possible, and collapsing it into an error string throws away the structure the
agent-native design (plan §16) exists to provide.

Bad arguments are reported the same way, with the specific field problems, so the model can
fix the call rather than being told the transport failed.

## The tool set is small on purpose

Plan §50: *"Do not expose 300+ tools in every prompt context."*

Fifteen curated tools, plus `search_tools` for everything else. An agent's context is
finite, and a server that dumps its whole surface into every prompt has spent the model's
attention before the task begins. A test enforces the ceiling.

Tools carry `readOnlyHint` / `destructiveHint` annotations, so a client can require
confirmation before publishing and an agent policy can separate reading from acting
(plan §48.6).

## The instructions front-load the two mistakes agents make

Returned from `initialize` and `server/discover`:

1. **`create_post` returns 202, not a published post.** Publishing is asynchronous, and
   partial success is normal. An agent that treats the 202 as done will report success for
   posts that failed.
2. **Never guess a platform limit.** `get_capabilities` and `compose_post` give the real
   ones for that specific account, which differ by account type and approval state.

Both are cheap to say once and expensive to discover by trial.

## Idempotency

`create_post` requires an idempotency key. When the caller omits one, the dispatcher
generates it.

That protects the case that matters most in an agent loop — a dropped response leading to
an immediate retry of the same call — but it cannot deduplicate two calls the agent
*decided* to make. The tool description says exactly that rather than implying more safety
than exists, and an agent running a job it may re-run should pass its own key.

## Batches run sequentially

JSON-RPC allows batching and some clients use it. Two `create_post` calls executed in
parallel would race the idempotency reservation, and the whole point of that reservation is
that concurrent identical calls produce one post.

## What is deliberately not here yet

**OAuth 2.1 for MCP** (plan §51). Static API keys are what most agent deployments actually
hold today, and the scoped-token model layers on top of this rather than replacing it —
short-lived tokens narrowed to specific profiles and actions become the foundation of agent
governance in Phase 9.

**Resources and prompts.** Both MCP features are real, and neither has a use here that a
tool does not already serve better. Advertising empty capabilities would only cost every
client a round trip.

## Related

- Plan §50, §51, §16, §48
- [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28)
