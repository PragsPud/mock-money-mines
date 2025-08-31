# Mines (Mock Money, Provably-Fair Style)

A browser-only, educational Mines-style game (5×5 grid, 1–24 mines) that demonstrates a transparent, provably-fair style commit–reveal scheme with mock balance and verifiable mine placement. The app uses the Web Crypto API for SHA-256 and HMAC-SHA-256, requires no server, and focuses on accessibility, keyboard usability, and clear math.

## Features
- 5×5 grid Mines gameplay with adjustable mines and a cash-out-at-any-time flow.
- Provably-fair demo: pre-round server seed hash commitment, post-round seed reveal, and deterministic mine placement derived from HMAC(serverSeed, clientSeed:nonce:counter).
- Transparent multipliers: dynamic payout computed from fair odds with an adjustable house edge parameter for experimentation.
- Accessibility-first: proper form labels, non-submitting buttons, aria-live updates, and arrow-key navigation across tiles with roving tabindex.
- Persistence: mock balance saved locally via localStorage.

## How it works
- Commitment: Before each round, a random server seed is generated and its SHA-256 hash is displayed. After the round ends (bust or cash out), the server seed is revealed so the commitment can be verified.
- Determinism: Mines are selected by shuffling indices 0–24 using a keystream produced by HMAC-SHA-256(serverSeed, `${clientSeed}:${nonce}:${counter}`) and a Fisher–Yates shuffle.
- Odds and multipliers: The probability of r safe picks with M mines is Π_{i=0..r-1} (25 - M - i)/(25 - i), and the fair multiplier is 1/probability. The app applies a configurable “house edge” for educational comparison.

## Keyboard and accessibility
- Arrow keys move focus across the 5×5 board (roving tabindex), and tiles announce their row/column and state to assistive tech.
- Form controls have labels connected via for/id, and live status updates are announced via aria-live.

## Files
- index.html – markup and structure.
- styles.css – layout and theme.
- app.js – logic, cryptography, math, and interactions.

## Running
Open index.html directly in a modern browser; no build or server is required.  
The Github Pages version can be accessed [here](https://pragspud.github.io/mock-money-mines/).

## Verifying a round
1. Start a round to see the server seed hash (commitment) and the effective client seed and nonce.
2. Finish the round by busting or cashing out to reveal the server seed.
3. Click “Verify commitment” to recompute SHA-256(serverSeed) and confirm it matches the pre-round hash.
4. Optionally re-derive the mine order using the client seed, nonce, and server seed to confirm the tile set.

## Notes
- This is an educational replica with mock money and transparent math; it’s not a gambling product.
- Browser support requires the Web Crypto API (SubtleCrypto.digest and SubtleCrypto.sign).
