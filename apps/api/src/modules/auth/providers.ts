import { devProvidersAllowed, type Env } from '../../config/env.js';
import { DevIdentityProvider } from './dev-identity-provider.js';
import type { IdentityProvider } from './identity-provider.js';

/** Builds the configured identity provider. Env validation has already enforced the mode rules. */
export function createIdentityProvider(env: Env): IdentityProvider {
  if (env.AUTH_MODE === 'dev') {
    if (!devProvidersAllowed(env)) {
      throw new Error('AUTH_MODE=dev requires ALLOW_DEV_PROVIDERS=true and NODE_ENV!=production');
    }
    return new DevIdentityProvider(env);
  }
  throw new Error('AUTH_MODE=world is implemented in Phase 10 (World ID Agent Pass)');
}
