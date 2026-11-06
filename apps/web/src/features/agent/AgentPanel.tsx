/**
 * Agent chat (PHASE 06 §2): date separators, auto-scroll with a "new messages" pill, optimistic
 * user message, "Agent is thinking… · <current step>" from the live trace, multiline composer
 * (Enter sends, Shift+Enter newline, 500 chars), quick-action chips, example cards, and cards that
 * update in place from SSE. Long histories stay cheap with `content-visibility: auto`.
 */
import type { UserView } from '@warden/shared';
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Blocks,
  Droplets,
  Loader2,
  PieChart,
  ShieldCheck,
  Sparkles,
  Target,
  Trophy,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import { AgentBadge, CardIndex, ErrorState, Panel, SkeletonRows } from '@/components/ui-kit';
import { useTraceStream } from '@/features/trace/trace-context';
import { Wordmark } from '@/layout/Logo';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { dayLabel } from './cards/card-utils';
import { ZgChip } from './cards/parts';
import { ComposerContext, type ComposerApi } from './composer-context';
import { foldMessages, type FoldedMessage } from './fold';
import { consumePrefill, subscribePrefill } from './prefill';
import { isAwaitingReply, useAgentMessages, useSendAgentMessage } from './hooks';
import { PlanCards } from './PlanCards';

const COMPOSER_MAX_CHARS = 500;

const QUICK_ACTIONS = [
  { label: 'Swap', icon: ArrowLeftRight, text: 'Swap $10 ETH to USDC' },
  { label: 'Best pool', icon: Trophy, text: 'Best pool for ETH/USDC?' },
  { label: 'Explain a hook', icon: Blocks, text: 'Explain this hook: 0x' },
  { label: 'Portfolio', icon: PieChart, text: 'Show my portfolio' },
  { label: 'Set take-profit', icon: Target, text: 'Sell half if ETH goes up 2%' },
] as const;

const EXAMPLES = [
  {
    icon: ArrowLeftRight,
    title: 'Swap',
    text: 'Swap $5 ETH to USDC',
    hint: 'Small and safe — your agent does it alone',
  },
  {
    icon: ShieldCheck,
    title: 'Safety check',
    text: 'Is USDC safe?',
    hint: 'Allowlist, Uniswap lists and liquidity',
  },
  {
    icon: Droplets,
    title: 'Liquidity',
    text: 'Best pool for ETH/USDC?',
    hint: 'Compares pools, hooks and fee APR',
  },
  {
    icon: Target,
    title: 'Over your limit',
    text: 'Swap $60 ETH to USDC',
    hint: 'Watch it ask you first',
  },
] as const;

function Bubble({ item, preparing }: { item: FoldedMessage; preparing: boolean }) {
  const { message } = item;
  const mine = message.role === 'USER';
  const zg = mine
    ? undefined
    : item.cards.map((c) => ('zg' in c ? c.zg : undefined)).find((z) => z !== undefined);
  return (
    <li
      className={cn(
        'flex [contain-intrinsic-size:auto_120px] [content-visibility:auto]',
        mine ? 'justify-end' : 'justify-start',
      )}
    >
      {!mine && (
        <span
          className="mt-0.5 mr-2.5 hidden size-7 shrink-0 items-center justify-center rounded-full border border-agent/30 bg-agent/10 text-agent sm:flex"
          aria-hidden
        >
          <Sparkles className="size-3.5" />
        </span>
      )}
      <div
        className={cn(
          'min-w-0 text-sm leading-relaxed',
          mine
            ? 'max-w-[85%] rounded-xl rounded-br-sm bg-primary px-4 py-2.5 text-primary-foreground'
            : 'w-full max-w-[680px]',
        )}
      >
        <p className={cn('whitespace-pre-wrap [overflow-wrap:anywhere]', !mine && 'pt-0.5')}>
          {message.text}
        </p>
        {!mine && <PlanCards cards={item.cards} preparing={preparing} />}
        <p
          className={cn(
            'mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[11px]',
            mine ? 'justify-end text-primary-foreground/70' : 'text-subtle-foreground',
          )}
        >
          <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>
            {formatRelative(message.createdAt)}
          </time>
          {zg && <ZgChip zg={zg} />}
        </p>
      </div>
    </li>
  );
}

