// ---------- Utilities: format ----------
const fmtMoney = (n) => {
  const sign = n < 0 ? "-" : "";
  const val = Number.isFinite(n) ? Math.abs(n) : 0;
  return sign + "$" + val.toFixed(2);
};

// ---------- Utilities: WebCrypto wrappers (SHA-256, HMAC-SHA-256) ----------
const enc = new TextEncoder();

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return bufToHex(digest);
}

async function hmacSHA256Hex(keyRaw, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(keyRaw),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return bufToHex(sig);
}

function bufToHex(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) {
    s += b[i].toString(16).padStart(2, "0");
  }
  return s;
}

function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return arr;
}

// ---------- Deterministic PRNG from HMAC(serverSeed, clientSeed:nonce:counter) ----------
function Keystream(serverSeed, clientSeed, nonce) {
  let counter = 0;
  let buffer = new Uint8Array(0);
  return {
    async refill() {
      const msg = `${clientSeed}:${nonce}:${counter++}`;
      const hex = await hmacSHA256Hex(serverSeed, msg);
      buffer = hexToBytes(hex);
    },
    async nextFloat() {
      if (buffer.length < 4) {
        await this.refill();
      }
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const val = view.getUint32(0, false);
      buffer = buffer.slice(4);
      return val / (0x100000000);
    }
  };
}

async function shuffleDeterministic(n, ks) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const r = await ks.nextFloat();
    const j = Math.floor(r * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- Probability / Multiplier ----------
function probabilitySafePicks(r, mines, total = 25) {
  if (r <= 0) return 1;
  let prob = 1;
  for (let i = 0; i < r; i++) {
    const safeLeft = (total - mines) - i;
    const tilesLeft = total - i;
    if (safeLeft <= 0) return 0;
    prob *= safeLeft / tilesLeft;
  }
  return prob;
}

function payoutMultiplier(r, mines, houseEdgePct) {
  if (r <= 0) return 1;
  const prob = probabilitySafePicks(r, mines);
  if (prob <= 0) return Infinity;
  const edge = Math.max(0, Math.min(0.99, houseEdgePct / 100));
  return (1 - edge) / prob;
}

// ---------- Game State ----------
const gridEl = document.getElementById("mainBoard");
const balanceEl = document.getElementById("balance");
const badgeEl = document.getElementById("roundBadge");
const safeCountEl = document.getElementById("safeCount");
const multEl = document.getElementById("multiplier");
const cashOutEl = document.getElementById("cashOutValue");
const serverHashEl = document.getElementById("serverHash");
const serverSeedEl = document.getElementById("serverSeed");
const clientSeedShowEl = document.getElementById("clientSeedShow");
const nonceShowEl = document.getElementById("nonceShow");
const verifyBtn = document.getElementById("verifyBtn");
const nextRoundBtn = document.getElementById("nextRoundBtn");
const cashOutBtn = document.getElementById("cashOutBtn");
const newGameBtn = document.getElementById("newGameBtn");
const statusBox = document.getElementById("statusBox");

const betEl = document.getElementById("bet");
const minesEl = document.getElementById("mines");
const edgeEl = document.getElementById("edge");
const clientSeedEl = document.getElementById("clientSeed");

let balance = 1000.00;
let roundActive = false;
let currentBet = 0;
let minesCount = 3;
let houseEdgePct = 3.0;
let serverSeed = null;
let serverSeedHash = null;
let clientSeed = null;
let nonce = 0; // start from 0, increment each round
let minesSet = new Set();
let revealed = new Set();
let safeReveals = 0;
let keystream = null;

// Roving tabindex tracking for 5x5 grid keyboard navigation
let focusIndex = 0;

function loadBalance() {
  const v = localStorage.getItem("mines_mock_balance");
  if (v && !isNaN(parseFloat(v))) balance = parseFloat(v);
  balanceEl.textContent = fmtMoney(balance);
}
function saveBalance() {
  localStorage.setItem("mines_mock_balance", balance.toFixed(2));
  balanceEl.textContent = fmtMoney(balance);
}

function randomHex(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2,"0")).join("");
}

function setBadge(text, color = null) {
  badgeEl.textContent = text;
  badgeEl.style.background = color ? color : "#1b2037";
}

function tileAriaLabel(index, state) {
  const row = Math.floor(index / 5) + 1;
  const col = (index % 5) + 1;
  if (state === "hidden") return `Tile row ${row} column ${col}, hidden`;
  if (state === "safe") return `Tile row ${row} column ${col}, safe`;
  if (state === "mine") return `Tile row ${row} column ${col}, mine`;
  return `Tile row ${row} column ${col}`;
}

