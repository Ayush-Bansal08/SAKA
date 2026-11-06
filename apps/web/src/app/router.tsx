import { createBrowserRouter } from 'react-router';
import { ActivityPage } from '@/pages/ActivityPage';
import { ApprovalPage } from '@/pages/ApprovalPage';
import { CockpitPage } from '@/pages/CockpitPage';
import { HookDetailPage } from '@/pages/HookDetailPage';
import { HooksPage } from '@/pages/HooksPage';
import { InboxPage } from '@/pages/InboxPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { SimulatorPage } from '@/pages/SimulatorPage';
import { AuthGate } from './AuthGate';
import { RouteError } from './RouteError';

export const router = createBrowserRouter([
  {
    element: <AuthGate />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <CockpitPage /> },
      { path: 'hooks', element: <HooksPage /> },
      { path: 'hooks/:chainId/:address', element: <HookDetailPage /> },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'inbox/simulator', element: <SimulatorPage /> },
      { path: 'activity', element: <ActivityPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'approvals/:id', element: <ApprovalPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
