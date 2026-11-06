# SAKA UI revamp: feature inventory

Every screen, control, data display and flow in `apps/web` as of `07dc051`, with where it lives today
and where it goes. Paths are relative to `apps/web/src`.

- **New home** uses the views proposed in [audit.md](./audit.md) §4. After the redesign in §10 of
  that file, read "Home" and "Ask" below as the workspace at `/app`, and `/` as the landing page.
- **Clicks** is the worst case from any view in the new shell. Target is ≤ 2.
- **✓** means a unit test, an e2e test or a reviewed screenshot exercised the row in the new UI.
  ☐ means nothing has exercised it since the revamp, so it is unverified, not known broken.

## Shell and global

| ID  | Feature                                                | Type    | Lives in today                    | New home                                | Clicks | ✓   |
| --- | ------------------------------------------------------ | ------- | --------------------------------- | --------------------------------------- | ------ | --- |
| G1  | Skip to content link                                   | a11y    | `layout/AppShell.tsx`             | Shell                                   | 0      | ✅  |
| G2  | DEV identity banner                                    | safety  | `layout/DevBanner.tsx`            | Shell, always on top                    | 0      | ✅  |
| G3  | Logo, link to home                                     | nav     | `layout/AppShell.tsx` TopBar      | Sidebar top; mobile top bar             | 0      | ✅  |
| G4  | Demo price override chip + tooltip                     | safety  | `layout/AppShell.tsx`             | Top bar                                 | 0      | ☐   |
| G5  | Daily limit mini-bar (links to limits)                 | safety  | `layout/AppShell.tsx`             | Top bar, links to Autopilot → Mandate   | 0      | ✅  |
| G6  | Live stream status pill                                | status  | `features/trace/LiveActivity.tsx` | Top bar                                 | 0      | ✅  |
| G7  | Chain badge + testnet tooltip                          | safety  | `layout/AppShell.tsx`             | Top bar (static, see audit §4.4)        | 0      | ✅  |
| G8  | Live activity button (tablet, cockpit only)            | control | `layout/AppShell.tsx`             | Top bar, every view and size            | 1      | ✅  |
| G9  | Account menu: name, verified, DEV, settings, sign out  | control | `layout/UserMenu.tsx`             | Top bar; adds wallet address + balance  | 1      | ✅  |
| G10 | Side nav + pending badge                               | nav     | `layout/AppShell.tsx`, `nav.ts`   | Sidebar 240px / 72px rail               | 0      | ✅  |
| G11 | Mobile bottom tabs + pending dot                       | nav     | `layout/AppShell.tsx`             | Mobile bottom tabs                      | 0      | ✅  |
| G12 | "Testnet only" note                                    | safety  | `layout/AppShell.tsx`             | Sidebar footer; mobile via G7 chip      | 0      | ✅  |
| G13 | Plan drawer, opens on `?plan=<id>` on any route        | flow    | `features/plan/PlanDrawer.tsx`    | Shell, restyled                         | 2      | ✅  |
| G14 | Executed / refused / approval toasts off the chat view | flow    | `layout/useTraceToasts.ts`        | Shell; "chat view" becomes `/ask`       | 0      | ✅  |
| G15 | RED alert toast on every view                          | safety  | `layout/useTraceToasts.ts`        | Shell                                   | 0      | ✅  |
| G16 | Toaster                                                | display | `app/Providers.tsx`               | Shell, restyled                         | 0      | ✅  |
| G17 | Splash (loading, signing in)                           | state   | `app/AuthGate.tsx`                | Logo on dot-matrix backdrop             | 0      | ☐   |
| G18 | API unreachable error + retry                          | state   | `app/AuthGate.tsx`                | Unchanged flow, restyled                | 0      | ✅  |
| G19 | Account load error + retry                             | state   | `app/AuthGate.tsx`                | Unchanged flow, restyled                | 0      | ☐   |
| G20 | Route crash boundary                                   | state   | `app/RouteError.tsx`              | Unchanged flow, restyled                | 0      | ☐   |
| G21 | Not found page                                         | state   | `pages/NotFoundPage.tsx`          | Unchanged flow, restyled                | 0      | ✅  |
| G22 | 401 clears session, returns to sign-in                 | flow    | `features/auth/hooks.ts`          | Untouched                               | 0      | ☐   |
| G23 | Cockpit mobile tabs (Agent / Portfolio / Activity)     | nav     | `pages/CockpitPage.tsx`           | Replaced by bottom tabs (G11)           | 1      | ✅  |
| G24 | `/?prefill=<text>&suggestion=<id>` Telegram deep link  | flow    | `pages/CockpitPage.tsx`           | `/` forwards to `/ask`, then cleans URL | 0      | ✅  |
| G25 | Reduced motion handling                                | a11y    | `index.css`                       | Kept and extended                       | 0      | ✅  |

