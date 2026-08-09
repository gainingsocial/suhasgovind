import { verifyDashboardSession } from '@gs/auth';
import { ApiError } from '@gs/errors';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';

/**
 * Human session authentication (plan §39).
 *
 * Deliberately a separate middleware from `authenticate`, not a mode of it. A route
 * accepts either a person or a machine, never both — mixing them is how a leaked API key
 * ends up able to mint more keys, or a browser session ends up publishing with a scope
 * nobody granted it.
 *
 * The token is verified against Supabase's published JWKS. This API holds only the public
 * key, so it can check a session but could never forge one.
 */
export function authenticateHuman(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.env.SUPABASE_URL) {
      throw new ApiError('INTERNAL_ERROR', {
        message: 'Dashboard authentication is not configured: SUPABASE_URL is unset.',
      });
    }

    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new ApiError('AUTHENTICATION_REQUIRED', {
        message: 'Sign in to the dashboard to use this endpoint.',
      });
    }

    const token = header.slice('Bearer '.length).trim();

    // An API key presented here is refused rather than attempted. Saying so precisely
    // saves an integrator from debugging a signature error that is really a category
    // mistake.
    if (token.startsWith('sk_test_') || token.startsWith('sk_live_')) {
      throw new ApiError('AUTHENTICATION_REQUIRED', {
        message:
          'This endpoint requires a signed-in dashboard user. An API key cannot create or revoke API keys.',
      });
    }

    const user = await verifyDashboardSession(token, { supabaseUrl: c.env.SUPABASE_URL });

    c.set('user', user);
    // Fields go in the second argument; the first is trace context only.
    c.set('logger', c.get('logger').child({}, { userId: user.userId }));

    await next();
  };
}
