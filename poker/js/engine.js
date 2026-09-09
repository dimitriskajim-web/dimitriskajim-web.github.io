/**
 * No-Limit Texas Hold'em engine.
 *
 * The engine is a synchronous state machine. It never waits, never renders and
 * never talks to a bot: the caller asks who is to act, gets that seat's legal
 * actions, and calls `act()`. Everything the UI needs to animate comes out of
 * the `events` queue via `drainEvents()`.
 *
 *   const game = new HoldemGame({ seats, smallBlind: 25, bigBlind: 50 });
 *   game.startHand();
 *   while (!game.handOver) {
 *     const seat = game.actingSeat();
 *     game.act(decide(seat, game.legalActions()));
 *   }
 */

import { freshDeck, makeRng } from './cards.js';
import { evaluate } from './evaluator.js';

export const STREETS = ['preflop', 'flop', 'turn', 'river'];

/** Chip amounts read better with separators in the hand history. */
const chips = (n) => n.toLocaleString('en-US');

export class HoldemGame {
  /**
   * @param {object} config
   * @param {Array<{id:string,name:string,chips:number,isHuman?:boolean}>} config.seats
   * @param {number} config.smallBlind
   * @param {number} config.bigBlind
   * @param {number} [config.ante]
   * @param {number} [config.seed] seed the shuffle for reproducible hands
   */
  constructor({ seats, smallBlind, bigBlind, ante = 0, seed } = {}) {
    if (!seats || seats.length < 2) throw new Error('A table needs at least two seats');
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.ante = ante;
    this.rng = makeRng(seed);

    this.seats = seats.map((seat, index) => ({
      index,
      id: seat.id,
      name: seat.name,
      isHuman: !!seat.isHuman,
      chips: seat.chips,
      hole: [],
      folded: true,        // "not in this hand" until cards are dealt
      allIn: false,
      inHand: false,
      committed: 0,        // chips put in on the current street
      totalCommitted: 0,   // chips put in across the whole hand
      hasActed: false,
      lastAction: null,
      sittingOut: false,
      result: null,        // filled in at showdown
      wonThisHand: 0,
    }));

    this.buttonIndex = this.seats.length - 1; // startHand() advances it first
    this.handNumber = 0;
    this.street = 'idle';
    this.board = [];
    this.deck = [];
    this.pot = 0;          // chips swept from completed streets
    this.currentBet = 0;
    this.minRaise = bigBlind;
    this.actingIndex = -1;
    this.lastAggressorIndex = -1;
    this.handOver = true;
    this.pots = [];
    this.events = [];
    this.log = [];
  }

  // ── queries ──────────────────────────────────────────────────────────────

  /** Total chips on the table right now, including live bets. */
  get totalPot() {
    return this.pot + this.seats.reduce((sum, s) => sum + s.committed, 0);
  }

  /** Seats with chips who are not sitting out — the ones dealt into a hand. */
  eligibleSeats() {
    return this.seats.filter((s) => !s.sittingOut && s.chips > 0);
  }

  playersInHand() {
    return this.seats.filter((s) => s.inHand && !s.folded);
  }

  /** Players who still have a decision to make (not folded, not all-in). */
  playersToAct() {
    return this.playersInHand().filter((s) => !s.allIn && s.chips > 0);
  }