## Sign-in and onboarding

| ID  | Feature                                           | Type    | Lives in today                             | New home                     | Clicks | ✓   |
| --- | ------------------------------------------------- | ------- | ------------------------------------------ | ---------------------------- | ------ | --- |
| A1  | Sign-in: logo, app name, pitch, three pillars     | display | `features/auth/SignInPage.tsx`             | Connect screen on dot-matrix | 0      | ✅  |
| A2  | Dev sign-in form, validation, pending state       | flow    | `features/auth/SignInPage.tsx`             | Connect screen               | 0      | ☐   |
| A3  | "Sign-in unavailable" World ID banner             | state   | `features/auth/SignInPage.tsx`             | Connect screen               | 0      | ☐   |
| A4  | Onboarding progress (4 steps)                     | display | `features/onboarding/OnboardingWizard.tsx` | Full-screen wizard, restyled | 0      | ✅  |
| A5  | Verify step, dev identity notice                  | flow    | `OnboardingWizard.tsx` VerifyStep          | Wizard                       | 0      | ☐   |
| A6  | Wallet step: auto-create, progress, error + retry | flow    | `OnboardingWizard.tsx` WalletStep          | Wizard                       | 0      | ☐   |
| A7  | Address card: copy, explorer, QR                  | control | `OnboardingWizard.tsx` AddressCard         | Wizard                       | 0      | ✅  |
| A8  | Risk profile picker, Back, Continue               | control | `OnboardingWizard.tsx` ProfileStep         | Wizard (selectable cards)    | 0      | ☐   |
| A9  | Fund step: amount, faucets, wrong-asset banner    | flow    | `OnboardingWizard.tsx` FundStep            | Wizard                       | 0      | ✅  |
| A10 | Live "waiting for deposit" status, change profile | status  | `OnboardingWizard.tsx` FundStep            | Wizard                       | 0      | ✅  |
| A11 | Done step, auto-continue countdown                | flow    | `OnboardingWizard.tsx` DoneStep            | Wizard                       | 0      | ☐   |
| A12 | Onboarding load error + retry                     | state   | `OnboardingWizard.tsx`                     | Wizard                       | 0      | ☐   |

## Ask: agent chat (Mode A)

