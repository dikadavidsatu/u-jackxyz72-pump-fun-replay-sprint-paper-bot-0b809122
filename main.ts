// Entry point for the pump.fun replay paper bot (protocol agent-fun/replay/v2).
//
// The grader runs exactly `node /bot/main.ts` on Node 22, which strips the types and
// runs this file as-is — no build step, no install, no imports beyond the vendored
// shim and the strategy next to it. Everything the bot runs lives in this repository.
//
// The wire, in short:
//   - The harness writes one JSON line per message on stdin: first a `hello` (the
//     run's seed, capital, caps, fees, latency), then one `batch` per slot, then a
//     `done` when the replay ends.
//   - Each `batch` carries that slot's events (CreateEvent / TradeEvent /
//     CompleteEvent), the latest marks for coins we hold or have pending, the fills
//     that resolved since the previous batch, and the account after those fills.
//   - We answer every batch with exactly one reply line: `{ type: 'reply', seq,
//     orders: [...] }`, at most hello.caps.max_orders_per_batch orders. Orders the
//     market refuses (size caps, cash, slippage) come back as rejected fills in a
//     later batch; they are not errors. A malformed reply is: the shim throws
//     OrderError here, so a broken bot fails on our machine, not in grading.
//   - stdout carries replies only — diagnostics go to stderr (console.error).
//
// Determinism is graded: the entry is executed twice on the same data and the two
// action logs must match byte for byte. That is why the strategy never reads the
// clock, the environment, Math.random or the network, and seeds any randomness it
// might ever need from hello.seed (it needs none today). Every trading decision
// lives in strategy.ts; this file only wires it up, validates the parameters once
// at startup so a bad config fails loudly before the first batch, and hands the
// strategy to the shim's runBot loop.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS, validateParams } from './strategy.ts';

// Validate before the first hello is answered: a parameter set that cannot trade
// sanely (a stake below the minimum, a trail that can never arm, a reserve window
// that is empty) must fail here, loudly, instead of silently trading nothing all
// run and scoring zero.
validateParams(DEFAULT_PARAMS);

// Diagnostics go to stderr only: stdout carries the hello / batch / orders replies
// and nothing else, so a stray log line there would corrupt the protocol.
console.error(
  `[seasoned-tape] stake=${DEFAULT_PARAMS.stakeSol} SOL window=${DEFAULT_PARAMS.windowSlots} slots ` +
    `season=${DEFAULT_PARAMS.seasonSlots} slots maxRise=${(DEFAULT_PARAMS.maxRise * 100).toFixed(0)}% ` +
    `stop=${(DEFAULT_PARAMS.stopLoss * 100).toFixed(0)}% trail=${(DEFAULT_PARAMS.trailArm * 100).toFixed(0)}%/-${(DEFAULT_PARAMS.trailDrop * 100).toFixed(0)}%`,
);

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot(strategy);
