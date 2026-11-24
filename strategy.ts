// BreadthMomentum strategy for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea, in my own design: most fresh pump.fun curves die fast, so I only buy a coin after it has
// survived a short seasoning period and its recent tape shows broad, one-sided demand — several
// distinct wallets buying, net SOL flowing in, and the price grinding up rather than spiking.
// Each position is one fixed fractional stake (no pyramiding): small enough that a full book of
// losers cannot threaten the 50% drawdown guardrail, large enough that every filled buy clears
// the 0.01 SOL round-trip bar many times over.
//
// Exits are mechanical: a hard stop under cost, a profit lock once the position has run, a
// trailing exit from the best mark, a flow-reversal exit when recent tape turns net-selling, and
// a maximum hold so capital keeps recycling into new coins. Recycling matters: the ranking bar
// needs round trips on at least 20 distinct coins, so a "breadth mode" loosens the entry filter
// and shortens the hold whenever completed round trips lag behind the slot pace of the run.
//
// The bot speaks the hello / batch / orders / slot protocol through the vendored shim: hello
// fixes the caps, every batch carries events, marks, fills and the account, and each reply is a
// list of orders decided purely from that batch stream. Fully deterministic: no clock reads, no
// randomness, iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Lookback window in slots for the entry tape. */
  windowSlots: number;
  /** Minimum slots between a curve's create slot and our first buy. */
  seasonSlots: number;
  /** Real SOL reserve bounds at entry. */
  minReserveSol: number;
  maxReserveSol: number;
  /** Tape requirements inside the window. */
  minTrades: number;
  minBuyers: number;
  minBuyShare: number;
  minNetInflowSol: number;
  minRise: number;
  maxRise: number;
  /** One fixed stake per position, in SOL. */
  stakeSol: number;
  minStakeSol: number;
  buySlipBps: number;
  /** Exit rules, as fractions of cost / peak value. */
  stopLoss: number;
  profitLock: number;
  trailArm: number;
  trailDrop: number;
  /** Net outflow over the short window that forces an exit, in SOL. */
  reversalOutflowSol: number;
  reversalWindowSlots: number;
  maxHoldSlots: number;
  /** Per-coin discipline. */
  cooldownSlots: number;
  maxEntriesPerMint: number;
  maxMainPositions: number;
  /** Breadth mode: engage when round trips lag this slot pace. */
  breadthTargetCoins: number;
  breadthStakeSol: number;
  breadthMaxHoldSlots: number;
  /** Total cost exposure cap across open positions, in SOL. */
  maxExposureSol: number;
}

