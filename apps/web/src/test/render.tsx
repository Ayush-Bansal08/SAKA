/* eslint-disable react-refresh/only-export-components -- test helper */
/** Component-test harness: router, query client, trace stream and composer contexts. */
import type { TraceEvent } from '@warden/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ComposerContext, type ComposerApi } from '@/features/agent/composer-context';
import { TraceStreamContext } from '@/features/trace/trace-context';

export interface Harness extends RenderResult {
  fetchMock: ReturnType<typeof vi.fn>;
  composer: ComposerApi & { prefill: ReturnType<typeof vi.fn> };
  location: () => string;
}

export function renderUi(
  ui: ReactElement,
  opts: { events?: TraceEvent[]; route?: string; responses?: Record<string, unknown> } = {},
): Harness {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(opts.responses ?? {}).find(([k]) => url.includes(k));
    return new Response(JSON.stringify(hit ? hit[1] : {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const composer = { prefill: vi.fn() };
  let current = opts.route ?? '/';
  function Spy() {
    const l = useLocation();
    current = `${l.pathname}${l.search}`;
    return null;
  }
  const result = render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[opts.route ?? '/']}>
          <TraceStreamContext.Provider
            value={{ events: opts.events ?? [], status: 'live', hasReceived: true }}
          >
            <ComposerContext.Provider value={composer}>
              <Routes>
                <Route
                  path="*"
                  element={
                    <>
                      <Spy />
                      {ui}
                    </>
                  }
                />
              </Routes>
            </ComposerContext.Provider>
          </TraceStreamContext.Provider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...result, fetchMock, composer, location: () => current };
}

export const ISO = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
