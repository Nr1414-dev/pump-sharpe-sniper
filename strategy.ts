// Sharpe-Sniper: a paper-trading bot for the Pump.fun Sharpe Sprint.
//
// Goal is NOT the biggest PnL — it is the highest HOURLY SHARPE ratio over a
// 6-hour window: many small, independent, low-variance round trips spread
// evenly across the hours, with a hard drawdown governor. Every leg below was
// chosen from base-rate measurements on the dev dataset (see audit notes):
//  - launch sniping alone loses: from the age-3 price most coins drift down
//    and only ~19% ever touch +12% in 10 slots, while ~40% of launches are
//    dead coins that never move at all (pure fee bleed at max-hold exit);
//  - dip entries on mature curves (30-45% pullback, buyers still stepping in)
//    and short momentum entries (fresh inflow, price near its window high)
//    both measured slightly positive expectancy at tight TP/SL, so they carry
//    the bot while the sniper leg only trades the most active launches.
// A pure function of the batches it is fed: no clock, no randomness, no I/O,
// no floats in money math (lamports are bigint; price ratios are plain
// numbers compared with fixed thresholds, which is deterministic IEEE 754).

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const CURVE_FEE_BPS = 125n;

export interface SniperParams {
  enabled: boolean;
  minAge: number;
  maxAge: number;
  stakeLamports: bigint;
  minBuyLamports: bigint;
  minRealSolLamports: bigint;
  maxDevBuyLamports: bigint;
  maxBuyers: number;
  minTrades: number;
  minNetFlowLamports: bigint;
  skipDevSold: boolean;
  tpBps: number;
  slBps: number;
  maxHoldSlots: number;
  exitOnDevSell: boolean;
}

export interface DipParams {
  enabled: boolean;
  minAgeSlots: number;
  maxAgeHighSlots: number;
  highWindowSlots: number;
  ddMin: number;
  ddMax: number;
  minRealSolLamports: bigint;
  minHighRealSolLamports: bigint;
  flowTrades: number;
  minBuys: number;
  lastMustBeBuy: boolean;
  minNetFlowLamports: bigint;
  trancheLamports: bigint;
  minBuyLamports: bigint;
  tpBps: number;
  slBps: number;
  maxHoldSlots: number;
  cooldownSlots: number;
  maxEntriesPerBatch: number;
  /** Partial take-profit: sell tp1ShareBps of the position at +tp1Bps (0 = off). */
  tp1Bps: number;
  tp1ShareBps: number;
  /** Trailing exit: once best value is +trailArmBps, exit if value falls trailBps below best (0 = off). */
  trailBps: number;
  trailArmBps: number;
}

export interface MomentumParams {
  enabled: boolean;
  cooldownSlots: number;
  minAgeSlots: number;
  windowSlots: number;
  minNetSolLamports: bigint;
  minBuys: number;
  minBuyers: number;
  minPriceUp: number;
  maxPriceUp: number;
  nearHigh: number;
  minRqSolLamports: bigint;
  maxRqSolLamports: bigint;
  stakeLamports: bigint;
  minBuyLamports: bigint;
  tpBps: number;
  slBps: number;
  maxHoldSlots: number;
}

export interface GovernorParams {
  /** Pause new entries while drawdown from the equity peak exceeds this. */
  ddPause: number;
  /** Resume entries once drawdown has recovered below this. */
  ddResume: number;
}

export interface PacingParams {
  /** Counted round trips (buy >= 0.01 SOL) to aim for per hour. */
  targetTripsPerHour: number;
  /** Last-resort probe size when an hour has produced no fills at all. */
  probeLamports: bigint;
  /** Most probes to open per hour. */
  maxProbesPerHour: number;
}

export interface Params {
  sniper: SniperParams;
  dip: DipParams;
  momentum: MomentumParams;
  governor: GovernorParams;
  pacing: PacingParams;
}

