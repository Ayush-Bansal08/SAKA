/** Redis key the API refreshes on authenticated requests; the balance watcher backs off without it. */
export function activityKey(userId: string): string {
  return `activity:${userId}`;
}
