/**
 * The table screen: everything between the engine and the glass.
 *
 * The engine is authoritative and synchronous; this class paces it out over
 * time — bots pause to "think", cards animate in, chips slide to the pot — and
 * blocks on a promise while the human decides what to do.
 */

import { HoldemGame } from './engine.js';
import { decide, thinkingTime } from './bots.js';
import { TABLE_ROSTER } from './roster.js';
import { evaluate } from './evaluator.js';
import { RANKS, SUITS, SUIT_SYMBOLS, rankOf, suitOf } from './cards.js';
import {
  profile, equippedValue, formatChips, addChips, recordHand, FELT_THEMES,
} from './state.js';

/** Seat anchor points as a percentage of the felt. Seat 0 is the player. */
const SEAT_LAYOUT = [
  { x: 50, y: 99 },
  { x: 15, y: 70 },
  { x: 27, y: 17 },
  { x: 73, y: 17 },
  { x: 85, y: 70 },
];
const CENTER = { x: 50, y: 48 };
const lerp = (a, b, t) => a + (b - a) * t;
const towardCenter = (i, t) => ({
  x: lerp(SEAT_LAYOUT[i].x, CENTER.x, t),
  y: lerp(SEAT_LAYOUT[i].y, CENTER.y, t),
});

const PACE = { action: 340, street: 720, deal: 620, showdown: 1500, award: 1700 };

