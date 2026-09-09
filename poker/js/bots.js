/**
 * Bot opponents.
 *
 * Each bot estimates its equity by Monte-Carlo rollout (deal the unknown
 * opponent hands and the rest of the board at random, count how often it wins),
 * compares that with the pot odds it is being offered, and then bends the
 * result through a personality: how often it bluffs, how big it bets, how
 * willing it is to call thin.
 */

import { makeDeck, makeRng } from './cards.js';
import { evaluate } from './evaluator.js';

export const PERSONALITIES = {
  rock: { label: 'Tight & patient', aggression: 0.35, bluff: 0.04, callThreshold: 0.06, sizing: 0.55, thinkMs: [900, 1800] },
  pro: { label: 'Balanced regular', aggression: 0.6, bluff: 0.12, callThreshold: 0.02, sizing: 0.66, thinkMs: [800, 2000] },
  shark: { label: 'Aggressive', aggression: 0.78, bluff: 0.2, callThreshold: 0.0, sizing: 0.75, thinkMs: [600, 1600] },
  station: { label: 'Calls too much', aggression: 0.25, bluff: 0.05, callThreshold: -0.12, sizing: 0.5, thinkMs: [700, 1500] },
  maniac: { label: 'Wild', aggression: 0.9, bluff: 0.34, callThreshold: -0.05, sizing: 0.9, thinkMs: [400, 1100] },
};

/**
 * Rough win probability for `hole` against `opponents` random hands.
 * Ties count as a fractional win, which is what pot odds actually care about.
 */
export function estimateEquity(hole, board, opponents, iterations = 300, rng = Math.random) {
  if (opponents <= 0) return 1;
  const known = new Set([...hole, ...board]);
  const stub = makeDeck().filter((c) => !known.has(c));
  let equity = 0;

  for (let i = 0; i < iterations; i++) {
    // Partial Fisher-Yates: only draw as many cards as this rollout needs.
    const needed = (5 - board.length) + opponents * 2;
    const drawn = [];
    const pool = stub.slice();
    for (let d = 0; d < needed; d++) {
      const j = d + Math.floor(rng() * (pool.length - d));
      const tmp = pool[d]; pool[d] = pool[j]; pool[j] = tmp;
      drawn.push(pool[d]);
    }
    const runout = [...board, ...drawn.slice(0, 5 - board.length)];
    const mine = evaluate([...hole, ...runout]).score;

    let better = 0;
    let equal = 0;
    let cursor = 5 - board.length;
    for (let o = 0; o < opponents; o++) {
      const theirs = evaluate([drawn[cursor], drawn[cursor + 1], ...runout]).score;
      cursor += 2;
      if (theirs > mine) { better++; break; }
      if (theirs === mine) equal++;
    }
    if (better === 0) equity += 1 / (equal + 1);
  }
  return equity / iterations;
}

/**
 * Decide an action for a bot seat.
 * @param {object} ctx
 * @param {import('./engine.js').HoldemGame} ctx.game
 * @param {object} ctx.seat
 * @param {object} ctx.legal  result of game.legalActions()
 * @param {string} ctx.personality key of PERSONALITIES
 * @param {() => number} [ctx.rng]
 */
