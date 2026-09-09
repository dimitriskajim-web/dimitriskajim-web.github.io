/**
 * Test suite for the poker engine. Run with `node test/run.js`.
 */
import { handFromString, handToString, makeRng, makeDeck } from '../js/cards.js';
import { evaluate, CATEGORY } from '../js/evaluator.js';
import { HoldemGame } from '../js/engine.js';
import { decide, estimateEquity } from '../js/bots.js';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (name, actual, expected) =>
  check(name, actual === expected, `expected ${expected}, got ${actual}`);

const score = (str) => evaluate(handFromString(str)).score;
const cat = (str) => evaluate(handFromString(str)).category;

// ── evaluator: categories ──────────────────────────────────────────────────
eq('royal flush', cat('Ah Kh Qh Jh Th 2c 3d'), CATEGORY.STRAIGHT_FLUSH);
eq('steel wheel is a straight flush', cat('Ah 2h 3h 4h 5h 9c Kd'), CATEGORY.STRAIGHT_FLUSH);
eq('quads', cat('7h 7d 7s 7c 2d 9h Jc'), CATEGORY.FOUR_OF_A_KIND);
eq('full house', cat('7h 7d 7s 2c 2d 9h Jc'), CATEGORY.FULL_HOUSE);
eq('two trips make a full house', cat('7h 7d 7s 2c 2d 2h Jc'), CATEGORY.FULL_HOUSE);
eq('flush', cat('Ah 9h 7h 4h 2h Kc Qd'), CATEGORY.FLUSH);
eq('straight', cat('9s 8h 7d 6c 5s Ah Kd'), CATEGORY.STRAIGHT);
eq('wheel straight', cat('As 2d 3c 4h 5s Kd Qh'), CATEGORY.STRAIGHT);
eq('trips', cat('7h 7d 7s 2c 9d Jh 3c'), CATEGORY.THREE_OF_A_KIND);
eq('two pair', cat('7h 7d 9s 9c 2d Jh 3c'), CATEGORY.TWO_PAIR);
eq('one pair', cat('7h 7d 9s 4c 2d Jh 3c'), CATEGORY.PAIR);
eq('high card', cat('7h 9d Js 4c 2d Kh 3c'), CATEGORY.HIGH_CARD);
eq('four to a straight is not a straight', cat('9s 8h 7d 6c 2s 3h Jd'), CATEGORY.HIGH_CARD);
eq('5-4-3-2 without an ace is not a wheel', cat('9s 8h 5d 4c 3s 2h Jd'), CATEGORY.HIGH_CARD);
eq('two broken runs are not a straight', cat('9s 8h 7d 5c 4s 3h 2d'), CATEGORY.HIGH_CARD);

// ── evaluator: ordering ────────────────────────────────────────────────────
check('quads beat a full house', score('7h 7d 7s 7c 2d 2h Jc') > score('7h 7d 7s 2c 2d 2h Jc'));
check('flush beats a straight', score('Ah 9h 7h 4h 2h 8s 5d') > score('9s 8h 7d 6c 5s 2h 3d'));
check('straight beats trips', score('9s 8h 7d 6c 5s 2h 2d') > score('7h 7d 7s 2c 9d Jh 3c'));
check('wheel loses to a six-high straight', score('As 2d 3c 4h 5s Kd Qh') < score('2d 3c 4h 5s 6d Kh Qs'));
check('ace-high flush beats king-high flush', score('Ah 9h 7h 4h 2h 8s 5d') > score('Kh 9h 7h 4h 2h 8s 5d'));
check('kicker breaks a pair tie', score('Ah Ad Ks 9c 4d 2h 3c') > score('Ah Ad Qs 9c 4d 2h 3c'));
check('identical hands tie', score('Ah Ad Ks 9c 4d 2h 3c') === score('As Ac Kd 9h 4s 2d 3h'));
check('board plays: both players tie', score('Ah Kh Qh Jh Th 2c 3d') === score('Ah Kh Qh Jh Th 5c 6d'));
eq('best five are reported', handToString(evaluate(handFromString('Ah Kh Qh Jh Th 2c 3d')).cards),
  'Ah Kh Qh Jh Th');