| ID  | Feature                                                | Type    | Lives in today                      | New home                  | Clicks | ✓   |
| --- | ------------------------------------------------------ | ------- | ----------------------------------- | ------------------------- | ------ | --- |
| K1  | Conversation list, day separators, lazy rendering      | display | `features/agent/AgentPanel.tsx`     | Ask                       | 1      | ✅  |
| K2  | Optimistic user bubble ("Sending…")                    | state   | `AgentPanel.tsx`                    | Ask                       | 1      | ✅  |
| K3  | "Agent is thinking… · current step"                    | status  | `AgentPanel.tsx`                    | Ask, breathing glow       | 1      | ✅  |
| K4  | "New messages" pill, stick-to-bottom scroll            | control | `AgentPanel.tsx`                    | Ask                       | 1      | ☐   |
| K5  | Composer: Enter, Shift+Enter, 500 chars, counter, send | control | `AgentPanel.tsx`                    | Ask, large prompt box     | 1      | ✅  |
| K6  | Quick action chips (5)                                 | control | `AgentPanel.tsx`                    | Ask, under the prompt box | 1      | ✅  |
| K7  | Welcome + 4 example cards                              | state   | `AgentPanel.tsx`                    | Ask, centered empty state | 1      | ✅  |
| K8  | Thinking / Ready badge, agent subtitle                 | status  | `AgentPanel.tsx`                    | Ask header                | 1      | ✅  |
| K9  | Timestamp + 0G chip per message                        | display | `AgentPanel.tsx`, `cards/parts.tsx` | Ask                       | 1      | ✅  |
| K10 | Load error + retry, skeleton                           | state   | `AgentPanel.tsx`                    | Ask                       | 1      | ☐   |
| K11 | Preview card: amounts, quote, checks, who approves     | safety  | `cards/PipelineCards.tsx`           | Ask, nothing collapsed    | 1      | ✅  |
| K12 | Preview countdown + Cancel, status transitions         | safety  | `cards/PipelineCards.tsx`           | Ask, nothing collapsed    | 1      | ✅  |
| K13 | Approval card: reasons, expiry, Approve (dev), Reject  | safety  | `cards/PipelineCards.tsx`           | Ask, nothing collapsed    | 1      | ✅  |
| K14 | Refusal card: reasons, "Try instead" chip              | safety  | `cards/PipelineCards.tsx`           | Ask, nothing collapsed    | 1      | ✅  |
| K15 | Receipt card: tx list, 0G proof, decision log          | display | `cards/PipelineCards.tsx`           | Ask, summary + disclosure | 1      | ✅  |
| K16 | Price moved card + re-preview                          | safety  | `cards/PipelineCards.tsx`           | Ask, nothing collapsed    | 1      | ✅  |
| K17 | Failure card                                           | state   | `cards/PipelineCards.tsx`           | Ask                       | 1      | ✅  |
| K18 | Suggestion card: Yes, Change, No                       | control | `cards/SuggestionCardView.tsx`      | Ask                       | 1      | ✅  |
| K19 | Info cards: token check, pool compare, hook score      | display | `cards/InfoCards.tsx`               | Ask, summary + disclosure | 1      | ✅  |
| K20 | Info cards: portfolio, trigger rule + cancel           | control | `cards/InfoCards.tsx`               | Ask                       | 1      | ✅  |
| K21 | Intent card (transient)                                | state   | `cards/InfoCards.tsx`               | Ask                       | 1      | ✅  |
| K22 | Trade score, hook, checks, 0G proof, log chips         | display | `cards/parts.tsx`                   | Ask and drawer            | 1      | ✅  |
| K23 | Prefill from other views                               | flow    | `agent/prefill.ts` + 9 call sites   | Every caller lands on Ask | 1      | ✅  |

## Live activity

| ID  | Feature                                                | Type    | Lives in today                    | New home                              | Clicks | ✓   |
| --- | ------------------------------------------------------ | ------- | --------------------------------- | ------------------------------------- | ------ | --- |
| L1  | Runs grouped by trace, status, duration, expand        | display | `features/trace/LiveActivity.tsx` | Ask side column + top bar drawer (G8) | 1      | ✅  |
| L2  | Filter chips: All, 0G, Uniswap, Safety, Human, Chain   | control | `LiveActivity.tsx`                | Same                                  | 2      | ✅  |
| L3  | Event rows: 0G model, trust, request ID, TEE, tool, tx | display | `LiveActivity.tsx`                | Same, plus plan drawer and simulator  | 1      | ✅  |
| L4  | Raw JSON toggle per event                              | control | `LiveActivity.tsx`                | Technical details disclosure          | 2      | ☐   |
| L5  | Open plan details from a run                           | control | `LiveActivity.tsx`                | Same                                  | 2      | ☐   |
| L6  | Empty, offline, connecting states                      | state   | `LiveActivity.tsx`                | Same                                  | 1      | ☐   |

## Portfolio

| ID  | Feature                                             | Type    | Lives in today                          | New home                         | Clicks | ✓   |
| --- | --------------------------------------------------- | ------- | --------------------------------------- | -------------------------------- | ------ | --- |
| P1  | Total value + all-time P&L                          | display | `features/portfolio/PortfolioPanel.tsx` | Home stat + Portfolio header     | 0      | ✅  |
| P2  | Refresh button, last-updated tooltip                | control | `PortfolioPanel.tsx`                    | Portfolio header                 | 1      | ☐   |
| P3  | Stale data warning ("last known values")            | safety  | `PortfolioPanel.tsx`                    | Portfolio, always visible        | 1      | ☐   |
| P4  | Token rows: balance, price, value, P&L or share     | display | `PortfolioPanel.tsx`                    | Portfolio holdings table         | 1      | ✅  |
| P5  | "Waiting for funds" empty state + address           | state   | `PortfolioPanel.tsx`                    | Portfolio and Home               | 1      | ☐   |
| P6  | LP cards: pair, range badge, hook badge, value, P&L | display | `features/portfolio/Liquidity.tsx`      | Portfolio, row summary           | 1      | ✅  |
| P7  | LP range bar, amounts, fees                         | display | `Liquidity.tsx`                         | Portfolio, row expand            | 2      | ✅  |
| P8  | LP Rebalance, Exit                                  | control | `Liquidity.tsx`                         | Portfolio, prefills Ask          | 2      | ✅  |
| P9  | No positions state + Add                            | control | `Liquidity.tsx`                         | Portfolio, prefills Ask          | 1      | ✅  |
| P10 | Risk meter gauge, drivers, score breakdown tooltip  | safety  | `PortfolioPanel.tsx`                    | Portfolio                        | 1      | ✅  |
| P11 | Agent spending today, per-action limit, remaining   | safety  | `PortfolioPanel.tsx`                    | Home stat + Portfolio            | 0      | ✅  |
| P12 | Price source, unpriced tokens, warnings             | safety  | `PortfolioPanel.tsx`                    | Portfolio footer, always visible | 1      | ✅  |
| P13 | Skeleton, load error + retry                        | state   | `PortfolioPanel.tsx`                    | Portfolio                        | 1      | ☐   |

