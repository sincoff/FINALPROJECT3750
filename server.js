/**
 * Battleship V2+ — Server
 * - Iteration 1: Server-controlled state; New Game vs Restart
 * - Iteration 2: Explicit game state machine (SETUP, PLAYER_TURN, COMPUTER_TURN, GAME_OVER)
 * - Advanced: Persistent storage (JSON); game survives server restart
 * - Advanced AI: Hunt/target behavior; memory of hits (target queue of adjacent cells)
 * - Exam Feature 1: Persistent scoreboard (JSON) — wins, losses, accuracy, streaks
 * - Exam Feature 2: AI difficulty levels (easy, medium, hard)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const GRID_SIZE = 10;
const SHIP_SPECS = [
  { name: '1×4', length: 4 },
  { name: '1×3', length: 3 },
  { name: '1×2', length: 2 },
];

const STATE = {
  SETUP: 'SETUP',
  PLAYER_TURN: 'PLAYER_TURN',
  COMPUTER_TURN: 'COMPUTER_TURN',
  GAME_OVER: 'GAME_OVER',
};

const DIFFICULTY = {
  EASY: 'easy',
  MEDIUM: 'medium',
  HARD: 'hard',
};

const STATE_FILE = path.join(__dirname, 'game-state.json');
const SCOREBOARD_FILE = path.join(__dirname, 'scoreboard.json');

function key(r, c) {
  return `${r},${c}`;
}

function placeShipRandom(grid, spec) {
  const vertical = Math.random() < 0.5;
  const maxRow = vertical ? GRID_SIZE - spec.length : GRID_SIZE - 1;
  const maxCol = vertical ? GRID_SIZE - 1 : GRID_SIZE - spec.length;
  if (maxRow < 0 || maxCol < 0) return null;
  for (let attempt = 0; attempt < 200; attempt++) {
    const r = Math.floor(Math.random() * (maxRow + 1));
    const c = Math.floor(Math.random() * (maxCol + 1));
    const cells = [];
    for (let i = 0; i < spec.length; i++) {
      cells.push({ row: vertical ? r + i : r, col: vertical ? c : c + i });
    }
    const occupied = new Set(grid.flatMap(s => s.cells.map(c => key(c.row, c.col))));
    if (cells.every(cell => !occupied.has(key(cell.row, cell.col)))) {
      return { name: spec.name, length: spec.length, cells };
    }
  }
  return null;
}

function placeEnemyShips() {
  const enemy = [];
  for (const spec of SHIP_SPECS) {
    let s;
    while (!(s = placeShipRandom(enemy, spec))) {}
    enemy.push(s);
  }
  return enemy;
}

function countShipsLeft(ships, hitsSet) {
  return ships.filter(ship =>
    ship.cells.some(c => !hitsSet.has(key(c.row, c.col)))
  ).length;
}

function validatePlacement(ships) {
  if (!Array.isArray(ships) || ships.length !== 3) return { ok: false, message: 'Must place exactly 3 ships' };
  const lengths = ships.map(s => s.length).sort((a, b) => b - a);
  if (lengths[0] !== 4 || lengths[1] !== 3 || lengths[2] !== 2) return { ok: false, message: 'Ships must be length 4, 3, and 2' };
  const occupied = new Set();
  for (const ship of ships) {
    if (!ship.cells || !Array.isArray(ship.cells)) return { ok: false, message: 'Invalid ship cells' };
    for (const cell of ship.cells) {
      const r = cell.row, c = cell.col;
      if (r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) return { ok: false, message: 'Ship out of bounds' };
      const k = key(r, c);
      if (occupied.has(k)) return { ok: false, message: 'Ships overlap' };
      occupied.add(k);
    }
  }
  return { ok: true };
}

// In-memory game state (also persisted to JSON)
let game = {
  state: STATE.SETUP,
  winner: null,
  difficulty: DIFFICULTY.MEDIUM, // default difficulty
  yourShips: [],
  enemyShips: [],
  yourHits: [],
  yourMisses: [],
  enemyHits: [],
  enemyMisses: [],
  aiTargetQueue: [], // hunt/target: cells adjacent to hits, not yet fired (strings "r,c")
};

// ========== SCOREBOARD (Persistent JSON) ==========

const DEFAULT_SCOREBOARD = {
  wins: 0,
  losses: 0,
  totalGames: 0,
  totalPlayerShots: 0,
  totalPlayerHits: 0,
  bestGame: null, // fewest shots to win (null = no wins yet)
  currentWinStreak: 0,
  longestWinStreak: 0,
  currentLossStreak: 0,
  longestLossStreak: 0,
  gameHistory: [], // last 20 games: { result, shots, hits, difficulty, date }
};

let scoreboard = { ...DEFAULT_SCOREBOARD };

function loadScoreboard() {
  try {
    if (fs.existsSync(SCOREBOARD_FILE)) {
      const raw = fs.readFileSync(SCOREBOARD_FILE, 'utf8');
      const data = JSON.parse(raw);
      // Merge with defaults so new fields are always present
      scoreboard = { ...DEFAULT_SCOREBOARD, ...data };
      if (!Array.isArray(scoreboard.gameHistory)) scoreboard.gameHistory = [];
      return true;
    }
  } catch (err) {
    console.error('Failed to load scoreboard:', err.message);
  }
  return false;
}

function saveScoreboard() {
  try {
    const fd = fs.openSync(SCOREBOARD_FILE, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(scoreboard, null, 2), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    console.error('Failed to save scoreboard:', err.message);
  }
}

function recordGameResult(winner) {
  const playerShots = game.enemyHits.length + game.enemyMisses.length;
  const playerHits = game.enemyHits.length;
  const result = winner === 'player' ? 'win' : 'loss';

  scoreboard.totalGames++;
  scoreboard.totalPlayerShots += playerShots;
  scoreboard.totalPlayerHits += playerHits;

  if (result === 'win') {
    scoreboard.wins++;
    scoreboard.currentWinStreak++;
    scoreboard.currentLossStreak = 0;
    if (scoreboard.currentWinStreak > scoreboard.longestWinStreak) {
      scoreboard.longestWinStreak = scoreboard.currentWinStreak;
    }
    if (scoreboard.bestGame === null || playerShots < scoreboard.bestGame) {
      scoreboard.bestGame = playerShots;
    }
  } else {
    scoreboard.losses++;
    scoreboard.currentLossStreak++;
    scoreboard.currentWinStreak = 0;
    if (scoreboard.currentLossStreak > scoreboard.longestLossStreak) {
      scoreboard.longestLossStreak = scoreboard.currentLossStreak;
    }
  }

  // Keep last 20 games in history
  scoreboard.gameHistory.push({
    result,
    shots: playerShots,
    hits: playerHits,
    difficulty: game.difficulty || 'medium',
    date: new Date().toISOString(),
  });
  if (scoreboard.gameHistory.length > 20) {
    scoreboard.gameHistory = scoreboard.gameHistory.slice(-20);
  }

  saveScoreboard();
}

function yourHitsSet() {
  return new Set(game.yourHits);
}

function yourMissesSet() {
  return new Set(game.yourMisses);
}

function enemyHitsSet() {
  return new Set(game.enemyHits);
}

function enemyMissesSet() {
  return new Set(game.enemyMisses);
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(game, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save state:', err.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      game = data;
      if (!Array.isArray(game.aiTargetQueue)) game.aiTargetQueue = [];
      return true;
    }
  } catch (err) {
    console.error('Failed to load state:', err.message);
  }
  return false;
}

function clientState() {
  return {
    state: game.state,
    winner: game.winner,
    difficulty: game.difficulty || DIFFICULTY.MEDIUM,
    yourShips: game.yourShips,
    yourHits: game.yourHits,
    yourMisses: game.yourMisses,
    enemyHits: game.enemyHits,
    enemyMisses: game.enemyMisses,
    yourShipsLeft: countShipsLeft(game.yourShips, yourHitsSet()),
    enemyShipsLeft: countShipsLeft(game.enemyShips, enemyHitsSet()),
  };
}

// Add adjacent cells (in bounds, not yet fired) to AI target queue
function addNeighborsToTargetQueue(r, c) {
  const fired = new Set([...game.yourHits, ...game.yourMisses]);
  const inQueue = new Set(game.aiTargetQueue);
  const neighbors = [
    [r - 1, c],
    [r + 1, c],
    [r, c - 1],
    [r, c + 1],
  ];
  for (const [nr, nc] of neighbors) {
    if (nr < 0 || nr >= GRID_SIZE || nc < 0 || nc >= GRID_SIZE) continue;
    const k = key(nr, nc);
    if (fired.has(k) || inQueue.has(k)) continue;
    game.aiTargetQueue.push(k);
    inQueue.add(k);
  }
}

// Check if any ship was just sunk (all its cells are in yourHits)
function anyShipSunk() {
  const hitsSet = yourHitsSet();
  return game.yourShips.some(ship =>
    ship.cells.every(cell => hitsSet.has(key(cell.row, cell.col)))
  );
}

// ========== AI DIFFICULTY LEVELS ==========

/**
 * EASY AI: Pure random — picks any unfired cell at random.
 * No targeting intelligence at all.
 */
