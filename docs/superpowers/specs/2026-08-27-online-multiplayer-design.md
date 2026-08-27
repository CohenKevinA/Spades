# Spades — Online Multiplayer Design

Status: approved for planning
Date: 2026-08-27

## Summary

Add a "Play online" mode to the existing single-page Spades game, alongside
the current solo-vs-bots mode (which is untouched). Up to four people join a
private room via a short room code and play the same game that exists today,
synced in real time through Firebase Firestore. Any seat not filled by a
human — at start, or after a player disconnects — is played by the existing
bot AI.

## Goals

- Play a full game of Spades with 1-4 human players in one private room.
- Reuse the existing game engine (dealing, bidding, trick rules, scoring)
  with minimal changes — it becomes the shared source of truth for local
  computation on every client, not a rewrite.
- No accounts, no sign-in screen, no server code to write or deploy.
- Keep the project buildless: no `package.json`, no bundler, no npm install.
- A disconnected player's seat is covered by a bot and can be reclaimed by
  reconnecting.

## Non-goals (explicitly out of scope for this spec)

- Public matchmaking / matching with strangers (private room codes only).
- Real user accounts, persistent stats, or cross-device identity.
- Hiding hands from a technically motivated client (see Known Limitations).
- Spectator mode, chat, rematch queues, or ranked play.
- Automated tests (no test framework exists in this project; verification is
  manual multi-tab playtesting).

## Architecture Overview

The existing game is 100% client-side with no network code
(`index.html` + `script.js` + `styles.css`, using `localStorage` for solo-game
persistence). Multiplayer adds:

- **Firebase Firestore** as the single shared data store for room/game state.
- **Firebase Anonymous Auth** for a stable per-browser identity (silent, no
  login UI), paired with a typed display name.
