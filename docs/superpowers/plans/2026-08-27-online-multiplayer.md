# Spades Online Multiplayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Play online" mode to the existing Spades game so 1-4 people can play a real game together over the internet via private room codes, reusing the existing solo game engine and bot AI.

**Architecture:** A new buildless ES-module file (`multiplayer.js`) talks to Firebase Firestore (state) and Anonymous Auth (identity), and drives the *existing* `script.js` render functions by mirroring a per-viewer "local view" of the shared room document into the same `state`/`els` objects `script.js` already renders from. No dedicated host client: every connected client races to perform the next due system action (bot move, trick resolution, hand scoring, dealing) inside a Firestore transaction, which arbitrates exactly one winner.

**Tech Stack:** Vanilla JS, Firebase JS SDK v10 (Firestore + Anonymous Auth) loaded via CDN ES modules, no npm/bundler/test framework — matches the existing project.

**Spec:** `docs/superpowers/specs/2026-08-27-online-multiplayer-design.md`

## Global Constraints

- No `package.json`, no bundler, no npm install — Firebase SDK loads via `<script type="module">` importing directly from `https://www.gstatic.com/firebasejs/10.12.2/...`.
- No Cloud Functions, no Firebase Blaze (paid) plan — Firestore + Anonymous Auth only, both on the free Spark plan.
- Solo mode (`script.js`'s existing behavior) must keep working unchanged; every task that touches `script.js` ends with a manual regression check of a full solo hand.
- Private room codes only — no public matchmaking, no real accounts, no chat/spectator/rematch features (all explicitly out of scope per the spec).
- Team pairing is always the two seats directly across the table from each other; the shared Firestore document must store team totals under a viewer-independent key (`ns`/`ew`), never under viewer-relative `us`/`them` labels, since those are only meaningful to one viewer at a time.
- Hands are visible to any client inspecting network traffic/devtools — this is an accepted, documented trade-off (see spec "Known Limitations"), not a bug to fix here.

---

## Prerequisites (human action — do this before Task 1)

These steps can't be done by an engineer working in this repo; they require a Google account and the Firebase console.

1. Go to https://console.firebase.google.com, create a new project (any name, e.g. "spades-online"). Google Analytics is not needed — you can decline it.
2. In the project, open **Build → Firestore Database → Create database**. Choose **production mode** and any nearby region.
3. Open **Build → Authentication → Get started**, then enable the **Anonymous** sign-in provider (Sign-in method tab → Anonymous → Enable → Save).
4. Open **Firestore Database → Rules**, replace the contents with the rules below, and click **Publish**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       // Any signed-in (including anonymous) user may read/write any room.
       // This project's trust model is "private room code shared with
       // friends" (see spec Known Limitations) — there is intentionally
       // no per-field cheat-proofing here.
       match /rooms/{roomCode} {
         allow read, update: if request.auth != null;
         allow create: if request.auth != null
           && request.resource.data.status == 'lobby';
         allow delete: if false;
       }
     }
   }
   ```

5. Open **Project settings** (gear icon) → scroll to **Your apps** → click the **Web** icon (`</>`) → register an app (any nickname, no Firebase Hosting needed). Copy the `firebaseConfig` object it shows you (looks like `{ apiKey: "...", authDomain: "...", projectId: "...", ... }`) — you'll paste this into `firebase-config.js` in Task 2.

Keep that config object handy; Task 2 has a placeholder for it.

---

### Task 1: Extract reusable pure functions in `script.js`

The existing engine functions are almost all already reusable as-is, but a few read the global `state` object directly or hardcode the solo-mode `'us'`/`'them'` team labels. This task makes them accept their inputs as parameters instead, with solo mode's existing call sites updated to pass the same global values they used implicitly before — solo behavior is unchanged, but the functions become callable by `multiplayer.js` with a different (room-seat) shape of data later.

**Files:**
- Modify: `script.js`

**Interfaces:**
- Produces (used by later tasks): `determineWinner(currentTrick)`, `computeTeamResult(teamSeats, bids, tricksTaken)`, `decideGameWinner(teamScore, targetScore)`, `computeBotBid(hand)`, `chooseBotCardIndex(hand, trick, isLeading, ledSuit, spadesBroken)`.
- Produces: `window.Spades = { state, els, ORDER, NAMES, SUITS }` — a bridge object. (Every top-level `function` declaration in `script.js`, e.g. `renderAllHands`, `getLegalIndices`, `buildDeck`, `shuffle`, `cardSort`, is *already* reachable as `window.functionName` — that's how classic `<script>` top-level function declarations work. Only the `const`-bound data below needs an explicit bridge, since `const` does not attach to `window`.)

- [ ] **Step 1: Parameterize `determineWinner`**

  In `script.js`, replace:
  ```js
  function determineWinner() {
    const ledSuit = state.currentTrick[0].card.suit;
    const spadesPlayed = state.currentTrick.filter((p) => p.card.suit === '♠');
    const contenders = spadesPlayed.length ? spadesPlayed : state.currentTrick.filter((p) => p.card.suit === ledSuit);
    return contenders.reduce((best, p) => (p.card.value > best.card.value ? p : best), contenders[0]).seat;
  }
  ```
  with:
  ```js
  function determineWinner(currentTrick) {
    const ledSuit = currentTrick[0].card.suit;
    const spadesPlayed = currentTrick.filter((p) => p.card.suit === '♠');
    const contenders = spadesPlayed.length ? spadesPlayed : currentTrick.filter((p) => p.card.suit === ledSuit);
    return contenders.reduce((best, p) => (p.card.value > best.card.value ? p : best), contenders[0]).seat;
  }
  ```
  Then update its one call site inside `resolveTrickFlow`:
  ```js
  const winner = determineWinner();
  ```
  becomes:
  ```js
  const winner = determineWinner(state.currentTrick);
  ```

- [ ] **Step 2: Parameterize `computeTeamResult`**

  Replace:
  ```js
  function computeTeamResult(teamSeats) {
    const nilSeats = teamSeats.filter((s) => state.bids[s] === 'nil');
    const nonNilSeats = teamSeats.filter((s) => state.bids[s] !== 'nil');
    const teamBid = nonNilSeats.reduce((sum, s) => sum + state.bids[s], 0);
    const teamTricks = nonNilSeats.reduce((sum, s) => sum + state.tricksTaken[s], 0);
    const met = teamTricks >= teamBid;

    let base = met ? teamBid * 10 : -teamBid * 10;
    let bags = met ? teamTricks - teamBid : 0;

    nilSeats.forEach((s) => {
      const madeNil = state.tricksTaken[s] === 0;
      base += madeNil ? 100 : -100;
      if (!madeNil) bags += state.tricksTaken[s];
    });

    const books = teamTricks + nilSeats.reduce((sum, s) => sum + state.tricksTaken[s], 0);

    return { base, bags, bid: teamBid, books };
  }
  ```
  with:
  ```js
  function computeTeamResult(teamSeats, bids, tricksTaken) {
    const nilSeats = teamSeats.filter((s) => bids[s] === 'nil');
    const nonNilSeats = teamSeats.filter((s) => bids[s] !== 'nil');
    const teamBid = nonNilSeats.reduce((sum, s) => sum + bids[s], 0);
    const teamTricks = nonNilSeats.reduce((sum, s) => sum + tricksTaken[s], 0);
    const met = teamTricks >= teamBid;

    let base = met ? teamBid * 10 : -teamBid * 10;
    let bags = met ? teamTricks - teamBid : 0;

    nilSeats.forEach((s) => {
      const madeNil = tricksTaken[s] === 0;
      base += madeNil ? 100 : -100;
      if (!madeNil) bags += tricksTaken[s];
    });

    const books = teamTricks + nilSeats.reduce((sum, s) => sum + tricksTaken[s], 0);

    return { base, bags, bid: teamBid, books };
  }
  ```
  Then update `endHand`'s two call sites:
  ```js
  const us = computeTeamResult(['you', 'top']);
  const them = computeTeamResult(['left', 'right']);
  ```
  becomes:
  ```js
  const us = computeTeamResult(['you', 'top'], state.bids, state.tricksTaken);
  const them = computeTeamResult(['left', 'right'], state.bids, state.tricksTaken);
  ```

- [ ] **Step 3: Generalize `decideGameWinner`**

  Replace:
  ```js
  function decideGameWinner() {
    const usOver = state.teamScore.us >= state.targetScore;
    const themOver = state.teamScore.them >= state.targetScore;
    if (!usOver && !themOver) return null;
    if (state.teamScore.us === state.teamScore.them) return null;
    return state.teamScore.us > state.teamScore.them ? 'us' : 'them';
  }
  ```
  with:
  ```js
  function decideGameWinner(teamScore, targetScore) {
    const [a, b] = Object.keys(teamScore);
    const aOver = teamScore[a] >= targetScore;
    const bOver = teamScore[b] >= targetScore;
    if (!aOver && !bOver) return null;
    if (teamScore[a] === teamScore[b]) return null;
    return teamScore[a] > teamScore[b] ? a : b;
  }
  ```
  `state.teamScore` is always defined as `{ us: ..., them: ... }` (object key order is insertion order in JS), so this returns exactly the same `'us'`/`'them'` strings solo mode already relies on — fully backward compatible. Update its two call sites:

  In `endHand`: `const winner = decideGameWinner();` becomes `const winner = decideGameWinner(state.teamScore, state.targetScore);`

  In `restoreState`: `const winner = decideGameWinner();` becomes `const winner = decideGameWinner(state.teamScore, state.targetScore);`

- [ ] **Step 4: Extract `computeBotBid` from `assignBotBids`**

  Replace:
  ```js
  function assignBotBids() {
    ORDER.filter((s) => s !== 'you').forEach((seat) => {
      const hand = state.hands[seat];
      const spades = hand.filter((c) => c.suit === '♠').length;
      const highs = hand.filter((c) => c.value >= 13).length;
      const estimate = Math.round(spades * 0.55 + highs * 0.5);
      state.bids[seat] = Math.min(9, Math.max(1, estimate));
    });
  }
  ```
  with:
  ```js
  function computeBotBid(hand) {
    const spades = hand.filter((c) => c.suit === '♠').length;
    const highs = hand.filter((c) => c.value >= 13).length;
    const estimate = Math.round(spades * 0.55 + highs * 0.5);
    return Math.min(9, Math.max(1, estimate));
  }

  function assignBotBids() {
    ORDER.filter((s) => s !== 'you').forEach((seat) => {
      state.bids[seat] = computeBotBid(state.hands[seat]);
    });
  }
  ```

- [ ] **Step 5: Extract `chooseBotCardIndex` from `botPlay`**

  Replace:
  ```js
  function botPlay(seat) {
    const hand = state.hands[seat];
    const trick = state.currentTrick;
    const isLeading = trick.length === 0;
    const ledSuit = isLeading ? null : trick[0].card.suit;
    const legal = getLegalIndices(hand, ledSuit, isLeading, state.spadesBroken);

    let chosen;
    if (isLeading) {
      const nonSpade = legal.filter((i) => hand[i].suit !== '♠');
      const pool = nonSpade.length ? nonSpade : legal;
      chosen = pool.reduce((best, i) => (hand[i].value < hand[best].value ? i : best), pool[0]);
    } else {
      const spadesInTrick = trick.filter((p) => p.card.suit === '♠');
      const contenders = spadesInTrick.length ? spadesInTrick : trick.filter((p) => p.card.suit === ledSuit);
      const winningValue = Math.max(...contenders.map((p) => p.card.value));
      const winningIsSpade = spadesInTrick.length > 0;
      const winners = legal.filter((i) => {
        const c = hand[i];
        if (winningIsSpade) return c.suit === '♠' && c.value > winningValue;
        return (c.suit === ledSuit && c.value > winningValue) || c.suit === '♠';
      });
      if (winners.length && Math.random() < 0.65) {
        chosen = winners.reduce((best, i) => (hand[i].value < hand[best].value ? i : best), winners[0]);
      } else {
        chosen = legal.reduce((best, i) => (hand[i].value < hand[best].value ? i : best), legal[0]);
      }
    }
    playCard(seat, chosen);
  }
  ```
  with:
  ```js
  function chooseBotCardIndex(hand, trick, isLeading, ledSuit, spadesBroken) {
    const legal = getLegalIndices(hand, ledSuit, isLeading, spadesBroken);

    if (isLeading) {
      const nonSpade = legal.filter((i) => hand[i].suit !== '♠');
      const pool = nonSpade.length ? nonSpade : legal;
      return pool.reduce((best, i) => (hand[i].value < hand[best].value ? i : best), pool[0]);
    }

    const spadesInTrick = trick.filter((p) => p.card.suit === '♠');
    const contenders = spadesInTrick.length ? spadesInTrick : trick.filter((p) => p.card.suit === ledSuit);
    const winningValue = Math.max(...contenders.map((p) => p.card.value));
    const winningIsSpade = spadesInTrick.length > 0;
    const winners = legal.filter((i) => {
      const c = hand[i];
      if (winningIsSpade) return c.suit === '♠' && c.value > winningValue;
      return (c.suit === ledSuit && c.value > winningValue) || c.suit === '♠';
    });
    if (winners.length && Math.random() < 0.65) {
      return winners.reduce((best, i) => (hand[i].value < hand[best].value ? i : best), winners[0]);
    }
    return legal.reduce((best, i) => (hand[i].value < hand[best].value ? i : best), legal[0]);
  }

  function botPlay(seat) {
    const hand = state.hands[seat];
    const trick = state.currentTrick;
    const isLeading = trick.length === 0;
    const ledSuit = isLeading ? null : trick[0].card.suit;
    const chosen = chooseBotCardIndex(hand, trick, isLeading, ledSuit, state.spadesBroken);
    playCard(seat, chosen);
  }
  ```

- [ ] **Step 6: Add a `mode` field to `state` and gate `onYourPlay` / the bid-confirm listener**

  In the `state` object literal near the top of `script.js`, add a `mode` field:
  ```js
  const state = {
    mode: 'solo', // 'solo' | 'online' — set to 'online' by multiplayer.js when a room is joined
    hands: { you: [], left: [], top: [], right: [] },
    ...
  };
  ```

  Replace:
  ```js
  function onYourPlay(idx) {
    playCard('you', idx);
  }
  ```
  with:
  ```js
  function onYourPlay(idx) {
    if (state.mode === 'online') {
      window.SpadesOnline?.submitPlay(idx);
      return;
    }
    playCard('you', idx);
  }
  ```

  Replace the `bidConfirm` click listener:
  ```js
  els.bidConfirm.addEventListener('click', () => {
    state.bids.you = state.selectedBid;
    els.bidSlip.hidden = true;
    ORDER.forEach((s) => {
      els.bidPill[s].textContent = state.bids[s] === 'nil' ? 'Nil' : state.bids[s];
    });
    setActiveSeat(state.leader);
    const seq = currentSeq();
    const first = seq[0];
    if (first === 'you') enableLegalCardsForYou();
    else setTimeout(() => botPlay(first), 500);
    saveState();
  });
  ```
  with:
  ```js
  els.bidConfirm.addEventListener('click', () => {
    if (state.mode === 'online') {
      window.SpadesOnline?.submitBid(state.selectedBid);
      return;
    }
    state.bids.you = state.selectedBid;
    els.bidSlip.hidden = true;
    ORDER.forEach((s) => {
      els.bidPill[s].textContent = state.bids[s] === 'nil' ? 'Nil' : state.bids[s];
    });
    setActiveSeat(state.leader);
    const seq = currentSeq();
    const first = seq[0];
    if (first === 'you') enableLegalCardsForYou();
    else setTimeout(() => botPlay(first), 500);
    saveState();
  });
  ```
  `window.SpadesOnline` doesn't exist yet — `?.` makes this a harmless no-op until Task 7 defines it. `multiplayer.js` (a deferred ES module) always finishes loading before a user can reach an online game, so by the time these paths are actually exercised in online mode, `window.SpadesOnline` is populated.

- [ ] **Step 7: Hook `exitGame` for online mode**

  At the top of the existing `exitGame` function body, add:
  ```js
  function exitGame() {
    closeExitConfirm();
    if (state.mode === 'online') {
      window.SpadesOnline?.leaveRoom();
      state.mode = 'solo';
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
    // ...rest of the existing function body is unchanged...
  ```
  The rest of `exitGame` (resetting hands/bids/scores, hiding the bid slip, showing the title overlay) already does exactly the right visual reset for leaving an online game too, so nothing else in that function changes.

- [ ] **Step 8: Add the `window.Spades` bridge**

  At the very end of `script.js`, after the existing `init();` call, add:
  ```js
  window.Spades = { state, els, ORDER, NAMES, SUITS };
  ```

- [ ] **Step 9: Manually verify solo mode still works**

  Serve the folder locally (`python -m http.server 8791` from the project root) and play a full solo hand in a browser: start a game, place a bid, play all 13 tricks, confirm the round banner/score/bag tally update, and confirm a second round deals correctly. This exercises every function touched in this task. Also open the browser console and confirm `window.Spades.state` and `window.Spades.ORDER` are defined.

- [ ] **Step 10: Commit**

  ```bash
  git add script.js
  git commit -m "Extract parameterized pure functions and add window.Spades bridge for multiplayer"
  ```

---

### Task 2: Firebase bootstrap module

**Files:**
- Create: `firebase-config.js`
- Modify: `index.html`

**Interfaces:**
- Produces: `db` (Firestore instance), `auth` (Auth instance), `whenAuthReady()` — returns a `Promise<string>` resolving to the signed-in anonymous user's `uid`, importable by `multiplayer.js` as `import { db, auth, whenAuthReady } from './firebase-config.js'`.

- [ ] **Step 1: Create `firebase-config.js`**

  ```js
  import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
  import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
  import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

  // Paste the config object from Firebase console → Project settings →
  // Your apps → Web app. This is safe to keep in a plain file committed to
  // the repo: Firebase's web config is not a secret, access is controlled
  // by the Firestore security rules published from the console instead.
  const firebaseConfig = {
    apiKey: 'REPLACE_ME',
    authDomain: 'REPLACE_ME',
    projectId: 'REPLACE_ME',
    storageBucket: 'REPLACE_ME',
    messagingSenderId: 'REPLACE_ME',
    appId: 'REPLACE_ME',
  };

  const app = initializeApp(firebaseConfig);
  export const db = getFirestore(app);
  export const auth = getAuth(app);

  let authReadyPromise = null;

  export function whenAuthReady() {
    if (!authReadyPromise) {
      authReadyPromise = new Promise((resolve, reject) => {
        onAuthStateChanged(
          auth,
          (user) => {
            if (user) {
              resolve(user.uid);
            } else {
              signInAnonymously(auth).catch(reject);
            }
          },
          reject
        );
      });
    }
    return authReadyPromise;
  }

  // Debug hook for manual verification (see plan Task 2, Step 3).
  window.__spadesFirebaseDebug = { db, auth, whenAuthReady };
  ```

  Replace `REPLACE_ME` with the real values from the Prerequisites section before testing.

- [ ] **Step 2: Load it from `index.html`**

  Add, after the existing `<script src="script.js"></script>` line:
  ```html
  <script type="module" src="firebase-config.js"></script>
  ```
  (Module scripts are deferred automatically and execute after the document finishes parsing, which is after the classic `script.js` at the bottom of `<body>` has already run — so `window.Spades` is guaranteed to exist before any module code runs.)

- [ ] **Step 3: Manually verify anonymous sign-in works**

  Serve the folder locally and open the page in a browser. In the console, run:
  ```js
  window.__spadesFirebaseDebug.whenAuthReady().then((uid) => console.log('signed in as', uid))
  ```
  Expected: logs a non-empty uid string within a second or two, no errors. If you see a `Firebase: Error (auth/configuration-not-found)` or similar, double check the Anonymous provider is enabled (Prerequisites step 3) and the config values are correct.

- [ ] **Step 4: Commit**

  ```bash
  git add firebase-config.js index.html
  git commit -m "Add Firebase bootstrap module (Firestore + Anonymous Auth)"
  ```

  Note: if `firebaseConfig` still has real project values filled in (not left as `REPLACE_ME`), that's fine to commit — see the comment in Step 1 on why this isn't a secret.

---

### Task 3: Seat/team remapping (pure functions, Node-testable)

This is the trickiest correctness point in the whole feature, so it gets its own isolated, unit-testable task before anything touches Firebase or the DOM.

The room document stores game state keyed by **fixed table positions** `n`/`e`/`s`/`w` (turn order: n → e → s → w → n...), not by the render-relative `you`/`left`/`top`/`right` labels `script.js` already renders from. Each client computes its own **local view**: its own room seat becomes `you`, and the other three rotate into `left`/`top`/`right` preserving turn order — reusing every existing render function unchanged. Partners are always the two seats directly across the table (`n`+`s`, `e`+`w`), which is rotation-invariant, so team pairing is always correct regardless of viewer. Team **totals**, however, must be stored under viewer-independent keys (`ns`/`ew`) since they're shared data, not "mine" vs "theirs" from one viewer's perspective.

**Files:**
- Create: `seat-mapping.js`
- Test: `seat-mapping.test.js`

**Interfaces:**
- Produces: `ROOM_SEATS` (`['n','e','s','w']`), `ROOM_TEAM` (`{n:'ns', e:'ew', s:'ns', w:'ew'}`), `renderSeatOf(mySeat, roomSeat)`, `roomSeq(leader)`, `nextRoomSeat(seat)`, `toLocalView(game, mySeat)` — where `game` is the Firestore-shaped room-seat-keyed object and the return value is shaped exactly like `script.js`'s `state` object (minus UI-only fields like `selectedBid`).
- These are plain ES module exports, imported by both `multiplayer.js` (Task 6+) and this task's test file.

- [ ] **Step 1: Write the failing test**

  Create `seat-mapping.test.js`:
  ```js
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { ROOM_SEATS, ROOM_TEAM, renderSeatOf, roomSeq, nextRoomSeat, toLocalView } from './seat-mapping.js';

  test('renderSeatOf maps my own seat to "you" and preserves turn order', () => {
    assert.equal(renderSeatOf('n', 'n'), 'you');
    assert.equal(renderSeatOf('n', 'e'), 'left');
    assert.equal(renderSeatOf('n', 's'), 'top');
    assert.equal(renderSeatOf('n', 'w'), 'right');

    // A different viewer sees a rotated, but internally consistent, mapping.
    assert.equal(renderSeatOf('e', 'e'), 'you');
    assert.equal(renderSeatOf('e', 's'), 'left');
    assert.equal(renderSeatOf('e', 'w'), 'top');
    assert.equal(renderSeatOf('e', 'n'), 'right');
  });

  test('nextRoomSeat and roomSeq follow fixed n->e->s->w order', () => {
    assert.equal(nextRoomSeat('n'), 'e');
    assert.equal(nextRoomSeat('w'), 'n');
    assert.deepEqual(roomSeq('e'), ['e', 's', 'w', 'n']);
  });

  test('ROOM_TEAM pairs opposite seats', () => {
    assert.equal(ROOM_TEAM.n, ROOM_TEAM.s);
    assert.equal(ROOM_TEAM.e, ROOM_TEAM.w);
    assert.notEqual(ROOM_TEAM.n, ROOM_TEAM.e);
  });

  test('toLocalView relabels hands/bids/tricksTaken/currentTrick/dealer/leader for the viewer', () => {
    const game = {
      hands: { n: ['N1'], e: ['E1'], s: ['S1'], w: ['W1'] },
      bids: { n: 4, e: 3, s: 'nil', w: 2 },
      tricksTaken: { n: 1, e: 0, s: 0, w: 2 },
      teamScore: { ns: 120, ew: 90 },
      teamBags: { ns: 3, ew: 1 },
      dealer: 'n',
      leader: 'e',
      spadesBroken: true,
      currentTrick: [{ seat: 'e', card: 'E1' }, { seat: 's', card: 'S1' }],
      history: [{ round: 1, bid: { ns: 7, ew: 5 }, books: { ns: 8, ew: 5 }, bags: { ns: 1, ew: 0 }, score: { ns: 70, ew: 50 } }],
    };

    const view = toLocalView(game, 'e');

    assert.deepEqual(view.hands, { you: ['E1'], left: ['S1'], top: ['W1'], right: ['N1'] });
    assert.deepEqual(view.bids, { you: 3, left: 'nil', top: 2, right: 4 });
    assert.deepEqual(view.tricksTaken, { you: 0, left: 0, top: 2, right: 1 });
    assert.deepEqual(view.teamScore, { us: 90, them: 120 });
    assert.deepEqual(view.teamBags, { us: 1, them: 3 });
    assert.equal(view.dealer, 'right');
    assert.equal(view.leader, 'you');
    assert.equal(view.spadesBroken, true);
    assert.deepEqual(view.currentTrick, [{ seat: 'you', card: 'E1' }, { seat: 'left', card: 'S1' }]);
    assert.deepEqual(view.history, [{ round: 1, bid: { us: 5, them: 7 }, books: { us: 5, them: 8 }, bags: { us: 0, them: 1 }, score: { us: 50, them: 70 } }]);
  });
  ```

- [ ] **Step 2: Run it to verify it fails**

  Run: `node --test seat-mapping.test.js`
  Expected: fails with a module-not-found error for `./seat-mapping.js` (it doesn't exist yet).

- [ ] **Step 3: Implement `seat-mapping.js`**

  ```js
  export const ROOM_SEATS = ['n', 'e', 's', 'w'];
  export const RENDER_SEATS = ['you', 'left', 'top', 'right'];
  export const ROOM_TEAM = { n: 'ns', e: 'ew', s: 'ns', w: 'ew' };

  export function nextRoomSeat(seat) {
    return ROOM_SEATS[(ROOM_SEATS.indexOf(seat) + 1) % 4];
  }

  export function roomSeq(leader) {
    const i = ROOM_SEATS.indexOf(leader);
    return [...ROOM_SEATS.slice(i), ...ROOM_SEATS.slice(0, i)];
  }

  export function renderSeatOf(mySeat, roomSeat) {
    const myIdx = ROOM_SEATS.indexOf(mySeat);
    const seatIdx = ROOM_SEATS.indexOf(roomSeat);
    const offset = (seatIdx - myIdx + 4) % 4;
    return RENDER_SEATS[offset];
  }

  function remapBySeat(bySeat, mySeat) {
    const out = {};
    for (const roomSeat of ROOM_SEATS) {
      if (bySeat[roomSeat] !== undefined) {
        out[renderSeatOf(mySeat, roomSeat)] = bySeat[roomSeat];
      }
    }
    return out;
  }

  export function toLocalView(game, mySeat) {
    const myTeam = ROOM_TEAM[mySeat];
    const otherTeam = myTeam === 'ns' ? 'ew' : 'ns';
    const teamView = (bySeat) => ({ us: bySeat[myTeam], them: bySeat[otherTeam] });

    return {
      hands: remapBySeat(game.hands, mySeat),
      bids: remapBySeat(game.bids, mySeat),
      tricksTaken: remapBySeat(game.tricksTaken, mySeat),
      teamScore: teamView(game.teamScore),
      teamBags: teamView(game.teamBags),
      dealer: renderSeatOf(mySeat, game.dealer),
      leader: renderSeatOf(mySeat, game.leader),
      spadesBroken: game.spadesBroken,
      currentTrick: game.currentTrick.map((p) => ({ seat: renderSeatOf(mySeat, p.seat), card: p.card })),
      history: game.history.map((row) => ({
        round: row.round,
        bid: teamView(row.bid),
        books: teamView(row.books),
        bags: teamView(row.bags),
        score: teamView(row.score),
      })),
      round: game.round,
      targetScore: game.targetScore,
    };
  }
  ```

- [ ] **Step 4: Run the test again to verify it passes**

  Run: `node --test seat-mapping.test.js`
  Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

  ```bash
  git add seat-mapping.js seat-mapping.test.js
  git commit -m "Add seat/team remapping between room-seat and render-seat spaces"
  ```

---

### Task 4: Room creation + "Play online" entry UI

**Files:**
- Modify: `index.html` (mode-select + create-room overlay markup)
- Modify: `styles.css` (matching styles)
- Create: `multiplayer.js` (new module — this task starts it; later tasks extend it)

**Interfaces:**
- Consumes: `db`, `auth`, `whenAuthReady` from `firebase-config.js`; `window.Spades` from `script.js`.
- Produces: `window.SpadesOnline.createRoom(displayName)` (async, navigates to the lobby on success), and the module-level debug hook `window.__spadesOnlineDebug`.

- [ ] **Step 1: Add mode-select and create-room markup to `index.html`**

  Add this new overlay markup right after the existing `<div class="game-overlay" id="gameOverlay">...</div>` block (still inside `.table-wood`):
  ```html
  <div class="online-overlay" id="onlineOverlay" hidden>
    <div class="overlay-card" id="onlineModeSelect">
      <h2>Play online</h2>
      <p>Create a room to invite friends, or join one with a code.</p>
      <label class="target-field" for="onlineNameInput">
        Your name
        <input type="text" id="onlineNameInput" maxlength="16" placeholder="e.g. Sam" />
      </label>
      <button class="overlay-start" id="createRoomBtn" type="button">Create room</button>
      <button class="overlay-recap" id="joinRoomShowBtn" type="button">Join a room</button>
      <button class="overlay-recap" id="onlineBackBtn" type="button">Back</button>
    </div>
  </div>
  ```
  And add a second button to the existing title overlay card, right after `overlayStartBtn`:
  ```html
  <button class="overlay-recap" id="playOnlineBtn" type="button">Play online</button>
  ```

- [ ] **Step 2: Add matching styles to `styles.css`**

  The `.online-overlay` needs the same full-bleed treatment as `.game-overlay`; add near the `.game-overlay` rules:
  ```css
  .online-overlay {
    position: absolute;
    inset: 0;
    z-index: 21;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(15, 9, 4, 0.72);
    border-radius: 28px;
  }
  .online-overlay[hidden] { display: none; }
  ```
  (It reuses `.overlay-card`, `.overlay-start`, `.overlay-recap`, `.target-field` — all already defined — so no further new rules are needed for this task.)

- [ ] **Step 3: Create `multiplayer.js` with room-code generation and `createRoom`**

  ```js
  import { db, auth, whenAuthReady } from './firebase-config.js';
  import {
    doc, getDoc, setDoc, serverTimestamp,
  } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

  const { state, els } = window.Spades;

  const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

  function randomRoomCode() {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    return code;
  }

  async function generateUniqueRoomCode() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomRoomCode();
      const snap = await getDoc(doc(db, 'rooms', code));
      if (!snap.exists()) return code;
    }
    throw new Error('Could not generate a unique room code, please try again.');
  }

  function emptySeats(firstSeat, uid, name) {
    const seats = {
      n: { uid: null, name: null, isBot: false, lastSeen: null },
      e: { uid: null, name: null, isBot: false, lastSeen: null },
      s: { uid: null, name: null, isBot: false, lastSeen: null },
      w: { uid: null, name: null, isBot: false, lastSeen: null },
    };
    seats[firstSeat] = { uid, name, isBot: false, lastSeen: Date.now() };
    return seats;
  }

  let currentRoomCode = null;
  let mySeat = null;

  async function createRoom(displayName) {
    const uid = await whenAuthReady();
    const roomCode = await generateUniqueRoomCode();
    const roomRef = doc(db, 'rooms', roomCode);

    await setDoc(roomRef, {
      targetScore: 500,
      createdAt: serverTimestamp(),
      status: 'lobby',
      seats: emptySeats('n', uid, displayName),
      game: null,
      turn: 0,
    });

    currentRoomCode = roomCode;
    mySeat = 'n';
    localStorage.setItem('spades-online-membership', JSON.stringify({ roomCode, uid }));

    showLobby(roomCode);
  }

  function showLobby(roomCode) {
    // Minimal placeholder lobby view for this task; Task 5 replaces this
    // with the live seat list.
    els.overlayTitle.textContent = 'Room ' + roomCode;
    els.overlaySubtitle.textContent = 'Waiting for players...';
  }

  document.getElementById('playOnlineBtn').addEventListener('click', () => {
    els.gameOverlay.hidden = true;
    document.getElementById('onlineOverlay').hidden = false;
  });

  document.getElementById('onlineBackBtn').addEventListener('click', () => {
    document.getElementById('onlineOverlay').hidden = true;
    els.gameOverlay.hidden = false;
  });

  document.getElementById('createRoomBtn').addEventListener('click', () => {
    const name = document.getElementById('onlineNameInput').value.trim() || 'Player';
    createRoom(name);
  });

  window.SpadesOnline = window.SpadesOnline || {};
  window.SpadesOnline.createRoom = createRoom;
  window.__spadesOnlineDebug = { get currentRoomCode() { return currentRoomCode; }, get mySeat() { return mySeat; }, db };
  ```

- [ ] **Step 4: Load `multiplayer.js` from `index.html`**

  Add, after the `firebase-config.js` script tag:
  ```html
  <script type="module" src="multiplayer.js"></script>
  ```

- [ ] **Step 5: Manually verify a room document is created**

  Serve locally, open the page, fill in a name, click **Play online** then **Create room**. In the console:
  ```js
  window.__spadesOnlineDebug.currentRoomCode
  ```
  Expected: a 6-character code string. Then, in the [Firestore console](https://console.firebase.google.com) for your project, open **Firestore Database → Data** and confirm a `rooms/{that code}` document exists with `status: "lobby"` and seat `n` filled with your typed name.

- [ ] **Step 6: Commit**

  ```bash
  git add index.html styles.css multiplayer.js
  git commit -m "Add Play online entry and room creation"
  ```

---

### Task 5: Join room + live lobby seat list

**Files:**
- Modify: `index.html` (join-room markup, lobby seat list markup)
- Modify: `styles.css` (lobby seat list styles)
- Modify: `multiplayer.js`

**Interfaces:**
- Consumes: `onSnapshot`, `doc`, `runTransaction` from the Firestore CDN module; `currentRoomCode`/`mySeat` module state from Task 4.
- Produces: `window.SpadesOnline.joinRoom(roomCode, displayName)`; internal `subscribeToRoom(roomCode)` used by later tasks too.

- [ ] **Step 1: Add join-room and lobby markup to `index.html`**

  Add inside `#onlineOverlay`, as a sibling to `#onlineModeSelect` (both toggle via `hidden`):
  ```html
  <div class="overlay-card" id="onlineJoinForm" hidden>
    <h2>Join a room</h2>
    <label class="target-field" for="joinNameInput">
      Your name
      <input type="text" id="joinNameInput" maxlength="16" placeholder="e.g. Sam" />
    </label>
    <label class="target-field" for="joinCodeInput">
      Room code
      <input type="text" id="joinCodeInput" maxlength="6" placeholder="ABC123" style="text-transform:uppercase" />
    </label>
    <div class="overlay-result" id="joinErrorText" hidden></div>
    <button class="overlay-start" id="joinRoomBtn" type="button">Join</button>
    <button class="overlay-recap" id="joinBackBtn" type="button">Back</button>
  </div>

  <div class="overlay-card" id="onlineLobby" hidden>
    <h2>Room <span id="lobbyRoomCode"></span></h2>
    <p>Share this code with friends. Empty seats are filled by bots.</p>
    <ul class="lobby-seat-list" id="lobbySeatList"></ul>
    <button class="overlay-start" id="lobbyStartBtn" type="button" hidden>Start game</button>
  </div>
  ```

