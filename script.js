/* ==========================================================================
   Spades — table logic
   A full round loop: deal, bid, play tricks, score, next hand.
   ========================================================================== */

const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = [
  { sym: '♠', red: false },
  { sym: '♥', red: true },
  { sym: '♦', red: true },
  { sym: '♣', red: false },
];
const SUIT_PRIORITY = { '♠': 0, '♥': 1, '♣': 2, '♦': 3 };
const ORDER = ['you', 'left', 'top', 'right'];
const NAMES = { you: 'You', left: 'Marcus', top: 'Priya', right: 'Dana' };

const els = {
  dealerTag: document.getElementById('dealerTag'),
  brokenTag: document.getElementById('brokenTag'),
  bagCount: document.getElementById('bagCount'),
  tallyMarks: document.getElementById('tallyMarks'),
  tallyBlot: document.getElementById('tallyBlot'),
  seat: {
    you: document.getElementById('seatBottom'),
    left: document.getElementById('seatLeft'),
    top: document.getElementById('seatTop'),
    right: document.getElementById('seatRight'),
  },
  cards: {
    left: document.getElementById('cardsLeft'),
    top: document.getElementById('cardsTop'),
    right: document.getElementById('cardsRight'),
  },
  bidPill: {
    you: document.getElementById('bidYou'),
    left: document.getElementById('bidLeft'),
    top: document.getElementById('bidTop'),
    right: document.getElementById('bidRight'),
  },
  trickPile: {
    you: document.getElementById('pileYou'),
    left: document.getElementById('pileLeft'),
    top: document.getElementById('pileTop'),
    right: document.getElementById('pileRight'),
  },
  trickCards: document.getElementById('trickCards'),
  roundBanner: document.getElementById('roundBanner'),
  scoreUs: document.getElementById('scoreUs'),
  scoreThem: document.getElementById('scoreThem'),
  roundNum: document.getElementById('roundNum'),
  bidSlip: document.getElementById('bidSlip'),
  bidGrid: document.getElementById('bidGrid'),
  bidNilBtn: document.getElementById('bidNilBtn'),
  bidConfirm: document.getElementById('bidConfirm'),
  yourHand: document.getElementById('yourHand'),
  gameOverlay: document.getElementById('gameOverlay'),
  overlayTitle: document.getElementById('overlayTitle'),
  overlaySubtitle: document.getElementById('overlaySubtitle'),
  overlayResult: document.getElementById('overlayResult'),
  overlayRecapBtn: document.getElementById('overlayRecapBtn'),
  targetScoreInput: document.getElementById('targetScoreInput'),
  overlayStartBtn: document.getElementById('overlayStartBtn'),
  scorepad: document.getElementById('scorepad'),
  historyOverlay: document.getElementById('historyOverlay'),
  historyBody: document.getElementById('historyBody'),
  historyCloseBtn: document.getElementById('historyCloseBtn'),
  exitBtn: document.getElementById('exitBtn'),
  exitConfirmOverlay: document.getElementById('exitConfirmOverlay'),
  exitCancelBtn: document.getElementById('exitCancelBtn'),
  exitConfirmBtn: document.getElementById('exitConfirmBtn'),
};

const state = {
  hands: { you: [], left: [], top: [], right: [] },
  bids: {},
  tricksTaken: { you: 0, left: 0, top: 0, right: 0 },
  teamBags: { us: 0, them: 0 },
  teamScore: { us: 0, them: 0 },
  round: 1,
  dealer: 'you',
  leader: 'left',
  spadesBroken: false,
  currentTrick: [],
  selectedBid: null,
  targetScore: 500,
  history: [],
};

/* ------------------------------------------------------------- storage -- */

const STORAGE_KEY = 'spades-game-v1';

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {}
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/* ---------------------------------------------------------------- deck -- */

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    RANKS.forEach((rank, i) => deck.push({ suit: suit.sym, rank, value: i + 2 }));
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardSort(a, b) {
  if (a.suit !== b.suit) return SUIT_PRIORITY[a.suit] - SUIT_PRIORITY[b.suit];
  return a.value - b.value;
}

