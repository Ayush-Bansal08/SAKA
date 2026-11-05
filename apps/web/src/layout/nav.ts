import { Activity, Blocks, Inbox, LayoutDashboard, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    to: '/',
    label: 'Cockpit',
    icon: LayoutDashboard,
    description: 'Portfolio, agent and live activity',
  },
  { to: '/hooks', label: 'Hooks', icon: Blocks, description: 'Uniswap v4 hook explorer' },
  { to: '/inbox', label: 'Inbox', icon: Inbox, description: 'Suggestions and approvals' },
  {
    to: '/activity',
    label: 'Activity',
    icon: Activity,
    description: 'Executed actions and proofs',
  },
  { to: '/settings', label: 'Settings', icon: Settings, description: 'Profile, limits and alerts' },
];
