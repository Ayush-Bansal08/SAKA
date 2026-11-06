import { cpSync } from 'node:fs';
cpSync(
  new URL('../apps/api/src/modules/agent/prompts', import.meta.url),
  new URL('../apps/api/dist/modules/agent/prompts', import.meta.url),
  { recursive: true },
);

cpSync(
  new URL('../apps/api/src/modules/ai0g/prompts', import.meta.url),
  new URL('../apps/api/dist/modules/ai0g/prompts', import.meta.url),
  { recursive: true },
);
