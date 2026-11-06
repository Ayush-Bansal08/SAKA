import { useProviders } from '@/features/auth/hooks';
import { SimulatorPanel } from '@/features/simulator/SimulatorPanel';
import { NotFoundPage } from './NotFoundPage';

/** With the flag off this path is the ordinary not-found page. */
export function SimulatorPage() {
  const providers = useProviders();
  return providers.data?.demoSimulator ? <SimulatorPanel /> : <NotFoundPage />;
}