function runComputerTurnEasy() {
  const firedSet = new Set([...game.yourHits, ...game.yourMisses]);
  const possible = [];
  for (let ri = 0; ri < GRID_SIZE; ri++) {
    for (let ci = 0; ci < GRID_SIZE; ci++) {
      if (!firedSet.has(key(ri, ci))) possible.push({ r: ri, c: ci });
    }
  }
  if (possible.length === 0) return;
  const cell = possible[Math.floor(Math.random() * possible.length)];
  const r = cell.r;
  const c = cell.c;
  const k = key(r, c);

  const hit = game.yourShips.some(ship =>
    ship.cells.some(cell => cell.row === r && cell.col === c)
  );

  if (hit) {
    game.yourHits.push(k);
    if (countShipsLeft(game.yourShips, yourHitsSet()) === 0) {
      game.state = STATE.GAME_OVER;
      game.winner = 'computer';
    } else {
      // Easy AI does NOT add neighbors — no targeting memory
      game.state = STATE.COMPUTER_TURN;
    }
  } else {
    game.yourMisses.push(k);
    game.state = STATE.PLAYER_TURN;
  }
}

/**
 * MEDIUM AI: Hunt/target with memory (existing behavior).
 * Hits add neighbors to queue; sunk ships clear queue.
 */
