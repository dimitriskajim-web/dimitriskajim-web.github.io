/**
 * Player profile: chip wallet, owned collectibles, lifetime stats.
 *
 * Everything lives in localStorage for now. When the app moves to a real
 * backend this is the one module that has to change — the rest of the app only
 * ever touches `profile` through these helpers.
 */

const KEY = 'meridian.profile.v1';
const STARTING_WALLET = 10000;

const DEFAULT_PROFILE = {
  wallet: STARTING_WALLET,
  owned: ['back-club', 'felt-emerald'],
  equipped: { back: 'back-club', felt: 'felt-emerald', frame: 'frame-none' },
  stats: { handsPlayed: 0, handsWon: 0, showdownsWon: 0, biggestPot: 0 },
  lastLounge: 'mezzanine',
};

export const CHIP_PACKS = [
  { id: 'pack-1', chips: 5000, price: '$1.99', name: 'Nightcap' },
  { id: 'pack-2', chips: 27500, price: '$8.99', name: 'Turndown', bonus: '+10%' },
  { id: 'pack-3', chips: 80000, price: '$19.99', name: 'Suite', bonus: '+25%', featured: true },
  { id: 'pack-4', chips: 250000, price: '$49.99', name: 'Penthouse', bonus: '+40%' },
];

export const COLLECTIBLES = [
  { id: 'back-club', slot: 'back', value: 'club', name: 'Club Standard', blurb: 'House deck', cost: 0 },
  { id: 'back-oxblood', slot: 'back', value: 'oxblood', name: 'Oxblood', blurb: 'Library red', cost: 4000 },
  { id: 'back-ivory', slot: 'back', value: 'ivory', name: 'Ivory Stock', blurb: 'Letterpress cream', cost: 6500 },
  { id: 'back-midnight', slot: 'back', value: 'midnight', name: 'Midnight', blurb: 'Late check-in', cost: 9000 },
  { id: 'felt-emerald', slot: 'felt', value: 'emerald', name: 'Emerald Baize', blurb: 'House cloth', cost: 0 },
  { id: 'felt-navy', slot: 'felt', value: 'navy', name: 'Boardroom Navy', blurb: 'Ninth floor', cost: 5000 },
  { id: 'felt-cocoa', slot: 'felt', value: 'cocoa', name: 'Cocoa Suede', blurb: 'Cigar lounge', cost: 7500 },
  { id: 'frame-none', slot: 'frame', value: 'none', name: 'No Frame', blurb: 'Plain plate', cost: 0 },
  { id: 'frame-brass', slot: 'frame', value: 'brass', name: 'Brass Frame', blurb: 'Member since', cost: 12000 },
  { id: 'frame-silver', slot: 'frame', value: 'silver', name: 'Silver Frame', blurb: 'Concierge tier', cost: 20000 },
];

/** Felt palettes, keyed by the collectible's `value`. */
export const FELT_THEMES = {
  emerald: { felt: '#17362f', felt2: '#0f2620', edge: '#0a1a16' },
  navy: { felt: '#1a2740', felt2: '#111a2c', edge: '#0a1220' },
  cocoa: { felt: '#392a22', felt2: '#271c16', edge: '#19100c' },
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_PROFILE);
    const saved = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_PROFILE),
      ...saved,
      equipped: { ...DEFAULT_PROFILE.equipped, ...(saved.equipped ?? {}) },
      stats: { ...DEFAULT_PROFILE.stats, ...(saved.stats ?? {}) },
    };
  } catch {
    // A corrupt or unavailable store should never stop someone playing.
    return structuredClone(DEFAULT_PROFILE);
  }
}

export const profile = load();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch { /* private mode, quota — the session still plays fine */ }
}

export function addChips(amount) {
  profile.wallet = Math.max(0, Math.round(profile.wallet + amount));
  save();
  return profile.wallet;
}

export function owns(id) {
  return profile.owned.includes(id);
}

export function buy(id) {
  const item = COLLECTIBLES.find((c) => c.id === id);
  if (!item || owns(id) || profile.wallet < item.cost) return false;
  profile.wallet -= item.cost;
  profile.owned.push(id);
  save();
  return true;
}

export function equip(id) {
  const item = COLLECTIBLES.find((c) => c.id === id);
  if (!item || !owns(id)) return false;
  profile.equipped[item.slot] = id;
  save();
  return true;
}

/** The `value` of whatever is equipped in a slot, e.g. 'oxblood'. */
export function equippedValue(slot) {
  const item = COLLECTIBLES.find((c) => c.id === profile.equipped[slot]);
  return item ? item.value : COLLECTIBLES.find((c) => c.slot === slot).value;
}

export function recordHand({ won, pot, showdown }) {
  profile.stats.handsPlayed++;
  if (won) profile.stats.handsWon++;
  if (won && showdown) profile.stats.showdownsWon++;
  profile.stats.biggestPot = Math.max(profile.stats.biggestPot, pot);
  save();
}

export function resetProfile() {
  Object.assign(profile, structuredClone(DEFAULT_PROFILE));
  save();
}

export const formatChips = (n) => Math.round(n).toLocaleString('en-US');
