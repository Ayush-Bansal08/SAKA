import { usd, type UserView } from '@warden/shared';
import { ChevronDown, LogOut, Settings } from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AddressChip, Badge, HumanBadge } from '@/components/ui-kit';
import { useSignOut } from '@/features/auth/hooks';
import { usePortfolio } from '@/features/portfolio/hooks';
import { initials } from '@/lib/format';

export function UserMenu({ user }: { user: UserView }) {
  const navigate = useNavigate();
  const signOut = useSignOut();
  const portfolio = usePortfolio().data;
  const name = user.displayName ?? 'You';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account menu for ${name}`}
        className="flex items-center gap-2 rounded-full border border-border bg-surface-2 py-0.5 pr-2 pl-0.5 text-sm transition-colors outline-none hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {initials(user.displayName)}
        </span>
        <span className="hidden max-w-[8rem] truncate font-medium lg:inline">{name}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[16rem]">
        <DropdownMenuLabel>
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <HumanBadge>Account owner</HumanBadge>
            {user.identityKind === 'dev' && <Badge tone="caution">DEV identity</Badge>}
          </div>
        </DropdownMenuLabel>
        {portfolio?.address && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              <p className="micro-label text-subtle-foreground">Agent wallet</p>
              <p className="mt-1 text-base font-medium tabular">{usd(portfolio.totalUsd)}</p>
              <AddressChip
                address={portfolio.address}
                chainId={portfolio.chainId}
                className="mt-1.5"
              />
            </DropdownMenuLabel>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <Settings aria-hidden /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            signOut.mutate(undefined, { onSettled: () => toast.success('Signed out') })
          }
        >
          <LogOut aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