- No custom backend, no Cloud Functions, no billing plan required (Firestore
  + Anonymous Auth both run on Firebase's free Spark plan).

There is no server-side referee and no single "host" client responsible for
gameplay. Instead:

> **Turn-owner / race-and-transact model:** every connected client that is
> eligible to perform the next required action (a bot's move, resolving a
> completed trick, scoring a completed hand, dealing the next round) computes
> it locally using the existing game engine and attempts to write the result
> in a Firestore transaction. Firestore's transaction semantics guarantee
> exactly one write wins; the rest are silent no-ops. For a human's own
> decision (their bid, which card to play), only that player's own client
> renders the controls to act — the transaction is still used as a safety
> check, not as a race, since no other client is racing to make that
> player's choice.

This means there is no "elected host" to fail over when someone
disconnects — the mechanism that already handles bot seats (any connected
client may act on behalf of a bot-controlled seat) is the same mechanism
that covers a formerly-human seat once it's marked bot-controlled after a
disconnect. One mechanism, two triggers.

The one exception is **room creation/lobby**: the room creator's client is
the one that presses "Start," which is a single one-time action (fill empty
seats with bots, perform the initial deal) — not an ongoing responsibility,
so it doesn't reintroduce a single point of failure during play.

## Stack & Buildless Constraint

Firebase's JS SDK is loaded via its CDN-hosted ES modules
(`https://www.gstatic.com/firebasejs/.../firebase-firestore.js` etc.) using
native `<script type="module">` imports — no npm, no bundler, no
`package.json`. This preserves the project's current "open `index.html`,
no dependencies" character described in its README.

New files:

- `firebase-config.js` — Firebase project config (apiKey, projectId, etc.)
  and SDK initialization. Not secret (Firebase web config is meant to be
  public; access is controlled by Firestore security rules, not by hiding
  this file), but kept in its own file so it's easy to find/swap.
- `multiplayer.js` — room lobby flow, Firestore sync, presence/heartbeat,
  and the transaction-based action functions. Calls into the existing
  functions in `script.js` (dealing, legal-move checks, trick resolution,
  scoring) rather than duplicating that logic.

`index.html` gains new (initially hidden) overlay markup for: mode select,
create/join room, and the lobby. `styles.css` gains matching styles
consistent with the existing wood-table / overlay-card visual language.

## Data Model (Firestore)

Single collection, one document per room:

```
rooms/{roomCode}
  targetScore: number
  createdAt: timestamp
  seats: {
    you:   { uid: string|null, name: string|null, isBot: boolean, lastSeen: timestamp|null }
    left:  { ...same shape }
    top:   { ...same shape }
    right: { ...same shape }
  }
  status: "lobby" | "playing" | "gameover"
  game: {
    // mirrors the existing client-side `state` object in script.js:
    hands: { you: Card[], left: Card[], top: Card[], right: Card[] }
    bids: { you?, left?, top?, right? }
    tricksTaken: { you, left, top, right }
    teamBags: { us, them }
    teamScore: { us, them }
    round: number
    dealer: Seat
    leader: Seat
    spadesBroken: boolean
    currentTrick: { seat, card }[]
    history: HandResult[]
  }
  turn: number   // monotonic counter, incremented on every accepted write;
                 // used inside transactions to detect and reject stale writes
```

`roomCode` is a short human-shareable string (e.g. `SPD-4Q7K`), generated
client-side at room creation and used directly as the Firestore document ID.

Note the "seats" naming reuses the existing `you/left/top/right` seat
identifiers from `script.js` — from each player's own client's point of
view, their own seat is relabeled to `you` for rendering purposes (the
existing render functions already assume `you` is always the bottom seat),
while the underlying document stores a stable, non-player-relative seat
key. The mapping between "my stable seat" and "which visual position I
render it as" is a small addition, not a rewrite of the render layer.

## Room Lifecycle

1. **Create room**: generate a room code, write a new `rooms/{roomCode}`
   document in `status: "lobby"` with the creator seated, other three seats
   empty. Creator lands on the lobby screen.
2. **Join room**: enter a code; if the room exists, is still in `status:
   "lobby"`, and has an open seat, claim the first open seat for this
   player (uid + typed display name). If the room doesn't exist or is full,
   show an inline error.
3. **Lobby**: all joined clients subscribe to the room doc and see seats
   fill in live. The creator's client shows a **Start** button once at
   least one other human has joined.
4. **Start**: creator's client fills any still-empty seats with
   `isBot: true`, performs the initial deal using the existing `deal()` /
   `assignBotBids()` logic, sets `status: "playing"`, and writes it all in
   one transaction. All clients' listeners fire and move them to the table.

## Gameplay Sync

- Every client holds a live Firestore listener (`onSnapshot`) on its room
  document and re-renders (reusing the existing render functions, adapted
  for "my seat" mapping) whenever it updates.
- When it's a human's turn and it's their own seat, their client enables
  the existing card/bid UI as it does today; picking a card/bid triggers a
  transaction that checks "is it still this seat's turn" before writing —
  guards against acting on stale state (e.g. a slow client that missed a
  bot's move in between).
- Bot moves, trick resolution, hand scoring, and dealing the next round are
  each attempted by every connected client the instant their local copy of
  the state says the action is due, using a Firestore transaction as the
  single-winner arbiter (see Architecture Overview). This deliberately
  reuses one mechanism for all four cases rather than four separate ones.

## Presence & Disconnect Handling

- Each connected client writes its own seat's `lastSeen` heartbeat every
  ~10 seconds while its tab is open.
- Any other connected client treats a seat as disconnected once its
  `lastSeen` is >20 seconds stale, and flips it to `isBot: true` via a
  transaction — after which that seat is covered like any other bot seat.
- This is a plain Firestore heartbeat, not Firebase Realtime Database's
  `onDisconnect()` presence feature — chosen to keep the stack to
  Firestore + Auth only. Trade-off: detection takes up to ~20s rather than
  being near-instant. Acceptable for a casual game; noted as a possible
  future upgrade if snappier detection is ever needed.

## Reconnection

- Firebase Anonymous Auth persists the same uid for a given browser across
  reloads by default.
- On load, if `localStorage` has a remembered `{roomCode, uid}` and that
  uid still occupies a seat in that room (even if currently `isBot: true`
  after a timeout), the client rejoins that seat directly — flips it back
  to `isBot: false` and resumes play — instead of returning to the lobby.

## Known Limitations

- **Hand visibility**: because there is no server keeping secrets, the
  shared room document that every client syncs contains all four hands,
  not just the viewer's own. A technically motivated player could read
  other players' cards via browser devtools. This is an accepted trade-off
  for a friends-only, no-accounts, no-backend design (see brainstorming
  discussion) — not a bug to fix in this build. A future fix would move
  dealing and hand storage to a server-side authority (e.g. Cloud
  Functions), which was explicitly deferred as out of scope.
- **Disconnect detection lag**: up to ~20 seconds before a dropped player's
  seat is handed to a bot, due to the heartbeat-based presence approach.
- **No cheat-proofing of moves beyond legality checks already in the
  existing engine** (e.g. a client could theoretically attempt to write an
  illegal card play; the existing `getLegalIndices` logic should be
  re-checked inside the transaction, not just relied on to disable the UI
  client-side, so a tampered client can't force an illegal state through).

## Error Handling

- Room not found / room full at join time → inline error on the join
  screen, no navigation.
- Firestore transaction conflicts (the expected "losing" side of a race)
  are silent no-ops, not surfaced as errors.
- A client's own connection drops → local writes simply fail and are not
  queued for later (Firestore's offline persistence is left at its default
  disabled state, so a returning-online client doesn't replay stale
  writes); the heartbeat going stale is what drives the actual
  disconnect-handling behavior for other players.

## UI Changes

- Title overlay: add a **Play online** button next to the existing
  **Start game** button.
- New overlays: mode select → create/join room → lobby (seat list + Start),
  styled consistent with the existing `overlay-card` / wood-table look.
- In-game: seat labels show the human display name when a seat is
  human-controlled, and something like "Marcus (bot)" when bot-controlled
  (including a formerly-human seat currently covered after a disconnect).
- The existing Exit button's confirmation flow extends naturally to online
  games — exiting a solo game already resets local state; exiting an
  online game additionally means "leave the room" (this needs no new UI,
  just wiring the existing exit action to also clear the room membership).

## Testing Plan

No test framework exists in this project (no `package.json`, no build
step), and this feature is inherently a multi-client realtime integration,
so verification is manual: multiple browser profiles/tabs joining the same
room code, playing a full hand through bidding/tricks/scoring, and
exercising disconnect → bot-takeover → reconnect, the same way the recent
Exit button change was verified end-to-end in a live browser session.
