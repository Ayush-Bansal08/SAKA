import { Badge, type BadgeTone } from '@/components/ui-kit';

const MODE: Record<'LIVE' | 'SIMULATED' | 'PAPER', BadgeTone> = {
  LIVE: 'safe',
  SIMULATED: 'caution',
  PAPER: 'info',
};

export function ModeBadge({ mode }: { mode: keyof typeof MODE }) {
  return <Badge tone={MODE[mode]}>{mode}</Badge>;
}
