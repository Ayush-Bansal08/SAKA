/** Release identifier: the deploy's git SHA when the platform provides one. */
export const APP_VERSION =
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.GIT_SHA?.slice(0, 7) ?? '0.1.0';
