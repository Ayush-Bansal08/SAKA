import { Fingerprint, ShieldAlert } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Badge, ErrorState, HashChip, Panel, SkeletonRows } from '@/components/ui-kit';
import { useApproval, usePlanAction } from '@/features/agent/plan-hooks';
import { useNow } from '@/hooks/useNow';
import { ApiError } from '@/lib/api';
import { PageContainer, PageHeader } from './PageHeader';

/** Approval page (the provider's verification URL): what, why, expiry, Approve/Deny. */
export function ApprovalPage() {
  const { id = '' } = useParams();
  const approval = useApproval(id);
  const action = usePlanAction();
  const now = useNow(1000);
  const a = approval.data;
  const left = a ? Math.max(0, Math.floor((Date.parse(a.expiresAt) - now) / 1000)) : 0;
  const pending = a?.status === 'PENDING' && left > 0;
  return (
    <PageContainer>
      <PageHeader title="Approval" description="Your agent wants to do something that needs you." />
      <Panel title={a?.summary ?? 'Loading…'} icon={<ShieldAlert />} className="max-w-xl">
        {approval.isPending ? (
          <SkeletonRows rows={3} />
        ) : approval.isError ? (
          <ErrorState
            title={
              approval.error instanceof ApiError && approval.error.status === 404
                ? 'Approval not found'
                : "Couldn't load this approval"
            }
            description={approval.error.message}
            onRetry={() => void approval.refetch()}
            retrying={approval.isFetching}
          />
        ) : a ? (
          <div className="space-y-4 text-sm">
            <p>{a.reason}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-muted-foreground">Value</dt>
              <dd className="tabular-nums">${a.amountUsd}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <Badge
                  tone={
                    pending
                      ? 'caution'
                      : a.status === 'APPROVED' || a.status === 'USED'
                        ? 'safe'
                        : 'neutral'
                  }
                >
                  {a.status === 'PENDING' && left === 0 ? 'EXPIRED' : a.status}
                </Badge>
              </dd>
              {pending && (
                <>
                  <dt className="text-muted-foreground">Expires in</dt>
                  <dd className="tabular-nums">
                    {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">Plan hash</dt>
              <dd>
                <HashChip value={a.planHash} />
              </dd>
            </dl>
            {pending ? (
              <div className="flex flex-wrap gap-2">
                {a.devApproveAvailable && (
                  <Button
                    disabled={action.isPending}
                    onClick={() => action.mutate({ kind: 'dev-approve', approvalId: a.id })}
                  >
                    <Fingerprint aria-hidden /> Approve (DEV)
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={action.isPending}
                  onClick={() => action.mutate({ kind: 'deny', approvalId: a.id })}
                >
                  Deny
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground">
                This approval is closed.{' '}
                <Link to="/" className="text-primary underline-offset-4 hover:underline">
                  Back to your agent
                </Link>
              </p>
            )}
            {a.providerKind === 'dev' && (
              <p className="text-[12px] text-caution">
                DEV approval — World ID step-up arrives in Phase 10.
              </p>
            )}
          </div>
        ) : null}
      </Panel>
    </PageContainer>
  );
}