function getTile(index) {
  return gridEl.querySelector(`.tile[data-idx="${index}"]`);
}

function applyRovingTabindex() {
  const tiles = gridEl.querySelectorAll(".tile");
  let hasFocusable = false;
  tiles.forEach((t, i) => {
    const focusable = (i === focusIndex && !t.disabled);
    t.tabIndex = focusable ? 0 : -1;
    if (focusable) hasFocusable = true;
  });
  // If the current focusIndex is not focusable, move to the next available tile
  if (!hasFocusable) {
    for (let i = 0; i < tiles.length; i++) {
      if (!tiles[i].disabled) {
        focusIndex = i;
        tiles[i].tabIndex = 0;
        break;
      }
    }
  }
}

function bindGridKeyboardOnce() {
  if (gridEl.dataset.kbBound === "1") return;
  gridEl.addEventListener("keydown", onGridKeydown);
  gridEl.dataset.kbBound = "1";
}

function resetBoard() {
  gridEl.innerHTML = "";
  for (let i = 0; i < 25; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tile";
    b.dataset.idx = i.toString();
    b.setAttribute("aria-label", tileAriaLabel(i, "hidden"));
    b.addEventListener("click", onTileClick);
    gridEl.appendChild(b);
  }
  focusIndex = 0;
  applyRovingTabindex();
}

function updateStatusUI() {
  const mult = payoutMultiplier(safeReveals, minesCount, houseEdgePct);
  const multDisplay = Number.isFinite(mult) ? `${mult.toFixed(2)}×` : "—×";
  multEl.textContent = multDisplay;
  const val = roundActive && Number.isFinite(mult) ? currentBet * mult : 0;
  cashOutEl.textContent = fmtMoney(val);
  safeCountEl.textContent = String(safeReveals);
  cashOutBtn.disabled = !(roundActive && safeReveals > 0 && Number.isFinite(mult));
  verifyBtn.disabled = !(serverSeed && serverSeedHash && !roundActive && serverSeedEl.textContent !== "—");
  nextRoundBtn.disabled = roundActive;
}

function clampInputs() {
  // Bet
  let bet = parseFloat(betEl.value || "0");
  if (!isFinite(bet) || bet <= 0) bet = 1.00;
  betEl.value = bet.toFixed(2);
  // Mines
  let m = parseInt(minesEl.value || "3", 10);
  if (!Number.isInteger(m)) m = 3;
  m = Math.max(1, Math.min(24, m));
  minesEl.value = String(m);
  minesCount = m;
  // Edge
  let e = parseFloat(edgeEl.value || "3");
  if (!isFinite(e)) e = 3;
  e = Math.max(0, Math.min(10, e));
  edgeEl.value = e.toFixed(1);
  houseEdgePct = e;
  updateStatusUI();
}

async function startRound() {
  if (roundActive) return;
  clampInputs();
  const bet = parseFloat(betEl.value);
  if (bet > balance) {
    alert("Insufficient balance");
    return;
  }

  // Seeds and nonce
  clientSeed = (clientSeedEl.value && clientSeedEl.value.trim().length > 0) ? clientSeedEl.value.trim() : randomHex(16);
  serverSeed = randomHex(32);
  serverSeedHash = await sha256Hex(serverSeed);
  nonce = (nonce || 0) + 1;

  clientSeedShowEl.textContent = clientSeed;
  nonceShowEl.textContent = String(nonce);
  serverSeedEl.textContent = "—";
  serverHashEl.textContent = serverSeedHash;

  // Deterministic tile shuffle and mine set
  keystream = Keystream(serverSeed, clientSeed, nonce);
  const order = await shuffleDeterministic(25, keystream);
  minesSet = new Set(order.slice(0, minesCount));

  // Deduct bet, reset round state
  balance -= bet; saveBalance();
  currentBet = bet;
  safeReveals = 0;
  revealed = new Set();
  roundActive = true;
  setBadge("Live", "linear-gradient(180deg, #7b1fa2, #53236f)");
  statusBox.classList.remove("win","lose");

  resetBoard();
  updateStatusUI();
}

function revealAll(finalHitIndex = null) {
  const tiles = Array.from(gridEl.querySelectorAll(".tile"));
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const idx = parseInt(t.dataset.idx, 10);
    if (minesSet.has(idx)) {
      t.classList.add("revealed","mine");
      t.textContent = "💣";
      t.setAttribute("aria-label", tileAriaLabel(idx, "mine"));
      t.disabled = true;
    } else if (revealed.has(idx)) {
      // already marked safe
    } else {
      t.classList.add("revealed","safe");
      t.textContent = "💎";
      t.setAttribute("aria-label", tileAriaLabel(idx, "safe"));
      t.disabled = true;
    }
  }
  if (finalHitIndex !== null) {
    const t = getTile(finalHitIndex);
    if (t) t.style.boxShadow = "0 0 0 3px rgba(229,57,53,0.6) inset";
  }
  applyRovingTabindex();
}