function useThinkingStep(traceId: string | null): string | null {
  const { events } = useTraceStream();
  return useMemo(() => {
    if (!traceId) return null;
    for (let i = events.length - 1; i >= 0; i--)
      if (events[i]!.traceId === traceId) return events[i]!.title;
    return null;
  }, [events, traceId]);
}

export function AgentPanel({ user, actions }: { user: UserView; actions?: React.ReactNode }) {
  const messagesQuery = useAgentMessages();
  const send = useSendAgentMessage();
  const [text, setText] = useState('');
  const [optimistic, setOptimistic] = useState<{ text: string; at: number } | null>(null);
  const [unseen, setUnseen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);

  // The API returns newest first; the chat reads top to bottom.
  const messages = useMemo(
    () => [...(messagesQuery.data?.messages ?? [])].reverse(),
    [messagesQuery.data],
  );
  const folded = useMemo(() => foldMessages(messages), [messages]);
  const hasMessages = folded.length > 0;
  const awaiting = isAwaitingReply(messagesQuery.data);
  const planning = send.isPending || awaiting || optimistic !== null;
  const pendingTraceId =
    send.data?.traceId ?? (awaiting ? (messages[messages.length - 1]?.traceId ?? null) : null);
  const step = useThinkingStep(planning ? pendingTraceId : null);

  // Drop the optimistic bubble once the server copy is loaded.
  useEffect(() => {
    if (!optimistic) return;
    const landed = messages.some(
      (m) =>
        m.role === 'USER' &&
        m.text === optimistic.text &&
        Date.parse(m.createdAt) >= optimistic.at - 60_000,
    );
    if (landed) setOptimistic(null);
  }, [messages, optimistic]);

  const scrollToEnd = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setUnseen(false);
  }, []);

  const lastId = messages[messages.length - 1]?.id;
  const lastCards = JSON.stringify(messagesQuery.data?.messages[0]?.cards ?? null);
  useLayoutEffect(() => {
    if (nearBottom.current) scrollToEnd();
    else if (lastId) setUnseen(true);
    // Card updates (countdown → receipt) also grow the list.
  }, [lastId, lastCards, optimistic, planning, scrollToEnd]);

  // Stay pinned to the bottom while content grows (lazy-rendered messages measuring in,
  // a countdown turning into a receipt) — unless the human scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    const content = el?.firstElementChild;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [messagesQuery.isPending, hasMessages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    if (nearBottom.current) setUnseen(false);
  };

  const submit = (value: string) => {
    const trimmed = value.trim().slice(0, COMPOSER_MAX_CHARS);
    if (!trimmed || planning) return;
    setOptimistic({ text: trimmed, at: Date.now() });
    nearBottom.current = true;
    setText('');
    send.mutate(trimmed, {
      onError: () => {
        setOptimistic(null);
        setText(trimmed);
      },
    });
  };

  const composer = useMemo<ComposerApi>(
    () => ({
      prefill(value: string) {
        setText(value.slice(0, COMPOSER_MAX_CHARS));
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        });
      },
    }),
    [],
  );

  // Text sent from other views (hook cards, LP positions, rules).
  useEffect(() => {
    const sub = subscribePrefill((t) => {
      composer.prefill(t);
      consumePrefill();
    });
    if (sub.initial) composer.prefill(sub.initial);
    return sub.unsubscribe;
  }, [composer]);

  // Auto-size the textarea (1–6 lines).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 6 * 22 + 20)}px`;
  }, [text]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(text);
    }
  };

  let lastDay = '';
  const visible = folded.filter((f) => !f.hidden);
  const now = new Date();
  // Nothing said yet: the prompt box moves to the centre, under the greeting.
  const welcoming = !messagesQuery.isPending && visible.length === 0 && !optimistic;

  return (
    <ComposerContext.Provider value={composer}>
      <Panel
        id="agent"
        title="Agent"
        subtitle="Plans on 0G · builds on Uniswap · you stay in control"
        icon={<Sparkles className={cn('text-agent', planning && 'agent-breathe')} />}
        actions={
          <>
            {actions}
            <AgentBadge icon={<Sparkles aria-hidden />}>
              {planning ? 'Thinking' : 'Ready'}
            </AgentBadge>
          </>
        }
        className="h-full min-h-0"
        bodyClassName={cn(
          'relative flex min-h-0 flex-col overflow-y-auto p-0',
          welcoming && 'justify-center',
        )}
      >
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={cn(
            'min-h-0 overflow-y-auto overscroll-contain px-3 py-3 sm:px-5',
            welcoming ? 'flex-none' : 'flex-1',
          )}
        >
          {messagesQuery.isPending ? (
            <SkeletonRows rows={4} label="Loading your conversation" />
          ) : messagesQuery.isError && !messagesQuery.data ? (
            <ErrorState
              title="Couldn't load your conversation"
              description={messagesQuery.error.message}
              onRetry={() => void messagesQuery.refetch()}
              retrying={messagesQuery.isFetching}
            />
          ) : visible.length === 0 && !optimistic ? (
            <Welcome name={user.displayName} />
          ) : (
            <ol className="mx-auto flex w-full max-w-3xl flex-col gap-5" aria-label="Conversation">
              {visible.map((item, idx) => {
                const day = dayLabel(item.message.createdAt, now);
                const sep = day !== lastDay;
                lastDay = day;
                return (
                  <FragmentWithSeparator key={item.message.id} day={sep ? day : null}>
                    <Bubble item={item} preparing={planning && idx === visible.length - 1} />
                  </FragmentWithSeparator>
                );
              })}
              {optimistic && (
                <li className="flex justify-end">
                  <div className="max-w-[85%] rounded-xl rounded-br-sm bg-primary/80 px-4 py-2.5 text-sm text-primary-foreground">
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {optimistic.text}
                    </p>
                    <p className="mt-1.5 text-right text-[11px] text-primary-foreground/70">
                      Sending…
                    </p>
                  </div>
                </li>
              )}
              {planning && (
                <li className="flex items-center gap-2 pl-0 sm:pl-9" aria-live="polite">
                  <Sparkles className="agent-breathe size-4 text-agent" aria-hidden />
                  <span className="text-xs text-muted-foreground">
                    Agent is thinking…
                    {step && <span className="text-foreground/80"> · {step}</span>}
                  </span>
                </li>
              )}
            </ol>
          )}
        </div>

        {unseen && (
          <button
            type="button"
            onClick={() => scrollToEnd(true)}
            className="absolute bottom-[132px] left-1/2 z-10 inline-flex min-h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-agent/40 bg-card px-3 py-1.5 text-xs font-medium text-agent hover:bg-surface-2"
          >
            <ArrowDown className="size-3.5" aria-hidden /> New messages
          </button>
        )}

        <div className={cn('p-3 sm:p-4', !welcoming && 'border-t border-border')}>
          <form
            className="relative mx-auto w-full max-w-3xl"
            onSubmit={(e) => {
              e.preventDefault();
              submit(text);
            }}
            aria-label="Message your agent"
          >
            <div className="relative min-w-0">
              <label htmlFor="agent-input" className="sr-only">
                Message your agent
              </label>
              <textarea
                id="agent-input"
                ref={inputRef}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, COMPOSER_MAX_CHARS))}
                onKeyDown={onKeyDown}
                maxLength={COMPOSER_MAX_CHARS}
                disabled={planning}
                aria-describedby="agent-input-hint"
                placeholder={planning ? 'Your agent is thinking…' : 'Ask your agent…'}
                className={cn(
                  'surface-highlight block max-h-[152px] w-full resize-none rounded-lg border border-input bg-surface-2 py-3.5 pr-16 pl-4.5 text-[15px] leading-[22px] transition-colors placeholder:text-subtle-foreground hover:border-white/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60',
                  welcoming ? 'min-h-[104px]' : 'min-h-14',
                )}
              />
              <span
                id="agent-input-hint"
                className={cn(
                  'pointer-events-none absolute right-16 bottom-3 font-mono text-[10.5px] tabular-nums',
                  text.length > COMPOSER_MAX_CHARS - 50 ? 'text-caution' : 'text-subtle-foreground',
                )}
              >
                {text.length > 0 ? (
                  `${text.length}/${COMPOSER_MAX_CHARS}`
                ) : (
                  <span className="hidden sm:inline">⏎ send · ⇧⏎ line</span>
                )}
              </span>
            </div>
            <Button
              type="submit"
              size="icon"
              className="absolute right-2.5 bottom-2.5 size-10 md:size-10"
              disabled={planning || text.trim().length === 0}
              aria-label="Send message"
            >
              {planning ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </Button>
          </form>
          <ul
            className="mx-auto mt-2.5 flex max-w-3xl gap-1.5 overflow-x-auto pb-0.5"
            aria-label="Quick actions"
          >
            {QUICK_ACTIONS.map((a) => (
              <li key={a.label} className="shrink-0">
                <button
                  type="button"
                  onClick={() => composer.prefill(a.text)}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <a.icon className="size-3.5" aria-hidden />
                  {a.label}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {welcoming && <Examples onPick={composer.prefill} />}
      </Panel>
    </ComposerContext.Provider>
  );
}

function FragmentWithSeparator({
  day,
  children,
}: {
  day: string | null;
  children: React.ReactNode;
}) {
  return (
    <>
      {day && (
        <li className="sticky top-0 z-[5] -my-1 flex justify-center" aria-hidden={false}>
          <span className="micro-label rounded-full border border-border bg-card/95 px-2.5 py-0.5 text-muted-foreground backdrop-blur">
            {day}
          </span>
        </li>
      )}
      {children}
    </>
  );
}

function Welcome({ name }: { name: string | null }) {
  return (
    <div className="relative mx-auto flex max-w-xl flex-col items-center pt-4 pb-1 text-center sm:pt-6">
      <Wordmark className="pointer-events-none absolute -top-14 left-1/2 hidden h-auto w-[620px] max-w-none -translate-x-1/2 text-foreground/[0.028] md:block" />
      <span className="relative flex size-12 items-center justify-center rounded-full border border-agent/30 bg-agent/10 text-agent">
        <Sparkles className="agent-breathe size-5" aria-hidden />
      </span>
      <h3 className="text-h2 md:text-h1 relative mt-4 font-medium">
        Hi {name ?? 'there'} — I'm your agent.
      </h3>
      <p className="relative mt-2 max-w-md text-sm text-muted-foreground">
        I think on 0G, build on Uniswap and check every trade before it runs. Small, safe actions I
        do alone; anything bigger waits for you.
      </p>
    </div>
  );
}

function Examples({ onPick }: { onPick: (t: string) => void }) {
  return (
    <ul
      className="mx-auto mt-1 grid w-full max-w-3xl grid-cols-1 gap-2.5 px-3 pb-4 sm:grid-cols-2 sm:px-4 lg:grid-cols-4"
      aria-label="Example requests"
    >
      {EXAMPLES.map((e, i) => (
        <li key={e.text}>
          <button
            type="button"
            onClick={() => onPick(e.text)}
            className="surface-highlight flex h-full w-full flex-col gap-2 rounded-md border border-border bg-card p-3.5 text-left transition-colors duration-150 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span className="flex items-center justify-between">
              <CardIndex value={i + 1} />
              <e.icon className="size-3.5 text-subtle-foreground" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="micro-label block text-muted-foreground">{e.title}</span>
              <span className="mt-1 block text-sm font-medium">“{e.text}”</span>
              <span className="mt-1 block text-xs text-subtle-foreground">{e.hint}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
