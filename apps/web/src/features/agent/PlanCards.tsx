/** Renders the cards of one agent message (PHASE 06 §2). */
import type { Card } from '@warden/shared';
import { isReplyEcho } from './cards/card-utils';
import { InfoCardView, IntentCardView } from './cards/InfoCards';
import {
  ApprovalCardView,
  FailureCardView,
  PreviewCardView,
  PriceMovedCardView,
  ReceiptCardView,
  RefusalCardView,
} from './cards/PipelineCards';
import { SuggestionCardView } from './cards/SuggestionCardView';

export function PlanCards({ cards, preparing = false }: { cards: Card[]; preparing?: boolean }) {
  // An intent card is transient: shown only while no pipeline card accompanies it.
  const hasPipeline = cards.some((c) => c.type !== 'intent' && c.type !== 'info');
  return (
    <>
      {cards.map((card, i) => {
        const key = `${card.type}-${'actionPlanId' in card ? card.actionPlanId : ''}-${i}`;
        switch (card.type) {
          case 'preview':
            return <PreviewCardView key={key} card={card} />;
          case 'approval':
            return <ApprovalCardView key={key} card={card} />;
          case 'refusal':
            return <RefusalCardView key={key} card={card} />;
          case 'receipt':
            return <ReceiptCardView key={key} card={card} />;
          case 'price_moved':
            return <PriceMovedCardView key={key} card={card} />;
          case 'failure':
            return <FailureCardView key={key} card={card} />;
          case 'suggestion':
            return <SuggestionCardView key={key} card={card} />;
          case 'info':
            return isReplyEcho(card) ? null : <InfoCardView key={key} card={card} />;
          case 'intent':
            return hasPipeline ? null : (
              <IntentCardView key={key} card={card} preparing={preparing} />
            );
          default:
            return null;
        }
      })}
    </>
  );
}