## Autopilot: inbox (Mode B)

| ID  | Feature                                                | Type    | Lives in today                      | New home                          | Clicks | ✓   |
| --- | ------------------------------------------------------ | ------- | ----------------------------------- | --------------------------------- | ------ | --- |
| I1  | Morning brief, pinned                                  | display | `features/inbox/SuggestionRow.tsx`  | Autopilot → Decisions             | 1      | ✅  |
| I2  | Pending approvals: summary, reason, amount, countdown  | safety  | `pages/InboxPage.tsx`               | Autopilot → Decisions, pinned top | 1      | ✅  |
| I3  | Approve (dev), Reject, Details, Telegram badge         | safety  | `pages/InboxPage.tsx`               | Autopilot → Decisions             | 1      | ✅  |
| I4  | Dev approval note                                      | safety  | `pages/InboxPage.tsx`               | Autopilot → Decisions             | 1      | ✅  |
| I5  | Suggestion rows: severity, red alert, simulated badge  | safety  | `features/inbox/SuggestionRow.tsx`  | Autopilot → Decisions             | 1      | ✅  |
| I6  | Suggestion facts: amount, status, scores, approver, 0G | display | `SuggestionRow.tsx`                 | Autopilot → Decisions             | 1      | ✅  |
| I7  | Suggestion countdown, Yes, Change, No                  | control | `SuggestionRow.tsx`                 | Autopilot → Decisions             | 1      | ✅  |
| I8  | Transaction link, Details                              | control | `SuggestionRow.tsx`                 | Autopilot → Decisions             | 2      | ✅  |
| I9  | Empty, loading and error states (both lists)           | state   | `pages/InboxPage.tsx`               | Autopilot → Decisions             | 1      | ✅  |
| I10 | Demo button to the simulator                           | nav     | `features/simulator/DemoButton.tsx` | Replaced by Simulator tab         | 2      | ✅  |
| I11 | Approval page at `/approvals/:id`                      | flow    | `pages/ApprovalPage.tsx`            | Same URL, restyled                | 0      | ✅  |

## Autopilot: mandate

| ID  | Feature                                                | Type    | Lives in today                     | New home            | Clicks | ✓   |
| --- | ------------------------------------------------------ | ------- | ---------------------------------- | ------------------- | ------ | --- |
| M1  | Risk profile cards, current marked                     | display | `pages/SettingsPage.tsx`           | Autopilot → Mandate | 2      | ✅  |
| M2  | Change profile (disabled, tooltip)                     | control | `pages/SettingsPage.tsx`           | Autopilot → Mandate | 2      | ✅  |
| M3  | Fresh verification note                                | safety  | `pages/SettingsPage.tsx`           | Autopilot → Mandate | 2      | ✅  |
| M4  | Limits table, Change limits (disabled, tooltip)        | safety  | `pages/SettingsPage.tsx`           | Autopilot → Mandate | 2      | ✅  |
| M5  | Auto-act switches (5) + hook pool safety note          | control | `features/inbox/AlertSettings.tsx` | Autopilot → Mandate | 2      | ✅  |
| M6  | Rules list: kind, status, chain step, target, next run | display | `features/triggers/RulesPanel.tsx` | Autopilot → Mandate | 2      | ✅  |
| M7  | Rule Cancel, last result, New rule                     | control | `RulesPanel.tsx`                   | Autopilot → Mandate | 2      | ✅  |
| M8  | Active rules panel on the cockpit                      | display | `pages/CockpitPage.tsx`            | Merged into M6      | 2      | ✅  |

## Autopilot: simulator

Hidden unless `providers.demoSimulator` is true, exactly as today.