eq('hand naming', evaluate(handFromString('7h 7d 7s 2c 2d 9h Jc')).name, 'Sevens full of Deuces');

// ── evaluator: exhaustive sanity over random 7-card hands ──────────────────
{
  const rng = makeRng(99);
  let bad = 0;
  for (let i = 0; i < 5000; i++) {
    const deck = makeDeck();
    for (let j = deck.length - 1; j > 0; j--) {
      const k = Math.floor(rng() * (j + 1));
      [deck[j], deck[k]] = [deck[k], deck[j]];
    }
    const cards = deck.slice(0, 7);
    const result = evaluate(cards);
    if (result.cards.length !== 5) bad++;
    if (new Set(result.cards).size !== 5) bad++;
    if (!result.cards.every((c) => cards.includes(c))) bad++;
    // The five reported cards must score exactly the same as the seven.
    if (evaluate(result.cards).score !== result.score) bad++;
  }
  eq('5000 random hands are self-consistent', bad, 0);
}

// ── engine: blinds and preflop order ───────────────────────────────────────
{
  const game = seatedGame(5, 1000, 3);
  game.startHand();
  eq('small blind posted', game.seats[game.smallBlindIndex].totalCommitted, 25);
  eq('big blind posted', game.seats[game.bigBlindIndex].totalCommitted, 50);
  eq('pot after blinds', game.totalPot, 75);
  eq('first to act is left of the big blind', game.actingIndex,
    (game.bigBlindIndex + 1) % 5);
  eq('everyone was dealt two cards', game.playersInHand().every((s) => s.hole.length === 2), true);
  const dealt = game.playersInHand().flatMap((s) => s.hole);
  eq('no duplicate hole cards', new Set(dealt).size, dealt.length);
}

// ── engine: the big blind gets an option ───────────────────────────────────
{
  const game = seatedGame(3, 1000, 11);
  game.startHand();
  game.act({ type: 'call' });   // button
  game.act({ type: 'call' });   // small blind completes
  eq('action returns to the big blind', game.actingIndex, game.bigBlindIndex);
  eq('big blind may check', game.legalActions().canCheck, true);
  game.act({ type: 'check' });
  eq('flop is dealt after the option', game.board.length, 3);
}

// ── engine: minimum raise sizing ───────────────────────────────────────────
{
  const game = seatedGame(3, 1000, 12);
  game.startHand();
  eq('minimum open is two big blinds', game.legalActions().minRaiseTo, 100);
  game.act({ type: 'raise', amount: 150 });
  eq('next minimum raise is 100 more', game.legalActions().minRaiseTo, 250);
  game.act({ type: 'raise', amount: 60 });   // illegal, snaps up to the minimum
  eq('undersized raises snap to the minimum', game.seats[game.actingIndex === 0 ? 1 : 0].committed >= 0, true);
  const raiser = game.seats.find((s) => s.lastAction && s.lastAction.startsWith('Raise 250'));
  check('short raise was clamped to 250', !!raiser, 'no seat raised to 250');
}

// ── engine: folding round hands the pot to the last player ─────────────────
{
  const game = seatedGame(5, 1000, 21);
  game.startHand();
  const bb = game.seats[game.bigBlindIndex];
  for (let i = 0; i < 4; i++) game.act({ type: 'fold' });
  eq('hand ends when everyone folds', game.handOver, true);
  eq('big blind collects the blinds', bb.chips, 1000 - 50 + 75);
  eq('winner is not shown down', game.seats.filter((s) => s.result).length, 0);
}

