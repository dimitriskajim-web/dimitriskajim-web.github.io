/**
 * App shell: lobby, cashier and navigation between the three screens.
 */

import { LOUNGES } from './roster.js';
import { TableScreen } from './table.js';
import {
  profile, save, buy, equip, owns, addChips, resetProfile, formatChips,
  CHIP_PACKS, COLLECTIBLES, FELT_THEMES,
} from './state.js';

const screens = {
  lobby: document.getElementById('screen-lobby'),
  table: document.getElementById('screen-table'),
  store: document.getElementById('screen-store'),
};

let current = 'lobby';

function show(name) {
  if (name === current) return;
  if (current === 'table' && name !== 'table') {
    const cashed = table.close();
    if (cashed > 0) toast(`Cashed out ${formatChips(cashed)} chips`);
  }
  for (const [key, node] of Object.entries(screens)) node.classList.toggle('is-active', key === name);
  current = name;
  refreshWallet();
  if (name === 'lobby') renderLounges();
  if (name === 'store') renderStore();
}

// ── wallet ───────────────────────────────────────────────────────────────────
function refreshWallet() {
  const text = formatChips(profile.wallet);
  for (const id of ['lobby-wallet', 'table-wallet', 'store-wallet']) {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  }
}

// ── lobby ────────────────────────────────────────────────────────────────────
function renderLounges() {
  const list = document.getElementById('lounge-list');
  list.replaceChildren();

  LOUNGES.forEach((lounge, floor) => {
    const locked = profile.wallet < Math.max(lounge.unlockAt, lounge.minBuyIn);
    const node = document.createElement('button');
    node.className = `lounge${locked ? ' locked' : ''}`;
    node.type = 'button';
    node.disabled = locked;
    node.innerHTML = `
      <span class="lounge-floor">${floor + 1}</span>
      <span class="lounge-body">
        <strong>${lounge.name}</strong>
        <span>${locked
          ? `Unlocks at ${formatChips(Math.max(lounge.unlockAt, lounge.minBuyIn))} chips`
          : lounge.subtitle}</span>
      </span>
      <span class="lounge-stakes">${formatChips(lounge.smallBlind)}/${formatChips(lounge.bigBlind)}
        <small>buy-in ${formatChips(lounge.minBuyIn)}</small></span>`;
    if (!locked) node.addEventListener('click', () => sitDown(lounge));
    list.appendChild(node);
  });
}

function sitDown(lounge) {
  // Sit with the table maximum where the wallet allows it, never less than the
  // minimum — a short stack at a big table is not a good first impression.
  const buyIn = Math.min(lounge.maxBuyIn, Math.max(lounge.minBuyIn, Math.floor(profile.wallet * 0.4)));
  if (profile.wallet < buyIn) {
    toast('Not enough chips for that room.');
    return;
  }
  addChips(-buyIn);
  profile.lastLounge = lounge.id;
  save();
  show('table');
  table.open(lounge, buyIn);
  refreshWallet();
}

// ── cashier ──────────────────────────────────────────────────────────────────
function renderStore() {
  const packs = document.getElementById('pack-grid');
  packs.replaceChildren();
  for (const pack of CHIP_PACKS) {
    const node = document.createElement('div');
    node.className = `pack${pack.featured ? ' featured' : ''}`;
    node.innerHTML = `
      ${pack.bonus ? `<span class="pack-bonus">${pack.bonus} bonus</span>` : ''}
      <span class="pack-amount">${formatChips(pack.chips)}</span>
      <span class="pack-name">${pack.name}</span>
      <button class="btn btn-quiet btn-sm" disabled>${pack.price}</button>`;
    packs.appendChild(node);
  }

  const grid = document.getElementById('collectible-grid');
  grid.replaceChildren();
  for (const item of COLLECTIBLES) {
    const isOwned = owns(item.id);
    const isEquipped = profile.equipped[item.slot] === item.id;
    const node = document.createElement('div');
    node.className = `collectible${isOwned ? ' owned' : ''}${isEquipped ? ' equipped' : ''}`;
    node.innerHTML = `
      <div class="collectible-preview">${previewMarkup(item)}</div>
      <strong>${item.name}</strong>
      <small>${item.blurb}</small>
      <button class="btn btn-sm ${isEquipped ? 'btn-quiet' : isOwned ? 'btn-brass' : 'btn-quiet'}"
        ${isEquipped ? 'disabled' : ''}>
        ${isEquipped ? 'Equipped' : isOwned ? 'Equip' : `${formatChips(item.cost)} chips`}
      </button>`;
    node.querySelector('button').addEventListener('click', () => {
      if (isOwned) {
        equip(item.id);
        toast(`${item.name} equipped`);
      } else if (buy(item.id)) {
        equip(item.id);
        toast(`${item.name} purchased`);
      } else {
        toast('Not enough chips.');
        return;
      }
      renderStore();
      refreshWallet();
    });
    grid.appendChild(node);
  }
}

function previewMarkup(item) {
  if (item.slot === 'back') {
    return `<div class="card back" data-back="${item.value}" style="--card-w:38px"></div>`;
  }
  if (item.slot === 'felt') {
    const theme = FELT_THEMES[item.value];
    return `<div style="width:100%;height:100%;border-radius:9px;
      background:radial-gradient(120% 90% at 50% 40%, ${theme.felt}, ${theme.felt2} 70%, ${theme.edge});
      box-shadow:inset 0 0 0 1px rgba(201,162,74,0.3)"></div>`;
  }
  return `<div class="avatar" data-frame="${item.value}" style="width:42px;height:42px">MC</div>`;
}

// ── toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2400);
}

// ── wiring ───────────────────────────────────────────────────────────────────
const table = new TableScreen({
  onLeave: () => show('lobby'),
  onWalletChange: refreshWallet,
  toast,
});

document.getElementById('btn-leave').addEventListener('click', () => show('lobby'));
for (const button of document.querySelectorAll('[data-goto]')) {
  button.addEventListener('click', () => show(button.dataset.goto));
}
document.getElementById('btn-reset-progress').addEventListener('click', () => {
  resetProfile();
  refreshWallet();
  renderLounges();
  toast('Progress reset');
});

// A blank wallet with nowhere to go would soft-lock the app.
if (profile.wallet < LOUNGES[0].minBuyIn) {
  addChips(LOUNGES[0].minBuyIn * 5);
  toast('The house has staked you back in.');
}

refreshWallet();
renderLounges();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