- [ ] **Step 2: Add lobby seat list styles to `styles.css`**

  ```css
  .lobby-seat-list {
    list-style: none;
    margin: 0 0 0.85rem;
    padding: 0;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    text-align: left;
  }
  .lobby-seat-list li {
    display: flex;
    justify-content: space-between;
    padding: 0.35rem 0;
    border-bottom: 1px solid rgba(32, 24, 18, 0.12);
  }
  .lobby-seat-list li:last-child { border-bottom: none; }
  .lobby-seat-list .seat-empty { opacity: 0.5; }
  ```

- [ ] **Step 3: Add `joinRoom` and the live lobby subscription to `multiplayer.js`**

  Add these imports to the existing import line from `firebase-firestore.js`:
  ```js
  import {
    doc, getDoc, setDoc, serverTimestamp, onSnapshot, runTransaction,
  } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
  ```

  Add, replacing the placeholder `showLobby` function from Task 4:
  ```js
  const SEAT_ORDER = ['n', 'e', 's', 'w'];
  let unsubscribeRoom = null;

  function openSeat(seats) {
    return SEAT_ORDER.find((s) => seats[s].uid === null) || null;
  }

  async function joinRoom(roomCode, displayName) {
    const uid = await whenAuthReady();
    const roomRef = doc(db, 'rooms', roomCode.toUpperCase());

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) throw new Error('room-not-found');
      const data = snap.data();
      if (data.status !== 'lobby') throw new Error('room-already-started');
      const seat = openSeat(data.seats);
      if (!seat) throw new Error('room-full');

      const seats = { ...data.seats, [seat]: { uid, name: displayName, isBot: false, lastSeen: Date.now() } };
      tx.update(roomRef, { seats });
      mySeat = seat;
    });

    currentRoomCode = roomCode.toUpperCase();
    localStorage.setItem('spades-online-membership', JSON.stringify({ roomCode: currentRoomCode, uid }));
    showLobby(currentRoomCode);
  }

  function renderLobby(data) {
    document.getElementById('lobbyRoomCode').textContent = currentRoomCode;
    const list = document.getElementById('lobbySeatList');
    list.innerHTML = '';
    SEAT_ORDER.forEach((seat) => {
      const info = data.seats[seat];
      const li = document.createElement('li');
      if (info.uid) {
        li.textContent = info.name + (seat === mySeat ? ' (you)' : '');
      } else {
        li.textContent = 'Waiting for a player...';
        li.classList.add('seat-empty');
      }
      list.appendChild(li);
    });

    const humanCount = SEAT_ORDER.filter((s) => data.seats[s].uid).length;
    const startBtn = document.getElementById('lobbyStartBtn');
    startBtn.hidden = !(mySeat === 'n' && humanCount >= 2);
  }

  function showLobby(roomCode) {
    els.gameOverlay.hidden = true;
    document.getElementById('onlineOverlay').hidden = false;
    document.getElementById('onlineModeSelect').hidden = true;
    document.getElementById('onlineJoinForm').hidden = true;
    document.getElementById('onlineLobby').hidden = false;

    if (unsubscribeRoom) unsubscribeRoom();
    unsubscribeRoom = onSnapshot(doc(db, 'rooms', roomCode), (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.status === 'lobby') {
        renderLobby(data);
      }
      // Task 6 adds the branch that handles data.status === 'playing'.
    });
  }

  document.getElementById('joinRoomShowBtn').addEventListener('click', () => {
    document.getElementById('onlineModeSelect').hidden = true;
    document.getElementById('onlineJoinForm').hidden = false;
  });

  document.getElementById('joinBackBtn').addEventListener('click', () => {
    document.getElementById('onlineJoinForm').hidden = true;
    document.getElementById('onlineModeSelect').hidden = false;
  });

  document.getElementById('joinRoomBtn').addEventListener('click', () => {
    const name = document.getElementById('joinNameInput').value.trim() || 'Player';
    const code = document.getElementById('joinCodeInput').value.trim();
    const errorEl = document.getElementById('joinErrorText');
    errorEl.hidden = true;
    joinRoom(code, name).catch((err) => {
      const messages = {
        'room-not-found': 'No room with that code.',
        'room-already-started': 'That game has already started.',
        'room-full': 'That room is full.',
      };
      errorEl.textContent = messages[err.message] || 'Could not join that room.';
      errorEl.hidden = false;
    });
  });

  window.SpadesOnline.joinRoom = joinRoom;
  ```

  Note: this replaces the `showLobby` function body from Task 4 (same function name, extended) — remove the old one-line version.

