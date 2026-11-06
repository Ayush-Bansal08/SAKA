# Planner evaluation

Live run: 2026-11-06T08:13:59.728Z · planner `glm-5.3` (private) · fallback `0gm-1.0-35b-a3b` (private) · reasoning_effort `low` · timeout 12000 ms

**32/35 passed (91.4%)** — target ≥ 90%: **met**. Latency p50 6102 ms · p95 20143 ms.

Each case checks the result kind and its key parameters (types, tokens, amounts, recipient, trigger rule) — see `apps/api/eval/planner.cases.json`. Reference prices: ETH $2224.95, USDC $1.00.

| Row           | Request                                                                  | Result | Latency ms | Output                                                                                             |
| ------------- | ------------------------------------------------------------------------ | ------ | ---------: | -------------------------------------------------------------------------------------------------- |
| swap          | Swap $20 ETH to USDC                                                     | PASS   |      12883 | swap_exact_in: swap $20 ETH → USDC                                                                 |
| swap          | Exchange 0.01 ETH for USDC                                               | PASS   |       8194 | swap_exact_in: swap $22.2495 ETH → USDC                                                            |
| swap          | Trade $10 ETH into USDC                                                  | PASS   |      12790 | swap_exact_in: swap $10 ETH → USDC                                                                 |
| swap          | Swap 15 USDC to ETH                                                      | PASS   |      10693 | swap_exact_in: swap $15 USDC → ETH                                                                 |
| exact_out     | Get me exactly 100 USDC                                                  | PASS   |       9021 | swap_exact_out: get exactly 100 USDC with ETH                                                      |
| exact_out     | Buy exactly 50 USDC with ETH                                             | PASS   |      12792 | swap_exact_out: get exactly 50 USDC with ETH                                                       |
| exact_out     | I want exactly 0.005 ETH, pay with USDC                                  | PASS   |      11195 | swap_exact_out: get exactly 0.005 ETH with USDC                                                    |
| swap_and_send | Send 20 USDC to 0x000000000000000000000000000000000000dEaD, pay with ETH | PASS   |       8989 | swap_and_send: send 20 USDC to 0x0000…dEaD, paid with ETH                                          |
| transfer      | Send 20 USDC to 0x000000000000000000000000000000000000dEaD               | PASS   |       3250 | transfer: send 20 USDC to 0x0000…dEaD                                                              |
| withdraw      | Withdraw 0.01 ETH to 0x000000000000000000000000000000000000dEaD          | PASS   |       3286 | transfer: send 0.01 ETH to 0x0000…dEaD                                                             |
| lp            | Put $100 into ETH/USDC                                                   | PASS   |      22553 | lp_open: provide $100 to ETH/USDC (balanced range)                                                 |
| lp            | Provide $50 of ETH/USDC liquidity                                        | PASS   |      16056 | lp_open: provide $50 to ETH/USDC (balanced range)                                                  |
| lp            | Open a wide ETH/USDC position with $20                                   | FAIL   |      15132 | error: I could not validate that plan. Please clarify the amount, token and recipient.             |
| take_profit   | Sell half if ETH goes up 2%                                              | PASS   |       3753 | create_trigger: take profit when ETH +2%                                                           |
| take_profit   | Sell 25% of my ETH if it rises 12%                                       | PASS   |       4131 | create_trigger: take profit when ETH +12%                                                          |
| stop_loss     | Stop loss at $2,800                                                      | PASS   |       4135 | create_trigger: stop loss when ETH ≤ $2800                                                         |
| stop_loss     | Sell my ETH if it drops below $2000                                      | PASS   |       4475 | create_trigger: stop loss when ETH ≤ $2000                                                         |
| dca           | Buy $10 of ETH every day                                                 | PASS   |       3406 | create_trigger: buy $10 of ETH every day                                                           |
| dca           | Buy $20 of ETH every 48 hours                                            | PASS   |       3797 | create_trigger: buy $20 of ETH every 48 h                                                          |
| chained       | If ETH hits $3,500, sell half, then put the USDC into liquidity          | FAIL   |       6102 | error: 0G is unavailable. Please try again.                                                        |
| best_pool     | Best pool for ETH/USDC?                                                  | PASS   |      20143 | answer: Best ETH/USDC pool on Sepolia: the 1.00% fee pool (fee 10000, tickSpacing 200, n           |
| token_safety  | Is USDC safe?                                                            | PASS   |       9176 | answer: Yes — USDC on Sepolia checks out as safe: it's on your allowlist, not on the uns           |
| token_safety  | Is this token safe? 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238           | PASS   |      15232 | answer: Yes — that token is USDC and it's safe: it's on your allowlist, not on the unsup           |
| hook          | Explain this hook                                                        | PASS   |       3015 | answer (clarify): Which hook would you like me to explain? Please share the hook's contract addres |
| portfolio     | Show my portfolio                                                        | PASS   |       9879 | answer: Your portfolio on Sepolia holds 0.05 ETH (~$111 at the reference price of $2,224           |
| portfolio     | /risk                                                                    | PASS   |       4745 | answer: Your risk profile is BALANCED (labeled Moderate). Portfolio: ~$190 total — 0.05            |
| general       | What can you do?                                                         | PASS   |       4224 | answer: I'm Warden, your DeFi assistant on Ethereum Sepolia. I can plan (but not execute           |
| ambiguous     | Swap some tokens                                                         | PASS   |       3686 | answer (clarify): Happy to help — which token would you like to swap, how much, and what should I  |
| ambiguous     | Send 20 USDC to 0xabc                                                    | PASS   |       3454 | answer (clarify): That address looks incomplete — a recipient must be a full 0x address with 40 he |
| ambiguous     | Buy ETH                                                                  | PASS   |       3644 | answer (clarify): Happy to plan that! How much would you like to spend — a dollar amount (e.g. "$1 |
| ambiguous     | Put money into a pool                                                    | PASS   |       4055 | answer (clarify): Happy to help you open a liquidity position. Which pair would you like (e.g. ETH |
| ambiguous     | Send it to my friend                                                     | PASS   |       4330 | answer (clarify): I can help with that, but I need a few details: what should I send (e.g., ETH or |
| edit          | Make it $30                                                              | PASS   |       4577 | lp_open: provide $30 to ETH/USDC (balanced range)                                                  |
| edit          | Make it $30 and add a stop-loss                                          | FAIL   |      13079 | answer (clarify): I've updated the swap to $30 of ETH → USDC (~0.013483 ETH, ~352.99 USDC). For th |
| edit          | Actually make it 0.02 ETH                                                | PASS   |       9092 | swap_exact_in: swap $44.5 ETH → USDC                                                               |
