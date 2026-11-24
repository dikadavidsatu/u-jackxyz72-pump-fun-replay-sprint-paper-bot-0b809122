// Local backtest of strategy.ts on the kit's sample dataset with the local engine port
// (tools/sim.ts, ported from the kit's replay market model).
//
//   node tools/backtest.ts <kit dir> ['{"stakeSol":0.3}'] [--trips]
//
// Prints net PnL, fills, distinct round-tripped coins at >=0.01 SOL, max drawdown and rejects,
// then repeats the run to confirm the action stream is deterministic.

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json] [--trips]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122', 'dev', ds.sha256));
const params = { ...DEFAULT_PARAMS, ...overrides };
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(6);

// A coin meets the ranking bar when a completed round trip on it started with a buy of at least
// 0.01 SOL; every stake this bot sends is above that, so completed trips are the count.
const run = () => simulate(ds, hello, createStrategy(params));
const r = run();
console.log(`net ${sol(r.netPnl)} SOL  fills ${r.fills}  coins ${r.mints}  trips ${r.trips.length}  wins ${r.trips.filter((t) => t.pnl > 0n).length}  dd ${r.maxDrawdown.toFixed(4)}  rejected ${r.rejected} ${JSON.stringify(r.rejectReasons)}  failed ${r.failed}`);
const r2 = run();
const same = r.netPnl === r2.netPnl && r.fills === r2.fills && r.trips.length === r2.trips.length && r.trips.every((t, i) => t.mint === r2.trips[i]!.mint && t.pnl === r2.trips[i]!.pnl);
console.log(`determinism: second run identical = ${same} (net ${sol(r2.netPnl)}, trips ${r2.trips.length})`);
if (process.argv.includes('--trips')) {
  for (const t of r.trips) console.log(t.mint, t.open, t.close - t.open, sol(t.pnl));
}
