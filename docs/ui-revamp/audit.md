# SAKA UI revamp: Phase 1 audit

Audited at `07dc051` on `main`. The demo simulator is already merged, so the branch can start from
`main` with no sequencing work. Every row of the UI is listed in
[feature-inventory.md](./feature-inventory.md).

## 1. Where the spec and the code disagree

The spec was written without the code in hand. These gaps change the plan, so they come first.

| Spec assumes                   | What the code does                                                                                                  | Proposal                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Next.js, `next/font/google`    | Vite + React 19 + React Router 7, fonts via `@fontsource`                                                           | Keep Vite and `@fontsource`                                                              |
| The product is SAKA            | The code says Warden: `APP_NAME` default, `@warden/*`, page title. "SAKA" appears nowhere in the repo               | Decision D3                                                                              |
| Wallet connect, Privy signing  | No browser wallet. Sign-in is a dev identity; the agent wallet is a Privy **server** wallet. The user never signs   | "Not connected" screen is the sign-in page. Approve (dev) stays the confirm step         |
| Network selector dropdown      | One execution chain, fixed by env. Nothing to switch to                                                             | Static chip with the existing tooltip. A dropdown would imply a choice that is not there |
| Autopilot big on/off control   | No master switch. Five separate auto-act switches. Detectors always run; a switch only decides "act" or "ask first" | Decision D2                                                                              |
| Mandate edit + save            | Read-only. Change profile, Change limits and Withdraw are disabled until World ID step-up                           | Keep them disabled with their tooltips                                                   |
| 24h change                     | `/portfolio` has all-time P&L only. 24h exists only as prose inside the morning brief                               | Show "All-time P&L", labelled. No invented number                                        |
| Autopilot decisions today      | No such count                                                                                                       | Third Home stat is Agent spend today, which is real                                      |
| Activity source filter, search | `/plans` filters by outcome, type and date only                                                                     | Keep those. A client-side filter over one page of results would mislead                  |
| PAPER chip on Activity rows    | Plans carry only `simulated`. Paper exists only on simulator runs                                                   | `LIVE` / `SIMULATED` on Activity; `PAPER` stays in the simulator                         |
| Light mode                     | Dark only, no toggle                                                                                                | Per the spec: do not add one, no Appearance card                                         |
| Inbox and Hooks                | Two of today's five nav items. Neither appears in the spec's six views                                              | Mapped in §4.2 and §4.3                                                                  |
| Advanced options, reset        | Neither exists                                                                                                      | Settings danger zone holds Sign out and Telegram disconnect only                         |

## 2. Current structure

- **Stack:** Vite 6, React 19, React Router 7 (`createBrowserRouter`), TanStack Query 5, Tailwind 4.
- **Component library:** shadcn-style primitives on Radix in `components/ui/`, product primitives in
  `components/ui-kit/` (`Panel`, `Badge`, `Stat`, states, chips).
- **Routes** (`app/router.tsx`): `/`, `/hooks`, `/hooks/:chainId/:address`, `/inbox`,
  `/inbox/simulator`, `/activity`, `/settings`, `/approvals/:id`, `*`.
- **Gate** (`app/AuthGate.tsx`): splash → API error → sign-in → onboarding → shell. The SSE stream
  mounts here once.
- **Shell** (`layout/AppShell.tsx`): top bar, 224px sidebar, bottom tabs under `md`, shell-level plan
  drawer.
- **Styles:** one file, `index.css`. Semantic CSS variables exposed through Tailwind `@theme inline`.
  Components use those semantic classes almost everywhere, which is what makes the reskin cheap.
- **Theme:** dark only. `<html class="dark">`, `Toaster theme="dark"`.
- **Icons and motion:** `lucide-react`, `tw-animate-css`. No animation library.

**Size:** 113 files, about 14,000 lines in `apps/web`. No other package is touched.

## 3. Logic and markup coupling

Rule used: markup moves, logic does not. Nothing in `apps/api`, `packages/*` or `lib/` changes. The
only logic edits are the routing changes in the first table below, all forced by the chat moving
off `/`.

**Logic touched, needs your sign-off:**

| File                                       | Change                                                                                      | Why                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `features/agent/prefill.ts`                | Add a non-consuming observer, so the shell can route to `/ask` on any prefill               | Rebalance, Exit, Add and New rule rely on the chat sitting beside them on the cockpit. Separated, they would silently do nothing |
| Callers of `navigate('/')` after a prefill | `HookCard.tsx` (2), `HookDetailPage.tsx`, `features/inbox/hooks.ts`: `'/'` becomes `'/ask'` | The chat is no longer at `/`                                                                                                     |
| `layout/useTraceToasts.ts`                 | `onCockpit` becomes `pathname === '/ask'`. Toast links follow the new paths                 | Toasts are muted only where the chat already shows the same event                                                                |

