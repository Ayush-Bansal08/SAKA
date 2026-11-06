/**
 * Settings. Reading is open to the user; every change (risk profile, limits, withdrawals) is a
 * STEP_UP action (PHASE_00 §9 rule 2) that needs a fresh World ID verification. Until the
 * approval pipeline (P05) and World (P10) exist, these endpoints answer 409 STEP_UP_REQUIRED.
 */
import {
  AutoActUpdateSchema,
  autoActSettings,
  ChangeLimitsRequestSchema,
  ChangeRiskProfileRequestSchema,
  SettingsResponseSchema,
  TimezoneUpdateSchema,
  WithdrawRequestSchema,
  type PolicyReasonCode,
} from '@warden/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AppError } from '../../lib/errors.js';
import { isValidTimeZone } from '../../lib/time.js';
import { authOf, requireUser } from '../auth/require-user.js';
import { firstRunAt, parseSpec } from '../triggers/service.js';
import { findAgentWallet, toWalletView } from '../wallet/wallet-service.js';
import { isAtOrPast, toLimitsView } from './onboarding.js';

function stepUpRequired(reason: PolicyReasonCode, what: string): AppError {
  return new AppError(
    'STEP_UP_REQUIRED',
    409,
    `${what} needs a fresh World ID verification, which arrives in Phase 10.`,
    { reason, availableIn: 'Phase 10' },
  );
}

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, env } = app.deps;

  app.get(
    '/settings',
    { preHandler: requireUser, schema: { response: { 200: SettingsResponseSchema } } },
    async (request) => {
      const { user } = authOf(request);
      const [limits, wallet] = await Promise.all([
        prisma.limits.findUnique({ where: { userId: user.id } }),
        findAgentWallet(prisma, user.id),
      ]);
      return {
        riskProfile: user.riskProfile,
        limits:
          limits && isAtOrPast(user.onboardingStep, 'FUND')
            ? toLimitsView(user.riskProfile, limits)
            : null,
        wallet: wallet ? toWalletView(wallet) : null,
        timezone: user.timezone,
        telegram: {
          available: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_USERNAME),
          linked: user.telegramChatId !== null,
          muted: user.telegramMuted,
          botUsername: env.TELEGRAM_BOT_USERNAME ?? null,
        },
        autoAct: autoActSettings(user.autoAct),
      };
    },
  );

  // Auto-act only narrows what the agent does inside the limits, so it needs no step-up.
  app.put(
    '/settings/auto-act',
    { preHandler: requireUser, schema: { body: AutoActUpdateSchema } },
    async (request) => {
      const { user } = authOf(request);
      const autoAct = { ...autoActSettings(user.autoAct), ...request.body };
      await prisma.user.update({ where: { id: user.id }, data: { autoAct } });
      return { autoAct };
    },
  );

  // The zone moves the morning brief, DCA runs and the daily limit window.
  app.put(
    '/settings/timezone',
    { preHandler: requireUser, schema: { body: TimezoneUpdateSchema } },
    async (request) => {
      const { user } = authOf(request);
      const { timezone } = request.body;
      if (!isValidTimeZone(timezone))
        throw new AppError('BAD_REQUEST', 400, 'That time zone is not recognised.');
      const now = new Date();
      const schedules = await prisma.trigger.findMany({
        where: { userId: user.id, status: 'ACTIVE', nextRunAt: { not: null } },
      });
      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { timezone } }),
        ...schedules.map((t) =>
          prisma.trigger.update({
            where: { id: t.id },
            data: { nextRunAt: firstRunAt(parseSpec(t), timezone, now) },
          }),
        ),
      ]);
      return { timezone };
    },
  );

  app.put(
    '/settings/risk-profile',
    { preHandler: requireUser, schema: { body: ChangeRiskProfileRequestSchema } },
    async () => {
      throw stepUpRequired('RISK_PROFILE_CHANGE', 'Changing your risk profile');
    },
  );

  app.put(
    '/settings/limits',
    { preHandler: requireUser, schema: { body: ChangeLimitsRequestSchema } },
    async () => {
      throw stepUpRequired('LIMIT_CHANGE', 'Changing your limits');
    },
  );

  app.post(
    '/wallet/withdraw',
    { preHandler: requireUser, schema: { body: WithdrawRequestSchema } },
    async () => {
      throw stepUpRequired('WITHDRAWAL', 'Withdrawing from your agent wallet');
    },
  );
};