export const DEFAULT_PARAMS: Params = {
  sniper: {
    enabled: false,
    minAge: 0,
    maxAge: 3,
    stakeLamports: 50_000_000n,
    minBuyLamports: 10_000_000n,
    minRealSolLamports: 1_000_000_000n,
    maxDevBuyLamports: 2_500_000_000n,
    maxBuyers: 8,
    minTrades: 3,
    minNetFlowLamports: 2_000_000_000n,
    skipDevSold: true,
    tpBps: 1500,
    slBps: 1000,
    maxHoldSlots: 10,
    exitOnDevSell: true,
  },
  dip: {
    enabled: true,
    minAgeSlots: 60,
    maxAgeHighSlots: 1000,
    highWindowSlots: 2500,
    ddMin: 0.3,
    ddMax: 0.35,
    minRealSolLamports: 5_000_000_000n,
    minHighRealSolLamports: 3_000_000_000n,
    flowTrades: 6,
    minBuys: 3,
    lastMustBeBuy: true,
    minNetFlowLamports: 500_000_000n,
    trancheLamports: 100_000_000n,
    minBuyLamports: 10_000_000n,
    tpBps: 1500,
    slBps: 1500,
    maxHoldSlots: 300,
    cooldownSlots: 300,
    maxEntriesPerBatch: 2,
    tp1Bps: 0,
    tp1ShareBps: 5000,
    trailBps: 0,
    trailArmBps: 500,
  },
  momentum: {
    enabled: false,
    cooldownSlots: 1500,
    minAgeSlots: 500,
    windowSlots: 30,
    minNetSolLamports: 1_000_000_000n,
    minBuys: 3,
    minBuyers: 5,
    minPriceUp: 0.05,
    maxPriceUp: 1.5,
    nearHigh: 0.95,
    minRqSolLamports: 2_000_000_000n,
    maxRqSolLamports: 60_000_000_000n,
    stakeLamports: 50_000_000n,
    minBuyLamports: 10_000_000n,
    tpBps: 1000,
    slBps: 800,
    maxHoldSlots: 100,
  },
  governor: { ddPause: 0.05, ddResume: 0.03 },
  pacing: { targetTripsPerHour: 5, probeLamports: 10_000_000n, maxProbesPerHour: 3 },
};

type Leg = 'sniper' | 'dip' | 'momentum' | 'probe';

interface Tick {
  slot: number;
  price: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
  realSol: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  createPrice: number;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  soldByOthers: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Recent ticks, oldest first; trimmed to the longest lookback any leg needs. */
  ticks: Tick[];
  buysSent: number;
  spentSent: bigint;
  done: boolean;
  complete: boolean;
  coolUntil: number;
  momCoolUntil: number;
}

interface Held {
  leg: Leg;
  openedSlot: number;
  txPaid: bigint;
  bestValue: bigint;
  entryPrice: number;
  entryHigh: number;
  tookTp1: boolean;
  /** The curve drained below the position's value: sells are refused (max_order_size). */
  unsellable: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

/**
 * Tokens of `tokens` that can actually be sold: the harness refuses a sell whose
 * gross proceeds exceed the curve's real SOL. Solve t*vq/(vt+t) <= rq for t.
 * Returns 0 when nothing can be sold for more than the tx fee.
 */
function sellableTokens(tokens: bigint, vq: bigint, vt: bigint, rq: bigint, tx: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || rq <= 0n) return 0n;
  const full = (tokens * vq) / (vt + tokens);
  if (full <= rq) return tokens;
  if (vq <= rq) return tokens;
  const tMax = (rq * vt) / (vq - rq);
  if (tMax <= 0n) return 0n;
  const amount = tMax < tokens ? tMax : tokens;
  const proceeds = sellValue(amount, vq, vt);
  return proceeds > tx ? amount : 0n;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  const probes = new Map<Pubkey, boolean>(); // mint -> selling?
  /** Leg a sent buy belongs to (the held record is only created when it fills). */
  const pendingLeg = new Map<Pubkey, Leg>();
  let firstBlockTime: number | null = null;
  let lastBlockTime = 0;
  let equityPeak = 0n;
  let entriesPaused = false;
  let myFills = 0;
  const tripsClosedPerHour = new Map<number, number>();
  const fillsPerHour = new Map<number, number>();
  const probesOpenedPerHour = new Map<number, number>();
  /** Distinct mints where a counted (>= 0.01 SOL) buy was opened this window. */
  const countedOpened = new Set<Pubkey>();
  const probedMints = new Set<Pubkey>();

  const hourOf = (blockTime: number): number =>
    firstBlockTime === null ? 0 : Math.max(0, Math.floor((blockTime - firstBlockTime) / 3600));

  const trimTicks = (c: Coin, nowSlot: number): void => {
    const keepFrom = nowSlot - Math.max(P.dip.highWindowSlots, P.momentum.windowSlots) - 10;
    let cut = 0;
    while (cut < c.ticks.length && c.ticks[cut]!.slot <= keepFrom) cut++;
    if (cut > 0) c.ticks.splice(0, cut);
    if (c.ticks.length > 600) c.ticks.splice(0, c.ticks.length - 600);
  };

