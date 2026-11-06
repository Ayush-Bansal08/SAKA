import { createBrowserRouter } from 'react-router';
import { ActivityPage } from '@/pages/ActivityPage';
import { ApprovalPage } from '@/pages/ApprovalPage';
import { AskPage } from '@/pages/AskPage';
import { AutopilotPage } from '@/pages/autopilot/AutopilotPage';
import { DecisionsTab } from '@/pages/autopilot/DecisionsTab';
import { MandateTab } from '@/pages/autopilot/MandateTab';
import { HomePage } from '@/pages/HomePage';
import { HookDetailPage } from '@/pages/HookDetailPage';
import { HooksPage } from '@/pages/HooksPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { PortfolioPage } from '@/pages/PortfolioPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { SimulatorPage } from '@/pages/SimulatorPage';
import { AuthGate } from './AuthGate';
import { Redirect } from './Redirect';
import { RouteError } from './RouteError';

export const router = createBrowserRouter([
  {
    element: <AuthGate />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'ask', element: <AskPage /> },
      {
        path: 'autopilot',
        element: <AutopilotPage />,
        children: [
          { index: true, element: <DecisionsTab /> },
          { path: 'mandate', element: <MandateTab /> },
          { path: 'simulator', element: <SimulatorPage /> },
        ],
      },
      { path: 'portfolio', element: <PortfolioPage /> },
      { path: 'hooks', element: <HooksPage /> },
      { path: 'hooks/:chainId/:address', element: <HookDetailPage /> },
      { path: 'activity', element: <ActivityPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'approvals/:id', element: <ApprovalPage /> },
      // Old paths: bookmarks, toasts and older links keep working.
      { path: 'inbox', element: <Redirect to="/autopilot" /> },
      { path: 'inbox/simulator', element: <Redirect to="/autopilot/simulator" /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
