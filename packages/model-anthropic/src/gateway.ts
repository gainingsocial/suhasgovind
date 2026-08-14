import Anthropic from '@anthropic-ai/sdk';
import {
  ModelGatewayError,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse,
} from '@gs/domain';

/**
 * The Anthropic adapter for the model gateway port (plan §4.2, §63R).
 *
 * Official documentation consulted:
 *   https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 *   https://platform.claude.com/docs/en/api/errors
 *   https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
 *
 * This is the **only** package in the repository allowed to import a model vendor's SDK
 * (plan §4.2: "application/domain code must not directly depend on a model-vendor SDK",
 * enforced by `pnpm boundaries`). Everything above it — extraction, generation, grounding
 * verification — is written against the `ModelGateway` interface, so swapping the model
 * behind it changes this file and nothing else.
 *
 * It deliberately lives outside `packages/providers/*`. Those are *social* provider adapters
 * and §75 makes them leaves that may not import `@gs/domain`; this adapter has to implement
 * an interface that lives in the domain, so it cannot be one.
 */

/**
 * The default model.
 *
 * Opus rather than a cheaper tier because the two jobs here are the ones where a weaker
 * model costs more than it saves: an extraction that misreads the source produces claims
 * that fail grounding verification, and a generation that drifts produces drafts a human
 * rewrites. Both failures are paid for twice. `model` is configurable for exactly the case
 * where a customer decides otherwise.
 */
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Output budget per call.
 *
 * On this model `max_tokens` caps thinking *and* the response together, so a budget sized
 * to the JSON alone truncates mid-object and fails schema validation — which would surface
 * as "the model returned nothing useful" rather than "the budget was too small".
 */
const DEFAULT_MAX_TOKENS = 16_000;

export interface AnthropicGatewayConfig {
  apiKey: string;
  /** Defaults to {@link DEFAULT_MODEL}. */
  model?: string;
  maxTokens?: number;
  /** Injected in tests. Production passes nothing and gets a real client. */
  client?: Pick<Anthropic, 'messages'>;
}

/**
 * Map an SDK failure onto the taxonomy the pipeline branches on (plan §79 shape).
 *
 * The caller never sees an Anthropic error type. It sees the same vocabulary it would get
 * from any other gateway, which is the entire point of the port: a timeout is handled the
 * same way whoever is behind it.
 */
function normalizeError(error: unknown): ModelGatewayError {
  if (error instanceof Anthropic.APIError) {
    switch (error.status) {
      case 400:
        // Includes the context-window rejection, which is the one 400 the pipeline can
        // actually act on — it means the source needs splitting, not fixing.
        return /context|token|too long|too large/i.test(error.message)
          ? new ModelGatewayError('CONTEXT_TOO_LARGE', error.message)
          : new ModelGatewayError('UNKNOWN', error.message);
      case 401:
      case 403:
        // Not retryable and not "unavailable": the key is wrong, and retrying a wrong key
        // forever is how a misconfiguration looks like an outage.
        return new ModelGatewayError('NOT_CONFIGURED', `Model provider rejected the credential: ${error.message}`);
      case 413:
        return new ModelGatewayError('CONTEXT_TOO_LARGE', error.message);
      case 429:
        return new ModelGatewayError('RATE_LIMITED', error.message, true);
      default:
        if (error.status !== undefined && error.status >= 500) {
          return new ModelGatewayError('PROVIDER_UNAVAILABLE', error.message, true);
        }
        return new ModelGatewayError('UNKNOWN', error.message);
    }
  }

  // A timeout arrives as a connection error or an abort, depending on which side gave up
  // first. Both mean the same thing to the caller.
  if (error instanceof Error && /abort|timeout|timed out/i.test(error.message)) {
    return new ModelGatewayError('TIMEOUT', error.message, true);
  }

  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelGatewayError('PROVIDER_UNAVAILABLE', error.message, true);
  }

  return new ModelGatewayError('UNKNOWN', error instanceof Error ? error.message : 'Unknown model failure.');
}

