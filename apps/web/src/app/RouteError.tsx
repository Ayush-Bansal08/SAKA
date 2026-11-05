import { isRouteErrorResponse, useRouteError } from 'react-router';
import { ErrorState } from '@/components/ui-kit';

/** Last-resort boundary for render errors anywhere in the route tree. */
export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unexpected error';
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <ErrorState
        title="This view crashed"
        description={message}
        onRetry={() => window.location.reload()}
      />
    </div>
  );
}
