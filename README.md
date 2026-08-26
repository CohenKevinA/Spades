# Spades

A single-player Spades game that runs entirely in the browser — no build step, no dependencies. You play against three AI opponents (Priya, Marcus, Dana) at a wood card table.

## Playing

Open `index.html` in a browser, or serve the folder locally:

```
python -m http.server 8000
```

then visit `http://localhost:8000`.

Set a target score (default 500) and hit **Start game**. Bid your tricks each hand (or call Nil), follow suit when you can, and the first team to reach the target score wins.

## Rules implemented

- Standard 4-player partnership Spades (You + Priya vs. Marcus + Dana)
- Nil bids, bag tracking, and the −100 penalty at 10 bags
- Spades can't be led until broken (unless a hand is spades-only)
- Adjustable win target, set at the start of each game

## Files

- `index.html` — table markup and start/game-over overlay
- `script.js` — game state, dealing, bidding, trick logic, scoring
- `styles.css` — wood-table visual theme
- `assets/` — card-back crest image
