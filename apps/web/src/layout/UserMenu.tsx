import type { UserView } from '@warden/shared';
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
import { Badge, HumanBadge } from '@/components/ui-kit';
import { useSignOut } from '@/features/auth/hooks';
import { initials } from '@/lib/format';

export function UserMenu({ user }: { user: UserView }) {
  const navigate = useNavigate();
  const signOut = useSignOut();
  const name = user.displayName ?? 'You';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account menu for ${name}`}
        className="flex items-center gap-2 rounded-full border border-border bg-surface-2 py-1 pr-2 pl-1 text-sm transition-colors outline-none hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-human/15 text-xs font-semibold text-human">
          {initials(user.displayName)}
        </span>
        <span className="hidden max-w-[10rem] truncate font-medium sm:inline">{name}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <div className="truncate text-sm font-semibold">{name}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <HumanBadge>Verified human</HumanBadge>
            {user.identityKind === 'dev' && <Badge tone="caution">DEV identity</Badge>}
          </div>
        </DropdownMenuLabel>
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
