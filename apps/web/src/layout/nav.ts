import { Blocks, History, Radar, Settings, Sparkles, Wallet, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const AGENT_ITEM: NavItem = {
  to: '/app',
  label: 'Agent',
  icon: Sparkles,
  description: 'Tell your agent what to do',
};

export const WORKSPACE_ITEMS: readonly NavItem[] = [
  { to: '/portfolio', label: 'Portfolio', icon: Wallet, description: 'What you own' },
  {
    to: '/autopilot',
    label: 'Autopilot',
    icon: Radar,
    description: 'Approvals, suggestions and limits',
  },
  { to: '/activity', label: 'Activity', icon: History, description: 'Actions and proofs' },
  { to: '/hooks', label: 'Hooks', icon: Blocks, description: 'Uniswap v4 hook explorer' },
];

/** The five views that make up the mobile tab bar. */
export const NAV_ITEMS: readonly NavItem[] = [AGENT_ITEM, ...WORKSPACE_ITEMS];

export const SETTINGS_ITEM: NavItem = {
  to: '/settings',
  label: 'Settings',
  icon: Settings,
  description: 'Account, wallet and alerts',
};
