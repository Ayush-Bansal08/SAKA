import type { UserView } from '@warden/shared';
import { useOutletContext } from 'react-router';
import { PortfolioView } from '@/features/portfolio/PortfolioPanel';

export function PortfolioPage() {
  const { user } = useOutletContext<{ user: UserView }>();
  return <PortfolioView user={user} />;
}