export function decide({ game, seat, legal, personality = 'pro', rng = Math.random }) {
  const style = PERSONALITIES[personality] ?? PERSONALITIES.pro;
  const opponents = Math.max(1, game.playersInHand().length - 1);
  const board = game.board;
  const preflop = board.length === 0;
  const iterations = preflop ? 220 : 380;

  const equity = estimateEquity(seat.hole, board, opponents, iterations, rng);
  const pot = Math.max(1, legal.pot);
  const toCall = legal.toCall;
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

  // Position matters most before the flop: acting late is worth loosening up for.
  const seatsBehind = seatsLeftToAct(game, seat);
  const positional = preflop ? (seatsBehind <= 1 ? 0.04 : seatsBehind >= 3 ? -0.03 : 0) : 0;
  const strength = equity + positional;

  // Equity has to be read against the field: 30% is weak heads up and strong
  // five-handed, so every threshold is expressed as a multiple of the equity an
  // average hand holds against this many opponents.
  const neutral = 1 / (opponents + 1);

  // Equity is measured against random holdings, but nobody puts a lot of chips
  // in with a random holding. Discount it by how much is being asked for: a
  // pot-sized bet on the river represents a far stronger range than a min-bet.
  // The mandatory big blind is not a bet anyone chose to make, so an unraised
  // pot carries no such information.
  const unraised = preflop && game.currentBet <= game.bigBlind;
  const pressure = toCall > 0 && !unraised
    ? Math.min(0.22, (toCall / pot) * 0.14 + (preflop ? 0 : 0.03))
    : 0;

  const roll = rng();
  const raiseSize = (fraction) => Math.round(legal.committed + toCall + (pot + toCall) * fraction);

  // ── nobody has bet: check or take the initiative ─────────────────────────
  if (toCall === 0) {
    const valueBet = strength > neutral * (1.55 - style.aggression * 0.35);
    const bluff = roll < style.bluff && legal.canRaise && !preflop;
    if (legal.canRaise && (valueBet || bluff)) {
      const fraction = valueBet
        ? style.sizing * (0.8 + rng() * 0.5)
        : style.sizing * (0.55 + rng() * 0.35);
      return capped(game, legal, { type: 'bet', amount: raiseSize(fraction) }, strength, style, rng);
    }
    return { type: 'check' };
  }

  // ── facing a bet ─────────────────────────────────────────────────────────
  const committedRatio = toCall / Math.max(1, legal.chips + legal.committed);
  // Raising before the flop also wins the pot uncontested often enough that it
  // needs less raw equity than betting into a field that has already committed.
  const raiseThreshold = preflop
    ? neutral * (1.45 - style.aggression * 0.4)
    : neutral * (1.95 - style.aggression * 0.5);
  const edge = (strength - pressure) - potOdds;

  // Raising is gated on personality, but not so hard that strong hands get
  // limped: a good hand still comes in raising most of the time.
  const raiseGate = 0.4 + style.aggression * 0.6;
  if (strength - pressure > raiseThreshold && legal.canRaise && roll < raiseGate) {
    const fraction = style.sizing * (0.9 + rng() * 0.6);
    return capped(game, legal, { type: 'raise', amount: raiseSize(fraction) }, strength, style, rng);
  }

  // A semi-bluff raise: not enough to call profitably, but fold equity is real.
  if (legal.canRaise && roll < style.bluff * 0.5 && strength > neutral * 0.8 && committedRatio < 0.25) {
    return capped(game, legal, { type: 'raise', amount: raiseSize(style.sizing) }, strength, style, rng);
  }

  if (edge > style.callThreshold) return { type: 'call' };

  // Getting a huge price is worth a look even with a weak hand.
  if (toCall <= game.bigBlind && edge > style.callThreshold - 0.08) return { type: 'call' };

  return { type: 'fold' };
}

/** Keep bet sizing sane and turn near-shoves into clean all-ins. */
function capped(game, legal, action, strength, style, rng) {
  const potNow = Math.max(1, legal.pot + legal.toCall);
  // A bet of several times the pot only ever gets called by something better,
  // so cap sizing at a heavy overbet however strong the hand looks.
  const ceiling = Math.round(legal.committed + legal.toCall + potNow * 1.6);
  let amount = Math.min(action.amount, ceiling, legal.maxRaiseTo);
  amount = Math.max(amount, legal.minRaiseTo);

  if (amount >= legal.maxRaiseTo) return { type: 'allin' };
  // Leaving a token stack behind is worse than just moving it in.
  if (legal.maxRaiseTo - amount <= game.bigBlind * 1.5) return { type: 'allin' };
  // Shove only when the stack is not much bigger than the pot in the first place.
  if (strength > 0.85 && legal.maxRaiseTo <= potNow * 2.2 && rng() < style.aggression * 0.5) {
    return { type: 'allin' };
  }
  return { ...action, amount };
}

function seatsLeftToAct(game, seat) {
  const n = game.seats.length;
  let count = 0;
  for (let step = 1; step < n; step++) {
    const other = game.seats[(seat.index + step) % n];
    if (other.inHand && !other.folded && !other.allIn && other.chips > 0) count++;
  }
  return count;
}

/** How long the bot should appear to think, in ms. */
export function thinkingTime(personality, rng = Math.random) {
  const [lo, hi] = (PERSONALITIES[personality] ?? PERSONALITIES.pro).thinkMs;
  return Math.round(lo + rng() * (hi - lo));
}

export const makeBotRng = makeRng;