**Markup split, no logic change:**

| Component                           | Split                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `features/agent/AgentPanel.tsx`     | Restyled in place. Empty and conversation layouts share one tree, so the composer never remounts and no state moves |
| `features/portfolio/PortfolioPanel` | Export `Totals`, `Tokens`, `RiskMeterView`, `LimitsBar`, `PriceSource`. They already take plain props               |
| `features/inbox/AlertSettings.tsx`  | Export Telegram, Auto-act and Time zone panels. `AlertSettings` stays as a composition so its tests are unchanged   |
| `pages/InboxPage.tsx`               | Body becomes `DecisionsTab`; `ApprovalRow` moves with its hooks intact                                              |
| `pages/SettingsPage.tsx`            | Risk, Limits and Rules move to `MandateTab`; `StepUpButton` is shared                                               |
| `features/simulator/SimulatorPanel` | Drops its own page header and back link, which the tabs replace. State untouched                                    |
| `pages/CockpitPage.tsx`             | Removed. Its one piece of logic, the `?prefill=` effect, moves to the `/` route                                     |

## 4. Proposed information architecture

### 4.1 Views

| View      | Route        | Answers                      | Holds                                                                            |
| --------- | ------------ | ---------------------------- | -------------------------------------------------------------------------------- |
| Home      | `/`          | How am I doing?              | Value, all-time P&L, agent spend, agent status, 3 recent actions, waiting banner |
| Ask       | `/ask`       | Do something for me          | Chat, every plan card, live trace column                                         |
| Autopilot | `/autopilot` | What is it doing on its own? | Tabs: Decisions, Mandate, Simulator                                              |
| Portfolio | `/portfolio` | What do I own?               | Holdings, LP positions, risk meter, limits                                       |
| Activity  | `/activity`  | What happened?               | History, filters, CSV, drawer                                                    |
| Hooks     | `/hooks`     | Is this hook safe?           | Explorer and detail pages, unchanged URLs                                        |
| Settings  | `/settings`  | Control my account           | Account, wallet, Telegram, time zone, link to Mandate                            |

### 4.2 Inbox goes to Autopilot → Decisions

Suggestions are the agent's unprompted decisions, so they are what the spec's Decisions tab means.
Pending approvals pin to the top of that tab, and the pending badge moves to the Autopilot nav item,
so they stay one click away from anywhere. Home also shows a "N waiting for you" banner, so an
expiring approval cannot hide behind a tab.

### 4.3 Hooks stays a top-level item

It has no natural home in the six views: it is research, not holdings or history. It is also the
Uniswap v4 story judges will want to see. Proposal: seventh sidebar item, above Settings. On mobile
it sits in the account menu with Settings, so the bottom bar keeps the spec's five tabs.

### 4.4 Spec items that stay honest rather than literal

- **Network** is a static chip, because there is only one chain.
- **Account menu** adds the agent wallet address, copy and balance from data already loaded.
- **"Show agent internals"** is a remembered UI preference on Ask and Autopilot that opens
  disclosures by default and shows the trace column. No logic.
- **Safety rule:** Preview, Approval, Refusal and Price moved cards never collapse. Only settled
  cards (Receipt, info cards) get summary + disclosure. This follows spec §7 rule 9.

### 4.5 Token mapping

Existing variables are aliased to the spec's tokens, so every component reskins at once and is then
tidied view by view.

| Existing                          | Becomes                              | Note                                                         |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `--background`                    | `--bg-0`                             |                                                              |
| `--card`                          | `--bg-1`                             |                                                              |
| `--surface-2`, `--popover`        | `--bg-2`                             |                                                              |
| `--surface-3`                     | `--bg-3`                             |                                                              |
| `--border`, `--border-strong`     | `--line`, `--line-strong`            |                                                              |
| `--agent`, `--ring`               | `--ai`                               | Violet becomes blue                                          |
| `--primary`                       | `--text-1` on `--bg-0`               | Light pill, as specified                                     |
| `--safe`, `--danger`, `--caution` | `--success`, `--danger`, `--warning` |                                                              |
| `--human` (teal)                  | `--text-1`                           | Not in the spec. A human action reads as the light pill      |
| `--zg` (pink)                     | `--ai`                               | Not in the spec. 0G proof is about the agent                 |
| `--info` (blue)                   | `--text-2`                           | Blue is reserved for the agent                               |
| New                               | `--warm`, `--warm-soft`              | `Simulated (demo)` and `SIMULATED` move from caution to warm |

**One spec value fails its own AA rule.** `--text-3` at `#6B7083` measures 3.29–4.07:1 across the four
surfaces, under the 4.5:1 minimum. `#858B9F` measures 4.77–5.90:1, so it passes on all four while
still reading as muted. Every other text token passes. See decision D4.

## 5. Wireframes

### Shell