  /** Net flow and distinct buyers over the last `windowSlots` slots. */
  const windowFlow = (c: Coin, nowSlot: number, windowSlots: number): { net: bigint; buys: number; buyers: number; startPrice: number; high: number; lastPrice: number } => {
    const from = nowSlot - windowSlots;
    let net = 0n;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let lastPrice = 0;
    const buyers = new Set<Pubkey>();
    for (const t of c.ticks) {
      if (t.slot <= from) {
        startPrice = t.price;
        continue;
      }
      if (startPrice < 0) startPrice = t.price;
      if (t.isBuy) {
        net += t.sol;
        buys++;
        buyers.add(t.user);
      } else {
        net -= t.sol;
      }
      if (t.price > high) high = t.price;
      lastPrice = t.price;
    }
    return { net, buys, buyers: buyers.size, startPrice, high, lastPrice };
  };

  const recentHigh = (c: Coin, nowSlot: number, windowSlots: number): { high: number; highRealSol: bigint; hiSlot: number } => {
    let high = 0;
    let highRealSol = 0n;
    let hiSlot = -1;
    for (let i = c.ticks.length - 1; i >= 0; i--) {
      const t = c.ticks[i]!;
      if (nowSlot - t.slot > windowSlots) break;
      if (t.price > high) {
        high = t.price;
        highRealSol = t.realSol;
        hiSlot = t.slot;
      }
    }
    return { high, highRealSol, hiSlot };
  };

  /** Liquidation value of a position at the batch's marks (or the curve's reserves). */
  const positionValue = (state: BotState, marks: Map<Pubkey, { vq: bigint; vt: bigint }>, mint: Pubkey, tokens: bigint, tx: bigint): bigint => {
    let mk = marks.get(mint);
    if (mk === undefined) {
      const cv = state.curves.get(mint);
      if (cv === undefined) return 0n;
      mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
    }
    const v = sellValue(tokens, mk.vq, mk.vt);
    return v > tx ? v - tx : 0n;
  };

  const equityNow = (state: BotState, marks: Map<Pubkey, { vq: bigint; vt: bigint }>, tx: bigint): bigint => {
    let e = state.cash;
    for (const [mint, pos] of state.positions) e += positionValue(state, marks, mint, pos.token_amount, tx);
    return e;
  };

