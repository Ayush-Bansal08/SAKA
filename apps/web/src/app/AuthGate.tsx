/**
 * Decides what the whole app renders: splash → API error → sign-in → onboarding → shell.
 * The shell (and the single SSE connection) only mounts with a valid session.
 */
import { ErrorState } from '@/components/ui-kit';
import { useMe, useProviders, useSessionToken } from '@/features/auth/hooks';
import { SignInPage } from '@/features/auth/SignInPage';
import { OnboardingWizard } from '@/features/onboarding/OnboardingWizard';
import { TraceStreamProvider } from '@/features/trace/TraceStreamProvider';
import { AppShell } from '@/layout/AppShell';
import { Wordmark } from '@/layout/Logo';
import { ApiError } from '@/lib/api';
import { API_URL } from '@/lib/config';

function Splash({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex min-h-dvh items-center justify-center"
    >
      <Wordmark className="agent-breathe h-12" />
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function AuthGate() {
  const providers = useProviders();
  const token = useSessionToken();
  const me = useMe(Boolean(token) && providers.isSuccess);

  if (providers.isPending) return <Splash label="Loading" />;
  if (providers.isError) {
    const err = providers.error;
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <ErrorState
          title="Can't reach SAKA"
          description={
            err instanceof ApiError && err.isNetwork
              ? `The API at ${API_URL} is not responding. Make sure it is running, then try again.`
              : (err?.message ?? 'Unexpected error')
          }
          onRetry={() => void providers.refetch()}
          retrying={providers.isFetching}
        />
      </div>
    );
  }

  if (!token) return <SignInPage providers={providers.data} />;
  if (me.isPending) return <Splash label="Signing you in" />;
  if (me.isError) {
    // 401 clears the session (→ sign-in on next render); anything else is shown with retry.
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <ErrorState
          title="Couldn't load your account"
          description={me.error.message}
          onRetry={() => void me.refetch()}
          retrying={me.isFetching}
        />
      </div>
    );
  }

  return (
    <TraceStreamProvider token={token}>
      {me.data.onboardingStep === 'DONE' ? (
        <AppShell providers={providers.data} user={me.data} />
      ) : (
        <OnboardingWizard providers={providers.data} user={me.data} />
      )}
    </TraceStreamProvider>
  );
}