```
┌───────────┬──────────────────────────────────────────────────────────┐
│ saka ✦    │ [ HOME ]    ⚠override  Today ▓▓░ $5/$50  ● Live  ⛓ Testnet  ⚡  ◉ Name ▾ │
│           ├──────────────────────────────────────────────────────────┤
│ ⌂ Home    │                                                          │
│ ✦ Ask     │                                                          │
│ ◎ Autopilot ②                     view content                       │
│ ▤ Portfolio                                                          │
│ ↻ Activity│                                                          │
│ ⬡ Hooks   │                                                          │
│           │                                                          │
│ ⚙ Settings│                                                          │
│ ◐ Auto-act 3/5                                                       │
│ TESTNET ONLY                                                         │
└───────────┴──────────────────────────────────────────────────────────┘
Tablet: 72px icon rail.   Mobile: top bar + 5 bottom tabs, Hooks and Settings in ◉.
```

### Home

```
              ╭──────── glowing horizon arc ────────╮
 [ ✦ AUTO-ACT 3 OF 5 ]
 Good evening, Name
 SAKA is *watching your positions*

 ┌─ ⚠ 2 waiting for you ────────────────────── Review » ┐   only when pending > 0
 ┌ PORTFOLIO VALUE ┐ ┌ ALL-TIME P&L ┐ ┌ AGENT SPEND TODAY ┐
 │ $2,600.00       │ │ +$31 (+1.2%) │ │ $5 of $50         │
 └─────────────────┘ └──────────────┘ └───────────────────┘
 ┌ AGENT (AI featured) ───────┐ ┌ RECENT ACTIVITY ──────────┐
 │ ✦ Last: ETH dipped 8%...   │ │ Swap $5 ETH→USDC   ✓ 2m   │
 │ View decisions »           │ │ ...                       │
 └────────────────────────────┘ │ View all »                │
 ( Ask SAKA )   ( Open Autopilot )
```

### Ask

```
 Empty                                  Conversation
                                        ┌ chat ────────────────┐ ┌ TRACE ─────┐
      (faint outlined saka)             │ You: Swap $5 ETH     │ │ All 0G Uni │
      Hi Name, I'm your agent.          │ ┌ Preview ─────────┐ │ │ ● plan     │
 ┌─────────────────────────────────┐    │ │ 0.0065 → 20 USDC │ │ │ ● policy   │
 │ Ask your agent…               ↑ │    │ │ quote, checks    │ │ │ ● 0G guard │
 └─────────────────────────────────┘    │ │ in 3s  [Cancel]  │ │ │ ● tx       │
 ( Swap ) ( Best pool ) ( Portfolio )   │ └──────────────────┘ │ └────────────┘
 ┌ 01 Swap ┐ ┌ 02 Safety ┐ ...          │ ┌ Ask your agent… ↑┐ │  shown when
                                        └──────────────────────┘  internals on
```

### Autopilot

```
 [ AUTOPILOT ]  What SAKA does *on its own*             [ show internals ◯ ]
 ( Auto-act 3 of 5 ) ( $25/action ) ( $50/day ) ( 0.5% slippage ) ( 2 rules )
 ── Decisions ②  ·  Mandate  ·  Simulator ─────────────────────────────

 Decisions                             Mandate
 ┌ Morning brief ─────────────┐        ┌ Risk profile ─┐ ┌ Limits ───────┐
 ┌ Needs your approval ───────┐        │ 3 cards       │ │ table         │
 │ $60 swap · 4:12 left       │        └───────────────┘ └───────────────┘
 │ [Approve] [Reject] Details │        ┌ Auto-act ─────┐ ┌ Rules ────────┐
 ┌ Suggestions ───────────────┐        │ 5 switches    │ │ list, cancel  │
 │ ▲ Hook changed · RED       │        └───────────────┘ └───────────────┘
 │ [Yes] [Change] [No]        │

 Simulator
 ( SIMULATED )                             [ Demo | Paper ]
 ┌ 01 ETH −10% ──┐ ┌ 02 ETH −8% ──┐ ┌ 03 Better LP? ┐
 │ tags       »Run│ │ tags      »Run│ │ tags      »Run│
 ┌ LIVE TRACE ─────────────┐ ┌ DECISION DIGEST ─────────┐
 │ ...                     │ │ ✓ NO ACTION · deliberate │
 ┌ RUN HISTORY ──────────────────────────────────────────┐
```

### Portfolio

```
 [ PORTFOLIO ]  $2,600.00  +$31 all-time                         ⟳
 ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░ ETH 70% · USDC 30%
 ┌ HOLDINGS ──────────────────────┐ ┌ RISK ──────┐
 │ Token  Amount  Price  Value P&L │ │ gauge 34   │
 ┌ LIQUIDITY ─────────────────────┐ ┌ LIMITS ────┐
 │ ETH/USDC  In range  $120     ▾ │ │ $5 of $50  │
 │  range bar, fees, Rebalance…   │ └────────────┘
 USD values: Uniswap API · Ethereum mainnet reference
```

