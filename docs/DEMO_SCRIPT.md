# SAKA demo script (3 minutes)

Live app: <https://saka-rust.vercel.app>. Sign in as `demo`, which has the funded wallet.

## Before you present

- [ ] `https://saka-api-demo.eastasia.cloudapp.azure.com/health` answers `"status":"ok"`.
- [ ] The `demo` wallet holds Sepolia ETH.
- [ ] Telegram is linked and open on your phone.
- [ ] Your local `pnpm dev` is stopped.
- [ ] Agent internals are on, so the live trace shows beside the chat.

## The script

| Time | Do this                                                                     | Say this                                                                                                                              |
| ---- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Open the landing page and sign in.                                          | "SAKA gives each person their own AI DeFi agent, with a verifiable reason for every move."                                            |
| 0:15 | Show the wallet, portfolio and risk profile.                                | "This is the agent's own wallet, and these are its limits. Execution is on testnet only."                                             |
| 0:30 | Send **"Swap $5 ETH to USDC"** and let the countdown finish.                | "It's small and safe, so it runs alone. You can cancel during the countdown."                                                         |
| 0:50 | Point at the trace, the 0G request ID, the receipt and the 0G Storage hash. | "Each step shows up live. 0G does the thinking, and every decision is logged to 0G Storage."                                          |
| 1:10 | Send **"Swap $60 ETH to USDC"**, reject it, then send it again and approve. | "Over the limit, it stops and asks. I rejected it and nothing traded. Now I approve it, and it executes."                             |
| 1:40 | Send **"Swap $500 ETH to USDC"**.                                           | "Too risky, so it refuses and explains why. Failing safe is the default."                                                             |
| 1:55 | Open **Hooks** and pick one, showing the score and explanation.             | "Nobody understands Uniswap v4 hooks, so we score each one from 0 to 100 and explain it in plain words."                              |
| 2:15 | Open **Autopilot → Simulator** and run a price drop.                        | "This is why you come back tomorrow: the agent comes to you. The event is simulated; the decision is real."                           |
| 2:35 | Show the Telegram alert and press **Yes**.                                  | "It reaches me on Telegram, and one tap says go."                                                                                     |
| 2:45 | Open **Activity** and a decision's proof.                                   | "Here's everything it did or refused to do, with on-chain and 0G proofs."                                                             |
| 2:55 | Close on the 0G line.                                                       | "Without 0G the agent can't think, can't double-check its own trades, and there's no tamper-proof record of why it moved your money." |

## Be upfront about

- World ID isn't in this build. Sign-in and approvals use the labelled dev identity, which is why
  the amber banner shows.
- Swaps run on Ethereum Sepolia. Mainnet is read-only, for market data.

## If something is slow or fails

| Problem                   | Say or do                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| The agent is slow         | "Each step runs on verified models, and you can watch them in the trace." An answer can take 30–40 seconds.     |
| A swap is refused         | "A failed check refuses the trade. That's the safety layer doing its job." Open **Details** to show the reason. |
| A 0G check is unavailable | "The guard fails closed, so with no check there's no trade." Move on to Hooks.                                  |
| The transaction is slow   | Sepolia can lag. Move on to Hooks and come back for the receipt.                                                |
| Telegram doesn't arrive   | Show the same suggestion in **Autopilot**, where every alert also appears.                                      |
| The site won't load       | Switch networks or use a phone hotspot, then check `/health`.                                                   |
