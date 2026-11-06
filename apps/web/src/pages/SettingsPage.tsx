import { CHAINS, type UserView } from '@warden/shared';
import { ArrowUpRight, LogOut, ShieldCheck, UserRound, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useOutletContext } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AddressChip,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  HumanBadge,
  Panel,
  PillIcon,
} from '@/components/ui-kit';
import { useSignOut } from '@/features/auth/hooks';
import { AlertSettings } from '@/features/inbox/AlertSettings';
import { useSettings } from '@/features/portfolio/hooks';
import { StepUpButton } from '@/features/portfolio/StepUpButton';
import { formatFullTime } from '@/lib/format';
import { PageContainer, PageHeader } from './PageHeader';

export function SettingsPage() {
  const { user } = useOutletContext<{ user: UserView }>();
  const settings = useSettings();
  const signOut = useSignOut();

  return (
    <PageContainer>
      <PageHeader
        title="Settings"
        description="Your identity, your agent's wallet and your alerts."
      />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-2">
        <div className="grid gap-4">
          <Panel title="Account" icon={<UserRound />}>
            <dl className="space-y-3 text-sm">
              <Row label="Name">{user.displayName ?? '—'}</Row>
              <Row label="Identity">
                <span className="flex flex-wrap justify-end gap-1.5">
                  <HumanBadge>Verified human</HumanBadge>
                  {user.identityKind === 'dev' && <Badge tone="caution">DEV</Badge>}
                </span>
              </Row>
              <Row label="Verified">{user.verifiedAt ? formatFullTime(user.verifiedAt) : '—'}</Row>
              <Row label="Time zone">{settings.data?.timezone ?? user.timezone}</Row>
            </dl>
          </Panel>

          <Panel title="Agent wallet" icon={<Wallet />}>
            {settings.isPending ? (
              <div role="status" aria-label="Loading wallet" className="space-y-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-32" />
              </div>
            ) : settings.isError ? (
              <ErrorState
                className="py-4"
                title="Couldn't load your wallet"
                description={settings.error.message}
                onRetry={() => void settings.refetch()}
                retrying={settings.isFetching}
              />
            ) : settings.data.wallet ? (
              <div className="space-y-4">
                <dl className="space-y-3 text-sm">
                  <Row label="Address">
                    <AddressChip
                      address={settings.data.wallet.address}
                      chainId={settings.data.wallet.chainId}
                    />
                  </Row>
                  <Row label="Network">{CHAINS[settings.data.wallet.chainId].name}</Row>
                  <Row label="Created">{formatFullTime(settings.data.wallet.createdAt)}</Row>
                  <Row label="Wallet policy">
                    {settings.data.wallet.policyId ? (
                      <Badge tone="safe" icon={<ShieldCheck aria-hidden />}>
                        Privy policy enforced
                      </Badge>
                    ) : (
                      <Badge tone="neutral">Backend guard only</Badge>
                    )}
                  </Row>
                </dl>
                <p className="text-xs leading-relaxed text-subtle-foreground">
                  A Privy server wallet that only your agent controls. It can only call Uniswap
                  contracts, Permit2 and allowlisted tokens on this testnet.
                </p>
                <StepUpButton icon={<ArrowUpRight />}>Withdraw</StepUpButton>
              </div>
            ) : (
              <EmptyState
                className="py-4"
                icon={<Wallet />}
                title="No agent wallet yet"
                description="Finish onboarding to create it."
              />
            )}
          </Panel>
        </div>

        <div className="grid gap-4">
          <AlertSettings sections={['telegram', 'timezone']} />
          <Card glow="ai" className="p-5">
            <p className="micro-label text-subtle-foreground">Agent mandate</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Your risk profile, limits, auto-act switches and rules live in Autopilot.
            </p>
            <Button size="sm" variant="iconPill" asChild className="mt-4">
              <Link to="/autopilot/mandate">
                <PillIcon size="sm" /> Open mandate
              </Link>
            </Button>
          </Card>
        </div>
      </div>

      <section
        aria-labelledby="danger-title"
        className="mt-8 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/25 p-5"
      >
        <div>
          <h2 id="danger-title" className="micro-label text-danger">
            Danger zone
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Signing out ends this session. Your agent keeps its wallet, limits and rules.
          </p>
        </div>
        <Button
          variant="outline"
          className="border-danger/40 text-danger hover:bg-danger/10"
          disabled={signOut.isPending}
          onClick={() =>
            signOut.mutate(undefined, { onSettled: () => toast.success('Signed out') })
          }
        >
          <LogOut aria-hidden /> Sign out
        </Button>
      </section>
    </PageContainer>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{children}</dd>
    </div>
  );
}