- [ ] **Step 4: Manually verify with two browser tabs**

  Serve locally and open two tabs/profiles. In tab 1: create a room, note the code. In tab 2: click Play online → Join a room, enter that code and a different name, click Join. Expected: both tabs' lobby lists show two named seats and two "Waiting for a player..." rows, updating live in both tabs without a manual refresh. Only tab 1 (the creator, seat `n`) should see a **Start game** button.

- [ ] **Step 5: Commit**

  ```bash
  git add index.html styles.css multiplayer.js
  git commit -m "Add join room and live lobby seat list"
  ```

---

### Task 6: Start game — bot fill, initial deal, and rendering the table

**Files:**
- Modify: `multiplayer.js`

**Interfaces:**
- Consumes: `toLocalView`, `ROOM_SEATS`, `ROOM_TEAM` from `seat-mapping.js`; `buildDeck`, `shuffle`, `cardSort`, `computeBotBid`, `renderAllHands`, `renderAllTrickPiles`, `renderTally`, `startBidding` (all already `window.X` per Task 1's note) plus `window.Spades.state`/`els`.
- Produces: the `status === 'playing'` branch of the `onSnapshot` handler from Task 5, which every later task's UI depends on to actually see the table.

- [ ] **Step 1: Import the seat-mapping helpers**

  Add to the top of `multiplayer.js`:
  ```js
  import { ROOM_SEATS, ROOM_TEAM, renderSeatOf, roomSeq, nextRoomSeat, toLocalView } from './seat-mapping.js';
  ```

- [ ] **Step 2: Add the initial-deal function and the Start button handler**

  ```js
  function dealRoomGame(targetScore) {
    const deck = window.shuffle(window.buildDeck());
    const hands = {
      n: deck.slice(0, 13).sort(window.cardSort),
      e: deck.slice(13, 26).sort(window.cardSort),
      s: deck.slice(26, 39).sort(window.cardSort),
      w: deck.slice(39, 52).sort(window.cardSort),
    };
    const bids = {};
    const tricksTaken = {};
    ROOM_SEATS.forEach((seat) => { tricksTaken[seat] = 0; });

    return {
      hands,
      bids,
      tricksTaken,
      teamScore: { ns: 0, ew: 0 },
      teamBags: { ns: 0, ew: 0 },
      round: 1,
      dealer: 'n',
      leader: 'e',
      spadesBroken: false,
      currentTrick: [],
      history: [],
      targetScore,
    };
  }

  async function startOnlineGame() {
    const roomRef = doc(db, 'rooms', currentRoomCode);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      const data = snap.data();
      if (data.status !== 'lobby') return;

      const seats = { ...data.seats };
      ROOM_SEATS.forEach((seat) => {
        if (!seats[seat].uid) {
          seats[seat] = { uid: null, name: 'Bot', isBot: true, lastSeen: null };
        }
      });

      tx.update(roomRef, {
        status: 'playing',
        seats,
        game: dealRoomGame(data.targetScore),
        turn: 0,
      });
    });
  }

  document.getElementById('lobbyStartBtn').addEventListener('click', startOnlineGame);
  ```

  Seats claimed by a human keep `isBot: false`; empty seats are relabeled `isBot: true` with the display name "Bot" here, right before dealing — matching the spec's "fill empty seats with bots" behavior.

- [ ] **Step 3: Render the table when `status` becomes `"playing"`**

  In the `onSnapshot` callback inside `showLobby` (from Task 5), replace the comment `// Task 6 adds the branch...` with:
  ```js
  if (data.status === 'playing') {
    document.getElementById('onlineOverlay').hidden = true;
    renderOnlineGame(data);
  }
  ```

  Add the new `renderOnlineGame` function:
  ```js
  const RENDER_ORDER = ['you', 'left', 'top', 'right'];
  let biddingShownForRound = null;

  function renderOnlineGame(data) {
    const view = toLocalView(data.game, mySeat);
    Object.assign(state, view);
    state.mode = 'online';

    window.renderAllHands(false);
    window.renderAllTrickPiles();
    window.renderTally(state.teamBags.us);
    els.scoreUs.textContent = state.teamScore.us;
    els.scoreThem.textContent = state.teamScore.them;
    els.roundNum.textContent = state.round;
    els.dealerTag.textContent = 'Dealer: ' + (data.seats[data.game.dealer].name || 'Bot');
    els.brokenTag.dataset.broken = String(state.spadesBroken);
    els.brokenTag.textContent = state.spadesBroken ? 'Spades broken' : 'Spades not broken';

    // Only (re)show the bid-selection UI once per round, and only if this
    // player hasn't bid yet — NOT on every snapshot while others are still
    // bidding, or a partner's bid would reset this player's in-progress
    // selection out from under them.
    if (state.bids.you === undefined) {
      if (biddingShownForRound !== state.round) {
        biddingShownForRound = state.round;
        window.startBidding();
      }
    } else {
      els.bidSlip.hidden = true;
    }
    RENDER_ORDER.forEach((s) => {
      if (state.bids[s] !== undefined) {
        els.bidPill[s].textContent = state.bids[s] === 'nil' ? 'Nil' : state.bids[s];
      }
    });

    if (state.currentTrick.length === 4 || state.currentTrick.some((p) => p.seat === 'you')) {
      window.disableYourCards();
    } else if (RENDER_ORDER[state.currentTrick.length] === 'you' && state.bids.you !== undefined) {
      window.enableLegalCardsForYou();
    } else {
      window.disableYourCards();
    }
  }
  ```

  This deliberately reuses `renderAllHands`/`renderAllTrickPiles`/`renderTally`/`startBidding`/`enableLegalCardsForYou`/`disableYourCards` — the exact same functions solo mode already uses — by first mirroring the remapped view into the shared `state` object, the same pattern `restoreState` already uses for solo-mode's own localStorage resume. `biddingShownForRound` is what prevents another player's bid from re-triggering `startBidding()` (which calls `resetBidUI()`, clearing any bid this player was about to confirm) mid-round.

- [ ] **Step 4: Manually verify two tabs both see a dealt table**

  With the two tabs from Task 5's test still joined to the same room, click **Start game** in tab 1. Expected: both tabs immediately show the table with 13 cards in "your hand" (different cards in each tab — each tab is a different seat), correct opponent card-back counts, and the bid slip visible for whichever seat's turn it is per the existing bidding UI. Confirm in the Firestore console that the room's `game.hands` field has 13 cards in each of `n`/`e`/`s`/`w`.

- [ ] **Step 5: Commit**

  ```bash
  git add multiplayer.js
  git commit -m "Add Start game: bot-fill, initial deal, and table rendering"
  ```

---

### Task 7: Your own bid and card-play actions

**Files:**
- Modify: `multiplayer.js`

**Interfaces:**
- Produces: `window.SpadesOnline.submitBid(bid)`, `window.SpadesOnline.submitPlay(cardIndex)` — called by the `script.js` guards added in Task 1, Step 6.

- [ ] **Step 1: Add `submitBid`**

  ```js
  async function submitBid(bid) {
    const roomRef = doc(db, 'rooms', currentRoomCode);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      const data = snap.data();
      if (data.game.bids[mySeat] !== undefined) return; // already bid, stale click
      const bids = { ...data.game.bids, [mySeat]: bid };
      tx.update(roomRef, { game: { ...data.game, bids }, turn: (data.turn || 0) + 1 });
    });
  }

  window.SpadesOnline.submitBid = submitBid;
  ```

- [ ] **Step 2: Add `submitPlay` with a re-derived legality check**

  ```js
  async function submitPlay(cardIndex) {
    const roomRef = doc(db, 'rooms', currentRoomCode);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      const data = snap.data();
      const game = data.game;

      const seq = roomSeq(game.leader);
      const toAct = seq[game.currentTrick.length];
      if (toAct !== mySeat) return; // not actually my turn — stale UI

      const hand = game.hands[mySeat];
      const isLeading = game.currentTrick.length === 0;
      const ledSuit = isLeading ? null : game.currentTrick[0].card.suit;
      const legal = window.getLegalIndices(hand, ledSuit, isLeading, game.spadesBroken);
      if (!legal.includes(cardIndex)) return; // illegal — reject silently, UI already prevents this

      const card = hand[cardIndex];
      const newHand = hand.slice(0, cardIndex).concat(hand.slice(cardIndex + 1));
      const newTrick = [...game.currentTrick, { seat: mySeat, card }];
      const spadesBroken = game.spadesBroken || card.suit === '♠';

      tx.update(roomRef, {
        game: {
          ...game,
          hands: { ...game.hands, [mySeat]: newHand },
          currentTrick: newTrick,
          spadesBroken,
        },
        turn: (data.turn || 0) + 1,
      });
    });
  }

  window.SpadesOnline.submitPlay = submitPlay;
  ```

- [ ] **Step 3: Manually verify bidding and a few plays sync across tabs**

  With both tabs seated at a dealt table (from Task 6's test), place a bid in whichever tab's turn it is; confirm the other tab's bid pill updates live. Once both human seats have bid (bot seats won't have bids yet — that's Task 8), play a legal card from the tab whose turn it is and confirm it appears in the other tab's trick area. Also try clicking a card that isn't actually legal (e.g. via `window.SpadesOnline.submitPlay(0)` in the console when it's not your turn) and confirm via the Firestore console that no write occurred.

- [ ] **Step 4: Commit**

  ```bash
  git add multiplayer.js
  git commit -m "Add transactional submitBid/submitPlay for the local player's own turn"
  ```

---

### Task 8: System actions — bots, trick resolution, scoring, dealing (race-and-transact)

This is the mechanism that makes the game actually finish a hand without a dedicated host: every connected client watches the synced state and, whenever it looks like the next action is due, attempts it. The Firestore transaction ensures only one attempt actually commits.

**Files:**
- Modify: `multiplayer.js`

**Interfaces:**
- Consumes: `chooseBotCardIndex`, `computeBotBid`, `determineWinner`, `computeTeamResult`, `decideGameWinner` (all on `window.*` per Task 1).
- Produces: `maybeAdvanceGame(data)`, called from the `onSnapshot` handler on every update.

- [ ] **Step 1: Add the four pure "compute next game" functions**

  ```js
  function applyBotBid(game, seat) {
    const bid = window.computeBotBid(game.hands[seat]);
    return { ...game, bids: { ...game.bids, [seat]: bid } };
  }

  function applyBotPlay(game, seat) {
    const hand = game.hands[seat];
    const isLeading = game.currentTrick.length === 0;
    const ledSuit = isLeading ? null : game.currentTrick[0].card.suit;
    const index = window.chooseBotCardIndex(hand, game.currentTrick, isLeading, ledSuit, game.spadesBroken);
    const card = hand[index];
    const newHand = hand.slice(0, index).concat(hand.slice(index + 1));
    return {
      ...game,
      hands: { ...game.hands, [seat]: newHand },
      currentTrick: [...game.currentTrick, { seat, card }],
      spadesBroken: game.spadesBroken || card.suit === '♠',
    };
  }

  function applyTrickResolution(game) {
    const winner = window.determineWinner(game.currentTrick);
    return {
      ...game,
      tricksTaken: { ...game.tricksTaken, [winner]: game.tricksTaken[winner] + 1 },
      leader: winner,
      currentTrick: [],
    };
  }

  function applyHandScoring(game) {
    const nsResult = window.computeTeamResult(['n', 's'], game.bids, game.tricksTaken);
    const ewResult = window.computeTeamResult(['e', 'w'], game.bids, game.tricksTaken);

    let teamScore = {
      ns: game.teamScore.ns + nsResult.base,
      ew: game.teamScore.ew + ewResult.base,
    };
    let teamBags = {
      ns: game.teamBags.ns + nsResult.bags,
      ew: game.teamBags.ew + ewResult.bags,
    };
    if (teamBags.ns >= 10) { teamBags.ns -= 10; teamScore.ns -= 100; }
    if (teamBags.ew >= 10) { teamBags.ew -= 10; teamScore.ew -= 100; }

    const history = [...game.history, {
      round: game.round,
      bid: { ns: nsResult.bid, ew: ewResult.bid },
      books: { ns: nsResult.books, ew: ewResult.books },
      bags: { ns: teamBags.ns, ew: teamBags.ew },
      score: { ns: teamScore.ns, ew: teamScore.ew },
    }];

    return { ...game, teamScore, teamBags, history };
  }

  function applyNewDeal(game) {
    const dealer = nextRoomSeat(game.dealer);
    const dealt = dealRoomGame(game.targetScore);
    return { ...dealt, dealer, leader: nextRoomSeat(dealer), round: game.round + 1, history: game.history, teamScore: game.teamScore, teamBags: game.teamBags };
  }
  ```

- [ ] **Step 2: Add `maybeAdvanceGame`, the single entry point every client calls on each snapshot**

  ```js
  async function maybeAdvanceGame(data) {
    if (data.status !== 'playing') return;
    const game = data.game;
    const roomRef = doc(db, 'rooms', currentRoomCode);

    const handsEmpty = ROOM_SEATS.every((s) => game.hands[s].length === 0);
    if (handsEmpty) {
      if (window.decideGameWinner({ us: game.teamScore.ns, them: game.teamScore.ew }, game.targetScore)) {
        return; // game over — nothing left to advance
      }
      await tryAdvance(roomRef, (g) => applyNewDeal(g));
      return;
    }

    if (game.currentTrick.length === 4) {
      await tryAdvance(roomRef, (g) => {
        const resolved = applyTrickResolution(g);
        const stillPlaying = !ROOM_SEATS.every((s) => resolved.hands[s].length === 0);
        return stillPlaying ? resolved : applyHandScoring(resolved);
      });
      return;
    }

    if (Object.keys(game.bids).length < 4) {
      const missingBidder = ROOM_SEATS.find((s) => game.bids[s] === undefined && data.seats[s].isBot);
      if (missingBidder) await tryAdvance(roomRef, (g) => applyBotBid(g, missingBidder));
      return;
    }

    const seq = roomSeq(game.leader);
    const toAct = seq[game.currentTrick.length];
    if (data.seats[toAct].isBot) {
      await tryAdvance(roomRef, (g) => applyBotPlay(g, toAct));
    }
  }

  async function tryAdvance(roomRef, computeNext) {
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(roomRef);
        const data = snap.data();
        if (data.status !== 'playing') return;
        const nextGame = computeNext(data.game);
        tx.update(roomRef, { game: nextGame, turn: (data.turn || 0) + 1 });
      });
    } catch (e) {
      // Lost the race to another client, or state moved on already — expected, ignore.
    }
  }

  window.SpadesOnline._maybeAdvanceGame = maybeAdvanceGame; // exposed for the Task 8 manual test below
  ```

- [ ] **Step 3: Call it from the snapshot handler**

  In `renderOnlineGame` (Task 6), after the existing body, add:
  ```js
  maybeAdvanceGame(data);
  ```

- [ ] **Step 4: Manually verify a full hand plays out with bots involved**

  Create a room, join with one other tab, start the game (two bot seats fill in automatically). Expected: bot seats bid and play automatically with a natural pause between moves (the transactions happen quickly since there's no artificial delay in this task — that polish is out of scope here), tricks resolve, and after 13 tricks the hand scores and a new hand deals automatically, all mirrored live in both tabs.

  To specifically verify the race-arbitration behavior (two clients attempting the same action at once should never both win), watch the room document in the Firestore console's **Data** tab while this plays out and confirm `turn` increases by exactly 1 for each individual action (one bot bid, one bot play, one trick resolution, etc.) — never jumping by 2+ (which would mean two writes both landed, a sign the transaction retry logic isn't actually arbitrating) and never stalling for more than a couple seconds (which would mean every attempt is failing).

- [ ] **Step 5: Commit**

  ```bash
  git add multiplayer.js
  git commit -m "Add race-and-transact system actions: bot moves, trick resolution, scoring, dealing"
  ```

---

### Task 9: Presence heartbeat and disconnect -> bot takeover

**Files:**
- Modify: `multiplayer.js`

**Interfaces:**
- Produces: an internal heartbeat interval started in `renderOnlineGame`/`renderLobby`; extends `maybeAdvanceGame` with a stale-seat check.

- [ ] **Step 1: Add the heartbeat writer**

  ```js
  const HEARTBEAT_INTERVAL_MS = 10000;
  const STALE_AFTER_MS = 20000;
  let heartbeatTimer = null;

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(async () => {
      if (!currentRoomCode || !mySeat) return;
      const roomRef = doc(db, 'rooms', currentRoomCode);
      try {
        const snap = await getDoc(roomRef);
        if (!snap.exists()) return;
        const seats = { ...snap.data().seats };
        if (!seats[mySeat] || seats[mySeat].isBot) return;
        seats[mySeat] = { ...seats[mySeat], lastSeen: Date.now() };
        await setDoc(roomRef, { seats }, { merge: true });
      } catch (e) {
        // Offline or transient error — next tick will retry.
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
  ```

  Call `startHeartbeat()` at the top of `joinRoom` and `createRoom` (both already run once you have a seat).

- [ ] **Step 2: Detect and take over stale seats inside `maybeAdvanceGame`**

  Add, as the first check inside `maybeAdvanceGame` (before the `handsEmpty` check):
  ```js
  const staleSeat = ROOM_SEATS.find((s) => {
    const seat = data.seats[s];
    return seat.uid && !seat.isBot && seat.lastSeen && Date.now() - seat.lastSeen > STALE_AFTER_MS;
  });
  if (staleSeat) {
    const roomRef = doc(db, 'rooms', currentRoomCode);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(roomRef);
        const seats = { ...snap.data().seats };
        if (seats[staleSeat].isBot) return; // someone already flipped it
        seats[staleSeat] = { ...seats[staleSeat], isBot: true };
        tx.update(roomRef, { seats });
      });
    } catch (e) {}
    return; // let the resulting snapshot re-trigger the rest of maybeAdvanceGame
  }
  ```

- [ ] **Step 3: Manually verify a dropped tab gets covered by a bot**

  With two human tabs in a live game, close one tab entirely (not just navigate away — close it so its heartbeat stops). In the remaining tab, wait about 20-25 seconds. Expected: that seat's label switches to showing it as bot-controlled and the game keeps progressing through that seat's turns automatically (verify via the Firestore console that `seats.<seat>.isBot` flips to `true`).

- [ ] **Step 4: Commit**

  ```bash
  git add multiplayer.js
  git commit -m "Add presence heartbeat and disconnect-to-bot-takeover"
  ```

---

### Task 10: Reconnection

**Files:**
- Modify: `multiplayer.js`

**Interfaces:**
- Produces: an `attemptResume()` function called once at module load.

- [ ] **Step 1: Add `attemptResume`**

  ```js
  async function attemptResume() {
    const raw = localStorage.getItem('spades-online-membership');
    if (!raw) return;
    const { roomCode, uid: savedUid } = JSON.parse(raw);
    const uid = await whenAuthReady();
    if (uid !== savedUid) {
      localStorage.removeItem('spades-online-membership');
      return;
    }

    const roomRef = doc(db, 'rooms', roomCode);
    const snap = await getDoc(roomRef);
    if (!snap.exists()) {
      localStorage.removeItem('spades-online-membership');
      return;
    }

    const data = snap.data();
    const seat = ROOM_SEATS.find((s) => data.seats[s].uid === uid);
    if (!seat) {
      localStorage.removeItem('spades-online-membership');
      return;
    }

    currentRoomCode = roomCode;
    mySeat = seat;

    if (data.seats[seat].isBot) {
      await runTransaction(db, async (tx) => {
        const freshSnap = await tx.get(roomRef);
        const seats = { ...freshSnap.data().seats };
        seats[seat] = { ...seats[seat], isBot: false, lastSeen: Date.now() };
        tx.update(roomRef, { seats });
      });
    }

    startHeartbeat();
    if (data.status === 'lobby') {
      showLobby(roomCode);
    } else {
      els.gameOverlay.hidden = true;
      if (unsubscribeRoom) unsubscribeRoom();
      unsubscribeRoom = onSnapshot(roomRef, (s) => {
        if (s.exists()) renderOnlineGame(s.data());
      });
    }
  }

  attemptResume();
  ```

- [ ] **Step 2: Manually verify reload restores your seat**

  In a live game tab, close it, wait ~25 seconds so the seat is marked bot-controlled (per Task 9's behavior), then reopen the same URL in a new tab. Expected: you land directly at the table (not the title screen), in your original seat, and `seats.<yourSeat>.isBot` flips back to `false` in the Firestore console.

- [ ] **Step 3: Commit**

  ```bash
  git add multiplayer.js
  git commit -m "Add reconnection: resume an online room from localStorage on load"
  ```

---

### Task 11: Leave room wiring + bot seat labels

**Files:**
- Modify: `multiplayer.js`
- Modify: `script.js` (seat label rendering)

**Interfaces:**
- Produces: `window.SpadesOnline.leaveRoom()` (called from `script.js`'s `exitGame`, wired in Task 1).

- [ ] **Step 1: Add `leaveRoom`**

  ```js
  async function leaveRoom() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
    if (currentRoomCode && mySeat) {
      const roomRef = doc(db, 'rooms', currentRoomCode);
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(roomRef);
          if (!snap.exists()) return;
          const seats = { ...snap.data().seats };
          seats[mySeat] = { ...seats[mySeat], isBot: true };
          tx.update(roomRef, { seats });
        });
      } catch (e) {}
    }
    localStorage.removeItem('spades-online-membership');
    currentRoomCode = null;
    mySeat = null;
  }

  window.SpadesOnline.leaveRoom = leaveRoom;
  ```

- [ ] **Step 2: Show "(bot)" on bot-controlled seats**

  The seat labels in `index.html` aren't marked up identically: `seatLeft` and `seatRight` wrap the name in `<span class="seat-name">` (added by a past mobile-layout fix), but `seatTop` has a bare text node (`<span class="turn-dot"></span>Priya <span class="bid-pill">`). Handle both shapes. In `renderOnlineGame` (Task 6), after the existing body, add:
  ```js
  function findLabelTextNode(container) {
    for (const node of container.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return node;
    }
    return null;
  }

  const seatLabelEl = {
    left: document.querySelector('#seatLeft .seat-label'),
    top: document.querySelector('#seatTop .seat-label'),
    right: document.querySelector('#seatRight .seat-label'),
  };

  ['left', 'top', 'right'].forEach((renderSeat) => {
    const roomSeat = ROOM_SEATS.find((s) => renderSeatOf(mySeat, s) === renderSeat);
    const info = data.seats[roomSeat];
    const label = info.isBot ? (info.name || 'Bot') + ' (bot)' : info.name;

    const nameSpan = seatLabelEl[renderSeat].querySelector('.seat-name');
    if (nameSpan) {
      nameSpan.textContent = label;
    } else {
      const textNode = findLabelTextNode(seatLabelEl[renderSeat]);
      if (textNode) textNode.textContent = label + ' ';
    }
  });
  ```
  This only touches the name text, leaving the existing `<span class="turn-dot">` and bid-pill spans inside each seat label untouched.

- [ ] **Step 3: Manually verify leaving and bot labels**

  In a live 2-human game, click **Exit** in one tab and confirm the quit dialog, then confirm **Quit**. Expected: that tab returns to the title screen and its localStorage `spades-online-membership` entry is gone; the other tab sees that seat's label switch to "<name> (bot)" and the game continues with a bot playing that seat.

- [ ] **Step 4: Commit**

  ```bash
  git add multiplayer.js script.js
  git commit -m "Wire Exit to leave the online room; label bot-controlled seats"
  ```

---

## Self-Review Notes

- **Spec coverage:** Firebase/Firestore + Anonymous Auth stack (Task 2), buildless CDN modules (Tasks 2/3/4), private room codes (Task 4), lobby + bot-fill on Start (Tasks 5-6), turn-owner/race-and-transact authority for bots/tricks/scoring/dealing (Task 8), heartbeat presence + bot takeover (Task 9), reconnection via localStorage (Task 10), Exit-to-leave-room and bot seat labels (Task 11), Firestore security rules matching the accepted low-trust model (Prerequisites) — all covered. Hand-visibility limitation is inherent to the design (all four hands live in the one synced `game.hands` object every client receives) and is not separately "implemented," per the spec's own framing of it as an accepted trade-off, not a feature.
- **Placeholder scan:** no TBD/TODO; every step has real, complete code.
- **Type/name consistency:** `toLocalView`/`ROOM_SEATS`/`ROOM_TEAM`/`renderSeatOf`/`roomSeq`/`nextRoomSeat` (Task 3) are used with matching names and signatures in Tasks 6-11. `window.SpadesOnline.{createRoom,joinRoom,submitBid,submitPlay,leaveRoom}` names match exactly what Task 1's `script.js` guards call. `window.Spades.{state,els,ORDER,NAMES,SUITS}` matches what Tasks 4/6 destructure.
