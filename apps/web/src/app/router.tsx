import { createBrowserRouter } from 'react-router';
import { ActivityPage } from '@/pages/ActivityPage';
import { CockpitPage } from '@/pages/CockpitPage';
import { HooksPage } from '@/pages/HooksPage';
import { InboxPage } from '@/pages/InboxPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { AuthGate } from './AuthGate';
import { RouteError } from './RouteError';

export const router = createBrowserRouter([
  {
    element: <AuthGate />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <CockpitPage /> },
      { path: 'hooks', element: <HooksPage /> },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'activity', element: <ActivityPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
