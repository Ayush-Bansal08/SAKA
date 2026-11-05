/** BullMQ queue names and repeatable job schedules shared by producers and the worker. */
export const QUEUES = {
  system: 'system',
} as const;

export const JOBS = {
  heartbeat: 'heartbeat',
} as const;

export const HEARTBEAT_EVERY_MS = 60_000;
