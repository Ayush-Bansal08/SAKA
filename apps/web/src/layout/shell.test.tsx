// @vitest-environment jsdom
import { act, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Redirect } from '@/app/Redirect';
import { observePrefill, requestPrefill, subscribePrefill } from '@/features/agent/prefill';
import { useStoredFlag } from '@/hooks/useStoredFlag';
import { sectionLabel } from './nav';

describe('sectionLabel', () => {
  it('names the view a path belongs to', () => {
    expect(sectionLabel('/')).toBe('Home');
    expect(sectionLabel('/autopilot/simulator')).toBe('Autopilot');
    expect(sectionLabel('/hooks/1/0xabc')).toBe('Hooks');
    expect(sectionLabel('/approvals/a1')).toBe('Approval');
  });

  it('does not mistake a longer path for a view', () => {
    expect(sectionLabel('/asking')).toBe('SAKA');
  });
});

describe('Redirect', () => {
  function Where() {
    const l = useLocation();
    return <p>{`${l.pathname}${l.search}`}</p>;
  }

  it('moves to the new path and keeps the query string', () => {
    render(
      <MemoryRouter initialEntries={['/inbox?plan=p1']}>
        <Routes>
          <Route path="/inbox" element={<Redirect to="/autopilot" />} />
          <Route path="/autopilot" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('/autopilot?plan=p1')).toBeInTheDocument();
  });
});

describe('prefill observers', () => {
  it('are told about every request and leave the text for the chat', () => {
    const seen: string[] = [];
    const stop = observePrefill((t) => seen.push(t));
    requestPrefill('Exit my position');
    stop();
    requestPrefill('Not seen');
    expect(seen).toEqual(['Exit my position']);
    const sub = subscribePrefill(() => undefined);
    expect(sub.initial).toBe('Not seen');
    sub.unsubscribe();
  });
});

describe('useStoredFlag', () => {
  afterEach(() => vi.restoreAllMocks());

  it('falls back to the default, remembers changes and keeps components in step', () => {
    const a = renderHook(() => useStoredFlag('test.flag.shared'));
    const b = renderHook(() => useStoredFlag('test.flag.shared'));
    expect(a.result.current[0]).toBe(false);
    act(() => a.result.current[1](true));
    expect(b.result.current[0]).toBe(true);
    expect(localStorage.getItem('test.flag.shared')).toBe('1');
  });

  it('still works when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useStoredFlag('test.flag.blocked', true));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
  });
});
