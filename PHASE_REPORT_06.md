# Phase 06 — Cockpit UI: agent chat, cards, live activity, activity page, approvals UI

Status: **built and verified** with unit, component and Playwright tests and against the live
local stack. Live AUTO execution on testnet is still blocked by the 0G model outage reported in
Phase 05 (Vela guard and 0GM explainer down on 0G's side), so the guard refuses every live action.
The UI shows that refusal correctly. The full happy path is verified against a mock API that is
validated by the real shared schemas.

## Acceptance criteria

| Criterion                                                                         | Result                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every Mode A swap / transfer / info row works from the chat with the correct card | **Done in the UI.** Preview, approval, refusal, receipt, price-moved, failure, info (token check, pool comparison, hook score, portfolio) and transient intent cards all render and update live. Live: planner + MCP + refusal path verified end to end; AUTO execution waits on 0G Vela. |
| A judge can explain any action from the UI alone                                  | **Done.** Plan drawer: timeline of every trace event, checks, policy reasons, approval record, calldata targets and selectors, executions, 0G inferences, 0G Storage payload, raw intent. Activity rows and live-activity runs open it.                                                   |
| 0G request IDs on every AI step; 0G Storage hash on every receipt / refusal       | **Done.** Planner chip on every reply, guard request ID in the checks, a "0G verified" popover on receipts listing every inference, and a root-hash chip once uploaded (pending state before).                                                                                            |
| Mobile usable at 375 px                                                           | **Done.** Tabbed cockpit, card list on Activity. The Playwright test asserts no horizontal scroll at 375 px.                                                                                                                                                                              |
| `PHASE_REPORT_06.md` with screenshots in `docs/screenshots/`                      | This file. Screenshots come from the Playwright smoke run.                                                                                                                                                                                                                                |

## What was built

**Shared / API**

- `cards.ts`: `checks` on preview, approval and refusal cards; `suggestedRequest` and `quote` on
  refusals; `quote`, `inferences` and `completedAt` on receipts; typed `InfoData` (token check,
  pool comparison, hook score, portfolio).
- Pipeline fills `checks`, and refusals offer a corrected request (exact decimal halving; a
  retry when a check was unavailable). The executor's receipts carry the quote and every 0G
  inference.
- Fact cards come from the MCP outputs the planner used; model text never supplies the numbers.
- New endpoints: `GET /plans` (filters + cursor paging), `GET /traces/:traceId/events`
  (owner-scoped), `GET /approvals/pending`. `GET /plans/:id` adds the trace ID, request text,
  calldata selectors and inferences.
- The policy trace event now carries `actionPlanId` (lets live-activity runs open the drawer).
  The SSE replay goes from 50 to 150 events.

**Web**

- Cockpit: 3 columns at ≥ 1280 px, tablet slide-over for activity, mobile tabs.
- Chat: day separators, pinned auto-scroll with a "New messages" pill, optimistic user message,
  "Agent is thinking… · <live step>", 500-character multiline composer (Enter / Shift+Enter),
  quick-action chips, example cards. Off-screen messages skip layout via `content-visibility`.
- Cards with a Details button; the preview → receipt transition happens in place (no card spam);
  the refusal suggestion chip pre-fills the composer.
- Live activity: runs grouped by trace (request text, status, duration), filter chips, 0G /
  Uniswap MCP / tx / 0G Storage rows.
- Activity page (filters, "When it said no", CSV export with formula-injection guard, mobile list),
  Inbox (pending approvals), header limit bar, SSE status, approval badge, toasts on other pages.

## Bugs found and fixed while verifying

- **Chat showed the welcome screen despite history.** A second observer of the messages query
  used a placeholder `queryFn`; TanStack applies the latest observer's options to refetches, so
  the history was replaced with an empty list. Both now share one `fetchAgentMessages`.
- **Chat opened mid-history.** Lazily laid-out messages changed height after the first scroll; a
  ResizeObserver now keeps the view pinned to the bottom unless the human scrolled up.
- **Tablet slide-over showed "Live activity" twice.** The sheet now embeds the panel without its
  header.
- **Plan drawer showed "Refused" twice** (outcome badge and policy badge).
- **jsdom 31** pulls undici 8, which needs a newer Node 22 than 22.14; pinned jsdom 26.1.0.

## Verification

- `pnpm lint` ✔ · `pnpm typecheck` ✔ · `pnpm format:check` ✔ · `pnpm build` ✔
- `pnpm test` ✔ — **480 tests** (api 248, mcp 153, shared 23, web 56). New: 22 card component
  tests (every card in every state), fold / runs / CSV / toast unit tests, and API tests for
  checks, receipts, the plan list and outcome filters, trace ownership, pending approvals, paging
  and corrected requests.
- `pnpm --filter @warden/web test:e2e` ✔ — 4 Playwright smokes: "swap $5" → countdown → receipt
  in place with 0G proof → drawer; "swap $60" → approval → reject → "Nothing was traded";
  refusal chip pre-fills the composer; activity / inbox / tablet / 375 px.
- Live: the cockpit, Activity and the drawer were checked in Chromium against the real local API
  (signed in as a dev user) with no console errors.

## Known limitations

- The mock API in `apps/web/e2e/mock-api.ts` is a real Node HTTP server, not MSW, because MSW
  cannot hold the SSE `/stream` open. Every response is validated with the shared Zod schemas.
- Lighthouse was not run in this session; accessibility was built in (labels on icon buttons,
  focus rings, roles for tabs / toolbar / progressbar, live regions).
- The chat loads the newest page of history only (no "load older" yet).
- Screenshots show mock data for the happy path (real 0G guard down); the refusal path was also
  checked live.

## Commands

```powershell
pnpm lint; pnpm typecheck; pnpm test; pnpm build
pnpm --filter @warden/web exec playwright install chromium   # once
pnpm --filter @warden/web test:e2e                           # writes docs/screenshots/*.png
pnpm dev                                                     # http://localhost:5173
```
