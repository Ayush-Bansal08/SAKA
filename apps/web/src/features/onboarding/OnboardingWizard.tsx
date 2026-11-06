/**
 * Full-screen onboarding (PHASE 03 §5): Verified human → Agent wallet → Risk profile → Fund.
 * The server owns the state machine (GET /onboarding); this view only decides which screen to
 * show and keeps the freshly created address on screen before moving on.
 */
import {
  CHAINS,
  RISK_PROFILES,
  riskProfileSettings,
  usd,
  type OnboardingResponse,
  type ProvidersResponse,
  type RiskProfile,
  type UserView,
} from '@warden/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Droplets,
  ExternalLink,
  Fingerprint,
  Gauge,
  Loader2,
  ShieldCheck,
  Sparkles,
  Wallet,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge, Banner, CopyButton, ErrorState, HumanBadge } from '@/components/ui-kit';
import { queryKeys as authKeys } from '@/features/auth/hooks';
import {
  useChooseProfile,
  useCreateWallet,
  useOnboarding,
  useOnTraceEvent,
} from '@/features/portfolio/hooks';
import { PROFILE_COPY } from '@/features/portfolio/profile-copy';
import { DevBanner } from '@/layout/DevBanner';
import { usesDevProviders } from '@/layout/dev-mode';
import { Logo } from '@/layout/Logo';
import { UserMenu } from '@/layout/UserMenu';
import { formatTokenAmount } from '@/lib/format';
import { cn } from '@/lib/utils';

type View = 'verify' | 'wallet' | 'profile' | 'fund' | 'done';

const STEPS: { view: Exclude<View, 'done'>; label: string; icon: ReactNode }[] = [
  { view: 'verify', label: 'Verified human', icon: <Fingerprint /> },
  { view: 'wallet', label: 'Agent wallet', icon: <Wallet /> },
  { view: 'profile', label: 'Risk profile', icon: <Gauge /> },
  { view: 'fund', label: 'Fund', icon: <Droplets /> },
];

const FUND_POLL_MS = 4_000;
const AUTO_CONTINUE_MS = 5_000;

function viewForStep(step: OnboardingResponse['step']): View {
  switch (step) {
    case 'VERIFY':
    case 'WALLET':
      return 'verify';
    case 'PROFILE':
      return 'profile';
    case 'FUND':
      return 'fund';
    case 'DONE':
      return 'done';
  }
}

