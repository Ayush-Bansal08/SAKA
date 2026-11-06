/** BullMQ queue names and repeatable job schedules shared by producers and the worker. */
export const QUEUES = {
  system: 'system',
  wallet: 'wallet',
  /** PHASE 05: one job per approved/AUTO plan (per-user Redis lock inside the job). */
  execute: 'execute',
  /** PHASE 05: decision-log uploads to 0G Storage. */
  decisionLog: 'decisionlog',
  /** PHASE 07: hook indexer (own queue: slow upstreams never delay other jobs). */
  hooks: 'hooks',
  /** PHASE 07: trigger evaluator. */
  triggers: 'triggers',
  /** PHASE 08: Mode B detectors. */
  modeb: 'modeb',
  /** PHASE 08: outgoing Telegram messages (one place, so one rate limit). */
  notify: 'notify',
} as const;

export const JOBS = {
  heartbeat: 'heartbeat',
  /** PHASE 03: deposit detection + funding (every BALANCE_POLL_MS). */
  balanceWatch: 'balance-watch',
  /** PHASE 05: PENDING approvals past expiresAt → EXPIRED (every 15 s). */
  approvalSweep: 'approval-sweep',
  execute: 'execute',
  decisionLogUpload: 'decisionlog.upload',
  hookIndex: 'hooks.index',
  triggerEvaluate: 'triggers.evaluate',
  modebTick: 'modeb.tick',
  notify: 'notify.send',
} as const;

export const HEARTBEAT_EVERY_MS = 60_000;
export const APPROVAL_SWEEP_EVERY_MS = 15_000;
export const HOOK_INDEX_EVERY_MS = 5 * 60_000;
export const TRIGGER_EVALUATE_EVERY_MS = 30_000;
export const MODEB_TICK_EVERY_MS = 60_000;
/** Under Telegram's ~30 messages per second per bot. */
export const NOTIFY_MAX_PER_SECOND = 25;
