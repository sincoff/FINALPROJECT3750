/**
 * Battleship V2+ — Client
 * Uses server API for all game state; no browser-refresh hacks.
 */
(function () {
  'use strict';

  const GRID_SIZE = 10;
  const SHIP_SPECS = [
    { name: '1×4', length: 4 },
    { name: '1×3', length: 3 },
    { name: '1×2', length: 2 },
  ];

  const API = '/api';
  let serverState = null; // { state, winner, yourShips, yourHits, yourMisses, enemyHits, enemyMisses, yourShipsLeft, enemyShipsLeft }
  let placementIndex = 0;
  let placementVertical = false;
  let localShips = []; // only during SETUP before submit

  const yourGridEl = document.getElementById('your-grid');
  const enemyGridEl = document.getElementById('enemy-grid');
  const statusEl = document.getElementById('status');
  const yourShipsCountEl = document.getElementById('your-ships-count');
  const enemyShipsCountEl = document.getElementById('enemy-ships-count');
  const newGameBtn = document.getElementById('new-game');
  const restartGameBtn = document.getElementById('restart-game');
  const explosionEl = document.getElementById('hit-explosion');
  const placementControlsEl = document.getElementById('placement-controls');
  const placementShipLabel = document.getElementById('placement-ship-label');
  const placementActionsEl = document.getElementById('placement-actions');
  const startBattleBtn = document.getElementById('start-battle');
  const rearrangeBtn = document.getElementById('rearrange');
  const orientH = document.getElementById('orient-h');
  const orientV = document.getElementById('orient-v');

  // Difficulty buttons
  const diffEasy = document.getElementById('diff-easy');
  const diffMedium = document.getElementById('diff-medium');
  const diffHard = document.getElementById('diff-hard');
  const diffButtons = [diffEasy, diffMedium, diffHard];

  // Scoreboard elements
  const statWins = document.getElementById('stat-wins');
  const statLosses = document.getElementById('stat-losses');
  const statTotal = document.getElementById('stat-total');
  const statAccuracy = document.getElementById('stat-accuracy');
  const statBest = document.getElementById('stat-best');
  const statStreak = document.getElementById('stat-streak');
  const gameHistoryEl = document.getElementById('game-history');
  const resetScoreboardBtn = document.getElementById('reset-scoreboard');

  let currentDifficulty = 'medium';

  let audioCtx = null;

  function playHitSound() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const ctx = audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 800;
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(180, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.12);
      osc.type = 'square';
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch (_) {}
  }

  // ========== SCOREBOARD ==========

  async function fetchScoreboard() {
    try {
      const data = await apiGet('/scoreboard');
      syncScoreboard(data);
    } catch (_) {
      // scoreboard unavailable — ignore
    }
  }

  function syncScoreboard(data) {
    statWins.textContent = data.wins || 0;
    statLosses.textContent = data.losses || 0;
    statTotal.textContent = data.totalGames || 0;
    statAccuracy.textContent = (data.accuracy || 0) + '%';
    statBest.textContent = data.bestGame !== null ? data.bestGame + ' shots' : '—';
    statStreak.textContent = data.currentWinStreak || 0;

    // Render game history (most recent first)
    gameHistoryEl.innerHTML = '';
    const history = (data.gameHistory || []).slice().reverse();
    if (history.length === 0) {
      gameHistoryEl.innerHTML = '<div style="text-align:center;padding:0.5rem;opacity:0.5;">No games played yet</div>';
      return;
    }
    for (const entry of history) {
      const div = document.createElement('div');
      div.className = 'history-entry';
      const accuracy = entry.shots > 0 ? Math.round((entry.hits / entry.shots) * 100) : 0;
      const dateStr = new Date(entry.date).toLocaleDateString();
      div.innerHTML =
        `<span class="history-result ${entry.result}">${entry.result.toUpperCase()}</span>` +
        `<span class="history-detail">${entry.shots} shots · ${accuracy}% acc</span>` +
        `<span class="history-diff">${entry.difficulty || 'medium'}</span>` +
        `<span class="history-detail">${dateStr}</span>`;
      gameHistoryEl.appendChild(div);
    }
  }

  async function resetScoreboard() {
    if (!confirm('Reset all statistics? This cannot be undone.')) return;
    try {
      const data = await apiPost('/scoreboard/reset', {});
      syncScoreboard(data);
    } catch (_) {}
  }

  // ========== DIFFICULTY ==========

  function syncDifficultyUI(diff) {
    currentDifficulty = diff || 'medium';
    diffButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.diff === currentDifficulty);
    });
  }

  function setDifficultyEnabled(enabled) {
    diffButtons.forEach(btn => {
      btn.disabled = !enabled;
    });
  }

  async function changeDifficulty(diff) {
    try {
      const data = await apiPost('/game/difficulty', { difficulty: diff });
      currentDifficulty = diff;
      syncDifficultyUI(diff);
      syncUI(data);
    } catch (err) {
      statusEl.textContent = err.message || 'Cannot change difficulty now';
    }
  }

  function key(r, c) {
    return `${r},${c}`;
  }

  async function apiGet(path) {
    const res = await fetch(API + path);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  function canPlaceAt(r, c, length, vertical, occupied) {
    for (let i = 0; i < length; i++) {
      const nr = vertical ? r + i : r;
      const nc = vertical ? c : c + i;
      if (nr < 0 || nr >= GRID_SIZE || nc < 0 || nc >= GRID_SIZE) return false;
      if (occupied.has(key(nr, nc))) return false;
    }
    return true;
  }

  function buildShipAt(r, c, spec, vertical) {
    const cells = [];
    for (let i = 0; i < spec.length; i++) {
      cells.push({ row: vertical ? r + i : r, col: vertical ? c : c + i });
    }
    return { name: spec.name, length: spec.length, cells };
  }

  function updatePlacementUI() {
    if (placementIndex < SHIP_SPECS.length) {
      placementShipLabel.textContent = SHIP_SPECS[placementIndex].name;
      placementActionsEl.classList.add('hidden');
    } else {
      placementActionsEl.classList.remove('hidden');
    }
  }

  function syncUI(data) {
    serverState = data;
    const state = data.state;
    const placementPhase = state === 'SETUP';

    // Sync difficulty UI
    syncDifficultyUI(data.difficulty);
    setDifficultyEnabled(placementPhase);

    if (placementPhase) {
      placementControlsEl.classList.remove('hidden');
      restartGameBtn.style.display = 'none';
      yourShipsCountEl.textContent = localShips.length;
    } else {
      placementControlsEl.classList.add('hidden');
      if (state === 'PLAYER_TURN' || state === 'COMPUTER_TURN' || state === 'GAME_OVER') {
        restartGameBtn.style.display = 'inline-block';
      }
      yourShipsCountEl.textContent = data.yourShipsLeft ?? 3;
    }
    enemyShipsCountEl.textContent = data.enemyShipsLeft ?? 3;

    const diffLabel = (data.difficulty || 'medium').toUpperCase();
    if (state === 'GAME_OVER') {
      const resultText = data.winner === 'player'
        ? 'VICTORY — ENEMY FLEET DESTROYED'
        : 'DEFEAT — FLEET DESTROYED';
      statusEl.textContent = resultText + ' [' + diffLabel + ']';
      // Refresh scoreboard after game ends
      fetchScoreboard();
    } else if (state === 'PLAYER_TURN') {
      statusEl.textContent = 'YOUR TURN — SELECT TARGET ON ENEMY GRID [' + diffLabel + ']';
    } else if (state === 'COMPUTER_TURN') {
      statusEl.textContent = 'ENEMY TURN — INCOMING...';
    } else if (placementPhase) {
      statusEl.textContent = 'PLACE YOUR SHIPS — CLICK GRID BELOW [' + diffLabel + ']';
    }

    const yourShips = placementPhase ? localShips : (data.yourShips || []);
    const shipCells = new Set();
    yourShips.forEach(s => s.cells.forEach(c => shipCells.add(key(c.row, c.col))));
    const yourHits = new Set(data.yourHits || []);
    const yourMisses = new Set(data.yourMisses || []);
    const enemyHits = new Set(data.enemyHits || []);
    const enemyMisses = new Set(data.enemyMisses || []);

    yourGridEl.innerHTML = '';
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.row = r;
        cell.dataset.col = c;
        if (shipCells.has(key(r, c))) cell.classList.add('ship');
        if (yourHits.has(key(r, c))) cell.classList.add('hit');
        if (yourMisses.has(key(r, c))) cell.classList.add('miss');
        yourGridEl.appendChild(cell);
      }
    }

    if (placementPhase) {
      yourGridEl.classList.add('clickable');
      yourGridEl.querySelectorAll('.cell').forEach(el => {
        el.addEventListener('click', onYourGridClickPlace);
      });
    } else {
      yourGridEl.classList.remove('clickable');
    }

    enemyGridEl.innerHTML = '';
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.row = r;
        cell.dataset.col = c;
        if (enemyHits.has(key(r, c))) cell.classList.add('hit');
        if (enemyMisses.has(key(r, c))) cell.classList.add('miss');
        enemyGridEl.appendChild(cell);
      }
    }
    if (state === 'PLAYER_TURN') {
      enemyGridEl.querySelectorAll('.cell:not(.hit):not(.miss)').forEach(el => {
        el.addEventListener('click', onEnemyCellClick);
      });
    }
  }

  function onYourGridClickPlace(e) {
    const cell = e.target.closest('.cell');
    if (!cell || placementIndex >= SHIP_SPECS.length) return;
    const row = parseInt(cell.dataset.row, 10);
    const col = parseInt(cell.dataset.col, 10);
    const spec = SHIP_SPECS[placementIndex];
    const occupied = new Set(localShips.flatMap(s => s.cells.map(c => key(c.row, c.col))));
    if (!canPlaceAt(row, col, spec.length, placementVertical, occupied)) return;
    localShips.push(buildShipAt(row, col, spec, placementVertical));
    placementIndex++;
    updatePlacementUI();
    syncUI({ ...serverState, yourShips: localShips, state: 'SETUP' });
  }

  async function startBattle() {
    if (localShips.length !== 3) return;
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    try {
      const data = await apiPost('/game/place', { ships: localShips });
      syncUI(data);
    } catch (err) {
      statusEl.textContent = 'Placement rejected: ' + (err.message || 'try again');
    }
  }

  function rearrange() {
    localShips = [];
    placementIndex = 0;
    placementShipLabel.textContent = SHIP_SPECS[0].name;
    placementActionsEl.classList.add('hidden');
    syncUI({
      state: 'SETUP',
      winner: null,
      difficulty: currentDifficulty,
      yourShips: [],
      yourHits: [],
      yourMisses: [],
      enemyHits: [],
      enemyMisses: [],
      yourShipsLeft: 0,
      enemyShipsLeft: 3,
    });
  }

  async function onEnemyCellClick(e) {
    const cell = e.target.closest('.cell');
    if (!cell || cell.classList.contains('hit') || cell.classList.contains('miss')) return;
    const row = parseInt(cell.dataset.row, 10);
    const col = parseInt(cell.dataset.col, 10);
    const prevEnemyHits = new Set(serverState.enemyHits || []);
    try {
      const data = await apiPost('/game/fire', { row, col });
      const newHit = (data.enemyHits || []).some(k => !prevEnemyHits.has(k));
      if (newHit) {
        playHitSound();
        explosionEl.classList.remove('flash');
        void explosionEl.offsetWidth;
        explosionEl.classList.add('flash');
        setTimeout(() => explosionEl.classList.remove('flash'), 400);
      }
      syncUI(data);
    } catch (err) {
      statusEl.textContent = (err.message || 'Fire failed') + ' — try again';
    }
  }

  async function loadGame() {
    try {
      const data = await apiGet('/game');
      if (data.state === 'SETUP') {
        localShips = Array.isArray(data.yourShips) ? data.yourShips : [];
        placementIndex = localShips.length;
        placementShipLabel.textContent = SHIP_SPECS[Math.min(placementIndex, 2)].name;
        updatePlacementUI();
      } else {
        localShips = Array.isArray(data.yourShips) ? data.yourShips : [];
      }
      syncUI(data);
    } catch (_) {
      statusEl.textContent = 'Cannot reach server. Start server: npm start';
      restartGameBtn.style.display = 'none';
    }
  }

  async function newGame() {
    try {
      const data = await apiPost('/game/new', { difficulty: currentDifficulty });
      localShips = [];
      placementIndex = 0;
      placementShipLabel.textContent = SHIP_SPECS[0].name;
      placementActionsEl.classList.add('hidden');
      orientH.classList.add('active');
      orientV.classList.remove('active');
      syncUI(data);
    } catch (err) {
      statusEl.textContent = err.message || 'New game failed';
    }
  }

  async function restartGame() {
    try {
      const data = await apiPost('/game/restart', {});
      syncUI(data);
    } catch (err) {
      statusEl.textContent = err.message || 'Restart failed';
    }
  }

  orientH.addEventListener('click', () => {
    placementVertical = false;
    orientH.classList.add('active');
    orientV.classList.remove('active');
  });
  orientV.addEventListener('click', () => {
    placementVertical = true;
    orientV.classList.add('active');
    orientH.classList.remove('active');
  });
  startBattleBtn.addEventListener('click', startBattle);
  rearrangeBtn.addEventListener('click', rearrange);
  newGameBtn.addEventListener('click', newGame);
  restartGameBtn.addEventListener('click', restartGame);

  // Difficulty buttons
  diffButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      changeDifficulty(btn.dataset.diff);
    });
  });

  // Scoreboard reset
  resetScoreboardBtn.addEventListener('click', resetScoreboard);

  restartGameBtn.style.display = 'none';
  loadGame();
  fetchScoreboard();
})();