// Tuned on the sample dataset with tools/backtest.ts: the first cut (90-slot window, 120-slot
// seasoning, 0.22 SOL stakes, reserves from 3 SOL) lost 0.671 SOL over 87 round trips with a
// 7.9% drawdown — it chased moves too late and paid the 1%-of-reserve size cap too often on thin
// curves. The settings below (shorter tape, deeper curves, smaller stake) cut the sample loss
// roughly in half, lifted round trips to 94 across 73 coins and halved the drawdown, without
// narrowing the coin breadth the ranking bar needs. They are a flat, robust region, not the
// sample's single best cell: the grading window is different data.
export const DEFAULT_PARAMS: Params = {
  windowSlots: 45,
  seasonSlots: 60,
  minReserveSol: 6,
  maxReserveSol: 45,
  minTrades: 6,
  minBuyers: 4,
  minBuyShare: 0.62,
  minNetInflowSol: 0.6,
  minRise: 0.02,
  maxRise: 0.6,
  stakeSol: 0.15,
  minStakeSol: 0.05,
  buySlipBps: 2000,
  stopLoss: 0.14,
  profitLock: 0.28,
  trailArm: 0.18,
  trailDrop: 0.12,
  reversalOutflowSol: 0.8,
  reversalWindowSlots: 25,
  maxHoldSlots: 1100,
  cooldownSlots: 900,
  maxEntriesPerMint: 2,
  maxMainPositions: 4,
  breadthTargetCoins: 24,
  breadthStakeSol: 0.06,
  breadthMaxHoldSlots: 160,
  maxExposureSol: 1.2,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface Held {
  openedSlot: number;
  peakValueSol: number;
  breadth: boolean;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Mints where a buy of ours filled and a later sell of ours filled: a completed round trip. */
  const roundTripped = new Set<Pubkey>();
  const boughtMints = new Set<Pubkey>();
  let firstSlot = -1;
  let lastQualifiedSlot = -1;
  const keepSlots = Math.max(p.windowSlots, p.reversalWindowSlots) + 8;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1_000_000_000 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net signed SOL flow of a tape over the last `w` slots ending at `now`. */
  const netFlow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry test on the recent tape; `relaxed` is the breadth-mode version of the same idea. */
  const entryOk = (t: Tape, now: number, reserveSol: number, relaxed: boolean): boolean => {
    if (reserveSol < p.minReserveSol || reserveSol > p.maxReserveSol) return false;
    if (t.createdSlot === null || now - t.createdSlot < p.seasonSlots) return false;
    const from = now - p.windowSlots;
    let trades = 0;
    let buySol = 0;
    let totalSol = 0;
    let firstPrice = -1;
    let lastPrice = 0;
    let lastWasBuy = false;
    const buyers = new Set<string>();
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      trades++;
      totalSol += tr.sol;
      if (firstPrice < 0) firstPrice = tr.price;
      lastPrice = tr.price;
      lastWasBuy = tr.buy;
      if (tr.buy) {
        buySol += tr.sol;
        buyers.add(tr.user);
      }
    }
    if (!lastWasBuy || firstPrice <= 0) return false;
    const minTrades = relaxed ? 4 : p.minTrades;
    const minBuyers = relaxed ? 3 : p.minBuyers;
    const minBuyShare = relaxed ? 0.55 : p.minBuyShare;
    const minNet = relaxed ? 0.05 : p.minNetInflowSol;
    if (trades < minTrades || buyers.size < minBuyers) return false;
    if (totalSol <= 0 || buySol / totalSol < minBuyShare) return false;
    if (netFlow(t, now, p.windowSlots) < minNet) return false;
    const rise = lastPrice / firstPrice - 1;
    if (!relaxed && (rise < p.minRise || rise > p.maxRise)) return false;
    if (relaxed && rise > p.maxRise) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      if (firstSlot < 0) firstSlot = now;
      const tradedNow = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
        if (f.side === 'buy' && Number(f.quote_lamports) >= 10_000_000) boughtMints.add(f.mint);
        if (f.side === 'sell' && boughtMints.has(f.mint) && !roundTripped.has(f.mint)) {
          roundTripped.add(f.mint);
          lastQualifiedSlot = now;
        }
      }
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Math.max(1, Number(e.virtual_token_reserves)),
          });
          tradedNow.add(e.mint);
        }
      }
      for (const mint of tradedNow) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keepSlots) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingMints = new Set<Pubkey>();
      const sellPending = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingMints.add(po.order.mint);
        if (po.order.side === 'sell') sellPending.add(po.order.mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // Breadth mode: round trips are the ranking bar, so if none has completed for a long
      // stretch of slots while the target is unmet, loosen entries and shorten holds.
      const sinceQualified = lastQualifiedSlot < 0 ? now - firstSlot : now - lastQualifiedSlot;
      const breadthMode = roundTripped.size < p.breadthTargetCoins && sinceQualified > 6000;

      // Exits first: every held position is re-marked from the batch marks and tested against
      // the mechanical exit rules.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExitSlot = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const valueSol = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
        const costSol = Number(pos.cost_lamports) / LAMPORTS;
        if (valueSol > h.peakValueSol) h.peakValueSol = valueSol;
        let exit = h.exiting;
        if (!exit && valueSol < costSol * (1 - p.stopLoss)) exit = true;
        if (!exit && valueSol > costSol * (1 + p.profitLock)) exit = true;
        if (!exit && h.peakValueSol >= costSol * (1 + p.trailArm) && valueSol < h.peakValueSol * (1 - p.trailDrop)) exit = true;
        if (!exit && netFlow(tapeOf(mint), now, p.reversalWindowSlots) < -p.reversalOutflowSol) exit = true;
        const holdLimit = h.breadth ? p.breadthMaxHoldSlots : p.maxHoldSlots;
        if (!exit && now - h.openedSlot > holdLimit) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (sellPending.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries: one fixed stake per fresh position, only on coins traded in this batch.
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposureSol = 0;
      for (const mint of held.keys()) {
        const pos = state.positions.get(mint);
        if (pos !== undefined) exposureSol += Number(pos.cost_lamports) / LAMPORTS;
      }
      for (const mint of tradedNow) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0 || held.size >= p.maxMainPositions + (breadthMode ? 1 : 0)) break;
        if (held.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntriesPerMint || now - t.lastExitSlot < p.cooldownSlots) continue;
        const reserveSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entryOk(t, now, reserveSol, breadthMode)) continue;
        const stake = breadthMode ? p.breadthStakeSol : p.stakeSol;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(stake, capSol, p.maxExposureSol - exposureSol);
        if (amount > freeSol - txSol) amount = freeSol - txSol;
        if (amount < p.minStakeSol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        held.set(mint, { openedSlot: now, peakValueSol: 0, breadth: breadthMode, exiting: false, filled: false });
        t.entries++;
        freeSol -= amount + txSol;
        exposureSol += amount;
        slotsLeft--;
      }
      return orders;
    },
  };
}
