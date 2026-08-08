import { HealthResponseSchema } from '@gs/contracts/http';
import { ERROR_CODE_METADATA } from '@gs/errors';
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
 * Error codes are part of the contract and are documented per route (Rule 5).
 * The catalog in `@gs/errors` is the single source, so this list cannot go stale.
 */
function documentedErrorCodes(): string {
  return Object.entries(ERROR_CODE_METADATA)
    .filter(([, meta]) => meta.status === 404 || meta.status >= 500)
    .map(([code, meta]) => `- \`${code}\` (${meta.status}) — ${meta.message}`)
    .join('\n');
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
          },
        },
      },
    },
    components: {
      securitySchemes: {
        // Registered now so routes added later declare a scope rather than inventing one.
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Project-scoped API key. Every authenticated route requires one.',
        },
      },
    },
    'x-error-codes': {
      description: 'Stable, documented error codes. See docs/errors/.',
      notFoundAndServerCodes: documentedErrorCodes(),
    },
  };
}