function deal() {
  const deck = shuffle(buildDeck());
  state.hands.you = deck.slice(0, 13).sort(cardSort);
  state.hands.left = deck.slice(13, 26);
  state.hands.top = deck.slice(26, 39);
  state.hands.right = deck.slice(39, 52);
}

function assignBotBids() {
  ORDER.filter((s) => s !== 'you').forEach((seat) => {
    const hand = state.hands[seat];
    const spades = hand.filter((c) => c.suit === '♠').length;
    const highs = hand.filter((c) => c.value >= 13).length;
    const estimate = Math.round(spades * 0.55 + highs * 0.5);
    state.bids[seat] = Math.min(9, Math.max(1, estimate));
  });
}

/* -------------------------------------------------------------- icons --- */

function svgSuit(suit) {
  const paths = {
    '♠': '<path d="M12 2C7 7 2 11 2 15.5 2 18.5 4.5 20.5 7.5 20.5 9 20.5 10.3 19.9 11.2 19 10.8 21 9.5 22.5 7.5 23L16.5 23C14.5 22.5 13.2 21 12.8 19 13.7 19.9 15 20.5 16.5 20.5 19.5 20.5 22 18.5 22 15.5 22 11 17 7 12 2Z"/>',
    '♥': '<path d="M12 21C12 21 3 14.5 3 8.5 3 5.5 5.3 3.5 8 3.5 9.8 3.5 11.2 4.5 12 6 12.8 4.5 14.2 3.5 16 3.5 18.7 3.5 21 5.5 21 8.5 21 14.5 12 21 12 21Z"/>',
    '♦': '<path d="M12 2L20 12 12 22 4 12Z"/>',
    '♣': '<circle cx="12" cy="8" r="4"/><circle cx="7.3" cy="13.2" r="4"/><circle cx="16.7" cy="13.2" r="4"/><path d="M10.3 15L13.7 15 15.2 23 8.8 23Z"/>',
  };
  return `<svg class="card-face-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${paths[suit]}</svg>`;
}

/* --------------------------------------------------------- card render - */

function createCardEl(card, { interactive = false, index = null } = {}) {
  const el = document.createElement(interactive ? 'button' : 'div');
  const suit = SUITS.find((s) => s.sym === card.suit);
  el.className = 'card' + (suit.red ? ' red' : '');
  if (interactive) {
    el.type = 'button';
    el.dataset.index = index;
    el.setAttribute('aria-label', `${card.rank} of ${suitName(card.suit)}`);
  }
  const center = ['J', 'Q', 'K'].includes(card.rank)
    ? `<span class="card-letter">${card.rank}</span>`
    : svgSuit(card.suit);
  el.innerHTML = `
    <span class="card-index"><span>${card.rank}</span><span class="pip">${card.suit}</span></span>
    <span class="card-index bottom"><span>${card.rank}</span><span class="pip">${card.suit}</span></span>
    <div class="card-center">${center}</div>`;
  return el;
}

function suitName(sym) {
  return { '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs' }[sym];
}

function renderYourHand(animate) {
  els.yourHand.innerHTML = '';
  state.hands.you.forEach((card, i) => {
    const btn = createCardEl(card, { interactive: true, index: i });
    btn.disabled = true;
    btn.style.animation = animate ? '' : 'none';
    if (animate) btn.style.animationDelay = `${i * 0.03}s`;
    btn.addEventListener('click', () => onYourPlay(i));
    els.yourHand.appendChild(btn);
  });
}

function renderOpponentCount(seat) {
  const container = els.cards[seat];
  container.innerHTML = '';
  state.hands[seat].forEach(() => {
    const back = document.createElement('div');
    back.className = 'opp-card';
    container.appendChild(back);
  });
}

function renderAllHands(animate) {
  renderYourHand(animate);
  renderOpponentCount('left');
  renderOpponentCount('top');
  renderOpponentCount('right');
  els.trickCards.innerHTML = '';
}

/* -------------------------------------------------------------- tally -- */