| ID  | Feature                                               | Type    | Lives in today                          | New home                              | Clicks | ✓   |
| --- | ----------------------------------------------------- | ------- | --------------------------------------- | ------------------------------------- | ------ | --- |
| S1  | Scenario cards + Trigger, disabled while busy         | control | `features/simulator/ScenarioCard.tsx`   | Numbered selectable cards             | 2      | ✅  |
| S2  | Demo / Paper mode toggle, mode help line              | control | `features/simulator/SimulatorPanel.tsx` | Header segmented control              | 2      | ✅  |
| S3  | SIMULATED badge on every panel, explanatory copy      | safety  | `SimulatorPanel.tsx`, `ModeBadge.tsx`   | Same, warm chip                       | 2      | ✅  |
| S4  | Live trace, stored + streamed, states                 | display | `features/simulator/ReasoningTrace.tsx` | Left column                           | 2      | ✅  |
| S5  | Decision digest: changed, did, why, signals           | display | `features/simulator/DecisionCard.tsx`   | Right column, summary always visible  | 2      | ✅  |
| S6  | Digest: cost, risk, hook caveat, alternatives, status | safety  | `DecisionCard.tsx`                      | Right column                          | 2      | ✅  |
| S7  | "Proposed:" wording until a tx lands                  | safety  | `DecisionCard.tsx`                      | Unchanged logic                       | 2      | ✅  |
| S8  | NO ACTION shown as deliberate                         | display | `DecisionCard.tsx`                      | AI-blue chip + shield                 | 2      | ✅  |
| S9  | Reasoning failed state + retry                        | state   | `DecisionCard.tsx`                      | Right column                          | 2      | ✅  |
| S10 | Run history, selection, status badges                 | control | `SimulatorPanel.tsx`                    | Below the columns                     | 2      | ✅  |
| S11 | `/inbox/simulator` is not found with the flag off     | flow    | `pages/SimulatorPage.tsx`               | Same gate on the new path and the old | 0      | ✅  |

## Activity

| ID  | Feature                                                | Type    | Lives in today           | New home                             | Clicks | ✓   |
| --- | ------------------------------------------------------ | ------- | ------------------------ | ------------------------------------ | ------ | --- |
| V1  | Filters: outcome, type, since date                     | control | `pages/ActivityPage.tsx` | Activity filter row                  | 1      | ✅  |
| V2  | Quick chips: "When it said no", "Executed only", Clear | control | `pages/ActivityPage.tsx` | Activity filter row                  | 1      | ✅  |
| V3  | Export CSV, 2,000 row cap                              | control | `pages/ActivityPage.tsx` | Activity header                      | 1      | ☐   |
| V4  | Table: time, request, amount, outcome, approved by     | display | `pages/ActivityPage.tsx` | Activity, 5 columns + source chip    | 1      | ✅  |
| V5  | Type, trade score, tx link, 0G log columns             | display | `pages/ActivityPage.tsx` | Row expand, then drawer              | 2      | ✅  |
| V6  | Simulated (demo) badge                                 | safety  | `pages/ActivityPage.tsx` | Activity, on the row, always visible | 1      | ✅  |
| V7  | Row opens plan drawer                                  | control | `pages/ActivityPage.tsx` | Activity                             | 2      | ✅  |
| V8  | Mobile card list                                       | display | `pages/ActivityPage.tsx` | Activity                             | 1      | ✅  |
| V9  | Load more                                              | control | `pages/ActivityPage.tsx` | Activity                             | 1      | ☐   |
| V10 | Empty, filtered-empty, error, skeleton                 | state   | `pages/ActivityPage.tsx` | Activity                             | 1      | ✅  |

## Plan drawer sections

| ID  | Feature                                      | Type    | Lives in today                 | New home                     | Clicks | ✓   |
| --- | -------------------------------------------- | ------- | ------------------------------ | ---------------------------- | ------ | --- |
| D1  | Outcome, type, policy, score, hook, 0G proof | display | `features/plan/PlanDrawer.tsx` | Drawer header                | 2      | ✅  |
| D2  | Amount line and quote rows                   | safety  | `PlanDrawer.tsx`               | Drawer header                | 2      | ✅  |
| D3  | Timeline, safety checks, penalties           | display | `PlanDrawer.tsx`               | Drawer                       | 2      | ✅  |
| D4  | Policy decision, approval record             | safety  | `PlanDrawer.tsx`               | Drawer                       | 2      | ✅  |
| D5  | Unsigned calls, executions, tx hashes        | display | `PlanDrawer.tsx`               | Drawer                       | 2      | ✅  |
| D6  | 0G decision log, show payload                | control | `PlanDrawer.tsx`               | Drawer                       | 2      | ☐   |
| D7  | Raw intent JSON, plan hash                   | display | `PlanDrawer.tsx`               | Technical details disclosure | 2      | ✅  |