  actingSeat() {
    return this.actingIndex >= 0 ? this.seats[this.actingIndex] : null;
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  emit(type, payload = {}) {
    this.events.push({ type, ...payload });
  }

  note(text) {
    this.log.push(text);
    this.emit('log', { text });
  }

  /** "You call 200" but "Ray Okafor calls 200". */
  says(seat, verb) {
    return `${seat.name} ${seat.isHuman ? verb : `${verb}${verb.endsWith('s') ? 'es' : 's'}`}`;
  }

  // ── hand setup ───────────────────────────────────────────────────────────

  startHand() {
    const eligible = this.eligibleSeats();
    if (eligible.length < 2) throw new Error('Not enough funded seats to deal a hand');

    this.handNumber++;
    this.street = 'preflop';
    this.board = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.lastAggressorIndex = -1;
    this.pots = [];
    this.handOver = false;
    this.deck = freshDeck(this.rng);

    for (const seat of this.seats) {
      seat.hole = [];
      seat.committed = 0;
      seat.totalCommitted = 0;
      seat.hasActed = false;
      seat.lastAction = null;
      seat.allIn = false;
      seat.result = null;
      seat.wonThisHand = 0;
      seat.inHand = !seat.sittingOut && seat.chips > 0;
      seat.folded = !seat.inHand;
    }

    this.buttonIndex = this.nextOccupied(this.buttonIndex);
    this.emit('hand-start', { handNumber: this.handNumber, button: this.buttonIndex });
    this.note(`— Hand #${this.handNumber} — button: ${this.seats[this.buttonIndex].name}`);

    if (this.ante > 0) {
      for (const seat of this.playersInHand()) this.postChips(seat, Math.min(this.ante, seat.chips), 'ante');
      this.sweepToPot();
    }

    const headsUp = this.playersInHand().length === 2;
    const sbIndex = headsUp ? this.buttonIndex : this.nextOccupied(this.buttonIndex);
    const bbIndex = this.nextOccupied(sbIndex);
    this.smallBlindIndex = sbIndex;
    this.bigBlindIndex = bbIndex;

    this.postBlind(this.seats[sbIndex], this.smallBlind, 'small blind');
    this.postBlind(this.seats[bbIndex], this.bigBlind, 'big blind');
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    this.dealHoleCards();

    this.emit('street', { street: 'preflop', board: [] });
    this.actingIndex = headsUp ? sbIndex : this.nextOccupied(bbIndex);
    this.skipToPlayableActor();
    return this;
  }

  dealHoleCards() {
    // Two passes round the table, as it is dealt live.
    for (let pass = 0; pass < 2; pass++) {
      let index = this.nextOccupied(this.buttonIndex);
      for (let n = 0; n < this.seats.length; n++) {
        const seat = this.seats[index];
        if (seat.inHand) seat.hole.push(this.deck.pop());
        index = this.nextOccupied(index);
        if (index === this.nextOccupied(this.buttonIndex)) break;
      }
    }
    for (const seat of this.playersInHand()) {
      this.emit('deal-hole', { seat: seat.index, cards: seat.hole.slice() });
    }
  }

  postBlind(seat, amount, label) {
    const posted = this.postChips(seat, Math.min(amount, seat.chips), label);
    this.note(`${this.says(seat, 'post')} ${label} ${chips(posted)}`);
  }

  postChips(seat, amount, label) {
    const paid = Math.min(amount, seat.chips);
    seat.chips -= paid;
    seat.committed += paid;
    seat.totalCommitted += paid;
    if (seat.chips === 0) seat.allIn = true;
    this.emit('post', { seat: seat.index, amount: paid, label, chips: seat.chips });
    return paid;
  }

  // ── seat traversal ───────────────────────────────────────────────────────

  /** Next seat index (wrapping) that is dealt into this hand, or funded pre-deal. */
  nextOccupied(from) {
    const n = this.seats.length;
    for (let step = 1; step <= n; step++) {
      const idx = (from + step) % n;
      const seat = this.seats[idx];
      const playing = this.street === 'idle' || this.handOver
        ? !seat.sittingOut && seat.chips > 0
        : seat.inHand;
      if (playing) return idx;
    }
    return from;
  }

  /** Next seat after `from` that still has a decision to make. */
  nextToAct(from) {
    const n = this.seats.length;
    for (let step = 1; step <= n; step++) {
      const seat = this.seats[(from + step) % n];
      if (seat.inHand && !seat.folded && !seat.allIn && seat.chips > 0) return seat.index;
    }
    return -1;
  }

  skipToPlayableActor() {
    const seat = this.seats[this.actingIndex];
    if (!seat || !seat.inHand || seat.folded || seat.allIn || seat.chips === 0) {
      this.actingIndex = this.nextToAct(this.actingIndex);
    }
    if (this.bettingRoundComplete()) this.closeBettingRound();
    else this.emit('to-act', { seat: this.actingIndex, legal: this.legalActions() });
  }

  // ── betting ──────────────────────────────────────────────────────────────

  /** What the seat to act is allowed to do, with the amounts already worked out. */
  legalActions(seatIndex = this.actingIndex) {
    const seat = this.seats[seatIndex];
    if (!seat || this.handOver) return null;

    const toCall = Math.max(0, this.currentBet - seat.committed);
    const callAmount = Math.min(toCall, seat.chips);
    const stackTo = seat.committed + seat.chips; // largest "raise to" this seat can make
    const canRaise = seat.chips > toCall;
    const minRaiseTo = Math.min(this.currentBet + this.minRaise, stackTo);

    return {
      seat: seatIndex,
      toCall,
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      callAmount,
      isAllInCall: toCall > 0 && callAmount === seat.chips,
      canRaise,
      isOpeningBet: this.currentBet === 0,
      minRaiseTo,
      maxRaiseTo: stackTo,
      pot: this.totalPot,
      chips: seat.chips,
      committed: seat.committed,
    };
  }

  /**
   * Apply an action for the seat to act.
   * @param {{type:'fold'|'check'|'call'|'bet'|'raise'|'allin', amount?:number}} action
   *        `amount` on bet/raise is the total this seat is betting *to*.
   */
  act(action) {
    if (this.handOver) throw new Error('Hand is over');
    const seat = this.seats[this.actingIndex];
    if (!seat) throw new Error('Nobody is to act');
    const legal = this.legalActions();
    const type = action.type;

    if (type === 'fold') {
      if (legal.toCall === 0) {
        // Folding for free is legal but always wrong; treat it as a check.
        return this.act({ type: 'check' });
      }
      seat.folded = true;
      seat.lastAction = 'Fold';
      this.note(this.says(seat, 'fold'));
      this.emit('action', { seat: seat.index, action: 'fold' });
    } else if (type === 'check') {
      if (!legal.canCheck) throw new Error(`${seat.name} cannot check facing ${legal.toCall}`);
      seat.lastAction = 'Check';
      this.note(this.says(seat, 'check'));
      this.emit('action', { seat: seat.index, action: 'check' });
    } else if (type === 'call') {
      if (!legal.canCall) return this.act({ type: 'check' });
      const paid = this.postChips(seat, legal.callAmount, 'call');
      seat.lastAction = seat.allIn ? `All in ${paid}` : `Call ${paid}`;
      this.note(`${this.says(seat, 'call')} ${chips(paid)}${seat.allIn ? ' (all in)' : ''}`);
      this.emit('action', { seat: seat.index, action: 'call', amount: paid, allIn: seat.allIn });
    } else if (type === 'bet' || type === 'raise' || type === 'allin') {
      const requested = type === 'allin' ? legal.maxRaiseTo : Math.round(action.amount);
      const raiseTo = this.clampRaise(requested, legal);
      const paid = this.postChips(seat, raiseTo - seat.committed, 'raise');
      const increment = raiseTo - this.currentBet;
      const opening = legal.isOpeningBet;

      if (increment >= this.minRaise) {
        // A full-size raise reopens the betting for everyone behind.
        this.minRaise = increment;
        for (const other of this.playersToAct()) {
          if (other.index !== seat.index) other.hasActed = false;
        }
      }
      this.currentBet = Math.max(this.currentBet, raiseTo);
      this.lastAggressorIndex = seat.index;
      seat.lastAction = seat.allIn ? `All in ${raiseTo}` : `${opening ? 'Bet' : 'Raise'} ${raiseTo}`;
      this.note(`${this.says(seat, opening ? 'bet' : 'raise')}${opening ? '' : ' to'} ` +
        `${chips(raiseTo)}${seat.allIn ? ' (all in)' : ''}`);
      this.emit('action', {
        seat: seat.index, action: opening ? 'bet' : 'raise', amount: paid, to: raiseTo, allIn: seat.allIn,
      });
    } else {
      throw new Error(`Unknown action: ${type}`);
    }

    seat.hasActed = true;
    this.afterAction();
    return this;
  }

  /** Keep a raise inside the legal band, snapping short raises to all-in. */
  clampRaise(requested, legal) {
    let raiseTo = Math.max(requested, 0);
    if (raiseTo >= legal.maxRaiseTo) return legal.maxRaiseTo;      // all in
    if (raiseTo < legal.minRaiseTo) return legal.minRaiseTo;
    return raiseTo;
  }

  afterAction() {
    if (this.playersInHand().length === 1) {
      this.finishHand();
      return;
    }
    if (this.bettingRoundComplete()) {
      this.closeBettingRound();
      return;
    }
    this.actingIndex = this.nextToAct(this.actingIndex);
    this.emit('to-act', { seat: this.actingIndex, legal: this.legalActions() });
  }

  bettingRoundComplete() {
    const live = this.playersInHand();
    if (live.length <= 1) return true;
    const toAct = this.playersToAct();
    if (toAct.length === 0) return true;
    // One player left with chips and everyone else all-in: nothing left to decide
    // once that player has matched the largest live bet.
    return toAct.every((s) => s.hasActed && s.committed === this.currentBet);
  }

  /** Move street bets into the pot and deal the next street (or run it out). */
  closeBettingRound() {
    this.sweepToPot();
    for (const seat of this.seats) {
      seat.committed = 0;
      seat.hasActed = false;
      seat.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.lastAggressorIndex = -1;

    if (this.playersInHand().length === 1) {
      this.finishHand();
      return;
    }

    // Nobody left to bet — run the remaining board out and show down.
    const contested = this.playersToAct().length > 1;
    while (this.street !== 'river' && !contested) {
      this.dealNextStreet();
    }
    if (!contested) {
      this.finishHand();
      return;
    }
    if (this.street === 'river') {
      this.finishHand();
      return;
    }
    this.dealNextStreet();
    this.actingIndex = this.nextToAct(this.buttonIndex);
    if (this.bettingRoundComplete()) this.closeBettingRound();
    else this.emit('to-act', { seat: this.actingIndex, legal: this.legalActions() });
  }

  dealNextStreet() {
    const next = STREETS[STREETS.indexOf(this.street) + 1];
    this.street = next;
    this.deck.pop(); // burn card, as at a live table
    const drawn = next === 'flop' ? [this.deck.pop(), this.deck.pop(), this.deck.pop()] : [this.deck.pop()];
    this.board.push(...drawn);
    this.emit('street', { street: next, board: this.board.slice(), drawn });
    this.note(`${next[0].toUpperCase() + next.slice(1)}: ${this.board.length} cards`);
  }

  sweepToPot() {
    const swept = this.seats.reduce((sum, s) => sum + s.committed, 0);
    if (swept > 0) {
      this.pot += swept;
      this.emit('collect', { pot: this.pot, amount: swept });
    }
  }

  // ── showdown & payout ────────────────────────────────────────────────────

  /**
   * Split everything wagered into a main pot and any side pots, each with the
   * list of seats entitled to win it.
   */
  buildPots() {
    const contributors = this.seats.filter((s) => s.totalCommitted > 0);
    const levels = [...new Set(contributors.map((s) => s.totalCommitted))].sort((a, b) => a - b);
    const pots = [];
    let previous = 0;

    for (const level of levels) {
      let amount = 0;
      for (const seat of contributors) {
        amount += Math.min(seat.totalCommitted, level) - Math.min(seat.totalCommitted, previous);
      }
      const eligible = contributors
        .filter((s) => !s.folded && s.inHand && s.totalCommitted >= level)
        .map((s) => s.index);
      if (amount > 0 && eligible.length > 0) {
        const last = pots[pots.length - 1];
        // Fold a layer into the previous pot when the same seats are entitled to it.
        if (last && last.eligible.join() === eligible.join()) last.amount += amount;
        else pots.push({ amount, eligible });
      } else if (amount > 0 && pots.length) {
        pots[pots.length - 1].amount += amount;
      }
      previous = level;
    }
    return pots;
  }

  finishHand() {
    this.sweepToPot();
    for (const seat of this.seats) seat.committed = 0;

    const live = this.playersInHand();
    const pots = this.buildPots();
    this.pots = pots;
    const awards = [];

    if (live.length === 1) {
      // Everyone folded: the last player standing takes it without showing.
      const winner = live[0];
      const total = pots.reduce((sum, p) => sum + p.amount, 0);
      winner.chips += total;
      winner.wonThisHand += total;
      awards.push({ seat: winner.index, amount: total, potIndex: 0, showdown: false });
      this.note(`${this.says(winner, 'win')} ${chips(total)} (everyone folded)`);
    } else {
      for (const seat of live) {
        const hand = evaluate([...seat.hole, ...this.board]);
        seat.result = hand;
      }
      this.emit('showdown', {
        seats: live.map((s) => ({ seat: s.index, cards: s.hole.slice(), hand: s.result })),
        board: this.board.slice(),
      });
      for (const seat of live) this.note(`${this.says(seat, 'show')} ${seat.result.name}`);

      pots.forEach((pot, potIndex) => {
        const contenders = pot.eligible
          .map((i) => this.seats[i])
          .filter((s) => s.result);
        if (!contenders.length) return;
        const best = Math.max(...contenders.map((s) => s.result.score));
        const winners = contenders.filter((s) => s.result.score === best);
        const share = Math.floor(pot.amount / winners.length);
        let remainder = pot.amount - share * winners.length;

        // Odd chips go to the first winner clockwise from the button.
        const ordered = winners
          .slice()
          .sort((a, b) => this.seatDistanceFromButton(a.index) - this.seatDistanceFromButton(b.index));
        for (const seat of ordered) {
          let amount = share;
          if (remainder > 0) { amount++; remainder--; }
          seat.chips += amount;
          seat.wonThisHand += amount;
          awards.push({ seat: seat.index, amount, potIndex, showdown: true, hand: seat.result });
          const label = pots.length > 1 ? (potIndex === 0 ? 'main pot' : `side pot ${potIndex}`) : 'pot';
          this.note(`${this.says(seat, 'win')} ${chips(amount)} (${label}) with ${seat.result.name}`);
        }
      });
    }

    this.pot = 0;
    this.street = 'complete';
    this.handOver = true;
    this.actingIndex = -1;
    this.emit('award', { awards, pots });
    this.emit('hand-end', {
      handNumber: this.handNumber,
      awards,
      board: this.board.slice(),
      stacks: this.seats.map((s) => ({ seat: s.index, chips: s.chips })),
    });
  }

  seatDistanceFromButton(index) {
    const n = this.seats.length;
    return (index - this.buttonIndex + n) % n || n;
  }

  /** Snapshot for the UI — plain data, safe to render from. */
  snapshot({ revealAll = false } = {}) {
    return {
      handNumber: this.handNumber,
      street: this.street,
      board: this.board.slice(),
      pot: this.totalPot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      button: this.buttonIndex,
      acting: this.actingIndex,
      handOver: this.handOver,
      seats: this.seats.map((s) => ({
        index: s.index,
        id: s.id,
        name: s.name,
        chips: s.chips,
        committed: s.committed,
        folded: s.folded,
        allIn: s.allIn,
        inHand: s.inHand,
        isHuman: s.isHuman,
        lastAction: s.lastAction,
        sittingOut: s.sittingOut,
        hole: revealAll || s.isHuman ? s.hole.slice() : [],
        result: s.result,
        wonThisHand: s.wonThisHand,
      })),
    };
  }
}
