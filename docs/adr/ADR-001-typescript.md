# ADR-001 — TypeScript end to end

**Status:** Accepted
**Date:** 2026-08-07
**Plan reference:** §4.1

## Context

The platform spans a public REST API at the edge, queue consumers, durable workflows, provider
adapters, a dashboard, an SDK, an OpenAPI document and (later) an MCP server. Every one of these
surfaces shares the same domain vocabulary: profiles, connections, destinations, posts, targets,
capabilities.

If those surfaces are written in different languages, the shared vocabulary has to be re-expressed
and re-validated at every boundary, and it drifts. The single largest source of bugs in a unified
API is a contract that means one thing in the publishing engine and a slightly different thing in
the dashboard or the SDK.

A common counter-argument is that integrating many third-party APIs and LLMs implies Python. It does
not. Social providers, CMS systems and model vendors all expose HTTP APIs.

## Decision

Use TypeScript for the entire product: API Worker, provider adapters, queue consumers, workflows,
dashboard, SDK, MCP server, validation schemas and shared domain contracts.

One Zod schema in `@gs/contracts` is simultaneously:

- the runtime request validator in the API Worker,
- the compile-time type in the domain layer,
- the OpenAPI schema,
- the generated SDK type,
- the MCP tool input schema.

Do not introduce Go, Rust or Python into the main product.

## Consequences

- Contract drift between API, dashboard, SDK and agent surface becomes a type error rather than a
  production incident.
- Web Crypto, `fetch`, `Request`/`Response` and streams work identically in Workers and in tests, so
  adapters need no runtime shims.
- We accept TypeScript's weaker story for CPU-bound work. This is fine: the edge runtime does not do
  CPU-bound work. Media transcoding is explicitly out of process (ADR-005, plan §32).
- Solo/small-team maintenance cost stays low — one toolchain, one lint config, one test runner.

## Alternatives considered

**Go for the publishing engine.** Better concurrency primitives, but the engine's work is I/O
orchestration, not computation, and it would fragment the contract layer.

**Python for the Content Intelligence layer.** Rejected for the main path per plan §4.1. Python is
permitted later for an *isolated* workload with a measured ecosystem advantage (for example
ML-driven video analysis), never as a second general backend.

## Escape hatch

A separate media-transcoding service may use a containerized FFmpeg worker in Node/TypeScript, or Go
if benchmarking proves it necessary. It communicates over a queue, so its language is an
implementation detail invisible to the core.