### Activity

```
 [ ACTIVITY ]  Everything it did, *and refused to do*         [Export CSV]
 Outcome ▾  Type ▾  Since ▾  ( When it said no ) ( Executed only )  Clear
 Time   Request          Amount  Outcome     Approved by  Source
 2m     Swap $5 ETH…     $5.00   ✓ Executed  Agent        LIVE      ▾
 └ Swap · Score 96 · 0xab…cd ↗ · 0G log ↗                 Details »
```

### Hooks and Settings

```
 Hooks: same content as today, restyled. Numbered grid, tokens, chips.

 Settings
 ┌ Account ───────┐ ┌ Agent wallet ─────┐
 ┌ Alerts ────────┐ ┌ Time zone ────────┐
 ┌ Agent mandate: limits, auto-act and rules live in Autopilot » ┐
 ┌ Danger zone: Sign out · Disconnect Telegram ──────────────────┐
```

## 6. Baseline

Run on `main` at `07dc051`, before any change.

| Check                   | Result                                                         |
| ----------------------- | -------------------------------------------------------------- |
| `pnpm typecheck`        | Pass, 4 of 4 packages                                          |
| `pnpm lint`             | Pass, 4 of 4 packages                                          |
| `pnpm test`             | Pass, 722 tests: web 100, api 440, mcp 159, shared 23          |
| `test:e2e` (Playwright) | Pass, 8 of 8, against the mock API                             |
| `pnpm format:check`     | **Pre-existing failure:** 36 files. CI does not run this check |

There are no pre-existing test, type or lint failures, so every phase is measured against these
numbers. New files will be Prettier-clean. The 36 existing failures stay as they are unless a phase
rewrites that file.

"Before" screenshots from this run are in [screenshots/before/](./screenshots/before/).

## 7. Risks

| Risk                                                                   | Mitigation                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Prefill silently dropped once the chat leaves the cockpit              | Shell-level observer routes every prefill to `/ask`; e2e covers all callers                  |
| `/?prefill=` is hardcoded in the API (`modeb/suggestions.ts:603`)      | `/` keeps honoring it. Telegram links already sent still work                                |
| Redirects dropping `?plan=` from old links                             | Redirect helper keeps the query string; covered by a test                                    |
| Chat scroll depends on a bounded-height parent                         | Ask keeps the `h-full` chain; e2e checks auto-scroll                                         |
| Preview's 3-second Cancel window hidden by a disclosure                | Decision cards are excluded from all collapsing (§4.4)                                       |
| Toast muting tied to `/`                                               | Moved to `/ask`, tested                                                                      |
| Test churn from new routes                                             | Selectors change only where markup moved; assertions are not loosened                        |
| e2e mock API has no `/simulator/*` and no `demoSimulator`              | Extend the mock in Phase 6 so the simulator gets e2e coverage                                |
| `.env` holds `APP_NAME=Warden`, and it feeds Telegram copy and 0G logs | Decision D3                                                                                  |
| `warden.session` storage key                                           | Left alone. Renaming it signs everyone out and breaks the e2e helper                         |
| Real flows need live 0G, Postgres and testnet funds                    | Automated parity runs on the mock API. Live checks are reported separately as run or not run |

## 8. Decisions needed

- **D1. Information architecture:** approve §4, including Inbox → Autopilot Decisions and Hooks as
  a seventh sidebar item.
- **D2. Autopilot on/off:** a real master switch does not exist.
  - Option A: status chip plus the five real switches. Zero new behaviour, honors Hard Rule 2.
  - Option B: a master switch that writes all five through the existing `PUT /settings/auto-act`.
    It matches §9.3 and demos well, but it is new behaviour, and turning it back on has to restore
    the previous five values.
- **D3. Naming:** set `APP_NAME=SAKA` and change user-facing copy? This also renames the app in
  Telegram messages and in the `app` field of new 0G decision logs. `@warden/*` package names and
  the `warden.session` key stay.
- **D4. Fonts and contrast:** add `@fontsource-variable/geist`, `@fontsource-variable/geist-mono`
  and `@fontsource/instrument-serif` (all OFL-1.1, Hard Rule 7), and use `#858B9F` for `--text-3`.

## 9. Decisions made

Approved by the developer after this audit:

- **D1:** Layout approved as proposed. Inbox becomes Autopilot → Decisions; Hooks stays a sidebar item.
- **D2:** Option A. Status chip plus the five real switches. No master switch, no new behaviour.
- **D3:** Full user-facing rename to SAKA, including `APP_NAME`. `@warden/*` and `warden.session` stay.
- **D4:** Add the three font packages. `--text-3` is `#858B9F`.
