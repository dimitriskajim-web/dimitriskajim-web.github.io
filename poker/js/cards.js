/**
 * Card primitives: ranks, suits, deck construction and shuffling.
 * A card is an integer 0..51 so the evaluator can work on plain numbers,
 * with helpers to turn it into something printable.
 *
 *   rank = card >> 2   (0 = deuce ... 12 = ace)
 *   suit = card & 3    (0 = clubs, 1 = diamonds, 2 = hearts, 3 = spades)
 */

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['c', 'd', 'h', 's'];
export const SUIT_SYMBOLS = { c: '♣', d: '♦', h: '♥', s: '♠' };
export const SUIT_NAMES = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };

export const rankOf = (card) => card >> 2;
export const suitOf = (card) => card & 3;

/** '9h' -> card index. Accepts upper or lower case. */
export function cardFromString(str) {
  const rank = RANKS.indexOf(str[0].toUpperCase());
  const suit = SUITS.indexOf(str[1].toLowerCase());
  if (rank < 0 || suit < 0) throw new Error(`Unknown card: ${str}`);
  return rank * 4 + suit;
}

export const cardToString = (card) => RANKS[rankOf(card)] + SUITS[suitOf(card)];
export const handToString = (cards) => cards.map(cardToString).join(' ');

/** Parse 'Ah Kd 7c' into an array of card indices. */
export const handFromString = (str) => str.trim().split(/\s+/).map(cardFromString);

export function makeDeck() {
  const deck = new Array(52);
  for (let i = 0; i < 52; i++) deck[i] = i;
  return deck;
}

/**
 * Deterministic PRNG (mulberry32) so simulations and replays can be seeded.
 * Called with no seed it falls back to crypto-backed randomness.
 */
export function makeRng(seed) {
  if (seed === undefined || seed === null) {
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      const buf = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buf);
      seed = buf[0];
    } else {
      seed = (Math.random() * 2 ** 32) >>> 0;
    }
  }
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, in place. */
export function shuffle(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

/** A shuffled deck you pop cards off the end of. */
export function freshDeck(rng = Math.random) {
  return shuffle(makeDeck(), rng);
}