function renderTally(count) {
  els.tallyMarks.innerHTML = '';
  let remaining = count;
  while (remaining > 0) {
    const size = Math.min(5, remaining);
    const group = document.createElement('div');
    group.className = 'tally-group';
    for (let i = 0; i < size; i++) {
      const mark = document.createElement('span');
      mark.className = 'tally-mark';
      mark.style.animationDelay = `${i * 0.05}s`;
      group.appendChild(mark);
    }
    if (size === 5) {
      const strike = document.createElement('span');
      strike.className = 'tally-strike';
      group.appendChild(strike);
    }
    els.tallyMarks.appendChild(group);
    remaining -= 5;
  }
  els.bagCount.textContent = `${count} / 10`;
}

/* ---------------------------------------------------------- trick pile - */

function renderTrickPile(seat) {
  const pile = els.trickPile[seat];
  pile.innerHTML = '';
  for (let i = 0; i < state.tricksTaken[seat]; i++) {
    const card = document.createElement('div');
    card.className = 'pile-card';
    card.style.setProperty('--jitter', `${(i * 37) % 11 - 5}deg`);
    pile.appendChild(card);
  }
}

function renderAllTrickPiles() {
  ORDER.forEach(renderTrickPile);
}

/* ------------------------------------------------------------ history -- */

