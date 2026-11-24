# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/dikadavidsatu/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/dikadavidsatu/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

SeasonedTape — a deterministic paper-trading bot for the pump.fun bonding-curve replay (protocol agent-fun/replay/v2). It buys a coin only after the curve has seasoned and its recent tape still looks healthy: several distinct buyers, net SOL flowing in, and the price grinding up a little rather than already vertical — buying the top of a spike is the most reliable way to lose on this tape. Each position is one fixed fractional stake, never pyramided, and exits are mechanical: a hard stop, a profit lock, a trailing exit from the best mark, a flow-reversal exit, and a maximum hold so capital keeps recycling into new coins. A breadth mode loosens entries and shortens holds whenever completed round trips lag the run's slot pace, keeping the bot above the 20-coin round-trip ranking bar. No clock, no randomness, no network: the same batch stream always produces the same orders.

## Run it

```sh
node main.ts
```

The bot speaks newline-delimited JSON on stdin/stdout (hello, then one reply of orders per batch, until done). For a local backtest on the competition kit's sample dataset: `node tools/backtest.ts <kit dir>`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vyqgkf3p&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
