/** BullMQ queue names and repeatable job schedules shared by producers and the worker. */
export const QUEUES = {
  system: 'system',
  wallet: 'wallet',
} as const;

export const JOBS = {
  heartbeat: 'heartbeat',
  /** PHASE 03: deposit detection + funding (every BALANCE_POLL_MS). */
  balanceWatch: 'balance-watch',
} as const;

export const HEARTBEAT_EVERY_MS = 60_000;
