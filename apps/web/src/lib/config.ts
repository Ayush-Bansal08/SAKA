/** Runtime config for the web app. Only public values belong here — never secrets. */
const DEFAULT_API_URL = 'http://localhost:3001';

function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export const API_URL = normaliseUrl(import.meta.env.VITE_API_URL || DEFAULT_API_URL);