function runComputerTurnMedium() {
  const firedSet = new Set([...game.yourHits, ...game.yourMisses]);
  let r, c, k;

  // Target mode: prefer queue (cells adjacent to previous hits)
  while (game.aiTargetQueue.length > 0) {
    k = game.aiTargetQueue.shift();
    if (firedSet.has(k)) continue;
    const [rr, cc] = k.split(',').map(Number);
    r = rr;
    c = cc;
    break;
  }

  // Hunt mode: random unfired cell
  if (r === undefined) {
    const possible = [];
    for (let ri = 0; ri < GRID_SIZE; ri++) {
      for (let ci = 0; ci < GRID_SIZE; ci++) {
        const ki = key(ri, ci);
        if (!firedSet.has(ki)) possible.push({ r: ri, c: ci });
      }
    }
    if (possible.length === 0) return;
    const cell = possible[Math.floor(Math.random() * possible.length)];
    r = cell.r;
    c = cell.c;
  }

  k = key(r, c);
  const hit = game.yourShips.some(ship =>
    ship.cells.some(cell => cell.row === r && cell.col === c)
  );

  if (hit) {
    game.yourHits.push(k);
    if (countShipsLeft(game.yourShips, yourHitsSet()) === 0) {
      game.state = STATE.GAME_OVER;
      game.winner = 'computer';
      game.aiTargetQueue = [];
    } else {
      addNeighborsToTargetQueue(r, c);
      if (anyShipSunk()) game.aiTargetQueue = [];
      game.state = STATE.COMPUTER_TURN;
    }
  } else {
    game.yourMisses.push(k);
    game.state = STATE.PLAYER_TURN;
  }
}

/**
 * HARD AI: Hunt/target with probability density + checkerboard hunting.
 * When hunting (no target queue), uses checkerboard pattern to maximize
 * coverage efficiency. When targeting, prioritizes cells along the axis
 * of consecutive hits for smarter ship-finding.
 */
