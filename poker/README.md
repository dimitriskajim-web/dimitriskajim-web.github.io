# Meridian Club — Poker

A mobile-first No-Limit Texas Hold'em client themed as a private card room inside
a business hotel: ink and charcoal, walnut panelling, brass fittings, cream
stationery. This is the first slice — a working five-handed table with real
Hold'em rules and bot opponents — built so the lobby, the multiplayer backend and
the store can be layered on without rewriting the game.

Play it at `/poker/` (e.g. `https://dimitriskajim-web.github.io/poker/`).

## What works today

- **Five-handed No-Limit Hold'em.** Blinds, dealer button rotation, four betting
  rounds, min-raise rules, short all-in raises that do not reopen betting,
  side pots, split pots, odd chips awarded left of the button.
- **A complete hand evaluator.** Any five of seven cards, all nine categories,
  correct kickers, and the wheel scored as a five-high straight.
- **Four bot opponents with distinct styles.** Each estimates its equity by
  Monte-Carlo rollout, compares it against the pot odds, discounts for how much
  is being asked of it, and then bends the answer through a personality.
- **Lobby gated by chip wallet.** Four rooms from The Atrium (5/10) to The
  Penthouse (500/1000); a room unlocks when the wallet can cover it.
- **A cashier.** Chip packages are a storefront preview; collectibles — card
  backs, table cloths, avatar frames — are bought with chips and equip for real.
- **Offline-capable PWA.** Manifest, icons, service worker, safe-area insets,
  portrait lock.

## Not built yet

Real multiplayer (the engine is deliberately transport-agnostic — see below),
Play Billing, accounts, tournaments, and a turn clock.

## Layout

```
poker/
├── index.html              three screens: lobby, table, cashier
├── css/theme.css           tokens, typography, cards, chips, buttons
├── css/table.css           screens, felt, seats, animation
├── js/cards.js             deck, seeded shuffle, card encoding
├── js/evaluator.js         five-of-seven hand evaluator
├── js/engine.js            the rules — a synchronous state machine
├── js/bots.js              equity estimation and bot decisions
├── js/roster.js            the regulars, and the rooms they play in
├── js/state.js             wallet, collectibles, stats (localStorage)
├── js/table.js             table screen: paces the engine, animates, takes input
├── js/app.js               shell: navigation, lobby, cashier
└── test/                   test suite and a printable gameplay simulation
```

### Why the engine looks like this

`HoldemGame` never waits, never renders and never asks a bot anything. The caller
asks who is to act, gets that seat's legal actions, and calls `act()`:

```js
const game = new HoldemGame({ seats, smallBlind: 25, bigBlind: 50 });
game.startHand();
while (!game.handOver) {
  const seat = game.actingSeat();
  game.act(decide(seat, game.legalActions()));
}
```

That is what makes the same code testable in Node, playable in the browser, and
movable to a server later: the multiplayer version replaces the loop, not the
rules. Everything the UI needs to animate comes out of `drainEvents()`, and
`snapshot()` returns plain data with opponents' hole cards stripped out — the
same shape a server would send down a socket.

## Running it

```bash
cd poker
npm run serve      # http://localhost:4173  (any static server works)
npm test           # 63 checks: evaluator, betting rules, side pots, 600 simulated hands
npm run sim        # a readable transcript of five hands at the table
node test/simulate.js 20 12345   # 20 hands from a fixed seed
```

The tests cover hand ranking against known orderings, 5,000 random hands checked
for self-consistency, blind posting and action order, the big blind's option,
min-raise clamping, side pots across three unequal all-ins, chopped pots, odd-chip
distribution, and 600 bot-vs-bot hands asserting that no chips are created or
destroyed and that no betting round fails to terminate.

## Packaging for Google Play

The app is already a PWA, so the shortest path is a Trusted Web Activity:

1. Host it over HTTPS (GitHub Pages already does).
2. `npx @bubblewrap/cli init --manifest https://<host>/poker/manifest.webmanifest`
3. `npx @bubblewrap/cli build` → signed `.aab` for the Play Console.
4. Publish `.well-known/assetlinks.json` at the domain root so the address bar
   is hidden.

Capacitor is the alternative if native plugins are needed (Play Billing, push,
Play Games sign-in) — `npx cap add android` with this folder as `webDir`.

Before a store build:

- **Self-host the fonts.** Cormorant Garamond and Inter currently come from
  Google Fonts; a packaged app should ship them locally so it works offline and
  makes no third-party request on launch.
- Bump `CACHE` in `sw.js` on every release, or clients keep the old bundle.
- Play requires a content rating questionnaire for card games, and a "simulated
  gambling" disclosure. There are no real-money payouts here, which keeps it out
  of the real-money gambling policy.

## House rules the engine implements

- A raise must be at least the size of the previous raise; an all-in for less
  than that does not reopen betting for players who have already acted.
- A player all-in for less than a call is still eligible for the portion of the
  pot they paid for; the remainder becomes a side pot contested by the rest.
- Uncalled bets return to the bettor (they fall out as a one-player side pot).
- Odd chips in a split go to the first winner clockwise from the button.
- Everyone folding wins the pot without a showdown, and no cards are shown.
