/** A Mode B suggestion in the chat (PHASE 08): same Yes / Change / No as the inbox. */
import type { SuggestionCard } from '@warden/shared';
import { AlertTriangle, Check, Info, Lightbulb, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, ZgVerifiedBadge } from '@/components/ui-kit';
import { useSuggestionAction } from '@/features/inbox/hooks';
import { STATUS_META, severityTone } from '@/features/inbox/suggestion-meta';
import { usd } from './card-utils';
import { CardShell } from './parts';

const ICON = { RED: <AlertTriangle />, NORMAL: <Lightbulb />, INFO: <Info /> } as const;

export function SuggestionCardView({ card }: { card: SuggestionCard }) {
  const action = useSuggestionAction();
  const open = card.status === 'OPEN' || card.status === undefined;
  const meta = card.status ? STATUS_META[card.status] : null;
  const act = (kind: 'accept' | 'decline' | 'change') =>
    action.mutate({ id: card.suggestionId, action: kind });
  return (
    <CardShell
      tone={severityTone(card.severity)}
      icon={ICON[card.severity]}
      eyebrow={card.severity === 'RED' ? 'Red alert' : 'From your agent'}
      title={card.title}
      label="Suggestion"
      badge={meta && <Badge tone={meta.tone}>{meta.label}</Badge>}
      footer={
        <>
          {card.simulated && <Badge tone="caution">Simulated (demo)</Badge>}
          {card.zg && <ZgVerifiedBadge title={`0G request ${card.zg.requestId}`} />}
        </>
      }
    >
      <p className="text-sm leading-relaxed [overflow-wrap:anywhere]">{card.message}</p>
      {card.amountUsd && (
        <p className="text-lg font-semibold tabular-nums">{usd(card.amountUsd)}</p>
      )}
      {card.actions.length > 0 && (open || card.actions.includes('change')) && (
        <div className="flex flex-wrap gap-2">
          {card.actions.includes('yes') && (
            <Button size="sm" disabled={action.isPending} onClick={() => act('accept')}>
              <Check aria-hidden /> Yes
            </Button>
          )}
          {card.actions.includes('change') && (
            <Button
              size="sm"
              variant="secondary"
              disabled={action.isPending}
              onClick={() => act('change')}
            >
              <Pencil aria-hidden /> Change
            </Button>
          )}
          {card.actions.includes('no') && (
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending}
              onClick={() => act('decline')}
            >
              <X aria-hidden /> No
            </Button>
          )}
        </div>
      )}
    </CardShell>
  );
}
