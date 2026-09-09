/**
 * Five-of-seven Texas Hold'em hand evaluator.
 *
 * evaluate(cards) returns { score, category, ranks, cards, name } where `score`
 * is a single integer: bigger is better, equal means a tie (a chopped pot).
 * The score packs the category and five kickers into 24 bits:
 *
 *   category << 20 | k1 << 16 | k2 << 12 | k3 << 8 | k4 << 4 | k5
 *
 * Ranks inside the score are 0..12 (deuce..ace); the wheel straight is scored
 * with a five as its high card, which is what makes A-2-3-4-5 lose to 2-3-4-5-6.
 */

import { rankOf, suitOf, RANKS } from './cards.js';

export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
};

const CATEGORY_LABELS = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

const packScore = (category, k) =>
  (category << 20) | (k[0] << 16) | ((k[1] ?? 0) << 12) | ((k[2] ?? 0) << 8) | ((k[3] ?? 0) << 4) | (k[4] ?? 0);

/**
 * Highest straight inside a rank-presence bitmask, or -1.
 * Returns the rank of the straight's high card; the wheel (A-2-3-4-5) reports
 * 3 — the five — so it correctly loses to every other straight.
 */
function straightHigh(mask) {
  for (let high = 12; high >= 4; high--) {
    const run = 0b11111 << (high - 4);
    if ((mask & run) === run) return high;
  }
  const wheel = (1 << 12) | 0b1111; // A-5-4-3-2
  if ((mask & wheel) === wheel) return 3;
  return -1;
}

/**
 * @param {number[]} cards 5, 6 or 7 card indices.
 * @returns {{score:number, category:number, ranks:number[], cards:number[], name:string}}
 */
export function evaluate(cards) {
  if (cards.length < 5) throw new Error('Need at least five cards to evaluate');

  const rankCounts = new Array(13).fill(0);
  const suitCounts = [0, 0, 0, 0];
  const bySuit = [[], [], [], []];
  let rankMask = 0;

  for (const card of cards) {
    const r = rankOf(card);
    const s = suitOf(card);
    rankCounts[r]++;
    suitCounts[s]++;
    bySuit[s].push(card);
    rankMask |= 1 << r;
  }

  const flushSuit = suitCounts.findIndex((n) => n >= 5);

  // Straight flush — check straights inside the flush suit only.
  if (flushSuit >= 0) {
    let flushMask = 0;
    for (const card of bySuit[flushSuit]) flushMask |= 1 << rankOf(card);
    const sfHigh = straightHigh(flushMask);
    if (sfHigh >= 0) {
      const picked = pickStraight(bySuit[flushSuit], sfHigh);
      return finish(CATEGORY.STRAIGHT_FLUSH, [sfHigh], picked);
    }
  }

  // Rank multiplicities, highest rank first.
  const quads = [], trips = [], pairs = [], singles = [];
  for (let r = 12; r >= 0; r--) {
    if (rankCounts[r] === 4) quads.push(r);
    else if (rankCounts[r] === 3) trips.push(r);
    else if (rankCounts[r] === 2) pairs.push(r);
    else if (rankCounts[r] === 1) singles.push(r);
  }

  if (quads.length) {
    const quad = quads[0];
    const kicker = bestRanksExcluding(rankCounts, [quad], 1)[0];
    return finish(CATEGORY.FOUR_OF_A_KIND, [quad, kicker], [
      ...cardsOfRank(cards, quad, 4),
      ...cardsOfRank(cards, kicker, 1),
    ]);
  }

  if (trips.length && (trips.length > 1 || pairs.length)) {
    const three = trips[0];
    const pair = trips.length > 1 ? Math.max(trips[1], pairs[0] ?? -1) : pairs[0];
    return finish(CATEGORY.FULL_HOUSE, [three, pair], [
      ...cardsOfRank(cards, three, 3),
      ...cardsOfRank(cards, pair, 2),
    ]);
  }

  if (flushSuit >= 0) {
    const flushCards = bySuit[flushSuit]
      .slice()
      .sort((a, b) => rankOf(b) - rankOf(a))
      .slice(0, 5);
    return finish(CATEGORY.FLUSH, flushCards.map(rankOf), flushCards);
  }

  const sHigh = straightHigh(rankMask);
  if (sHigh >= 0) {
    return finish(CATEGORY.STRAIGHT, [sHigh], pickStraight(cards, sHigh));
  }

  if (trips.length) {
    const three = trips[0];
    const kickers = bestRanksExcluding(rankCounts, [three], 2);
    return finish(CATEGORY.THREE_OF_A_KIND, [three, ...kickers], [
      ...cardsOfRank(cards, three, 3),
      ...kickers.flatMap((r) => cardsOfRank(cards, r, 1)),
    ]);
  }

  if (pairs.length >= 2) {
    const [hi, lo] = pairs;
    const kicker = bestRanksExcluding(rankCounts, [hi, lo], 1)[0];
    return finish(CATEGORY.TWO_PAIR, [hi, lo, kicker], [
      ...cardsOfRank(cards, hi, 2),
      ...cardsOfRank(cards, lo, 2),
      ...cardsOfRank(cards, kicker, 1),
    ]);
  }

  if (pairs.length === 1) {
    const pair = pairs[0];
    const kickers = bestRanksExcluding(rankCounts, [pair], 3);
    return finish(CATEGORY.PAIR, [pair, ...kickers], [
      ...cardsOfRank(cards, pair, 2),
      ...kickers.flatMap((r) => cardsOfRank(cards, r, 1)),
    ]);
  }

  const high = singles.slice(0, 5);
  return finish(CATEGORY.HIGH_CARD, high, high.flatMap((r) => cardsOfRank(cards, r, 1)));
}