function runComputerTurnHard() {
  const firedSet = new Set([...game.yourHits, ...game.yourMisses]);
  const hitsSet = new Set(game.yourHits);
  let r, c, k;

  // Target mode: prefer queue, but prioritize cells that continue a line of hits
  if (game.aiTargetQueue.length > 0) {
    // Score each queue cell: higher if it continues a line of existing hits
    const scored = [];
    for (const qk of game.aiTargetQueue) {
      if (firedSet.has(qk)) continue;
      const [qr, qc] = qk.split(',').map(Number);
      let score = 1;
      // Check if this cell continues a horizontal or vertical line of hits
      const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (const [dr, dc] of dirs) {
        const nk = key(qr + dr, qc + dc);
        if (hitsSet.has(nk)) {
          score += 2;
          // Extra bonus if two in a row in this direction
          const nnk = key(qr + 2 * dr, qc + 2 * dc);
          if (hitsSet.has(nnk)) score += 3;
        }
      }
      scored.push({ r: qr, c: qc, score });
    }

    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score);
      // Pick the highest scored cell (break ties randomly among top scorers)
      const topScore = scored[0].score;
      const topCells = scored.filter(s => s.score === topScore);
      const pick = topCells[Math.floor(Math.random() * topCells.length)];
      r = pick.r;
      c = pick.c;
      // Remove from queue
      game.aiTargetQueue = game.aiTargetQueue.filter(qk => qk !== key(r, c));
    }
  }

  // Hunt mode: checkerboard pattern for efficient coverage
  if (r === undefined) {
    game.aiTargetQueue = []; // clear any stale queue entries
    const checkerboard = [];
    const other = [];
    for (let ri = 0; ri < GRID_SIZE; ri++) {
      for (let ci = 0; ci < GRID_SIZE; ci++) {
        if (firedSet.has(key(ri, ci))) continue;
        if ((ri + ci) % 2 === 0) {
          checkerboard.push({ r: ri, c: ci });
        } else {
          other.push({ r: ri, c: ci });
        }
      }
    }
    // Prefer checkerboard cells; fall back to others when exhausted
    const pool = checkerboard.length > 0 ? checkerboard : other;
    if (pool.length === 0) return;
    const cell = pool[Math.floor(Math.random() * pool.length)];
    r = cell.r;
    c = cell.c;
  }

  k = key(r, c);
  const hit = game.yourShips.some(ship =>
    ship.cells.some(cell => cell.row === r && cell.col === c)
  );

  if (hit) {
    game.yourHits.push(k);
    if (countShipsLeft(game.yourShips, yourHitsSet()) === 0) {
      game.state = STATE.GAME_OVER;
      game.winner = 'computer';
      game.aiTargetQueue = [];
    } else {
      addNeighborsToTargetQueue(r, c);
      if (anyShipSunk()) game.aiTargetQueue = [];
      game.state = STATE.COMPUTER_TURN;
    }
  } else {
    game.yourMisses.push(k);
    game.state = STATE.PLAYER_TURN;
  }
}

/**
 * Dispatch to the correct AI based on current game difficulty.
 */
function runComputerTurn() {
  switch (game.difficulty) {
    case DIFFICULTY.EASY:
      return runComputerTurnEasy();
    case DIFFICULTY.HARD:
      return runComputerTurnHard();
    case DIFFICULTY.MEDIUM:
    default:
      return runComputerTurnMedium();
  }
}

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// GET /api/game — current state (client never sees enemyShips)
app.get('/api/game', (req, res) => {
  res.json(clientState());
});

// POST /api/game/new — new game: new enemy placement, clear player ships and shots, SETUP
// Accepts optional { difficulty: 'easy' | 'medium' | 'hard' }
app.post('/api/game/new', (req, res) => {
  const { difficulty } = req.body || {};
  game.state = STATE.SETUP;
  game.winner = null;
  game.yourShips = [];
  game.enemyShips = placeEnemyShips();
  game.yourHits = [];
  game.yourMisses = [];
  game.enemyHits = [];
  game.enemyMisses = [];
  game.aiTargetQueue = [];
  // Update difficulty if a valid value is provided
  if (difficulty && Object.values(DIFFICULTY).includes(difficulty)) {
    game.difficulty = difficulty;
  }
  saveState();
  res.json(clientState());
});