/**
 * Narrow the port's `unknown` schema to the object shape the API requires.
 *
 * `ModelRequest.schema` is `unknown` because the domain must not know what a JSON schema
 * looks like to any particular vendor. Checking it here — rather than casting the whole
 * request and letting the API reject it — turns a confusing remote 400 into a local error
 * that names the actual problem.
 */
function asJsonSchema(schema: unknown): { [key: string]: unknown } {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new ModelGatewayError(
      'SCHEMA_VALIDATION_FAILED',
      'The request carried no JSON schema object, so the output could not be constrained.',
    );
  }

  return schema as { [key: string]: unknown };
}

/** Concatenate the text blocks. Thinking blocks carry no output and are skipped. */
function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export function createAnthropicGateway(config: AnthropicGatewayConfig): ModelGateway {
  if (!config.apiKey) {
    throw new ModelGatewayError('NOT_CONFIGURED', 'An Anthropic API key is required.');
  }

  const model = config.model ?? DEFAULT_MODEL;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const client = config.client ?? new Anthropic({ apiKey: config.apiKey });

  return {
    configured: true,

    async complete(request: ModelRequest): Promise<ModelResponse> {
      const startedAt = Date.now();

      /**
       * Instructions and source text are separated on purpose (plan §63S rule 1).
       *
       * `instructions` is ours and goes in the system prompt, where it carries operator
       * authority. `untrustedContent` is somebody else's web page and goes in a user turn,
       * already wrapped by the caller. Concatenating the two would be the whole prompt
       * injection surface in one line.
       */
      const schema = asJsonSchema(request.schema);

      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system: request.instructions,
            messages: [{ role: 'user', content: request.untrustedContent }],
            /**
             * No tools. Not a restricted set — none (plan §63S rule 2). A model reading
             * text written to subvert it must not be holding anything that acts.
             */
            tools: [],
            /**
             * Schema-constrained output. The alternative is asking for JSON in prose and
             * parsing whatever comes back, which the domain explicitly refuses to trust:
             * "a model asked for JSON returns prose often enough that trusting it is a
             * choice".
             */
            output_config: { format: { type: 'json_schema', schema } },
          },
          // Wall-clock budget from the call policy, so a hung model cannot hold a worker
          // (plan §63S rule 3). Milliseconds — the TypeScript SDK's unit.
          { timeout: request.policy.timeoutMs, ...(request.signal ? { signal: request.signal } : {}) },
        );
      } catch (error) {
        throw normalizeError(error);
      }

      /**
       * A refusal is a real answer about this source, not a transport failure.
       *
       * Reported as `CONTENT_FILTERED` so the pipeline records that *this article* could
       * not be processed and moves on. Retrying would refuse identically, and quietly
       * rerouting to a different model would change the output characteristics halfway
       * through a customer's archive without anyone being told.
       */
      if (message.stop_reason === 'refusal') {
        throw new ModelGatewayError(
          'CONTENT_FILTERED',
          'The model declined to process this source. It has been left unprocessed rather than partially drafted.',
        );
      }

      // Truncated output is not partial output here — it is invalid JSON, and pretending
      // otherwise pushes a parse failure downstream where the cause is invisible.
      if (message.stop_reason === 'max_tokens') {
        throw new ModelGatewayError(
          'CONTEXT_TOO_LARGE',
          `The response exceeded the ${maxTokens} token budget and was cut off before it was complete.`,
        );
      }

      const raw = textOf(message.content);

      let output: unknown;
      try {
        output = JSON.parse(raw);
      } catch {
        /**
         * Schema-constrained output should make this unreachable. It is checked anyway
         * because the failure it guards against — malformed output flowing into grounding
         * verification — surfaces as "this article could not be grounded", which blames
         * the source for our problem (Rule 14).
         */
        throw new ModelGatewayError(
          'SCHEMA_VALIDATION_FAILED',
          'The model returned output that was not valid JSON.',
        );
      }

      return {
        output,
        model: message.model,
        // The API reports the model it actually served; there is no separate version field,
        // and inventing one would make an output change look attributable when it is not.
        modelVersion: null,
        inputTokens: message.usage?.input_tokens ?? null,
        outputTokens: message.usage?.output_tokens ?? null,
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