export function OnboardingWizard({
  providers,
  user,
}: {
  providers: ProvidersResponse;
  user: UserView;
}) {
  const qc = useQueryClient();
  const [override, setOverride] = useState<View | null>(null);
  const onboarding = useOnboarding({ pollWhileFundingMs: FUND_POLL_MS });
  const data = onboarding.data;
  const serverView = data ? viewForStep(data.step) : null;
  // Funding completing always wins over a local override (address card, change profile).
  const view: View | null = serverView === 'done' ? 'done' : (override ?? serverView);

  // Deposits arrive on the live stream before the next poll.
  useOnTraceEvent(
    (e) => e.kind === 'receipt',
    () => void onboarding.refetch(),
  );

  const finished = useRef(false);
  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    // /me now reports DONE, so AuthGate swaps the wizard for the cockpit.
    void qc.invalidateQueries({ queryKey: authKeys.me });
  }, [qc]);

  return (
    <div className="flex min-h-dvh flex-col">
      {usesDevProviders(providers) && <DevBanner />}
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 md:px-6">
        <Logo appName={providers.appName} />
        <UserMenu user={user} />
      </header>

      <main id="main" className="flex flex-1 justify-center px-4 py-6 md:py-10">
        <div className="w-full max-w-2xl">
          {view ? (
            <Progress current={view} />
          ) : (
            <div className="grid grid-cols-4 gap-2" aria-hidden>
              {STEPS.map((step) => (
                <Skeleton key={step.view} className="h-1 rounded-full" />
              ))}
            </div>
          )}
          <div className="glass mt-6 rounded-lg border border-border p-5 sm:p-8">
            {onboarding.isPending ? (
              <WizardSkeleton />
            ) : onboarding.isError ? (
              <ErrorState
                className="py-6"
                title="Couldn't load your onboarding"
                description={onboarding.error.message}
                onRetry={() => void onboarding.refetch()}
                retrying={onboarding.isFetching}
              />
            ) : data && view === 'verify' ? (
              <VerifyStep
                isDev={user.identityKind === 'dev'}
                onContinue={() => setOverride('wallet')}
              />
            ) : data && view === 'wallet' ? (
              <WalletStep data={data} onContinue={() => setOverride('profile')} />
            ) : data && view === 'profile' ? (
              <ProfileStep
                current={data.profile}
                onDone={() => setOverride(null)}
                onBack={data.wallet ? () => setOverride('wallet') : undefined}
              />
            ) : data && view === 'fund' ? (
              <FundStep data={data} onChangeProfile={() => setOverride('profile')} />
            ) : data ? (
              <DoneStep data={data} onContinue={finish} />
            ) : null}
          </div>
          <p className="mt-4 text-center text-xs text-subtle-foreground">
            Testnet only · your agent executes on {CHAINS[providers.executionChainId].name}
          </p>
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function Progress({ current }: { current: View }) {
  const index = current === 'done' ? STEPS.length : STEPS.findIndex((s) => s.view === current);
  return (
    <nav aria-label="Onboarding progress">
      <ol className="grid grid-cols-4 gap-2">
        {STEPS.map((s, i) => {
          const done = i < index;
          const active = i === index;
          return (
            <li key={s.view} aria-current={active ? 'step' : undefined} className="min-w-0">
              <div
                className={cn(
                  'h-1 rounded-full transition-colors duration-500',
                  done ? 'bg-safe' : active ? 'bg-agent' : 'bg-surface-3',
                )}
              />
              <div
                className={cn(
                  'mt-2 flex items-center gap-1.5 text-xs font-medium',
                  done ? 'text-safe' : active ? 'text-foreground' : 'text-subtle-foreground',
                )}
              >
                <span className="hidden sm:inline [&_svg]:size-3.5">
                  {done ? <Check aria-hidden /> : s.icon}
                </span>
                <span className="truncate">{s.label}</span>
                {done && <span className="sr-only">(done)</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepHeader({
  icon,
  tone = 'agent',
  title,
  description,
}: {
  icon: ReactNode;
  tone?: 'agent' | 'human' | 'safe';
  title: string;
  description?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <div
        className={cn(
          'flex size-14 items-center justify-center rounded-full border [&_svg]:size-6',
          tone === 'agent' && 'border-agent/25 bg-agent/10 text-agent',
          tone === 'human' && 'border-human/25 bg-human/10 text-human',
          tone === 'safe' && 'border-safe/25 bg-safe/10 text-safe',
        )}
      >
        {icon}
      </div>
      <h1 className="text-h2 mt-4 font-medium">{title}</h1>
      {description && (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

function WizardSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col items-center gap-4 py-4">
      <Skeleton className="size-14 rounded-2xl" />
      <Skeleton className="h-6 w-56" />
      <Skeleton className="h-4 w-72" />
      <Skeleton className="mt-4 h-11 w-48" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Verified human
// ---------------------------------------------------------------------------

function VerifyStep({ isDev, onContinue }: { isDev: boolean; onContinue: () => void }) {
  return (
    <div className="flex flex-col items-center">
      <StepHeader
        tone="human"
        icon={<ShieldCheck />}
        title="You're a verified human"
        description="One human gets one agent. Your agent can only act within the limits you set, and anything bigger waits for you."
      />
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <HumanBadge>Verified human</HumanBadge>
        {isDev && <Badge tone="caution">DEV</Badge>}
      </div>
      {isDev && (
        <p className="mt-3 text-center text-xs text-caution">
          World ID verification arrives in Phase 10. You signed in with a DEV identity.
        </p>
      )}
      <Button size="lg" className="mt-7 w-full sm:w-auto" onClick={onContinue} autoFocus>
        Create my agent wallet
        <ArrowRight aria-hidden />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Agent wallet
// ---------------------------------------------------------------------------

function WalletStep({ data, onContinue }: { data: OnboardingResponse; onContinue: () => void }) {
  const create = useCreateWallet();
  const { mutate } = create;
  const hasWallet = data.wallet !== null;
  const started = useRef(false);

  useEffect(() => {
    // Once per mount, even under StrictMode's double effects (the API is idempotent anyway).
    if (hasWallet || started.current) return;
    started.current = true;
    mutate();
  }, [hasWallet, mutate]);

  if (create.isError && !data.wallet) {
    return (
      <div className="flex flex-col items-center">
        <StepHeader icon={<Wallet />} title="We couldn't create your agent wallet" />
        <Banner tone="warn" className="mt-5 w-full">
          {create.error.message}
        </Banner>
        <Button className="mt-5" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Try again
        </Button>
      </div>
    );
  }

  if (!data.wallet) {
    return (
      <div className="flex flex-col items-center py-4" role="status" aria-live="polite">
        <div className="relative flex size-20 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-agent/15 motion-reduce:animate-none" />
          <span className="absolute inset-2 rounded-full border border-agent/30 bg-agent/10" />
          <Bot className="relative size-8 text-agent" aria-hidden />
        </div>
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Creating your agent wallet…</h1>
        <p className="mt-2 max-w-sm text-center text-sm text-muted-foreground">
          A Privy server wallet with a policy that only lets it talk to Uniswap and your allowlisted
          tokens.
        </p>
      </div>
    );
  }

  const chain = CHAINS[data.wallet.chainId];
  return (
    <div className="flex flex-col items-center">
      <StepHeader
        tone="safe"
        icon={<Check />}
        title="Your agent wallet is ready"
        description="This wallet belongs to your agent. You fund it; it trades within your limits."
      />
      <AddressCard address={data.wallet.address} chainId={data.wallet.chainId} />
      <ul className="mt-4 w-full space-y-2 text-xs text-muted-foreground">
        <li className="flex items-center gap-2">
          <ShieldCheck className="size-3.5 shrink-0 text-safe" aria-hidden />
          {data.wallet.policyId
            ? 'Privy policy attached: only Uniswap contracts, Permit2 and allowlisted tokens.'
            : 'Guarded by SAKA’s policy engine (Privy policies are not enabled on this plan).'}
        </li>
        <li className="flex items-center gap-2">
          <Sparkles className="size-3.5 shrink-0 text-agent" aria-hidden />
          Lives on {chain.name} — testnet funds only.
        </li>
      </ul>
      <Button size="lg" className="mt-7 w-full sm:w-auto" onClick={onContinue} autoFocus>
        Choose how careful it should be
        <ArrowRight aria-hidden />
      </Button>
    </div>
  );
}

function AddressCard({
  address,
  chainId,
  qr = false,
}: {
  address: string;
  chainId: OnboardingResponse['funding']['chainId'];
  qr?: boolean;
}) {
  const chain = CHAINS[chainId];
  return (
    <div
      className={cn(
        'mt-6 flex w-full flex-col items-center gap-4 rounded-lg border border-border bg-surface-2/60 p-4 sm:flex-row sm:items-center',
        !qr && 'sm:justify-center',
      )}
    >
      {qr && (
        <div className="shrink-0 rounded-lg bg-white p-2.5" aria-hidden>
          <QRCodeSVG value={`ethereum:${address}@${chainId}`} size={132} level="M" />
        </div>
      )}
      <div className="min-w-0 flex-1 text-center sm:text-left">
        <div className="text-xs font-medium text-muted-foreground">Agent wallet · {chain.name}</div>
        <div className="mt-1.5 flex items-center justify-center gap-1 sm:justify-start">
          <code className="font-mono text-sm break-all text-foreground sm:text-sm">
            {address}
          </code>
          <CopyButton value={address} label="Copy wallet address" className="size-7 shrink-0" />
        </div>
        <a
          href={`${chain.explorerBaseUrl}/address/${address}`}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-2 inline-flex items-center gap-1 text-xs text-info hover:underline"
        >
          View on explorer <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Risk profile
// ---------------------------------------------------------------------------

function ProfileStep({
  current,
  onDone,
  onBack,
}: {
  current: RiskProfile | null;
  onDone: () => void;
  onBack?: (() => void) | undefined;
}) {
  const [selected, setSelected] = useState<RiskProfile>(current ?? 'BALANCED');
  const choose = useChooseProfile();

  return (
    <div>
      <StepHeader
        icon={<Gauge />}
        title="How careful should your agent be?"
        description="These are the limits for what your agent may do on its own. Anything above them waits for you."
      />
      <div
        role="radiogroup"
        aria-label="Risk profile"
        className="mt-6 grid gap-3 sm:grid-cols-3"
        onKeyDown={(e) => {
          const i = RISK_PROFILES.indexOf(selected);
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            setSelected(RISK_PROFILES[(i + 1) % RISK_PROFILES.length]!);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            setSelected(RISK_PROFILES[(i + RISK_PROFILES.length - 1) % RISK_PROFILES.length]!);
          }
        }}
      >
        {RISK_PROFILES.map((p) => {
          const s = riskProfileSettings(p);
          const active = p === selected;
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setSelected(p)}
              className={cn(
                'flex flex-col rounded-lg border p-4 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'border-agent/60 bg-agent/[0.07] ring-1 ring-agent/30'
                  : 'border-border bg-surface-2/40 hover:border-border-strong',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{PROFILE_COPY[p].label}</span>
                <span
                  className={cn(
                    'flex size-4 items-center justify-center rounded-full border',
                    active
                      ? 'border-agent bg-agent text-primary-foreground'
                      : 'border-border-strong',
                  )}
                  aria-hidden
                >
                  {active && <Check className="size-3" />}
                </span>
              </span>
              <span className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                {PROFILE_COPY[p].blurb} {PROFILE_COPY[p].detail}
              </span>
              <dl className="mt-4 space-y-1.5 border-t border-border pt-3 text-xs">
                <Mini label="Per action">{usd(s.perActionUsd)}</Mini>
                <Mini label="Per day">{usd(s.perDayUsd)}</Mini>
                <Mini label="Max slippage">{s.maxSlippagePct}%</Mini>
              </dl>
            </button>
          );
        })}
      </div>
      {choose.isError && (
        <Banner tone="warn" className="mt-4">
          {choose.error.message}
        </Banner>
      )}
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft aria-hidden />
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button
          size="lg"
          disabled={choose.isPending}
          onClick={() => choose.mutate(selected, { onSuccess: onDone })}
        >
          {choose.isPending && <Loader2 className="animate-spin" aria-hidden />}
          Use {PROFILE_COPY[selected].label}
          <ArrowRight aria-hidden />
        </Button>
      </div>
      <p className="mt-4 text-center text-xs text-subtle-foreground sm:text-right">
        After funding, changing your profile needs a fresh human verification.
      </p>
    </div>
  );
}

function Mini({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-subtle-foreground">{label}</dt>
      <dd className="font-medium tabular">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Fund
// ---------------------------------------------------------------------------

function FundStep({
  data,
  onChangeProfile,
}: {
  data: OnboardingResponse;
  onChangeProfile: () => void;
}) {
  const chain = CHAINS[data.funding.chainId];
  const deposit = data.funding.firstDeposit;
  if (!data.wallet) return null;
  return (
    <div>
      <StepHeader
        icon={<Droplets />}
        title="Fund your agent"
        description={
          <>
            Send about{' '}
            <strong className="text-foreground">
              {data.funding.suggestedEth} {chain.nativeSymbol}
            </strong>{' '}
            of {chain.name} testnet ETH to your agent's wallet. ETH also pays for gas.
          </>
        }
      />
      <AddressCard address={data.wallet.address} chainId={data.wallet.chainId} qr />

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {data.funding.faucets.map((f) => (
          <a
            key={f.url}
            href={f.url}
            target="_blank"
            rel="noreferrer noopener"
            className="group flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2/40 px-3.5 py-3 text-sm transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span className="min-w-0">
              <span className="block font-medium">{f.label}</span>
              <span className="block text-xs text-muted-foreground">
                {f.asset === 'ETH'
                  ? 'Free testnet ETH for gas and trades'
                  : 'Optional: testnet USDC'}
              </span>
            </span>
            <ExternalLink
              className="size-4 shrink-0 text-subtle-foreground group-hover:text-foreground"
              aria-hidden
            />
          </a>
        ))}
      </div>

      {deposit && deposit.symbol !== chain.nativeSymbol && (
        <Banner className="mt-4">
          Received {formatTokenAmount(deposit.amount)} {deposit.symbol}. Send a little{' '}
          {chain.nativeSymbol} too, so your agent can pay for gas.
        </Banner>
      )}

      <div
        className="mt-6 flex items-center justify-center gap-3 rounded-lg border border-dashed border-border-strong px-4 py-3.5"
        role="status"
        aria-live="polite"
      >
        <span className="relative flex size-2.5" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-info opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2.5 rounded-full bg-info" />
        </span>
        <span className="text-sm text-muted-foreground">
          Waiting for your deposit… this updates on its own.
        </span>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs text-subtle-foreground">
        <span>
          Profile:{' '}
          <span className="text-foreground">
            {data.profile ? PROFILE_COPY[data.profile].label : '—'}
          </span>
        </span>
        <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={onChangeProfile}>
          Change profile
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

function DoneStep({ data, onContinue }: { data: OnboardingResponse; onContinue: () => void }) {
  const deposit = data.funding.firstDeposit;
  const [left, setLeft] = useState(Math.round(AUTO_CONTINUE_MS / 1000));

  useEffect(() => {
    if (left <= 0) {
      onContinue();
      return;
    }
    const t = setTimeout(() => setLeft((s) => s - 1), 1_000);
    return () => clearTimeout(t);
  }, [left, onContinue]);

  return (
    <div className="flex flex-col items-center" role="status" aria-live="polite">
      <StepHeader
        tone="safe"
        icon={<Check />}
        title={
          deposit
            ? `Received ${formatTokenAmount(deposit.amount)} ${deposit.symbol} — your agent is ready`
            : 'Your agent is ready'
        }
        description={
          deposit?.valueUsd
            ? `About ${usd(deposit.valueUsd)} at the Ethereum mainnet reference price.`
            : 'Your cockpit shows balances, P&L and your risk meter.'
        }
      />
      <Button size="lg" className="mt-7 w-full sm:w-auto" onClick={onContinue} autoFocus>
        Open my cockpit
        <ArrowRight aria-hidden />
      </Button>
      <p className="mt-3 text-xs text-subtle-foreground">Continuing in {left}s…</p>
    </div>
  );
}
