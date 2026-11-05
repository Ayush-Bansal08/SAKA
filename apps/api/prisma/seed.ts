/**
 * Seed: creates nothing user-specific (PHASE_01 §3). It only verifies that the
 * database is reachable and migrations are applied.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

try {
  await prisma.$queryRaw`SELECT 1`;
  const migrations = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
  const users = await prisma.user.count();
  console.log(
    `[seed] database OK — ${migrations[0]?.count ?? 0n} migration(s) applied, ${users} user(s). Nothing to seed.`,
  );
} catch (err) {
  console.error('[seed] database check failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
