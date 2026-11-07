import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeAuthenticator, type FakeOverrides } from './fake-authenticator.js';
import { createTestApp, uniqueName } from './helpers.js';
import { RecordingJobs } from './phase5-fakes.js';

type Options = { challengeId: string; options: Record<string, unknown> };
interface Login {
  token: string;
  user: { id: string; identityKind: string; onboardingStep: string };
}

let app: FastifyInstance;
const jobs = new RecordingJobs();

beforeAll(async () => {
  app = await createTestApp(
    { AUTH_MODE: 'passkey', APPROVAL_MODE: 'passkey', ALLOW_DEV_PROVIDERS: 'false' },
    { jobs },
  );
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jobs.executions.length = 0;
});

const post = (url: string, payload: unknown = {}, token?: string) =>
  app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });

async function options(url: string, payload: unknown = {}, token?: string): Promise<Options> {
  const res = await post(url, payload, token);
  expect(res.statusCode).toBe(200);
  return res.json() as Options;
}

async function register(key = new FakeAuthenticator()) {
  const { challengeId, options: o } = await options('/auth/passkey/register/options', {
    displayName: uniqueName('pk'),
  });
  const res = await post('/auth/passkey/register/verify', {
    challengeId,
    response: key.register(o),
  });
  expect(res.statusCode).toBe(200);
  return { key, login: res.json() as Login };
}

async function signIn(key: FakeAuthenticator, overrides: FakeOverrides = {}) {
  const { challengeId, options: o } = await options('/auth/passkey/sign-in/options');
  return post('/auth/passkey/sign-in/verify', { challengeId, response: key.sign(o, overrides) });
}

async function pendingApproval(userId: string, expiresAt = new Date(Date.now() + 60_000)) {
  const { prisma } = app.deps;
  const planHash = randomBytes(16).toString('hex');
  const req = await prisma.agentRequest.create({
    data: { userId, channel: 'WEB', input: {}, traceId: randomBytes(8).toString('hex') },
  });
  const plan = await prisma.actionPlan.create({
    data: {
      agentRequestId: req.id,
      userId,
      intent: {},
      planHash,
      steps: [],
      amountUsd: '60',
      policyOutcome: 'STEP_UP',
      policyReasons: [],
      status: 'AWAITING_APPROVAL',
    },
  });
  return prisma.approval.create({
    data: {
      actionPlanId: plan.id,
      userId,
      planHash,
      amountUsd: '60',
      reason: 'Over your limit',
      channel: 'WEB',
      expiresAt,
      providerKind: 'passkey',
    },
  });
}

const statusOf = async (id: string) =>
  (await app.deps.prisma.approval.findUniqueOrThrow({ where: { id } })).status;