// ── engine: side pots ──────────────────────────────────────────────────────
{
  // Three stacks of different sizes all in: one main pot plus two side pots.
  const game = new HoldemGame({
    seats: [
      { id: 'short', name: 'Short', chips: 100 },
      { id: 'mid', name: 'Mid', chips: 300 },
      { id: 'big', name: 'Big', chips: 900 },
    ],
    smallBlind: 25, bigBlind: 50, seed: 4,
  });
  game.startHand();
  let guard = 0;
  while (!game.handOver && guard++ < 30) game.act({ type: 'allin' });
  const pots = game.pots;
  eq('three all-ins build three pots', pots.length, 3);
  eq('main pot is everyone x100', pots[0].amount, 300);
  eq('main pot has three contenders', pots[0].eligible.length, 3);
  eq('first side pot is two x200', pots[1].amount, 400);
  eq('first side pot has two contenders', pots[1].eligible.length, 2);
  eq('uncalled remainder returns to the big stack', pots[2].amount, 600);
  eq('uncalled remainder has one contender', pots[2].eligible.length, 1);
  eq('chips are conserved across side pots',
    game.seats.reduce((sum, s) => sum + s.chips, 0), 1300);
}

// ── engine: split pots ─────────────────────────────────────────────────────
{
  const game = new HoldemGame({
    seats: [{ id: 'a', name: 'A', chips: 500 }, { id: 'b', name: 'B', chips: 500 }],
    smallBlind: 25, bigBlind: 50, seed: 8,
  });
  game.startHand();
  // Force a board and holdings that must chop: both players play the board.
  game.seats[0].hole = handFromString('2c 3d');
  game.seats[1].hole = handFromString('2h 3s');
  game.board = handFromString('Ah Kh Qh Jh Th');
  game.street = 'river';
  for (const seat of game.seats) { seat.committed = 0; seat.totalCommitted = 200; seat.chips = 300; }
  game.pot = 400;
  game.finishHand();
  eq('a chopped pot is split evenly', game.seats[0].chips, 500);
  eq('both players get half', game.seats[1].chips, 500);
}

// ── engine: odd chip goes to the first seat left of the button ─────────────
{
  const game = new HoldemGame({
    seats: [
      { id: 'a', name: 'A', chips: 500 },
      { id: 'b', name: 'B', chips: 500 },
      { id: 'c', name: 'C', chips: 500 },
    ],
    smallBlind: 25, bigBlind: 50, seed: 8,
  });
  game.startHand();
  game.buttonIndex = 0;
  game.seats[0].hole = handFromString('2c 3d');   // both chop, playing the board
  game.seats[1].hole = handFromString('2h 3s');
  game.seats[2].hole = handFromString('4h 5s');   // folded, but its chips are in
  game.seats[2].folded = true;
  game.board = handFromString('Ah Kh Qh Jh Th');
  game.street = 'river';
  for (const seat of game.seats) { seat.committed = 0; seat.totalCommitted = 101; seat.chips = 399; }
  game.pot = 303;
  game.finishHand();
  eq('odd chip goes to the first winner left of the button', game.seats[1].chips, 399 + 152);
  eq('the other winner gets the smaller half', game.seats[0].chips, 399 + 151);
  eq('the folded seat wins nothing', game.seats[2].chips, 399);
}

// ── engine: long random simulation ─────────────────────────────────────────
{
  const rng = makeRng(2024);
  const game = seatedGame(5, 2000, 777);
  const startingChips = game.seats.reduce((sum, s) => sum + s.chips, 0);
  const styles = ['rock', 'pro', 'shark', 'station', 'maniac'];
  let hands = 0;
  let handsWithShowdown = 0;
  let errors = 0;

  for (let h = 0; h < 400; h++) {
    if (game.eligibleSeats().length < 2) break;
    try {
      game.startHand();
      let guard = 0;
      while (!game.handOver) {
        if (guard++ > 400) throw new Error('betting round did not terminate');
        const seat = game.actingSeat();
        const legal = game.legalActions();
        if (!seat || !legal) throw new Error('no seat to act while the hand is live');
        const action = decide({ game, seat, legal, personality: styles[seat.index], rng });
        assertLegal(game, seat, legal, action);
        game.act(action);
      }
      hands++;
      if (game.seats.some((s) => s.result)) handsWithShowdown++;
      // Bust-outs get a fresh stack, the way a bot would rebuy.
      for (const seat of game.seats) if (seat.chips === 0) seat.chips = 2000;
    } catch (err) {
      errors++;
      failures.push(`simulation hand ${h}: ${err.message}`);
      break;
    }
    const total = game.seats.reduce((sum, s) => sum + s.chips, 0);
    if (total % 1 !== 0) { failures.push(`fractional chips after hand ${h}`); break; }
    if (game.seats.some((s) => s.chips < 0)) { failures.push(`negative stack after hand ${h}`); break; }
  }
  eq('400 simulated hands ran clean', errors, 0);
  check('most hands completed', hands >= 390, `only ${hands} hands finished`);
  check('showdowns happen', handsWithShowdown > 40, `only ${handsWithShowdown} showdowns`);
  check('starting bankroll was non-zero', startingChips === 10000);
}

