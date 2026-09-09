/**
 * Plays a few hands at a five-handed table and prints a transcript, so the
 * whole flow — blinds, streets, betting, showdowns, side pots, button movement
 * — can be read and checked by eye.
 *
 *   node test/simulate.js [hands] [seed]
 */
import { HoldemGame } from '../js/engine.js';
import { decide } from '../js/bots.js';
import { makeRng, handToString } from '../js/cards.js';
import { TABLE_ROSTER } from '../js/roster.js';

const hands = Number(process.argv[2] ?? 5);
const seed = Number(process.argv[3] ?? 20260909);
const rng = makeRng(seed);

const SMALL_BLIND = 25;
const BIG_BLIND = 50;
const BUY_IN = 5000;

const seats = [
  { id: 'hero', name: 'You', chips: BUY_IN, isHuman: true, style: 'pro' },
  ...TABLE_ROSTER.slice(0, 4).map((bot) => ({ ...bot, chips: BUY_IN })),
];

const game = new HoldemGame({ seats, smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, seed });
const styleOf = (index) => seats[index].style ?? 'pro';
const chipsOf = (seat) => seat.chips.toLocaleString('en-US');
const bank = () => game.seats.reduce((sum, s) => sum + s.chips, 0);
const startingBank = bank();

console.log(`\n\x1b[1mMERIDIAN CLUB — Executive Lounge\x1b[0m`);
console.log(`No-Limit Hold'em · ${SMALL_BLIND}/${BIG_BLIND} · 5 seats · seed ${seed}\n`);
for (const seat of game.seats) {
  console.log(`  ${seat.isHuman ? '▸' : ' '} ${seat.name.padEnd(20)} ${chipsOf(seat).padStart(7)}  ${seat.isHuman ? '(you)' : styleOf(seat.index)}`);
}

for (let h = 0; h < hands; h++) {
  if (game.eligibleSeats().length < 2) { console.log('\nTable broke up — not enough funded seats.'); break; }
  game.startHand();

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`\x1b[1mHand #${game.handNumber}\x1b[0m   button: ${game.seats[game.buttonIndex].name}` +
    `   blinds: ${game.seats[game.smallBlindIndex].name} / ${game.seats[game.bigBlindIndex].name}`);
  for (const seat of game.playersInHand()) {
    console.log(`   ${seat.name.padEnd(20)} ${handToString(seat.hole).padEnd(8)}  ${chipsOf(seat).padStart(7)}`);
  }

  let street = 'preflop';
  console.log(`\n   \x1b[2m· preflop ·\x1b[0m`);

  let guard = 0;
  while (!game.handOver) {
    if (guard++ > 400) throw new Error('hand did not terminate');
    if (game.street !== street && game.street !== 'complete') {
      street = game.street;
      console.log(`\n   \x1b[2m· ${street} ·\x1b[0m  board: ${handToString(game.board)}   pot: ${game.totalPot}`);
    }
    const seat = game.actingSeat();
    const legal = game.legalActions();
    const action = decide({ game, seat, legal, personality: styleOf(seat.index), rng });
    game.act(action);
    console.log(`     ${seat.isHuman ? '\x1b[36m' : ''}${seat.name.padEnd(20)}\x1b[0m ${describeAction(game).padEnd(16)} ` +
      `stack ${chipsOf(seat).padStart(7)}   pot ${game.totalPot}`);
  }

  if (game.board.length) console.log(`\n   board: ${handToString(game.board)}`);
  const shown = game.seats.filter((s) => s.result);
  for (const seat of shown) {
    console.log(`   ${seat.name.padEnd(20)} ${handToString(seat.hole).padEnd(8)} ${seat.result.name}`);
  }
  if (game.pots.length > 1) {
    console.log(`   pots: ${game.pots.map((p, i) => `${i === 0 ? 'main' : `side ${i}`} ${p.amount} (${p.eligible.map((e) => game.seats[e].name).join(', ')})`).join(' | ')}`);
  }
  const winners = game.seats.filter((s) => s.wonThisHand > 0);
  console.log(`   \x1b[33m${winners.map((w) => `${w.name} wins ${w.wonThisHand.toLocaleString('en-US')}`).join('   ')}\x1b[0m`);

  // Anyone who busts sits back down with a fresh stack, as a bot would rebuy.
  for (const seat of game.seats) {
    if (seat.chips === 0) {
      console.log(`   ${seat.name} is felted and rebuys for ${BUY_IN.toLocaleString('en-US')}`);
      seat.chips = BUY_IN;
    }
  }
}

console.log(`\n${'─'.repeat(64)}`);
console.log('\x1b[1mFinal stacks\x1b[0m');
const sorted = game.seats.slice().sort((a, b) => b.chips - a.chips);
for (const seat of sorted) {
  const delta = seat.chips - BUY_IN;
  const sign = delta > 0 ? `+${delta.toLocaleString('en-US')}` : delta.toLocaleString('en-US');
  console.log(`   ${seat.name.padEnd(20)} ${chipsOf(seat).padStart(8)}   ${delta === 0 ? '—' : sign}`);
}
console.log(`\nchips in play: ${bank().toLocaleString('en-US')} (started with ${startingBank.toLocaleString('en-US')} + rebuys)\n`);

/** Pull the action just applied out of the event queue — the engine clears
 *  `seat.lastAction` when a street closes, so the events are the record. */
function describeAction(game) {
  const events = game.drainEvents();
  const action = events.reverse().find((e) => e.type === 'action');
  if (!action) return '';
  switch (action.action) {
    case 'fold': return 'Fold';
    case 'check': return 'Check';
    case 'call': return action.allIn ? `Call ${action.amount} all in` : `Call ${action.amount}`;
    case 'bet': return action.allIn ? `Bet ${action.to} all in` : `Bet ${action.to}`;
    case 'raise': return action.allIn ? `Raise ${action.to} all in` : `Raise to ${action.to}`;
    default: return action.action;
  }
}
