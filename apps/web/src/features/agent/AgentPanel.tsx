import {
  AGENT_MESSAGE_MAX_CHARS,
  type AgentMessageView,
  type UserView,
  type ZgProvenance,
} from '@warden/shared';
import { BadgeCheck, Bot, Loader2, MessageSquareText, SendHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  AgentBadge,
  Badge,
  EmptyState,
  ErrorState,
  HashChip,
  Panel,
  SkeletonRows,
} from '@/components/ui-kit';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { isAwaitingReply, useAgentMessages, useSendAgentMessage } from './hooks';
import { parseCards } from './plan-hooks';
import { PlanCards } from './PlanCards';

const EXAMPLE_PROMPTS = [
  'Swap $20 ETH to USDC',
  'Put $100 into ETH/USDC',
  'Is USDC safe?',
  'Stop loss at $2,800',
];

/** 0G provenance and status of the first valid card on an agent message. */
function cardMeta(message: AgentMessageView): {
  zg?: ZgProvenance;
  planned: boolean;
  failed: boolean;
} {
  const cards = parseCards(message.cards);
  // A bare intent card (no pipeline card after it) is a plan that was not prepared.
  const pipeline = cards.some((c) => c.type !== 'intent' && c.type !== 'info');
  for (const card of cards) {
    const zg = 'zg' in card ? card.zg : undefined;
    return {
      ...(zg ? { zg } : {}),
      planned: card.type === 'intent' && !pipeline,
      failed: card.type === 'info' && card.title === 'Planning failed',
    };
  }
  return { planned: false, failed: false };
}

function MessageBubble({ message }: { message: AgentMessageView }) {
  const mine = message.role === 'USER';
  const meta = mine ? null : cardMeta(message);
  return (
    <li className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[92%] sm:max-w-[85%] rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed',
          mine
            ? 'border-transparent bg-primary text-primary-foreground'
            : meta?.failed
              ? 'border-danger/40 bg-surface-2'
              : 'border-border bg-surface-2',
        )}
      >
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</p>
        {!mine && <PlanCards cards={parseCards(message.cards)} />}
        {meta && (meta.zg || meta.planned) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {meta.planned && <Badge tone="info">Plan · not executed</Badge>}
            {meta.zg && (
              <>
                <HashChip
                  tone="zg"
                  label="0G"
                  value={meta.zg.requestId}
                  icon={<BadgeCheck className="size-3" aria-hidden />}
                />
                <Badge tone="zg">{meta.zg.trustMode}</Badge>
                {meta.zg.teeVerified && <Badge tone="safe">TEE verified</Badge>}
              </>
            )}
          </div>
        )}
        <p
          className={cn(
            'mt-1 text-[11px]',
            mine ? 'text-primary-foreground/70' : 'text-subtle-foreground',
          )}
        >
          <time dateTime={message.createdAt}>{formatRelative(message.createdAt)}</time>
        </p>
      </div>
    </li>
  );
}

export function AgentPanel({ user }: { user: UserView }) {
  const messagesQuery = useAgentMessages();
  const send = useSendAgentMessage();
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The API returns newest first; the chat reads top to bottom.
  const messages = useMemo(
    () => [...(messagesQuery.data?.messages ?? [])].reverse(),
    [messagesQuery.data],
  );
  const planning = send.isPending || isAwaitingReply(messagesQuery.data);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, planning]);

  const submit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || planning) return;
    send.mutate(trimmed, { onSuccess: () => setText('') });
  };

  return (
    <Panel
      id="agent"
      title="Agent"
      subtitle="Plans on 0G · builds on Uniswap · you stay in control"
      icon={<Bot />}
      actions={<AgentBadge />}
      bodyClassName="flex min-h-[360px] flex-col p-0"
    >
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messagesQuery.isPending ? (
          <SkeletonRows rows={3} />
        ) : messagesQuery.isError ? (
          <ErrorState
            title="Couldn't load your conversation"
            description={messagesQuery.error.message}
            onRetry={() => void messagesQuery.refetch()}
            retrying={messagesQuery.isFetching}
          />
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center py-6">
            <EmptyState
              className="py-0"
              icon={<MessageSquareText />}
              title={`Hi ${user.displayName ?? 'there'} — I'm your agent.`}
              description="Ask me to swap, provide liquidity, set a stop-loss or check if a token is safe. I plan on 0G; nothing runs without passing the safety checks."
            >
              <ul
                className="mt-5 flex max-w-md flex-wrap justify-center gap-2"
                aria-label="Example requests"
              >
                {EXAMPLE_PROMPTS.map((p) => (
                  <li key={p}>
                    <button
                      type="button"
                      onClick={() => {
                        setText(p);
                        inputRef.current?.focus();
                      }}
                      className="rounded-full border border-border bg-surface-2 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {p}
                    </button>
                  </li>
                ))}
              </ul>
            </EmptyState>
          </div>
        ) : (
          <ol className="flex flex-col gap-3" aria-live="polite" aria-label="Conversation">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {planning && (
              <li className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> Planning on 0G…
              </li>
            )}
          </ol>
        )}
        <div ref={endRef} />
      </div>
      <form
        className="flex items-center gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
        aria-label="Message your agent"
      >
        <label htmlFor="agent-input" className="sr-only">
          Message your agent
        </label>
        <input
          id="agent-input"
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={AGENT_MESSAGE_MAX_CHARS}
          autoComplete="off"
          placeholder={planning ? 'Your agent is planning…' : 'e.g. Swap $20 ETH to USDC'}
          className="h-11 min-w-0 flex-1 rounded-md border border-input bg-surface-2 px-3.5 text-sm placeholder:text-subtle-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        />
        <Button
          type="submit"
          size="icon"
          className="size-11"
          disabled={planning || text.trim().length === 0}
          aria-label="Send message"
        >
          {send.isPending ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
        </Button>
      </form>
    </Panel>
  );
}