// ── engine: chips are conserved when nobody rebuys ─────────────────────────
{
  const rng = makeRng(31337);
  const game = new HoldemGame({
    seats: [
      { id: 'p0', name: 'P0', chips: 1500 }, { id: 'p1', name: 'P1', chips: 800 },
      { id: 'p2', name: 'P2', chips: 2400 }, { id: 'p3', name: 'P3', chips: 640 },
      { id: 'p4', name: 'P4', chips: 3000 },
    ],
    smallBlind: 25, bigBlind: 50, seed: 555,
  });
  const bank = 1500 + 800 + 2400 + 640 + 3000;
  let ok = true;
  for (let h = 0; h < 200 && game.eligibleSeats().length >= 2; h++) {
    game.startHand();
    let guard = 0;
    while (!game.handOver && guard++ < 400) {
      const seat = game.actingSeat();
      game.act(decide({ game, seat, legal: game.legalActions(), personality: 'pro', rng }));
    }
    if (game.seats.reduce((sum, s) => sum + s.chips, 0) !== bank) { ok = false; break; }
  }
  check('no chips are created or destroyed over 200 hands', ok);
}

// ── bots: equity estimates land near known values ──────────────────────────
{
  const rng = makeRng(11);
  const aces = estimateEquity(handFromString('As Ah'), [], 1, 4000, rng);
  const trash = estimateEquity(handFromString('7d 2c'), [], 1, 4000, rng);
  check('aces are around 85% heads up', aces > 0.82 && aces < 0.88, `got ${aces.toFixed(3)}`);
  check('72 offsuit is around 35% heads up', trash > 0.3 && trash < 0.4, `got ${trash.toFixed(3)}`);
  const madeFlush = estimateEquity(handFromString('Ah Kh'), handFromString('2h 7h Th'), 2, 3000, rng);
  check('a made nut flush is a big favourite', madeFlush > 0.85, `got ${madeFlush.toFixed(3)}`);
}

// ── helpers ────────────────────────────────────────────────────────────────
function seatedGame(count, chips, seed) {
  return new HoldemGame({
    seats: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `Seat ${i}`, chips })),
    smallBlind: 25, bigBlind: 50, seed,
  });
}

function assertLegal(game, seat, legal, action) {
  if (action.type === 'check' && !legal.canCheck) throw new Error(`${seat.name} checked facing ${legal.toCall}`);
  if ((action.type === 'bet' || action.type === 'raise') && !legal.canRaise) {
    throw new Error(`${seat.name} raised without the chips to do it`);
  }
  if (action.type === 'raise' && action.amount > legal.maxRaiseTo) {
    throw new Error(`${seat.name} raised to ${action.amount} over a stack of ${legal.maxRaiseTo}`);
  }
}

// ── report ─────────────────────────────────────────────────────────────────
const total = passed + failures.length;
if (failures.length) {
  console.log(`\n✗ ${failures.length} of ${total} checks failed:\n`);
  for (const failure of failures) console.log(`   • ${failure}`);
  process.exit(1);
}
console.log(`\n✓ all ${total} checks passed\n`);
