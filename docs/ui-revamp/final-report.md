# SAKA UI revamp: final report

Branch `feature/ui-revamp`, not merged or pushed. The whole app is restyled and restructured, and
everything automated passes. It has **not** been run against the live stack: all browser testing
used the mock API.

> **Updated after the redesign.** The developer rejected the first layout and logo. The app now has
> a landing page at `/`, a workspace at `/app`, a purple-black glass theme, Manrope, and a sharp new
> logo. See [audit.md](./audit.md) §10. Sections below reflect the current build.

## Test results against the baseline

| Check                  | Baseline             | Now                             |
| ---------------------- | -------------------- | ------------------------------- |
| Typecheck              | Pass, 4 of 4         | Pass, 4 of 4                    |
| Lint                   | Pass, no warnings    | Pass, no warnings               |
| Web unit tests         | 100                  | 108                             |
| API, MCP, shared tests | 440, 159, 23         | 440, 159, 23                    |
| Browser tests          | 8                    | 33                              |
| Production build       | Not recorded         | Pass                            |
| `pnpm format:check`    | 36 existing failures | Not re-run; new files are clean |

No existing test was removed and no assertion was loosened. Tests changed only where a route or
component moved: `/` became `/ask` in three places, and `InboxPage` became `DecisionsTab`.

## What changed

- **Tokens and type:** purple-black glass theme, Manrope, larger text, mono only for hashes.
- **Brand:** sharp wordmark, blade S symbol, favicons, app icons, share image, and the rename.
- **Shell:** collapsible glass sidebar, quiet top bar, bottom tabs, account menu with wallet and balance.
- **Views:** cursor-reactive landing page, agent workspace with portfolio, Autopilot (Decisions,
  Mandate, Simulator), Portfolio, Activity, rebuilt Hooks, Settings, sign-in, onboarding and approval.
- **Components:** pill buttons, warm chips, cards with corner ticks and glow, disclosures, tab nav,
  bottom sheet, remembered "Show agent internals".

## Logic files touched

Every change is listed. Nothing else outside the presentation layer moved.

| File                                        | Change                                          | Why                                          |
| ------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| `features/agent/prefill.ts`                 | Added a non-consuming observer                  | LP actions and New rule left the chat's side |
| `HookCard`, `HookDetailPage`, `inbox/hooks` | `navigate('/')` became `navigate('/app')`       | The chat moved                               |
| `layout/useTraceToasts.ts`                  | Toasts mute on `/app`, links go to `/autopilot` | The chat and inbox moved                     |
| `lib/api.ts`                                | Error text says SAKA                            | Decision D3                                  |
| `apps/api/src/config/env.ts`                | `APP_NAME` default is SAKA                      | Decision D3                                  |

`.env` and `.env.example` also set `APP_NAME=SAKA`. Both are gitignored, so **deployed environments
must set it themselves** if they override the default.

## Where the build differs from the spec

These were decided in the audit, or are gaps left open.

| Spec                           | Built                                                   | Reason                                 |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------- |
| Autopilot on/off control       | Status chip plus the five real switches                 | Decision D2. No master switch exists   |
| Network selector dropdown      | Static chip                                             | One chain, nothing to switch to        |
| Wallet connect, Privy signing  | Sign-in page; Approve (dev) confirms                    | The wallet is server-side              |
| Mandate edit and save          | Disabled with tooltips                                  | Needs World ID step-up                 |
| 24h change                     | All-time P&L, labelled                                  | The API has no 24h figure              |
| Decisions today                | Agent spend today                                       | No such count exists                   |
| Activity source filter, search | Existing outcome, type and date filters                 | A filter over one page would mislead   |
| `--text-3` `#6B7083`           | `#858B9F`                                               | Spec value fails AA                    |
| Number count-up (§10)          | **Not built**                                           | Left out; money values do not tween    |
| Blocking confirm modal (§8)    | Not added                                               | Confirmation stays inline, as before   |
| Condition tag chips (§9.3)     | Scenario description text                               | The API sends one description, no tags |
| LP rows collapsed              | Open by default up to 3 positions, or when out of range | Keeps detail visible for short lists   |

## Parity checklist

The spec's manual checklist, with how each item was actually checked.

| Item                                     | Status                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| Sign-in screen                           | Rendering tested. Submitting the form was not run: the mock has no route |
| Sign out                                 | Menu item checked; not clicked                                           |
| Network switch                           | Not applicable, one chain                                                |
| Mode A: prompt → plan → confirm → status | Tested on the mock: swap, approval, reject, refusal                      |
| Privy sign                               | Not applicable in the browser                                            |
| Autopilot switches                       | Unit tested                                                              |
| Mandate edit and save                    | Not applicable, locked controls verified disabled                        |
| Simulator                                | Tested on the mock, one scenario, Paper mode. **Not run on real 0G**     |
| Activity filters and drawer              | Tested                                                                   |
| Errors                                   | API down tested. Rejected signature and 0G failure not run live          |
| Mobile nav                               | Tested, no sideways scroll on 9 routes at 360, 768, 1024 and 1440px      |

## Inventory status

129 of 154 rows are verified. The other 25 have not been exercised since the revamp, so they are
unverified rather than known broken. They are mostly loading and error states, CSV export, Load
more, the What-if form, and onboarding steps other than Fund. Their changes are styling only, except
where [feature-inventory.md](./feature-inventory.md) says otherwise.

## Before the demo

1. Run the real stack and do one full pass: sign in, swap, approval, and all three simulator
   scenarios in Demo and Paper. Nothing here has touched real 0G or the testnet.
2. Set `APP_NAME=SAKA` on any deployed API, then restart the API and bot.
3. Merge when happy. Only the branch tip is guaranteed to build: the view commits depend on the
   router commit, so bisecting inside them will not work.

## Open questions

- The README still says Warden and links to the old `docs/screenshots/`. Should it be rewritten?
- `planner.v1.md` still says "You are Warden". Changing it alters model input, so it needs a planner
  eval run first. The Privy wallet label `Warden agent <id>` is also unchanged.

Screenshots: [before](./screenshots/before/) and [after](./screenshots/after/).
