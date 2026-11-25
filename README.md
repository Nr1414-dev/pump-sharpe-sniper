# Sharpe-Sniper — Pump.fun Sharpe Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Nr1414-dev/pump-sharpe-sniper/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Nr1414-dev/pump-sharpe-sniper/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for make.fun's [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty ($2 in USDC). It ranks by **hourly Sharpe ratio**, not PnL, so it optimizes for many small, low-variance round trips spread evenly across the 6-hour final window — not for the biggest win.

## Strategy

The bot is a **dip-rider with a guardrail filler**, built from base-rate measurements on the dev dataset (24h, 2–3 Nov 2026, 1,222 mints):

- **Dip leg (the earner).** Buys mature curves (age ≥ 60 slots) that pulled back 30–35% from a high made within the last 1,000 slots, with real SOL ≥ 5, buyers still stepping in (≥ 3 buys in the last 6 trades, net flow ≥ 0.5 SOL, last trade a buy). Stake 0.10 SOL, TP +15% / SL −15%, max hold 300 slots, 300-slot cooldown per mint. Launch sniping and momentum chasing were measured and **rejected**: from the age-3 price most launches drift down and only ~19% ever touch +12% in 10 slots, and momentum entries lose ~4% per trade after the 2-slot fill latency — both legs score negative Sharpe in the official grader and are disabled.
- **Guardrail filler probe.** The prize needs ≥ 20 counted round trips in distinct mints per window, and the dip leg alone yields 12–26 depending on regime. When the counted-mint pace falls behind (target 5/hour), the bot opens tiny 0.01 SOL probes on the most liquid *uncounted* coin and sells them on the next batch — each costs roughly the round-trip fee (~0.0004 SOL) and buys one counted mint.
- **Drawdown governor.** New entries pause while mark-to-market drawdown from the equity peak exceeds 5% (resume below 3%).
- **Unsellable positions.** The harness refuses a sell whose proceeds exceed the curve's real SOL (a rugged coin). The bot sizes sells to fit inside real SOL and never retries a refused sell.

## Results (official `grade-local`, dev dataset, full 24h)

| | Sharpe (hourly) | Net PnL | Max DD | Win rate | Round trips | Distinct mints | Compliant |
|---|---|---|---|---|---|---|---|
| **Sharpe-Sniper** | **+0.174** | **+0.152 SOL** | 0.019 | 37.5% | 152 | 119 | **yes** |
| house sniper pilot | −0.844 | −0.497 SOL | 0.054 | 12.7% | 354 | 354 | yes |
| house momentum pilot | −0.579 | −9.437 SOL | 0.954 | 6.7% | 75 | 45 | no |
| house reversion pilot | −0.481 | −3.987 SOL | 0.490 | 26.8% | 425 | 199 | yes |
| house equal-weight | −0.223 | −0.019 SOL | 0.009 | 0% | 5 | 5 | no |
| house hold-cash | NULL | 0 SOL | 0 | — | 0 | 0 | no |

6-hour windows (local sim, official market model): mean Sharpe **+0.095** on the four aligned windows and **+0.238** on three 3-hour-shifted holdout windows × 3 fail-keys (PnL positive in 6/9 holdout runs, 23–31 counted mints and max DD ≤ 0.016 in every run).

Deterministic: two `grade-local` runs produce byte-identical action logs (sha256 `5221cb98158ed617c78ec5e05092ec20a7c121f92bf7438673a9c20ee5423e86`).

## Run

The grader runs the bot as `node /bot/main.ts` (Node 22). `main.ts` is a thin entrypoint; the strategy lives in `strategy.ts` and the protocol in the vendored SDK shim (`vendor/makefun-bot.ts`, a byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`).

```sh
node main.ts   # speaks the agent-fun/replay/v2 protocol on stdin/stdout
```

No network, no clock, no randomness, no environment access: the strategy is a pure function of the batches it is fed. All money math is `bigint` lamports; price ratios are plain numbers compared against fixed thresholds.