function moveFocusToNextAvailable(fromIndex) {
  for (let i = fromIndex + 1; i < 25; i++) {
    const btn = getTile(i);
    if (btn && !btn.disabled) {
      focusIndex = i;
      applyRovingTabindex();
      return;
    }
  }
  // If none ahead, keep current focusIndex as-is
  applyRovingTabindex();
}

function onTileClick(e) {
  if (!roundActive) return;
  const btn = e.currentTarget;
  const idx = parseInt(btn.dataset.idx, 10);
  if (revealed.has(idx) || btn.disabled) return;

  if (minesSet.has(idx)) {
    // Mine hit — lose bet
    btn.classList.add("revealed","mine");
    btn.textContent = "💣";
    btn.setAttribute("aria-label", tileAriaLabel(idx, "mine"));
    btn.disabled = true;
    revealed.add(idx);
    roundActive = false;
    revealAll(idx);
    setBadge("Busted", "linear-gradient(180deg, #e53935, #b72824)");
    statusBox.classList.add("lose");
    // reveal server seed now
    serverSeedEl.textContent = serverSeed;
    updateStatusUI();
    return;
  } else {
    // Safe
    btn.classList.add("revealed","safe");
    btn.textContent = "💎";
    btn.setAttribute("aria-label", tileAriaLabel(idx, "safe"));
    btn.disabled = true;
    revealed.add(idx);
    safeReveals++;
    // Move focus to next available tile for keyboard users
    moveFocusToNextAvailable(idx);
    updateStatusUI();
  }
}

function doCashOut() {
  if (!roundActive) return;
  if (safeReveals <= 0) return;
  const mult = payoutMultiplier(safeReveals, minesCount, houseEdgePct);
  if (!Number.isFinite(mult)) return;
  const payout = currentBet * mult;
  balance += payout; saveBalance();
  roundActive = false;
  setBadge("Cashed out", "linear-gradient(180deg, #4caf50, #3d8b41)");
  statusBox.classList.add("win");
  revealAll(null);
  // reveal server seed now
  serverSeedEl.textContent = serverSeed;
  updateStatusUI();
}

// Keyboard navigation: arrows move focus among tiles (roving tabindex)
function onGridKeydown(e) {
  const key = e.key;
  const cols = 5;
  const rows = 5;
  let row = Math.floor(focusIndex / cols);
  let col = focusIndex % cols;
  if (key === "ArrowRight") { col = Math.min(cols - 1, col + 1); e.preventDefault(); }
  else if (key === "ArrowLeft") { col = Math.max(0, col - 1); e.preventDefault(); }
  else if (key === "ArrowDown") { row = Math.min(rows - 1, row + 1); e.preventDefault(); }
  else if (key === "ArrowUp") { row = Math.max(0, row - 1); e.preventDefault(); }
  else { return; }
  const next = row * cols + col;
  focusIndex = next;
  applyRovingTabindex();
  const btn = getTile(focusIndex);
  if (btn && !btn.disabled) btn.focus();
}

async function verifyCommitment() {
  // Only meaningful after reveal
  if (!serverSeed || !serverSeedHash || roundActive || serverSeedEl.textContent === "—") return;
  const h = await sha256Hex(serverSeed);
  const ok = (h === serverSeedHash);
  alert(ok ? "Verified: SHA-256(serverSeed) matches the pre-commit hash." : "Mismatch: commitment verification failed!");
}

function nextRound() {
  setBadge("Idle");
  serverSeed = null;
  serverSeedHash = null;
  serverSeedEl.textContent = "—";
  serverHashEl.textContent = "—";
  safeReveals = 0;
  revealed = new Set();
  statusBox.classList.remove("win","lose");
  resetBoard();
  updateStatusUI();
}

// Wire up controls
newGameBtn.addEventListener("click", startRound);
cashOutBtn.addEventListener("click", doCashOut);
verifyBtn.addEventListener("click", verifyCommitment);
nextRoundBtn.addEventListener("click", nextRound);

// Clamp inputs on change to keep values valid
[betEl, minesEl, edgeEl].forEach(el => {
  el.addEventListener("change", clampInputs);
  el.addEventListener("blur", clampInputs);
});

// Prevent Enter in text/number inputs from submitting the form
document.getElementById("controlsForm").addEventListener("submit", (e) => e.preventDefault());

// Initialize once
loadBalance();
resetBoard();
bindGridKeyboardOnce();
updateStatusUI();
