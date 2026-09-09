/**
 * The regulars at the Meridian Club. Names, tags and playing styles — the
 * flavour layer that sits on top of the bot engine.
 */
export const TABLE_ROSTER = [
  { id: 'vivienne', name: 'Vivienne Marchetti', short: 'Marchetti', initials: 'VM', title: 'Strategy Consultant', style: 'rock' },
  { id: 'ray', name: 'Ray Okafor', short: 'Okafor', initials: 'RO', title: 'Regional Director', style: 'shark' },
  { id: 'hideo', name: 'Hideo Sato', short: 'Sato', initials: 'HS', title: 'Chief Auditor', style: 'station' },
  { id: 'greta', name: 'Greta Lindqvist', short: 'Lindqvist', initials: 'GL', title: 'Venture Partner', style: 'pro' },
  { id: 'tomas', name: 'Tomas Beck', short: 'Beck', initials: 'TB', title: 'Commodities Broker', style: 'maniac' },
  { id: 'amara', name: 'Amara Diallo', short: 'Diallo', initials: 'AD', title: 'Hotel Proprietor', style: 'pro' },
];

/** Rooms the player unlocks as the chip wallet grows. */
export const LOUNGES = [
  { id: 'atrium', name: 'The Atrium', subtitle: 'Ground floor · learners welcome', smallBlind: 5, bigBlind: 10, minBuyIn: 400, maxBuyIn: 2000, unlockAt: 0 },
  { id: 'mezzanine', name: 'Mezzanine Bar', subtitle: 'First floor · casual stakes', smallBlind: 25, bigBlind: 50, minBuyIn: 2000, maxBuyIn: 10000, unlockAt: 2500 },
  { id: 'executive', name: 'Executive Lounge', subtitle: 'Ninth floor · members only', smallBlind: 100, bigBlind: 200, minBuyIn: 8000, maxBuyIn: 40000, unlockAt: 10000 },
  { id: 'penthouse', name: 'The Penthouse', subtitle: 'Rooftop · by invitation', smallBlind: 500, bigBlind: 1000, minBuyIn: 40000, maxBuyIn: 200000, unlockAt: 60000 },
];