describe('passkey sign-in', () => {
  it('reports passkeys and removes dev sign-in', async () => {
    const providers = await app.inject({ method: 'GET', url: '/auth/providers' });
    expect(providers.json()).toMatchObject({ identity: 'passkey', approvals: 'passkey' });
    const dev = await post('/auth/dev/sign-in', { displayName: 'alice' });
    expect(dev.statusCode).toBe(404);
  });

  it('creates an account and stores only the public key', async () => {
    const { key, login } = await register();
    expect(login.user.identityKind).toBe('passkey');
    expect(login.user.onboardingStep).toBe('WALLET');
    const stored = await app.deps.prisma.passkeyCredential.findUniqueOrThrow({
      where: { credentialId: key.credentialId.toString('base64url') },
    });
    expect(stored.userId).toBe(login.user.id);
  });

  it('signs the same passkey back in to the same account', async () => {
    const { key, login } = await register();
    const res = await signIn(key);
    expect(res.statusCode).toBe(200);
    expect((res.json() as Login).user.id).toBe(login.user.id);
    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${(res.json() as Login).token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('refuses a replayed response', async () => {
    const { key } = await register();
    const { challengeId, options: o } = await options('/auth/passkey/sign-in/options');
    const body = { challengeId, response: key.sign(o) };
    expect((await post('/auth/passkey/sign-in/verify', body)).statusCode).toBe(200);
    expect((await post('/auth/passkey/sign-in/verify', body)).statusCode).toBe(403);
  });

  it('refuses an unregistered passkey', async () => {
    expect((await signIn(new FakeAuthenticator())).statusCode).toBe(403);
  });

  it('refuses a response from another website', async () => {
    const { key } = await register();
    const res = await signIn(key, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a passkey for another domain', async () => {
    const { key } = await register();
    expect((await signIn(key, { rpId: 'evil.example' })).statusCode).toBe(403);
  });

  it('refuses a passkey used without fingerprint, face or PIN', async () => {
    const { key } = await register();
    expect((await signIn(key, { userVerified: false })).statusCode).toBe(403);
  });

  it('refuses a cloned authenticator whose counter went backwards', async () => {
    const { key } = await register();
    expect((await signIn(key)).statusCode).toBe(200);
    expect((await signIn(key)).statusCode).toBe(200);
    key.counter = 0;
    expect((await signIn(key)).statusCode).toBe(403);
  });

  it('refuses a challenge issued for a different purpose', async () => {
    const key = new FakeAuthenticator();
    const { challengeId, options: o } = await options('/auth/passkey/register/options', {
      displayName: uniqueName('pk'),
    });
    const res = await post('/auth/passkey/sign-in/verify', {
      challengeId,
      response: key.sign(o),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('passkey approvals', () => {
  const start = (id: string, token: string) =>
    options(`/approvals/${id}/passkey/options`, {}, token);
  const verify = (id: string, body: unknown, token: string) =>
    post(`/approvals/${id}/passkey/verify`, body, token);

  it('approves with the owner passkey and queues execution', async () => {
    const { key, login } = await register();
    const approval = await pendingApproval(login.user.id);
    const { challengeId, options: o } = await start(approval.id, login.token);

    const res = await verify(approval.id, { challengeId, response: key.sign(o) }, login.token);

    expect(res.statusCode).toBe(200);
    const row = await app.deps.prisma.approval.findUniqueOrThrow({
      where: { id: approval.id },
      include: { user: true },
    });
    expect(row.status).toBe('APPROVED');
    expect(row.providerKind).toBe('passkey');
    expect(row.approvedBySub).toBe(row.user.identitySub);
    expect(row.acr).toBe('passkey');
    expect(jobs.executions.map((j) => j.planId)).toEqual([approval.actionPlanId]);
  });

  it('only offers the owner passkeys', async () => {
    const { key, login } = await register();
    const approval = await pendingApproval(login.user.id);
    const { options: o } = await start(approval.id, login.token);
    expect(o.allowCredentials).toEqual([
      expect.objectContaining({ id: key.credentialId.toString('base64url') }),
    ]);
  });

  it('refuses a signature made for a different approval', async () => {
    const { key, login } = await register();
    const first = await pendingApproval(login.user.id);
    const second = await pendingApproval(login.user.id);
    const { challengeId, options: o } = await start(first.id, login.token);

    const res = await verify(second.id, { challengeId, response: key.sign(o) }, login.token);

    expect(res.statusCode).toBe(403);
    expect(await statusOf(first.id)).toBe('PENDING');
    expect(await statusOf(second.id)).toBe('PENDING');
    expect(jobs.executions).toEqual([]);
  });

  it("refuses another person's passkey, even with the owner's session", async () => {
    const { login } = await register();
    const { key: other } = await register();
    const approval = await pendingApproval(login.user.id);
    const { challengeId, options: o } = await start(approval.id, login.token);

    const res = await verify(approval.id, { challengeId, response: other.sign(o) }, login.token);

    expect(res.statusCode).toBe(403);
    expect(await statusOf(approval.id)).toBe('PENDING');
    expect(jobs.executions).toEqual([]);
  });

  it("hides an approval from anyone else's session", async () => {
    const { login } = await register();
    const { login: other } = await register();
    const approval = await pendingApproval(login.user.id);
    const res = await post(`/approvals/${approval.id}/passkey/options`, {}, other.token);
    expect(res.statusCode).toBe(404);
  });

  it('requires a session', async () => {
    const { login } = await register();
    const approval = await pendingApproval(login.user.id);
    expect((await post(`/approvals/${approval.id}/passkey/options`)).statusCode).toBe(401);
  });

  it('refuses a replayed approval', async () => {
    const { key, login } = await register();
    const approval = await pendingApproval(login.user.id);
    const { challengeId, options: o } = await start(approval.id, login.token);
    const body = { challengeId, response: key.sign(o) };

    expect((await verify(approval.id, body, login.token)).statusCode).toBe(200);
    expect((await verify(approval.id, body, login.token)).statusCode).toBe(409);
    expect(jobs.executions).toHaveLength(1);
  });

  it('rejects the approval when the plan changed after it was created', async () => {
    const { key, login } = await register();
    const approval = await pendingApproval(login.user.id);
    const { challengeId, options: o } = await start(approval.id, login.token);
    await app.deps.prisma.actionPlan.update({
      where: { id: approval.actionPlanId },
      data: { planHash: 'edited' },
    });

    const res = await verify(approval.id, { challengeId, response: key.sign(o) }, login.token);

    expect(res.statusCode).toBe(409);
    expect(await statusOf(approval.id)).toBe('REJECTED');
    expect(jobs.executions).toEqual([]);
  });

  it('expires instead of approving once the time is up', async () => {
    const { key, login } = await register();
    const approval = await pendingApproval(login.user.id, new Date(Date.now() - 1_000));
    const { challengeId, options: o } = await start(approval.id, login.token);

    const res = await verify(approval.id, { challengeId, response: key.sign(o) }, login.token);

    expect(res.statusCode).toBe(409);
    expect(await statusOf(approval.id)).toBe('EXPIRED');
    expect(jobs.executions).toEqual([]);
  });

  it('has no dev approve route', async () => {
    const { login } = await register();
    const approval = await pendingApproval(login.user.id);
    const res = await post(`/approvals/${approval.id}/dev-approve`, {}, login.token);
    expect(res.statusCode).toBe(404);
    expect(await statusOf(approval.id)).toBe('PENDING');
  });
});