## Hooks

| ID  | Feature                                             | Type    | Lives in today                | New home | Clicks | ✓   |
| --- | --------------------------------------------------- | ------- | ----------------------------- | -------- | ------ | --- |
| H1  | Market / Tradeable tabs                             | control | `pages/HooksPage.tsx`         | Hooks    | 1      | ✅  |
| H2  | Band chips, New this week, search, sort             | control | `pages/HooksPage.tsx`         | Hooks    | 1      | ✅  |
| H3  | Count + indexed-at line                             | display | `pages/HooksPage.tsx`         | Hooks    | 1      | ✅  |
| H4  | Hook card: score ring, permissions, Ask, Try swap   | control | `features/hooks/HookCard.tsx` | Hooks    | 1      | ✅  |
| H5  | Load more, states                                   | state   | `pages/HooksPage.tsx`         | Hooks    | 1      | ✅  |
| H6  | Detail: back link, header, Ask agent                | control | `pages/HookDetailPage.tsx`    | Same URL | 2      | ✅  |
| H7  | Detail: plain English, score breakdown, permissions | display | `pages/HookDetailPage.tsx`    | Same URL | 2      | ✅  |
| H8  | Detail: What-if comparison form                     | control | `pages/HookDetailPage.tsx`    | Same URL | 2      | ☐   |
| H9  | Detail: facts, pools, history                       | display | `pages/HookDetailPage.tsx`    | Same URL | 2      | ✅  |

## Settings

| ID  | Feature                                          | Type    | Lives in today                     | New home                       | Clicks | ✓   |
| --- | ------------------------------------------------ | ------- | ---------------------------------- | ------------------------------ | ------ | --- |
| T1  | Account: name, identity, verified at, time zone  | display | `pages/SettingsPage.tsx`           | Settings                       | 1      | ✅  |
| T2  | Agent wallet: address, network, created          | display | `pages/SettingsPage.tsx`           | Settings                       | 1      | ✅  |
| T3  | Wallet policy badge and explanation              | safety  | `pages/SettingsPage.tsx`           | Settings                       | 1      | ✅  |
| T4  | Withdraw (disabled, tooltip)                     | control | `pages/SettingsPage.tsx`           | Settings                       | 1      | ✅  |
| T5  | Telegram: connect, new link, open, waiting state | flow    | `features/inbox/AlertSettings.tsx` | Settings                       | 1      | ✅  |
| T6  | Telegram: disconnect, mute, unavailable notice   | control | `AlertSettings.tsx`                | Settings                       | 1      | ✅  |
| T7  | Time zone select                                 | control | `AlertSettings.tsx`                | Settings                       | 1      | ✅  |
| T8  | Link to the mandate                              | nav     | New link, no new state             | Settings → Autopilot → Mandate | 2      | ✅  |

## Reachable URLs

| ID  | URL today                     | After the revamp                                                   | ✓   |
| --- | ----------------------------- | ------------------------------------------------------------------ | --- |
| U1  | `/`                           | Home                                                               | ✅  |
| U2  | `/?prefill=…&suggestion=…`    | Forwards to Ask, pre-fills, cleans the URL                         | ✅  |
| U3  | `/?plan=<id>` and any `?plan` | Drawer opens on the same view                                      | ✅  |
| U4  | `/hooks`                      | Unchanged                                                          | ✅  |
| U5  | `/hooks/:chainId/:address`    | Unchanged                                                          | ✅  |
| U6  | `/inbox`                      | Redirects to `/autopilot`, keeps the query string                  | ✅  |
| U7  | `/inbox/simulator`            | Redirects to `/autopilot/simulator`, keeps the query string        | ✅  |
| U8  | `/activity`                   | Unchanged                                                          | ✅  |
| U9  | `/settings`                   | Unchanged                                                          | ✅  |
| U10 | `/approvals/:id`              | Unchanged. The API builds this URL, so it cannot move              | ✅  |
| U11 | New                           | `/ask`, `/portfolio`, `/autopilot/mandate`, `/autopilot/simulator` | ✅  |
