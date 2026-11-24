// Entry point for the pump.fun replay paper bot.
// The grader runs `node /bot/main.ts`; the wire protocol (hello, batch, orders, slot by slot)
// lives in the vendored shim, and every trading decision lives in strategy.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
