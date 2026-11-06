import { Badge, type BadgeTone } from '@/components/ui-kit';

const MODE: Record<'LIVE' | 'SIMULATED' | 'PAPER', BadgeTone> = {
  LIVE: 'safe',
  SIMULATED: 'warm',
  PAPER: 'warmOutline',
};

export function ModeBadge({ mode }: { mode: keyof typeof MODE }) {
  return (
    <Badge tone={MODE[mode]} className="tracking-[0.04em]">
      {mode === 'LIVE' && <span className="size-1.5 rounded-full bg-safe" aria-hidden />}
      {mode}
    </Badge>
  );
}
