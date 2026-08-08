import { ErrorEnvelopeSchema, HealthResponseSchema, MeResponseSchema } from '@gs/contracts/http';
import { ERROR_CODE_METADATA, type ErrorCode } from '@gs/errors';
import { z } from 'zod';

/**
 * OpenAPI document, generated from the same Zod schemas the routes validate with
 * (plan §85 Rule 5). Generating rather than hand-writing is the point: a schema and its
 * documentation cannot drift when there is only one of them.
 *
 * Zod v4 emits JSON Schema natively, so no additional OpenAPI dependency is pulled in.
 * `io: 'output'` matters — a schema with defaults or transforms has a wider input type
 * than output type, and a response body is the output side.
 */

const SPEC_VERSION = '3.1.0';

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { io: 'output', target: 'draft-2020-12' });
  // OpenAPI supplies its own $schema; leaving Zod's in makes some tooling complain.
  delete (generated as Record<string, unknown>).$schema;
  return generated as Record<string, unknown>;
}

/**
 * Error responses for a route, built from the catalog in `@gs/errors` (Rule 5:
 * documented error codes). The catalog is the single source, so a documented code cannot
 * drift from the one the route actually throws.
 *
 * Codes are grouped by status, because one HTTP status can carry several codes and the
 * response object is keyed by status.
 */
function errorResponses(codes: readonly ErrorCode[]): Record<string, unknown> {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const { status } = ERROR_CODE_METADATA[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }

  return Object.fromEntries(
    [...byStatus.entries()]
      .sort(([a], [b]) => a - b)
      .map(([status, group]) => [
        String(status),
        {
          description: group
            .map((code) => `\`${code}\` — ${ERROR_CODE_METADATA[code].message}`)
            .join('\n\n'),
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      ]),
  );
}

export function buildOpenApiDocument(serverUrl: string): Record<string, unknown> {
  return {
    openapi: SPEC_VERSION,
    info: {
      title: 'GainingSocial Unified Social API',
      version: '0.1.0',
      description:
        'Social execution infrastructure for software and AI agents. ' +
        'All timestamps are UTC ISO-8601.',
    },
    servers: [{ url: serverUrl }],
    paths: {
      '/health': {
        get: {
          operationId: 'getHealth',
          summary: 'Liveness probe',
          description:
            'Returns 200 whenever the Worker can serve requests. Unauthenticated, and ' +
            'returns no tenant data. Does not check database connectivity.',
          tags: ['Operations'],
          security: [],
          responses: {
            '200': {
              description: 'The Worker is serving requests.',
              headers: {
                'x-request-id': {
                  description: 'Echoed request identifier. Quote this when reporting a problem.',
                  schema: { type: 'string' },
                },
                'x-trace-id': {
                  description: 'Trace identifier correlating this request across services.',
                  schema: { type: 'string' },
                },
              },
              content: { 'application/json': { schema: jsonSchema(HealthResponseSchema) } },
            },
            ...errorResponses(['INTERNAL_ERROR']),
          },
        },
      },
      '/v1/me': {
        get: {
          operationId: 'getMe',
          summary: 'Describe the presenting API key',
          description:
            'Returns the tenant and scopes the presented key resolves to. Requires a ' +
            'valid key but no particular scope — a key may always describe itself, and ' +
            'requiring a scope would stop a misconfigured key from discovering why it is ' +
            'misconfigured.',
          tags: ['Identity'],
          security: [{ apiKey: [] }],
          responses: {
            '200': {
              description: 'The key is valid.',
              content: { 'application/json': { schema: jsonSchema(MeResponseSchema) } },
            },
            ...errorResponses([
              'AUTHENTICATION_REQUIRED',
              'API_KEY_MALFORMED',
              'API_KEY_INVALID',
              'API_KEY_REVOKED',
              'API_KEY_EXPIRED',
              'INTERNAL_ERROR',
            ]),
          },
        },
      },
    },
    components: {
      schemas: {
        Error: jsonSchema(ErrorEnvelopeSchema),
      },
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Project-scoped API key, `sk_live_…` or `sk_test_…`, sent as a bearer token. ' +
            'The key determines the tenant and environment; neither can be named by the ' +
            'caller.',
        },
      },
    },
  };
}