export class TableScreen {
  constructor({ onLeave, onWalletChange, toast }) {
    this.onLeave = onLeave;
    this.onWalletChange = onWalletChange;
    this.toast = toast;
    this.running = false;
    this.pendingAction = null;
    this.continueResolve = null;
    this.cardKeys = new Map();

    this.el = {
      screen: document.getElementById('screen-table'),
      felt: document.getElementById('felt'),
      seats: document.getElementById('seats'),
      board: document.getElementById('board'),
      pot: document.getElementById('pot-display'),
      potAmount: document.getElementById('pot-amount'),
      dealerMsg: document.getElementById('dealer-msg'),
      chipFx: document.getElementById('chip-fx'),
      heroCards: document.getElementById('hero-cards'),
      heroStack: document.getElementById('hero-stack'),
      heroName: document.getElementById('hero-name'),
      heroAvatar: document.getElementById('hero-avatar'),
      heroHand: document.getElementById('hero-hand'),
      actionRow: document.getElementById('action-row'),
      waitingRow: document.getElementById('waiting-row'),
      raisePanel: document.getElementById('raise-panel'),
      raiseSlider: document.getElementById('raise-slider'),
      raiseValue: document.getElementById('raise-value'),
      raiseLabel: document.getElementById('raise-label'),
      btnFold: document.getElementById('btn-fold'),
      btnCall: document.getElementById('btn-call'),
      btnRaise: document.getElementById('btn-raise'),
      btnNext: document.getElementById('btn-next-hand'),
      roomName: document.getElementById('table-room-name'),
      stakes: document.getElementById('table-stakes'),
      wallet: document.getElementById('table-wallet'),
      logPanel: document.getElementById('log-panel'),
      logLines: document.getElementById('log-lines'),
    };

    this.bindControls();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Sit down at a lounge with `buyIn` chips taken from the wallet. */
  open(lounge, buyIn) {
    this.lounge = lounge;
    this.buyIn = buyIn;
    this.el.roomName.textContent = lounge.name;
    this.el.stakes.textContent = `${formatChips(lounge.smallBlind)} / ${formatChips(lounge.bigBlind)}`;

    const bots = TABLE_ROSTER.slice(0, 4).map((bot) => ({ ...bot, chips: this.botBuyIn() }));
    this.seatStyles = ['human', ...bots.map((b) => b.style)];
    // The engine only carries id/name/chips, so the flavour stays on this side.
    this.people = [{ short: 'You', initials: 'YOU' }, ...bots];
    this.game = new HoldemGame({
      seats: [{ id: 'hero', name: 'You', chips: buyIn, isHuman: true }, ...bots],
      smallBlind: lounge.smallBlind,
      bigBlind: lounge.bigBlind,
    });

    this.applyCosmetics();
    this.buildSeats();
    this.el.logLines.replaceChildren();

    // Each sitting gets its own token. A loop left over from a previous table
    // sees a token that is no longer current and stops instead of driving the
    // new game alongside the new loop.
    const token = {};
    this.session = token;
    this.running = true;
    this.loop(token);
  }

  /** Is the loop holding this token still the one in charge? */
  alive(token) {
    return this.running && this.session === token;
  }

  /** Cash out: the stack at the table goes back into the wallet. */
  close() {
    if (!this.running) return 0;
    this.running = false;
    this.session = null;
    clearTimeout(this.continueTimer);
    clearTimeout(this.waitTimer);
    this.resolvePending(null);
    if (this.continueResolve) this.continueResolve(false);
    this.continueResolve = null;
    this.setControls('none');
    const cashed = this.game.seats[0].chips;
    addChips(cashed);
    this.onWalletChange?.();
    return cashed;
  }

  botBuyIn() {
    const { minBuyIn, maxBuyIn } = this.lounge;
    const span = maxBuyIn - minBuyIn;
    const raw = minBuyIn + Math.random() * span * 0.75;
    return Math.round(raw / this.lounge.bigBlind) * this.lounge.bigBlind;
  }

  applyCosmetics() {
    const theme = FELT_THEMES[equippedValue('felt')] ?? FELT_THEMES.emerald;
    this.el.felt.style.setProperty('--felt', theme.felt);
    this.el.felt.style.setProperty('--felt-2', theme.felt2);
    this.el.felt.style.setProperty('--felt-edge', theme.edge);
    this.cardBack = equippedValue('back');
    this.el.heroAvatar.dataset.frame = equippedValue('frame');
  }

  // ── the main loop ────────────────────────────────────────────────────────

  async loop(token) {
    while (this.alive(token)) {
      if (!this.ensureStacks()) break;
      await this.playHand(token);
      if (!this.alive(token)) break;
      const keepPlaying = await this.waitForContinue();
      if (!keepPlaying) break;
    }
  }

  /** Top players back up so there is always a game; the hero has to choose. */
  ensureStacks() {
    for (const seat of this.game.seats.slice(1)) {
      if (seat.chips <= 0) seat.chips = this.botBuyIn();
    }
    const hero = this.game.seats[0];
    if (hero.chips > 0) return true;

    const rebuy = Math.min(this.lounge.maxBuyIn, Math.max(this.lounge.minBuyIn, this.buyIn));
    if (profile.wallet >= rebuy) {
      addChips(-rebuy);
      hero.chips = rebuy;
      this.onWalletChange?.();
      this.setDealerMessage(`Rebuy — ${formatChips(rebuy)} chips`);
      return true;
    }
    this.toast?.('Not enough chips in your wallet to rebuy.');
    this.onLeave?.();
    return false;
  }

  async playHand(token) {
    this.clearTable();
    this.game.startHand();
    this.consumeEvents();
    this.render({ animateDeal: true });
    await this.wait(PACE.deal);

    while (this.alive(token) && !this.game.handOver) {
      const seat = this.game.actingSeat();
      const legal = this.game.legalActions();
      if (!seat || !legal) break;
      this.render();

      let action;
      if (seat.isHuman) {
        action = await this.awaitHumanAction(legal);
      } else {
        await this.wait(thinkingTime(this.seatStyles[seat.index]));
        if (!this.alive(token)) return;
        action = decide({ game: this.game, seat, legal, personality: this.seatStyles[seat.index] });
      }
      if (!this.alive(token) || !action) return;

      const streetBefore = this.game.street;
      this.game.act(action);
      this.consumeEvents();
      this.render();
      await this.wait(this.game.street !== streetBefore ? PACE.street : PACE.action);
    }

    if (this.alive(token)) await this.settle();
  }

  /** Turn engine events into the bits of theatre the table needs. */
  consumeEvents() {
    for (const event of this.game.drainEvents()) {
      if (event.type === 'log') this.appendLog(event.text);
      if (event.type === 'action') this.flashAction(event);
      if (event.type === 'collect' && event.amount > 0) this.flyChipsToPot();
      if (event.type === 'street') this.setDealerMessage(this.streetLabel(event.street));
    }
  }

  streetLabel(street) {
    return { preflop: '', flop: 'The flop', turn: 'The turn', river: 'The river' }[street] ?? '';
  }

  async settle() {
    const snapshot = this.game.snapshot({ revealAll: true });
    const showdown = snapshot.seats.some((s) => s.result);
    const winners = snapshot.seats.filter((s) => s.wonThisHand > 0);
    const pot = winners.reduce((sum, s) => sum + s.wonThisHand, 0);

    if (showdown) {
      this.revealAll = true;
      this.render();
      await this.wait(PACE.showdown);
    }

    for (const winner of winners) this.flyChipsToSeat(winner.index);
    const best = winners[0];
    const heroWon = winners.some((w) => w.index === 0);
    this.markWinners(winners.map((w) => w.index));

    const hand = this.game.seats[best.index].result;
    this.setDealerMessage(
      winners.length > 1
        ? `Split pot — ${formatChips(pot)}`
        : `${best.name} wins ${formatChips(best.wonThisHand)}${hand ? ` · ${hand.name}` : ''}`,
      'win',
    );
    recordHand({ won: heroWon, pot, showdown });
    this.render();
    await this.wait(PACE.award);
  }

  waitForContinue() {
    return new Promise((resolve) => {
      this.continueResolve = resolve;
      this.setControls('wait');
      // Deal on a tap, or by itself if the phone is just sitting on the table.
      const timer = setTimeout(() => this.continueHand(), 4200);
      this.continueTimer = timer;
    });
  }

  continueHand() {
    clearTimeout(this.continueTimer);
    const resolve = this.continueResolve;
    this.continueResolve = null;
    this.setControls('none');
    this.revealAll = false;
    resolve?.(true);
  }

  wait(ms) {
    return new Promise((resolve) => {
      this.waitTimer = setTimeout(resolve, ms);
    });
  }

  // ── human input ──────────────────────────────────────────────────────────

  awaitHumanAction(legal) {
    return new Promise((resolve) => {
      this.pendingAction = resolve;
      this.showActionBar(legal);
    });
  }

  resolvePending(action) {
    const resolve = this.pendingAction;
    this.pendingAction = null;
    this.hideActionBar();
    resolve?.(action);
  }

  /** Exactly one of the three control states is ever on screen. */
  setControls(mode) {
    this.el.actionRow.hidden = mode !== 'act';
    this.el.waitingRow.hidden = mode !== 'wait';
    this.el.raisePanel.hidden = mode !== 'raise';
  }

  showActionBar(legal) {
    this.legal = legal;
    this.setControls('act');

    this.el.btnCall.innerHTML = legal.canCheck
      ? 'Check'
      : `Call<span>${formatChips(legal.callAmount)}${legal.isAllInCall ? ' · all in' : ''}</span>`;
    this.el.btnRaise.innerHTML = legal.canRaise
      ? (legal.isOpeningBet ? 'Bet' : 'Raise')
      : 'Raise';
    this.el.btnRaise.disabled = !legal.canRaise;
    this.el.btnFold.disabled = false;

    this.el.raiseLabel.textContent = legal.isOpeningBet ? 'Bet' : 'Raise to';
    if (legal.canRaise) {
      const step = Math.max(1, Math.round(this.lounge.bigBlind / 2));
      this.el.raiseSlider.min = String(legal.minRaiseTo);
      this.el.raiseSlider.max = String(legal.maxRaiseTo);
      this.el.raiseSlider.step = String(step);
      this.setRaiseValue(Math.min(legal.maxRaiseTo, this.suggestedRaise(legal)));
    }
  }

  hideActionBar() {
    this.legal = null;
    this.setControls('none');
  }

  suggestedRaise(legal) {
    const potRaise = legal.committed + legal.toCall + (legal.pot + legal.toCall) * 0.6;
    return this.snapRaise(Math.max(legal.minRaiseTo, Math.round(potRaise)), legal);
  }

  snapRaise(value, legal) {
    const step = Math.max(1, Math.round(this.lounge.bigBlind / 2));
    const snapped = Math.round(value / step) * step;
    return Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, snapped));
  }

  setRaiseValue(value) {
    this.raiseTo = value;
    this.el.raiseSlider.value = String(value);
    const allIn = value >= this.legal.maxRaiseTo;
    this.el.raiseValue.textContent = allIn ? `${formatChips(value)} · all in` : formatChips(value);
  }

  bindControls() {
    const { el } = this;

    // Every handler checks that a decision is actually pending: taps can land
    // after the bar is hidden, and a stale action would desync the engine.
    el.btnFold.addEventListener('click', () => {
      if (this.pendingAction) this.resolvePending({ type: 'fold' });
    });
    el.btnCall.addEventListener('click', () => {
      if (!this.pendingAction || !this.legal) return;
      this.resolvePending({ type: this.legal.canCheck ? 'check' : 'call' });
    });

    el.btnRaise.addEventListener('click', () => {
      if (!this.pendingAction || !this.legal?.canRaise) return;
      this.setControls('raise');
    });
    document.getElementById('btn-raise-cancel').addEventListener('click', () => {
      this.setControls('act');
    });
    document.getElementById('btn-raise-confirm').addEventListener('click', () => {
      if (!this.pendingAction || !this.legal) return;
      const amount = this.raiseTo;
      this.resolvePending(
        amount >= this.legal.maxRaiseTo ? { type: 'allin' } : { type: 'raise', amount },
      );
    });
    el.raiseSlider.addEventListener('input', () => this.setRaiseValue(Number(el.raiseSlider.value)));

    for (const button of document.querySelectorAll('[data-raise]')) {
      button.addEventListener('click', () => {
        const legal = this.legal;
        if (!legal || !this.pendingAction) return;
        const potAfterCall = legal.pot + legal.toCall;
        const base = legal.committed + legal.toCall;
        const targets = {
          min: legal.minRaiseTo,
          half: base + potAfterCall * 0.5,
          pot: base + potAfterCall,
          max: legal.maxRaiseTo,
        };
        this.setRaiseValue(this.snapRaise(Math.round(targets[button.dataset.raise]), legal));
      });
    }

    el.btnNext.addEventListener('click', () => this.continueHand());

    document.getElementById('btn-log').addEventListener('click', () => {
      el.logPanel.hidden = !el.logPanel.hidden;
      el.logLines.scrollTop = el.logLines.scrollHeight;
    });
    document.getElementById('btn-log-close').addEventListener('click', () => {
      el.logPanel.hidden = true;
    });
  }

  // ── rendering ────────────────────────────────────────────────────────────

  buildSeats() {
    this.el.seats.replaceChildren();
    this.seatEls = [];

    for (const seat of this.game.seats) {
      if (seat.index === 0) { this.seatEls.push(null); continue; } // the hero lives in the bar below
      const node = document.createElement('div');
      node.className = 'seat';
      node.style.left = `${SEAT_LAYOUT[seat.index].x}%`;
      node.style.top = `${SEAT_LAYOUT[seat.index].y}%`;
      node.innerHTML = `
        <div class="seat-cards"></div>
        <div class="seat-plate">
          <div class="seat-timer"></div>
          <div class="avatar">${this.people[seat.index].initials}</div>
          <div class="seat-meta">
            <span class="seat-name">${this.people[seat.index].short}</span>
            <span class="seat-stack">0</span>
          </div>
        </div>`;
      this.el.seats.appendChild(node);
      this.seatEls.push(node);
    }

    this.dealerButton = document.createElement('div');
    this.dealerButton.className = 'dealer-button';
    this.dealerButton.textContent = 'D';
    this.el.seats.appendChild(this.dealerButton);

    this.betEls = this.game.seats.map((seat) => {
      const node = document.createElement('div');
      node.className = 'seat-bet';
      const spot = towardCenter(seat.index, 0.5);
      node.style.left = `${spot.x}%`;
      node.style.top = `${spot.y}%`;
      node.hidden = true;
      this.el.seats.appendChild(node);
      return node;
    });
  }

  clearTable() {
    this.revealAll = false;
    this.el.board.replaceChildren();
    this.el.dealerMsg.textContent = '';
    this.el.dealerMsg.classList.remove('win');
    this.cardKeys.clear();
    for (const node of this.seatEls) node?.classList.remove('winner', 'folded');
    for (const node of this.el.seats.querySelectorAll('.seat-action')) node.remove();
  }

  render({ animateDeal = false } = {}) {
    const state = this.game.snapshot({ revealAll: this.revealAll });

    // pot
    this.el.pot.hidden = state.pot <= 0;
    this.el.potAmount.textContent = formatChips(state.pot);

    // community cards
    this.renderCardRow(this.el.board, state.board, { key: 'board' });

    // dealer button, nudged sideways so it never covers a seat's cards
    const spot = towardCenter(state.button, 0.26);
    const seatX = SEAT_LAYOUT[state.button].x;
    const nudge = seatX === 50 ? 25 : seatX < 50 ? 7 : -7;
    this.dealerButton.style.left = `${spot.x + nudge}%`;
    this.dealerButton.style.top = `${state.button === 0 ? 84 : spot.y}%`;

    for (const seat of state.seats) {
      const node = this.seatEls[seat.index];
      const bet = this.betEls[seat.index];

      if (seat.committed > 0) {
        bet.hidden = false;
        bet.innerHTML = `<span class="bet-chip"><span class="chip-dot"></span><span>${formatChips(seat.committed)}</span></span>`;
      } else {
        bet.hidden = true;
      }

      if (seat.index === 0) { this.renderHero(seat, state, animateDeal); continue; }

      node.classList.toggle('acting', state.acting === seat.index && !state.handOver);
      node.classList.toggle('folded', seat.folded || !seat.inHand);
      const isAllIn = seat.allIn && seat.chips === 0;
      node.querySelector('.seat-stack').textContent = isAllIn ? 'ALL IN' : formatChips(seat.chips);
      node.querySelector('.seat-stack').classList.toggle('allin', isAllIn);
      node.querySelector('.avatar').dataset.frame = 'none';

      const cards = seat.inHand && !seat.folded
        ? (seat.hole.length ? seat.hole : [null, null])
        : [];
      this.renderCardRow(node.querySelector('.seat-cards'), cards, {
        key: `seat${seat.index}`,
        faceDown: !this.revealAll,
        highlight: this.revealAll && seat.result ? seat.result.cards : null,
        animate: animateDeal,
      });
    }
  }

  renderHero(seat, state, animateDeal) {
    this.el.heroStack.textContent = formatChips(seat.chips);
    this.el.wallet.textContent = formatChips(profile.wallet);
    this.renderCardRow(this.el.heroCards, seat.hole, {
      key: 'hero',
      faceDown: false,
      highlight: seat.result ? seat.result.cards : null,
      dim: seat.folded,
      animate: animateDeal,
    });

    // Name the hero's current hand as soon as there is a board to read.
    if (seat.hole.length === 2 && !seat.folded) {
      const known = [...seat.hole, ...state.board];
      this.el.heroHand.textContent = known.length >= 5 ? evaluate(known).name : holeLabel(seat.hole);
    } else {
      this.el.heroHand.textContent = seat.folded ? 'Folded' : '';
    }
  }

  /**
   * Render a row of cards, reusing the DOM when the cards have not changed so
   * that deal animations only fire on genuinely new cards.
   */
  renderCardRow(container, cards, { key, faceDown = false, highlight = null, dim = false, animate = false } = {}) {
    const signature = `${cards.map((c) => (c === null ? 'x' : c)).join(',')}|${faceDown}|${highlight ? highlight.join(',') : ''}|${dim}`;
    if (this.cardKeys.get(key) === signature) return;
    const previous = this.cardKeys.get(key) ?? '';
    this.cardKeys.set(key, signature);

    const existing = container.children.length;
    container.replaceChildren();

    cards.forEach((card, i) => {
      const node = card === null || faceDown
        ? backEl(this.cardBack)
        : faceEl(card);
      if (highlight && card !== null && !faceDown) {
        node.classList.toggle('highlight', highlight.includes(card));
        node.classList.toggle('dim', !highlight.includes(card));
      }
      if (dim) node.classList.add('dim');
      // Only stagger cards that were not on the table a moment ago.
      const isNew = animate || i >= existing || !previous;
      if (isNew) node.style.animationDelay = `${i * 90}ms`;
      else node.style.animation = 'none';
      container.appendChild(node);
    });
  }

  flashAction({ seat, action, to, allIn }) {
    const node = this.seatEls[seat];
    if (!node) return;
    node.querySelector('.seat-action')?.remove();
    const badge = document.createElement('div');
    badge.className = 'seat-action';
    badge.dataset.kind = allIn ? 'allin' : action;
    badge.textContent = allIn ? 'All in'
      : action === 'raise' ? `Raise ${formatChips(to)}`
      : action === 'bet' ? `Bet ${formatChips(to)}`
      : action === 'call' ? 'Call'
      : action === 'check' ? 'Check' : 'Fold';
    node.querySelector('.seat-plate').appendChild(badge);
    setTimeout(() => badge.remove(), 2200);
  }

  markWinners(indices) {
    for (const index of indices) this.seatEls[index]?.classList.add('winner');
  }

  setDealerMessage(text, tone = '') {
    this.el.dealerMsg.textContent = text;
    this.el.dealerMsg.classList.toggle('win', tone === 'win');
  }

  /** Chips sliding from each live bet into the middle. */
  flyChipsToPot() {
    for (const seat of this.game.seats) {
      const from = towardCenter(seat.index, 0.5);
      this.launchChip(from, CENTER);
    }
  }

  flyChipsToSeat(index) {
    for (let i = 0; i < 4; i++) {
      setTimeout(() => this.launchChip(CENTER, towardCenter(index, 0.34)), i * 70);
    }
  }

  launchChip(from, to) {
    const chip = document.createElement('div');
    chip.className = 'flying-chip';
    chip.style.left = `${from.x}%`;
    chip.style.top = `${from.y}%`;
    this.el.chipFx.appendChild(chip);
    requestAnimationFrame(() => {
      chip.style.left = `${to.x}%`;
      chip.style.top = `${to.y}%`;
      chip.style.opacity = '0.15';
    });
    setTimeout(() => chip.remove(), 520);
  }

  // ── hand history ─────────────────────────────────────────────────────────

  appendLog(text, cls = '') {
    const line = document.createElement('li');
    line.textContent = text;
    if (cls) line.className = cls;
    else if (/wins/.test(text)) line.className = 'win';
    this.el.logLines.appendChild(line);
    while (this.el.logLines.children.length > 220) this.el.logLines.firstChild.remove();
    this.el.logLines.scrollTop = this.el.logLines.scrollHeight;
  }
}

// ── card elements ──────────────────────────────────────────────────────────

function faceEl(card) {
  const node = document.createElement('div');
  const rank = RANKS[rankOf(card)];
  const suit = SUITS[suitOf(card)];
  node.className = 'card';
  node.dataset.suit = suit;
  node.dataset.index = rank;
  node.innerHTML = `<span class="rank">${rank}</span><span class="pip">${SUIT_SYMBOLS[suit]}</span>`;
  return node;
}

function backEl(back) {
  const node = document.createElement('div');
  node.className = 'card back';
  node.dataset.back = back ?? 'club';
  return node;
}

/** 'Ace-King suited', for the line under the hero's cards before the flop. */
function holeLabel(hole) {
  if (hole.length !== 2) return '';
  const [a, b] = hole;
  const names = [rankOf(a), rankOf(b)].sort((x, y) => y - x).map((r) => RANKS[r]);
  if (names[0] === names[1]) return `Pocket ${names[0]}s`;
  return `${names[0]}-${names[1]} ${suitOf(a) === suitOf(b) ? 'suited' : 'offsuit'}`;
}