// POST /api/game/restart — same boards, clear shots, back to PLAYER_TURN (only if already placed)
app.post('/api/game/restart', (req, res) => {
  if (game.yourShips.length !== 3 || !game.enemyShips.length) {
    return res.status(400).json({ error: 'Cannot restart: place ships and start a game first' });
  }
  game.state = STATE.PLAYER_TURN;
  game.winner = null;
  game.yourHits = [];
  game.yourMisses = [];
  game.enemyHits = [];
  game.enemyMisses = [];
  game.aiTargetQueue = [];
  saveState();
  res.json(clientState());
});

// POST /api/game/place — submit placement (valid only in SETUP)
app.post('/api/game/place', (req, res) => {
  if (game.state !== STATE.SETUP) {
    return res.status(400).json({ error: 'Placement only allowed in SETUP' });
  }
  const { ships } = req.body || {};
  const validation = validatePlacement(ships);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.message });
  }
  game.yourShips = ships;
  game.state = STATE.PLAYER_TURN;
  saveState();
  res.json(clientState());
});

// POST /api/game/fire — player shot (valid only in PLAYER_TURN)
app.post('/api/game/fire', (req, res) => {
  if (game.state !== STATE.PLAYER_TURN) {
    return res.status(400).json({ error: 'Fire only allowed on your turn' });
  }
  const { row, col } = req.body || {};
  const r = parseInt(row, 10);
  const c = parseInt(col, 10);
  if (isNaN(r) || isNaN(c) || r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) {
    return res.status(400).json({ error: 'Invalid cell' });
  }
  const k = key(r, c);
  if (game.enemyHits.includes(k) || game.enemyMisses.includes(k)) {
    return res.status(400).json({ error: 'Already fired at this cell' });
  }

  const hit = game.enemyShips.some(ship =>
    ship.cells.some(cell => cell.row === r && cell.col === c)
  );
  if (hit) {
    game.enemyHits.push(k);
    if (countShipsLeft(game.enemyShips, enemyHitsSet()) === 0) {
      game.state = STATE.GAME_OVER;
      game.winner = 'player';
      recordGameResult('player');
      saveState();
      return res.json(clientState());
    }
    game.state = STATE.PLAYER_TURN;
    saveState();
    return res.json(clientState());
  } else {
    game.enemyMisses.push(k);
    game.state = STATE.COMPUTER_TURN;
  }

  // Run computer turn(s) until miss or game over
  while (game.state === STATE.COMPUTER_TURN) {
    runComputerTurn();
    saveState();
  }

  // If AI won during its turn(s), record the result
  if (game.state === STATE.GAME_OVER && game.winner === 'computer') {
    recordGameResult('computer');
    saveState();
  }

  res.json(clientState());
});

// ========== SCOREBOARD API ENDPOINTS ==========

// GET /api/scoreboard — return current scoreboard
app.get('/api/scoreboard', (req, res) => {
  const accuracy = scoreboard.totalPlayerShots > 0
    ? Math.round((scoreboard.totalPlayerHits / scoreboard.totalPlayerShots) * 100)
    : 0;
  res.json({
    ...scoreboard,
    accuracy,
  });
});

// POST /api/scoreboard/reset — reset all stats
app.post('/api/scoreboard/reset', (req, res) => {
  scoreboard = { ...DEFAULT_SCOREBOARD, gameHistory: [] };
  saveScoreboard();
  res.json({ ...scoreboard, accuracy: 0 });
});

// POST /api/game/difficulty — change difficulty mid-setup (only during SETUP)
app.post('/api/game/difficulty', (req, res) => {
  const { difficulty } = req.body || {};
  if (!difficulty || !Object.values(DIFFICULTY).includes(difficulty)) {
    return res.status(400).json({ error: 'Invalid difficulty. Use easy, medium, or hard.' });
  }
  if (game.state !== STATE.SETUP) {
    return res.status(400).json({ error: 'Difficulty can only be changed during setup.' });
  }
  game.difficulty = difficulty;
  saveState();
  res.json(clientState());
});

// Load persisted state and scoreboard on startup
loadState();
loadScoreboard();
if (game.state === STATE.SETUP && !game.enemyShips.length) {
  game.enemyShips = placeEnemyShips();
  saveState();
}
// Ensure difficulty field exists on legacy state files
if (!game.difficulty) {
  game.difficulty = DIFFICULTY.MEDIUM;
  saveState();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Battleship server at http://localhost:${PORT}`);
});
