import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devSubject } from '../src/modules/auth/dev-identity-provider.js';
import { createTestApp, devSignIn, uniqueName } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('GET /auth/providers', () => {
  it('tells the web which providers to render', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/providers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      appName: 'Warden',
      identity: 'dev',
      approvals: 'dev',
      executionChainId: 11155111,
    });
  });
});

describe('POST /auth/dev/sign-in', () => {
  it('creates a verified user with default limits and returns a session', async () => {
    const name = uniqueName('alice');
    const body = await devSignIn(app, name);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.user.displayName).toBe(name);

    const user = await app.deps.prisma.user.findUniqueOrThrow({
      where: { id: body.user.id },
      include: { limits: true, sessions: true },
    });
    expect(user.identityIss).toBe('dev');
    expect(user.identitySub).toBe(devSubject(name));
    expect(user.verifiedAt).not.toBeNull();
    expect(user.onboardingStep).toBe('WALLET');
    expect(user.limits?.perActionUsd.toString()).toBe('25');
    expect(user.limits?.perDayUsd.toString()).toBe('100');
    // Only the hash of the token is stored.
    expect(user.sessions[0]?.tokenHash).not.toBe(body.token);
    expect(user.sessions[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns the same user for the same human (one human = one agent)', async () => {
    const name = uniqueName('alice');
    const first = await devSignIn(app, name);
    const second = await devSignIn(app, `  ${name.toUpperCase()} `);
    expect(second.user.id).toBe(first.user.id);
    expect(second.token).not.toBe(first.token);
    const count = await app.deps.prisma.user.count({
      where: { identityIss: 'dev', identitySub: devSubject(name) },
    });
    expect(count).toBe(1);
  });

  it('creates a different user for a different human', async () => {
    const alice = await devSignIn(app, uniqueName('alice'));
    const bob = await devSignIn(app, uniqueName('bob'));
    expect(bob.user.id).not.toBe(alice.user.id);
  });

  it('handles concurrent first sign-ins without duplicating the user', async () => {
    const name = uniqueName('carol');
    const results = await Promise.all([devSignIn(app, name), devSignIn(app, name)]);
    expect(results[0].user.id).toBe(results[1].user.id);
  });

  it('rejects invalid names with a readable validation error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/dev/sign-in',
      payload: { displayName: 'x' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toMatch(/at least 2 characters/);
  });
});

describe('GET /me', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects unknown tokens', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer not-a-real-session-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SESSION_EXPIRED');
  });

  it('returns the signed-in user', async () => {
    const { token, user } = await devSignIn(app, uniqueName('dave'));
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({
      id: user.id,
      identityKind: 'dev',
      riskProfile: 'BALANCED',
      timezone: 'Asia/Kolkata',
      telegramLinked: false,
    });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('rejects expired sessions', async () => {
    const { token, user } = await devSignIn(app, uniqueName('erin'));
    await app.deps.prisma.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/sign-out', () => {
  it('revokes the session', async () => {
    const { token } = await devSignIn(app, uniqueName('frank'));
    const headers = { authorization: `Bearer ${token}` };
    const out = await app.inject({ method: 'POST', url: '/auth/sign-out', headers });
    expect(out.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/me', headers });
    expect(me.statusCode).toBe(401);
  });
});

describe('errors', () => {
  it('returns a JSON 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('applies CORS for the web origin only', async () => {
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/me',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const evil = await app.inject({
      method: 'OPTIONS',
      url: '/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    // A fixed origin is always echoed, so browsers block any other origin.
    expect(evil.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
