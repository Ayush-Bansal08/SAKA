import {
  Blocks,
  History,
  House,
  Radar,
  Settings,
  Sparkles,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

/** The five views that also make up the mobile tab bar. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Home', icon: House, description: 'How you are doing at a glance' },
  { to: '/ask', label: 'Ask', icon: Sparkles, description: 'Tell your agent what to do' },
  {
    to: '/autopilot',
    label: 'Autopilot',
    icon: Radar,
    description: 'Approvals, suggestions and limits',
  },
  { to: '/portfolio', label: 'Portfolio', icon: Wallet, description: 'What you own' },
  { to: '/activity', label: 'Activity', icon: History, description: 'Actions and proofs' },
];

export const HOOKS_ITEM: NavItem = {
  to: '/hooks',
  label: 'Hooks',
  icon: Blocks,
  description: 'Uniswap v4 hook explorer',
};

export const SETTINGS_ITEM: NavItem = {
  to: '/settings',
  label: 'Settings',
  icon: Settings,
  description: 'Account, wallet and alerts',
};

/** The label for the top bar: the view this path belongs to. */
export function sectionLabel(pathname: string): string {
  if (pathname.startsWith('/approvals')) return 'Approval';
  const items = [...NAV_ITEMS, HOOKS_ITEM, SETTINGS_ITEM];
  const hit = items.find((i) =>
    i.to === '/' ? pathname === '/' : pathname === i.to || pathname.startsWith(`${i.to}/`),
  );
  return hit?.label ?? 'SAKA';
}