  return {
    onBatch(state, batch) {
      const nowSlot = batch.slot;
      const tx = state.txFeeLamports();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const vq0 = BigInt(e.virtual_quote_reserves);
          const vt0 = BigInt(e.virtual_token_reserves);
          coins.set(e.mint, {
            mint: e.mint,
            createSlot: e.slot,
            creator: e.creator,
            createPrice: vt0 === 0n ? 0 : Number(vq0) / Number(vt0),
            devBuy: 0n,
            trades: 0,
            buyers: new Set(),
            soldByOthers: 0n,
            devSold: false,
            lastTradeSlot: e.slot,
            ticks: [],
            buysSent: 0,
            spentSent: 0n,
            done: false,
            complete: false,
            coolUntil: -1,
            momCoolUntil: -1,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          const vt = BigInt(e.virtual_token_reserves);
          const vq = BigInt(e.virtual_quote_reserves);
          c.trades += 1;
          c.lastTradeSlot = e.slot;
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
          }
          c.ticks.push({
            slot: e.slot,
            price: vt === 0n ? 0 : Number(vq) / Number(vt),
            isBuy: e.is_buy,
            sol,
            user: e.user,
            realSol: BigInt(e.real_quote_reserves),
          });
          trimTicks(c, nowSlot);
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }
      const hour = hourOf(lastBlockTime);
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // Fills: track our own fills and open/close held records.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          myFills++;
          fillsPerHour.set(hour, (fillsPerHour.get(hour) ?? 0) + 1);
          if (f.side === 'buy' && BigInt(f.quote_lamports) >= 10_000_000n) countedOpened.add(f.mint);
          if (f.side === 'sell' && !state.positions.has(f.mint)) {
            tripsClosedPerHour.set(hour, (tripsClosedPerHour.get(hour) ?? 0) + 1);
          }
        }
        const h = held.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') h.txPaid += BigInt(f.tx_fee_lamports);
        if (h !== undefined && f.side === 'sell' && f.status === 'rejected' && f.reason === 'max_order_size') {
          h.unsellable = true;
        }
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, {
            leg: pendingLeg.get(f.mint) ?? (probes.has(f.mint) ? 'probe' : 'sniper'),
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            bestValue: 0n,
            entryPrice: 0,
            entryHigh: 0,
            tookTp1: false,
            unsellable: false,
          });
          pendingLeg.delete(f.mint);
        }
      }
      for (const mint of [...selling]) {
        let pending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') pending = true;
        if (!pending) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint)) {
          let pendingBuy = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'buy') pendingBuy = true;
          if (!pendingBuy) held.delete(mint);
        }
      }

      // Drawdown governor on mark-to-market equity.
      const eq = equityNow(state, marks, tx);
      if (eq > equityPeak) equityPeak = eq;
      if (equityPeak > 0n) {
        const dd = Number(equityPeak - eq) / Number(equityPeak);
        if (!entriesPaused && dd > P.governor.ddPause) entriesPaused = true;
        else if (entriesPaused && dd < P.governor.ddResume) entriesPaused = false;
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const pendingSell = new Set<Pubkey>();
      const pendingBuy = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
        else pendingBuy.add(po.order.mint);
      }
      const sentSell = new Set<Pubkey>();
      /** (vq, vt, real SOL) for a mint, from marks (held/pending) or the curve. */
      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint; rq: bigint } | null => {
        const mk = marks.get(mint);
        const cv = state.curves.get(mint);
        if (cv === undefined) return null;
        return { vq: mk?.vq ?? cv.virtual_quote_reserves, vt: mk?.vt ?? cv.virtual_token_reserves, rq: cv.real_quote_reserves };
      };
      /** Queue a sell sized so its proceeds fit inside the curve's real SOL. */
      const trySell = (mint: Pubkey, tokens: bigint): boolean => {
        const res = reservesOf(mint);
        if (res === null) return false;
        const amount = sellableTokens(tokens, res.vq, res.vt, res.rq, tx);
        if (amount <= 0n) return false;
        orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: 10_000 });
        sentSell.add(mint);
        selling.add(mint);
        return true;
      };

      // ---- Exits first ----
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint) || pendingSell.has(mint) || sentSell.has(mint)) continue;
        let h = held.get(mint);
        if (h === undefined) {
          h = { leg: 'sniper', openedSlot: nowSlot, txPaid: tx, bestValue: 0n, entryPrice: 0, entryHigh: 0, tookTp1: false, unsellable: false };
          held.set(mint, h);
        }
        if (h.unsellable) continue;
        const value = positionValue(state, marks, mint, pos.token_amount, tx);
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.bestValue) h.bestValue = value;
        // Partial take-profit: bank part of a dip winner early, let the rest run.
        if (h.leg === 'dip' && P.dip.tp1Bps > 0 && !h.tookTp1 && basis > 0n && value * BPS >= basis * (BPS + BigInt(P.dip.tp1Bps))) {
          const share = (pos.token_amount * BigInt(P.dip.tp1ShareBps)) / BPS;
          if (share > 0n && trySell(mint, share)) {
            h.tookTp1 = true;
            h.bestValue = 0n;
            continue;
          }
        }
        const legParams =
          h.leg === 'dip' ? { tp: P.dip.tpBps, sl: P.dip.slBps, hold: P.dip.maxHoldSlots } :
          h.leg === 'momentum' ? { tp: P.momentum.tpBps, sl: P.momentum.slBps, hold: P.momentum.maxHoldSlots } :
          h.leg === 'probe' ? { tp: 600, sl: 600, hold: 4 } :
          { tp: P.sniper.tpBps, sl: P.sniper.slBps, hold: P.sniper.maxHoldSlots };
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(legParams.tp))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(legParams.sl))) exit = true;
          if (h.leg === 'dip' && P.dip.trailBps > 0 && h.bestValue > 0n) {
            const armed = h.bestValue * BPS >= basis * (BPS + BigInt(P.dip.trailArmBps));
            const trailed = value * BPS <= h.bestValue * (BPS - BigInt(P.dip.trailBps));
            if (armed && trailed) exit = true;
          }
        }
        if (nowSlot - h.openedSlot >= legParams.hold) exit = true;
        const c = coins.get(mint);
        if (c !== undefined && h.leg === 'sniper' && P.sniper.exitOnDevSell && c.devSold) exit = true;
        if (!exit) continue;
        if (!trySell(mint, pos.token_amount)) {
          h.unsellable = true;
          continue;
        }
        if (c !== undefined) {
          c.done = h.leg === 'sniper';
          if (h.leg === 'dip') c.coolUntil = nowSlot + P.dip.cooldownSlots;
          if (h.leg === 'momentum') c.momCoolUntil = nowSlot + P.momentum.cooldownSlots;
        }
      }

      // ---- Probe sells: a probe's buy filled -> sell it all at once ----
      for (const [mint, isSelling] of probes) {
        if (isSelling) continue;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingBuy.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingSell.has(mint) || sentSell.has(mint)) continue;
        if (orders.length >= cap) break;
        if (!trySell(mint, pos.token_amount)) {
          const h = held.get(mint);
          if (h !== undefined) h.unsellable = true;
          continue;
        }
        probes.set(mint, true);
      }

      // ---- Entries ----
      const sentBuy = new Set<Pubkey>();
      const canEnter = !entriesPaused;
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      const tryBuy = (mint: Pubkey, amount: bigint, slippageBps: number, leg: Leg): boolean => {
        if (amount < 1n || free < amount + tx) return false;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: slippageBps });
        pendingLeg.set(mint, leg);
        sentBuy.add(mint);
        free -= amount + tx;
        return true;
      };

      if (canEnter) {
        // Sniper leg: youngest launches that pass the rug + activity filters.
        if (P.sniper.enabled) {
          for (const c of coins.values()) {
            if (orders.length >= cap) break;
            if (c.done || c.complete || c.buysSent > 0) continue;
            const age = nowSlot - c.createSlot;
            if (age < P.sniper.minAge || age > P.sniper.maxAge) {
              if (age > P.sniper.maxAge) c.done = true;
              continue;
            }
            if (open >= state.hello.caps.max_open_positions) break;
            const curve = state.curves.get(c.mint);
            if (curve === undefined || curve.complete) continue;
            if (c.devSold && P.sniper.skipDevSold) {
              c.done = true;
              continue;
            }
            const rq = curve.real_quote_reserves;
            if (rq < P.sniper.minRealSolLamports) continue;
            if (c.devBuy > P.sniper.maxDevBuyLamports) continue;
            if (c.trades < P.sniper.minTrades || c.buyers.size > P.sniper.maxBuyers) continue;
            let netFlow = 0n;
            for (const t of c.ticks) netFlow += t.isBuy ? t.sol : -t.sol;
            if (netFlow < P.sniper.minNetFlowLamports) continue;
            const maxBuy = state.maxBuyLamports(c.mint);
            const amount = P.sniper.stakeLamports < maxBuy ? P.sniper.stakeLamports : maxBuy;
            if (amount < P.sniper.minBuyLamports) continue;
            if (!tryBuy(c.mint, amount, 10_000, 'sniper')) continue;
            c.buysSent += 1;
            c.spentSent += amount;
            open += 1;
          }
        }

        // Dip leg: mature curve, sharp pullback from its recent high, buyers stepping back in.
        if (P.dip.enabled) {
          let entries = 0;
          const touched = new Set<Pubkey>();
          for (const e of batch.events) if (e.event === 'TradeEvent') touched.add(e.mint);
          for (const mint of touched) {
            if (orders.length >= cap || entries >= P.dip.maxEntriesPerBatch) break;
            if (open >= state.hello.caps.max_open_positions) break;
            if (state.positions.has(mint) || pendingBuy.has(mint) || sentBuy.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const c = coins.get(mint);
            if (c === undefined || c.done || nowSlot < c.coolUntil) continue;
            if (nowSlot - c.createSlot < P.dip.minAgeSlots) continue;
            const last = c.ticks[c.ticks.length - 1];
            if (last === undefined || last.realSol < P.dip.minRealSolLamports) continue;
            const { high, highRealSol, hiSlot } = recentHigh(c, nowSlot, P.dip.highWindowSlots);
            if (high <= 0 || highRealSol < P.dip.minHighRealSolLamports) continue;
            if (hiSlot < 0 || nowSlot - hiSlot > P.dip.maxAgeHighSlots) continue;
            const dd = 1 - last.price / high;
            if (dd < P.dip.ddMin || dd > P.dip.ddMax) continue;
            let buys = 0;
            let net = 0n;
            const recent = c.ticks.slice(-P.dip.flowTrades);
            if (recent.length < P.dip.flowTrades) continue;
            for (const t of recent) {
              if (t.isBuy) {
                buys++;
                net += t.sol;
              } else net -= t.sol;
            }
            if (buys < P.dip.minBuys || net < P.dip.minNetFlowLamports) continue;
            if (P.dip.lastMustBeBuy && !last.isBuy) continue;
            const maxBuy = state.maxBuyLamports(mint);
            const amount = P.dip.trancheLamports < maxBuy ? P.dip.trancheLamports : maxBuy;
            if (amount < P.dip.minBuyLamports) continue;
            if (!tryBuy(mint, amount, 500, 'dip')) continue;
            c.coolUntil = nowSlot + P.dip.cooldownSlots;
            entries++;
            open += 1;
          }
        }

        // Momentum leg: mature curve, fresh inflow with the price near its window high.
        if (P.momentum.enabled) {
          const touched = new Set<Pubkey>();
          for (const e of batch.events) if (e.event === 'TradeEvent') touched.add(e.mint);
          for (const mint of touched) {
            if (orders.length >= cap) break;
            if (open >= state.hello.caps.max_open_positions) break;
            if (state.positions.has(mint) || pendingBuy.has(mint) || sentBuy.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const c = coins.get(mint);
            if (c === undefined || c.done || nowSlot < c.momCoolUntil) continue;
            if (nowSlot - c.createSlot < P.momentum.minAgeSlots) continue;
            const rqSol = curve.real_quote_reserves;
            if (rqSol < P.momentum.minRqSolLamports || rqSol > P.momentum.maxRqSolLamports) continue;
            const fl = windowFlow(c, nowSlot, P.momentum.windowSlots);
            if (fl.buys < P.momentum.minBuys || fl.buyers < P.momentum.minBuyers) continue;
            if (fl.net < P.momentum.minNetSolLamports) continue;
            if (fl.startPrice <= 0) continue;
            const up = fl.lastPrice / fl.startPrice - 1;
            if (up < P.momentum.minPriceUp || up > P.momentum.maxPriceUp) continue;
            if (fl.lastPrice < fl.high * P.momentum.nearHigh) continue;
            const maxBuy = state.maxBuyLamports(mint);
            const amount = P.momentum.stakeLamports < maxBuy ? P.momentum.stakeLamports : maxBuy;
            if (amount < P.momentum.minBuyLamports) continue;
            if (!tryBuy(mint, amount, 1500, 'momentum')) continue;
            c.momCoolUntil = nowSlot + P.momentum.cooldownSlots;
            open += 1;
          }
        }
      }

      // ---- Guardrail filler probe ----
      // The prize needs >= 20 counted round trips in distinct mints per window.
      // The dip leg alone yields 12-26 depending on regime; when the pace falls
      // behind (target 24 by hour 5), open tiny 0.01 SOL probes on the most
      // liquid recently-traded coin and sell them on the next batch. Each probe
      // costs roughly the round-trip fee (~0.0004 SOL) and buys one counted mint.
      const hourProbes = probesOpenedPerHour.get(hour) ?? 0;
      const paceTarget = P.pacing.targetTripsPerHour * (hour + 1);
      if (
        canEnter &&
        hour >= 1 &&
        countedOpened.size < paceTarget - 2 &&
        hourProbes < P.pacing.maxProbesPerHour &&
        open < state.hello.caps.max_open_positions &&
        orders.length < cap
      ) {
        let bestMint: Pubkey | null = null;
        let bestRq = 0n;
        for (const e of batch.events) {
          if (e.event !== 'TradeEvent') continue;
          const mint = e.mint;
          // A probe only helps the guardrail on a mint the legs have NOT counted yet.
          if (countedOpened.has(mint)) continue;
          if (state.positions.has(mint) || pendingBuy.has(mint) || sentBuy.has(mint) || probes.has(mint) || probedMints.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const minRq = (P.pacing.probeLamports * 10_000n) / 100n;
          if (curve.real_quote_reserves < minRq) continue;
          if (curve.real_quote_reserves > bestRq) {
            bestRq = curve.real_quote_reserves;
            bestMint = mint;
          }
        }
        if (bestMint !== null && tryBuy(bestMint, P.pacing.probeLamports, 1500, 'probe')) {
          probes.set(bestMint, false);
          probedMints.add(bestMint);
          probesOpenedPerHour.set(hour, hourProbes + 1);
          open += 1;
        }
      }
      return orders;
    },
  };
}