function renderHistory() {
  els.historyBody.innerHTML = '';
  state.history.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.round}</td>
      <td>${row.bid.us}/${row.bid.them}</td>
      <td>${row.books.us}/${row.books.them}</td>
      <td>${row.bags.us}/${row.bags.them}</td>
      <td>${row.score.us}/${row.score.them}</td>
    `;
    els.historyBody.appendChild(tr);
  });
}

function openHistory() {
  renderHistory();
  els.historyOverlay.hidden = false;
}

function closeHistory() {
  els.historyOverlay.hidden = true;
}

els.scorepad.addEventListener('click', openHistory);
els.overlayRecapBtn.addEventListener('click', openHistory);
els.historyCloseBtn.addEventListener('click', closeHistory);
els.historyOverlay.addEventListener('click', (e) => {
  if (e.target === els.historyOverlay) closeHistory();
});

function triggerBlot() {
  els.tallyBlot.classList.remove('show');
  void els.tallyBlot.offsetWidth;
  els.tallyBlot.classList.add('show');
}

/* -------------------------------------------------------------- banner - */

function showBanner(text, duration = 1200) {
  els.roundBanner.textContent = text;
  els.roundBanner.classList.remove('show');
  void els.roundBanner.offsetWidth;
  els.roundBanner.style.animationDuration = `${duration}ms`;
  els.roundBanner.classList.add('show');
}

/* -------------------------------------------------------------- turns -- */

function setActiveSeat(seat) {
  ORDER.forEach((s) => els.seat[s].classList.toggle('active', s === seat));
}

function currentSeq() {
  const startIdx = ORDER.indexOf(state.leader);
  return [...ORDER.slice(startIdx), ...ORDER.slice(0, startIdx)];
}

function getLegalIndices(hand, ledSuit, isLeading, spadesBroken) {
  const all = hand.map((_, i) => i);
  if (isLeading) {
    if (!spadesBroken) {
      const nonSpade = all.filter((i) => hand[i].suit !== '♠');
      if (nonSpade.length) return nonSpade;
    }
    return all;
  }
  const same = all.filter((i) => hand[i].suit === ledSuit);
  return same.length ? same : all;
}

function enableLegalCardsForYou() {
  const isLeading = state.currentTrick.length === 0;
  const ledSuit = isLeading ? null : state.currentTrick[0].card.suit;
  const legal = getLegalIndices(state.hands.you, ledSuit, isLeading, state.spadesBroken);
  els.yourHand.querySelectorAll('.card').forEach((btn) => {
    btn.disabled = !legal.includes(Number(btn.dataset.index));
  });
}

function disableYourCards() {
  els.yourHand.querySelectorAll('.card').forEach((btn) => (btn.disabled = true));
}

function scheduleNextPlayer() {
  const seq = currentSeq();
  const nextSeat = seq[state.currentTrick.length];
  setActiveSeat(nextSeat);
  if (nextSeat === 'you') {
    enableLegalCardsForYou();
  } else {
    setTimeout(() => botPlay(nextSeat), 550 + Math.random() * 450);
  }
}

function onYourPlay(idx) {
  playCard('you', idx);
}

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

function restOffset(seat) {
  const key = seat === 'you' ? 'bottom' : seat;
  return { bottom: [0, 46], top: [0, -46], left: [-64, 0], right: [64, 0] }[key];
}

function renderTrickCard(seat, card) {
  const el = createCardEl(card, { interactive: false });
  el.classList.add('trick-card');
  const [x, y] = restOffset(seat);
  const jitter = Math.random() * 10 - 5;
  el.style.setProperty('--rot', `translate(${x + (Math.random() * 8 - 4)}px, ${y}px) rotate(${jitter}deg)`);
  els.trickCards.appendChild(el);
}

function playCard(seat, idx) {
  const hand = state.hands[seat];
  const card = hand.splice(idx, 1)[0];
  state.currentTrick.push({ seat, card });

  if (card.suit === '♠' && !state.spadesBroken) {
    state.spadesBroken = true;
    els.brokenTag.dataset.broken = 'true';
    els.brokenTag.textContent = 'Spades broken';
  }

  renderTrickCard(seat, card);
  if (seat === 'you') renderYourHand(false);
  else renderOpponentCount(seat);

  disableYourCards();
  setActiveSeat(null);

  if (state.currentTrick.length === 4) {
    setTimeout(resolveTrickFlow, 650);
  } else {
    scheduleNextPlayer();
  }
  saveState();
}

function determineWinner() {
  const ledSuit = state.currentTrick[0].card.suit;
  const spadesPlayed = state.currentTrick.filter((p) => p.card.suit === '♠');
  const contenders = spadesPlayed.length ? spadesPlayed : state.currentTrick.filter((p) => p.card.suit === ledSuit);
  return contenders.reduce((best, p) => (p.card.value > best.card.value ? p : best), contenders[0]).seat;
}

function resolveTrickFlow() {
  const winner = determineWinner();
  state.tricksTaken[winner]++;
  renderTrickPile(winner);
  showBanner(`${NAMES[winner]} takes it`, 850);

  const sweepTo = {
    bottom: 'translateY(160px)',
    top: 'translateY(-160px)',
    left: 'translateX(-180px)',
    right: 'translateX(180px)',
  }[winner === 'you' ? 'bottom' : winner];

  els.trickCards.querySelectorAll('.trick-card').forEach((el) => {
    el.style.setProperty('--sweep-to', sweepTo);
    el.classList.add('sweep');
  });

  setTimeout(() => {
    els.trickCards.innerHTML = '';
    state.currentTrick = [];
    state.leader = winner;
    const handsEmpty = Object.values(state.hands).every((h) => h.length === 0);
    if (handsEmpty) endHand();
    else scheduleNextPlayer();
    saveState();
  }, 520);
}

/* -------------------------------------------------------------- score -- */

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

function endHand() {
  const us = computeTeamResult(['you', 'top']);
  const them = computeTeamResult(['left', 'right']);

  state.teamScore.us += us.base;
  state.teamScore.them += them.base;
  state.teamBags.us += us.bags;
  state.teamBags.them += them.bags;

  let penaltyNote = '';
  if (state.teamBags.us >= 10) {
    state.teamBags.us -= 10;
    state.teamScore.us -= 100;
    penaltyNote = ' · bagged out −100';
    triggerBlot();
  }
  if (state.teamBags.them >= 10) {
    state.teamBags.them -= 10;
    state.teamScore.them -= 100;
  }

  renderTally(state.teamBags.us);
  els.scoreUs.textContent = state.teamScore.us;
  els.scoreThem.textContent = state.teamScore.them;

  state.history.push({
    round: state.round,
    bid: { us: us.bid, them: them.bid },
    books: { us: us.books, them: them.books },
    bags: { us: state.teamBags.us, them: state.teamBags.them },
    score: { us: state.teamScore.us, them: state.teamScore.them },
  });

  let resultText = us.base >= 0 ? `+${us.base}` : `${us.base}`;
  if (state.bids.you === 'nil') {
    resultText += state.tricksTaken.you === 0 ? ' · nil made' : ' · nil failed';
  }
  showBanner(resultText + penaltyNote, 2200);

  const winner = decideGameWinner();
  if (winner) {
    setTimeout(() => showGameOver(winner), 2500);
  } else {
    setTimeout(startNewRound, 2500);
  }
}

function decideGameWinner() {
  const usOver = state.teamScore.us >= state.targetScore;
  const themOver = state.teamScore.them >= state.targetScore;
  if (!usOver && !themOver) return null;
  if (state.teamScore.us === state.teamScore.them) return null;
  return state.teamScore.us > state.teamScore.them ? 'us' : 'them';
}

function nextInOrder(seat) {
  return ORDER[(ORDER.indexOf(seat) + 1) % 4];
}

/* -------------------------------------------------------------- bid UI - */

function resetBidUI() {
  state.selectedBid = null;
  els.bidGrid.querySelectorAll('.bid-num').forEach((b) => b.classList.remove('selected'));
  els.bidNilBtn.classList.remove('selected');
  els.bidConfirm.disabled = true;
  ORDER.forEach((s) => (els.bidPill[s].textContent = '—'));
}

function buildBidGrid() {
  els.bidGrid.innerHTML = '';
  for (let n = 0; n <= 13; n++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bid-num';
    btn.textContent = n;
    btn.addEventListener('click', () => {
      state.selectedBid = n;
      els.bidGrid.querySelectorAll('.bid-num').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      els.bidNilBtn.classList.remove('selected');
      els.bidConfirm.disabled = false;
    });
    els.bidGrid.appendChild(btn);
  }
}

els.bidNilBtn.addEventListener('click', () => {
  state.selectedBid = 'nil';
  els.bidGrid.querySelectorAll('.bid-num').forEach((b) => b.classList.remove('selected'));
  els.bidNilBtn.classList.add('selected');
  els.bidConfirm.disabled = false;
});

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

function startBidding() {
  resetBidUI();
  els.bidSlip.hidden = false;
}

/* -------------------------------------------------------------- round -- */

function startNewRound() {
  state.round++;
  els.roundNum.textContent = state.round;
  state.dealer = nextInOrder(state.dealer);
  state.leader = nextInOrder(state.dealer);
  state.bids = {};
  state.tricksTaken = { you: 0, left: 0, top: 0, right: 0 };
  state.spadesBroken = false;
  els.brokenTag.dataset.broken = 'false';
  els.brokenTag.textContent = 'Spades not broken';
  els.dealerTag.textContent = `Dealer: ${NAMES[state.dealer]}`;
  renderAllTrickPiles();

  deal();
  assignBotBids();
  renderAllHands(true);
  startBidding();
  saveState();
}

/* ------------------------------------------------------------- overlay -- */

const TEAM_LABEL = { us: 'You + Priya', them: 'Marcus + Dana' };

function showGameOver(winner) {
  els.overlayTitle.textContent = winner === 'us' ? 'You win!' : 'They win!';
  els.overlaySubtitle.textContent = `${TEAM_LABEL[winner]} reached the target.`;
  els.overlayResult.hidden = false;
  els.overlayResult.textContent =
    `You + Priya ${state.teamScore.us} · Marcus + Dana ${state.teamScore.them} (target ${state.targetScore})`;
  els.overlayRecapBtn.hidden = false;
  els.overlayStartBtn.textContent = 'New game';
  els.gameOverlay.hidden = false;
}

function startGame() {
  const raw = parseInt(els.targetScoreInput.value, 10);
  state.targetScore = Number.isFinite(raw) && raw >= 50 ? raw : 500;
  els.targetScoreInput.value = state.targetScore;

  state.round = 1;
  state.dealer = 'you';
  state.teamScore = { us: 0, them: 0 };
  state.teamBags = { us: 0, them: 0 };
  state.tricksTaken = { you: 0, left: 0, top: 0, right: 0 };
  state.spadesBroken = false;
  state.bids = {};
  state.currentTrick = [];
  state.history = [];

  els.roundNum.textContent = state.round;
  els.scoreUs.textContent = 0;
  els.scoreThem.textContent = 0;
  renderTally(0);
  renderAllTrickPiles();
  els.overlayRecapBtn.hidden = true;
  els.brokenTag.dataset.broken = 'false';
  els.brokenTag.textContent = 'Spades not broken';
  els.dealerTag.textContent = `Dealer: ${NAMES[state.dealer]}`;

  els.overlayTitle.textContent = 'Spades';
  els.overlaySubtitle.textContent = 'First team to the target score wins.';
  els.overlayResult.hidden = true;
  els.overlayStartBtn.textContent = 'Start game';
  els.gameOverlay.hidden = true;

  deal();
  assignBotBids();
  renderAllHands(true);
  startBidding();
  saveState();
}

els.overlayStartBtn.addEventListener('click', startGame);

/* ---------------------------------------------------------------- exit -- */

function openExitConfirm() {
  els.exitConfirmOverlay.hidden = false;
}

function closeExitConfirm() {
  els.exitConfirmOverlay.hidden = true;
}

function exitGame() {
  closeExitConfirm();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {}

  state.hands = { you: [], left: [], top: [], right: [] };
  state.bids = {};
  state.tricksTaken = { you: 0, left: 0, top: 0, right: 0 };
  state.teamBags = { us: 0, them: 0 };
  state.teamScore = { us: 0, them: 0 };
  state.round = 1;
  state.dealer = 'you';
  state.leader = 'left';
  state.spadesBroken = false;
  state.currentTrick = [];
  state.selectedBid = null;
  state.history = [];

  els.bidSlip.hidden = true;
  els.trickCards.innerHTML = '';
  setActiveSeat(null);
  renderAllHands(false);
  renderAllTrickPiles();
  renderTally(0);
  els.roundNum.textContent = state.round;
  els.scoreUs.textContent = 0;
  els.scoreThem.textContent = 0;
  els.brokenTag.dataset.broken = 'false';
  els.brokenTag.textContent = 'Spades not broken';
  els.dealerTag.textContent = `Dealer: ${NAMES[state.dealer]}`;

  els.overlayTitle.textContent = 'Spades';
  els.overlaySubtitle.textContent = 'First team to the target score wins.';
  els.overlayResult.hidden = true;
  els.overlayRecapBtn.hidden = true;
  els.overlayStartBtn.textContent = 'Start game';
  els.gameOverlay.hidden = false;
}

els.exitBtn.addEventListener('click', openExitConfirm);
els.exitCancelBtn.addEventListener('click', closeExitConfirm);
els.exitConfirmBtn.addEventListener('click', exitGame);
els.exitConfirmOverlay.addEventListener('click', (e) => {
  if (e.target === els.exitConfirmOverlay) closeExitConfirm();
});

/* -------------------------------------------------------------- resume - */

function restoreState(saved) {
  Object.assign(state, saved);

  els.dealerTag.textContent = `Dealer: ${NAMES[state.dealer]}`;
  els.brokenTag.dataset.broken = String(state.spadesBroken);
  els.brokenTag.textContent = state.spadesBroken ? 'Spades broken' : 'Spades not broken';
  els.roundNum.textContent = state.round;
  els.scoreUs.textContent = state.teamScore.us;
  els.scoreThem.textContent = state.teamScore.them;
  renderTally(state.teamBags.us);
  renderAllTrickPiles();
  els.targetScoreInput.value = state.targetScore;
  renderAllHands(false);
  state.currentTrick.forEach(({ seat, card }) => renderTrickCard(seat, card));

  const winner = decideGameWinner();
  if (winner) {
    showGameOver(winner);
    return;
  }
  els.gameOverlay.hidden = true;

  if (Object.values(state.hands).every((h) => h.length === 0)) {
    startNewRound();
    return;
  }

  if (state.bids.you === undefined) {
    startBidding();
    return;
  }

  ORDER.forEach((s) => {
    els.bidPill[s].textContent = state.bids[s] === 'nil' ? 'Nil' : state.bids[s];
  });
  els.bidSlip.hidden = true;

  if (state.currentTrick.length === 4) {
    resolveTrickFlow();
  } else {
    scheduleNextPlayer();
  }
}

function init() {
  buildBidGrid();
  const saved = loadSavedState();
  if (saved) {
    restoreState(saved);
  } else {
    renderTally(0);
    els.dealerTag.textContent = `Dealer: ${NAMES[state.dealer]}`;
  }
}

init();