function finish(category, ranks, best) {
  return {
    score: packScore(category, ranks),
    category,
    ranks,
    cards: best.slice(0, 5),
    name: describe(category, ranks),
  };
}

function cardsOfRank(cards, rank, count) {
  const out = [];
  for (const card of cards) {
    if (rankOf(card) === rank) {
      out.push(card);
      if (out.length === count) break;
    }
  }
  return out;
}

function bestRanksExcluding(rankCounts, exclude, count) {
  const out = [];
  for (let r = 12; r >= 0 && out.length < count; r--) {
    if (rankCounts[r] > 0 && !exclude.includes(r)) out.push(r);
  }
  return out;
}

/** The five cards making up a straight with the given high rank. */
function pickStraight(cards, high) {
  const wanted = high === 3 ? [3, 2, 1, 0, 12] : [high, high - 1, high - 2, high - 3, high - 4];
  return wanted.map((r) => cardsOfRank(cards, r, 1)[0]).filter((c) => c !== undefined);
}

const PLURALS = ['Deuces', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights',
  'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
const plural = (r) => PLURALS[r];

export function describe(category, ranks) {
  switch (category) {
    case CATEGORY.STRAIGHT_FLUSH:
      return ranks[0] === 12 ? 'Royal Flush' : `Straight Flush, ${RANKS[ranks[0]]} high`;
    case CATEGORY.FOUR_OF_A_KIND: return `Four ${plural(ranks[0])}`;
    case CATEGORY.FULL_HOUSE: return `${plural(ranks[0])} full of ${plural(ranks[1])}`;
    case CATEGORY.FLUSH: return `Flush, ${RANKS[ranks[0]]} high`;
    case CATEGORY.STRAIGHT: return `Straight, ${RANKS[ranks[0]]} high`;
    case CATEGORY.THREE_OF_A_KIND: return `Three ${plural(ranks[0])}`;
    case CATEGORY.TWO_PAIR: return `Two Pair, ${plural(ranks[0])} and ${plural(ranks[1])}`;
    case CATEGORY.PAIR: return `Pair of ${plural(ranks[0])}`;
    default: return `${RANKS[ranks[0]]} high`;
  }
}

export const categoryLabel = (category) => CATEGORY_LABELS[category];

/** Convenience: compare two 7-card holdings. >0 means `a` wins. */
export const compareHands = (a, b) => evaluate(a).score - evaluate(b).score;
