(function () {
  'use strict';

  const SHIP_SPECS = [4, 3, 2];
  const STORAGE_KEYS = {
    baseUrl: 'battleship.baseUrl',
    playerId: 'battleship.playerId',
    username: 'battleship.username',
    theme: 'battleship.theme',
    identitiesByServer: 'battleship.identitiesByServer',
  };

  function getStoredIdentity(key) {
    // Legacy keys (kept for backward compatibility).
    return sessionStorage.getItem(key) || localStorage.getItem(key);
  }

  function setStoredIdentity(key, value) {
    sessionStorage.setItem(key, value);
    localStorage.setItem(key, value);
  }

  function getServerIdentity(baseUrl) {
    if (!baseUrl) return null;
    let all = {};
    try {
      all = JSON.parse(localStorage.getItem(STORAGE_KEYS.identitiesByServer) || '{}');
    } catch (_) {}
    const hit = all[baseUrl];
    if (!hit || typeof hit !== 'object') return null;
    const playerId = parseInt(hit.playerId, 10);
    const username = typeof hit.username === 'string' ? hit.username : '';
    if (!Number.isInteger(playerId) || !username) return null;
    return { playerId, username };
  }

  function setServerIdentity(baseUrl, playerId, username) {
    if (!baseUrl || !Number.isInteger(playerId) || !username) return;
    let all = {};
    try {
      all = JSON.parse(localStorage.getItem(STORAGE_KEYS.identitiesByServer) || '{}');
    } catch (_) {}
    all[baseUrl] = { playerId, username };
    localStorage.setItem(STORAGE_KEYS.identitiesByServer, JSON.stringify(all));
  }
  const CLASS_SERVER_OPTIONS = [
    { label: 'Localhost (3000)', url: 'http://localhost:3000' },
    { label: 'Team 0x03 (Render)', url: 'https://finalproject3750.onrender.com' },
  ];

  const apiService = (() => {
    let baseUrl = '';
    function normalize(url) { return (url || '').trim().replace(/\/+$/, ''); }
    function setBaseUrl(url) { baseUrl = normalize(url); localStorage.setItem(STORAGE_KEYS.baseUrl, baseUrl); }
    function getBaseUrl() { return baseUrl; }
    async function request(path, options = {}) {
      if (!baseUrl) throw new Error('Connect to a server first.');
      const res = await fetch(`${baseUrl}${path}`, options);
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (!res.ok) {
        const msg =
          (data && (data.message || data.error)) || `Request failed (${res.status})`;
        const err = new Error(msg);
        err.status = res.status;
        err.code = data && data.error;
        throw err;
      }
      return data;
    }
    async function get(path) { return request(path); }
    async function post(path, body) {
      return request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    }
    return { setBaseUrl, getBaseUrl, get, post, normalize };
  })();

  function normalizeServerRoot(url) {
    return apiService.normalize(url).replace(/\/api$/i, '');
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(id);
    }
  }

  async function probeServerApi(baseUrl) {
    const probes = ['/api', '/api/', '/api/health', '/api/version', '/api/players'];
    for (const path of probes) {
      try {
        const res = await fetchWithTimeout(`${baseUrl}${path}`, { method: 'GET' }, 5000);
        // Any non-5xx response indicates the API route is reachable and responding.
        if (res.status < 500) return true;
      } catch (_) {
        // Try next probe.
      }
    }
    return false;
  }

  const ui = {
    status: document.getElementById('status'),
    serverSelect: document.getElementById('server-select'),
    serverInput: document.getElementById('server-input'),
    connectBtn: document.getElementById('connect-btn'),
    themeToggleBtn: document.getElementById('theme-toggle-btn'),
    serverIndicator: document.getElementById('server-indicator'),
    serverIndicatorText: document.getElementById('server-indicator-text'),
    registerScreen: document.getElementById('register-screen'),
    lobbyScreen: document.getElementById('lobby-screen'),
    gameScreen: document.getElementById('game-screen'),
    usernameInput: document.getElementById('username-input'),
    registerBtn: document.getElementById('register-btn'),
    identityLine: document.getElementById('identity-line'),
    createGridSize: document.getElementById('create-grid-size'),
    createMaxPlayers: document.getElementById('create-max-players'),
    createGameBtn: document.getElementById('create-game-btn'),
    refreshLobbyBtn: document.getElementById('refresh-lobby-btn'),
    gamesList: document.getElementById('games-list'),
    gameMeta: document.getElementById('game-meta'),
    turnIndicator: document.getElementById('turn-indicator'),
    yourGrid: document.getElementById('your-grid'),
    opponentGrids: document.getElementById('opponent-grids'),
    placementControls: document.getElementById('placement-controls'),
    shipPalette: document.getElementById('ship-palette'),
    placementShipLabel: document.getElementById('placement-ship-label'),
    orientH: document.getElementById('orient-h'),
    orientV: document.getElementById('orient-v'),
    submitShipsBtn: document.getElementById('submit-ships-btn'),
    clearShipsBtn: document.getElementById('clear-ships-btn'),
    statsPanel: document.getElementById('stats-panel'),
    movesLog: document.getElementById('moves-log'),
    backToLobbyBtn: document.getElementById('back-to-lobby-btn'),
    explosion: document.getElementById('hit-explosion'),
    resultModal: document.getElementById('game-result-modal'),
    resultTitle: document.getElementById('result-title'),
    resultMessage: document.getElementById('result-message'),
    resultCloseBtn: document.getElementById('result-close-btn'),
  };

  const state = {
    connected: false,
    playerId: null,
    username: '',
    currentGameId: null,
    pollingId: null,
    gridSize: 10,
    playersById: {},
    participants: [],
    moves: [],
    game: null,
    vertical: false,
    localShips: [],
    myUsedCells: new Set(),
    draggingShipLength: null,
    finishedPopupGameId: null,
  };

  function setStatus(msg) { ui.status.textContent = msg; }
  function key(r, c) { return `${r},${c}`; }
  function applyTheme(theme) {
    const mode = theme === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('light-mode', mode === 'light');
    localStorage.setItem(STORAGE_KEYS.theme, mode);
    if (ui.themeToggleBtn) {
      ui.themeToggleBtn.textContent = mode === 'light' ? 'DARK MODE' : 'LIGHT MODE';
    }
  }
  function mapFriendlyError(err) {
    const msg = (err && err.message) || '';
    if (/Not your turn/i.test(msg)) return 'Hold fire — it is not your turn.';
    if (/Cell already fired/i.test(msg)) return 'You already fired at that location.';
    if (/already finished/i.test(msg)) return 'Game over. Return to lobby to start another game.';
    if (/has not started/i.test(msg)) return 'Game is waiting for players to finish setup.';
    if (/already placed ships/i.test(msg)) return 'Your ships are already submitted. Waiting for other players.';
    if (/joined or placed/i.test(msg)) return 'Waiting for all players to join and place ships.';
    if (/Exactly 3 ships required/i.test(msg)) return 'Place all 3 ships (lengths 4, 3, 2) before submitting.';
    if (/not in this game/i.test(msg)) return 'You are not part of this game.';
    return msg || 'Something went wrong. Try again.';
  }

  function normalizeMovesPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.moves)) return payload.moves;
    if (Array.isArray(payload.data)) return payload.data;
    return [];
  }

  function normalizeGamePlayers(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.players)) return payload.players;
    if (Array.isArray(payload.data)) return payload.data;
    return [];
  }

  function getPlacedShipLengths() {
    return new Set(state.localShips.map((s) => s.length));
  }

  function updatePlacementLabel() {
    const placed = getPlacedShipLengths();
    const next = SHIP_SPECS.find((len) => !placed.has(len));
    ui.placementShipLabel.textContent = next ? `1x${next}` : 'READY';
  }

  function renderShipPalette() {
    if (!ui.shipPalette) return;
    ui.shipPalette.innerHTML = '';
    const placed = getPlacedShipLengths();
    for (const len of SHIP_SPECS) {
      const token = document.createElement('div');
      const isPlaced = placed.has(len);
      token.className = `ship-token${isPlaced ? ' placed' : ''}`;
      token.draggable = !isPlaced;
      token.dataset.length = String(len);
      token.innerHTML = `<span>Ship ${len}</span><span class="ship-cells">${'<i></i>'.repeat(len)}</span>`;
      if (!isPlaced) {
        token.addEventListener('dragstart', (e) => {
          state.draggingShipLength = len;
          if (e.dataTransfer) {
            e.dataTransfer.setData('text/plain', String(len));
            // Hide browser drag preview so only board ghost cells are visible.
            const ghost = document.createElement('div');
            ghost.style.width = '1px';
            ghost.style.height = '1px';
            ghost.style.opacity = '0';
            ghost.style.position = 'absolute';
            ghost.style.top = '-1000px';
            document.body.appendChild(ghost);
            e.dataTransfer.setDragImage(ghost, 0, 0);
            setTimeout(() => ghost.remove(), 0);
          }
        });
        token.addEventListener('dragend', () => {
          state.draggingShipLength = null;
          clearPlacementGhostPreview();
        });
      }
      ui.shipPalette.appendChild(token);
    }
  }

  function hideResultModal() {
    if (!ui.resultModal) return;
    ui.resultModal.classList.add('hidden');
  }

  function showResultModal(title, message) {
    if (!ui.resultModal || !ui.resultTitle || !ui.resultMessage) return;
    ui.resultTitle.textContent = title;
    ui.resultMessage.textContent = message;
    ui.resultModal.classList.remove('hidden');
  }

  function maybeShowFinishedPopup(game) {
    if (!game || game.status !== 'finished') return;
    const gid = game.game_id ?? state.currentGameId;
    if (gid == null || state.finishedPopupGameId === gid) return;

    const players = Array.isArray(game.players) ? game.players : [];
    const winnerFromBoard = players.find((p) => Number.isInteger(p.ships_remaining) && p.ships_remaining > 0);
    const winnerId = game.winner_id ?? (winnerFromBoard ? winnerFromBoard.player_id : null);

    const winnerName = winnerId != null
      ? (state.playersById[winnerId] || `Player ${winnerId}`)
      : 'Unknown';
    const me = players.find((p) => p.player_id === state.playerId);
    const iLost = !!me && Number.isInteger(me.ships_remaining) && me.ships_remaining <= 0;
    const iWon = winnerId != null && winnerId === state.playerId;

    if (iWon) {
      showResultModal('Victory!', `You won this match. Great work, Commander.`);
    } else if (iLost) {
      showResultModal('Defeat', `You were eliminated. Winner: ${winnerName}.`);
    } else {
      showResultModal('Match Finished', `Winner: ${winnerName}.`);
    }

    state.finishedPopupGameId = gid;
  }

  function tryPlaceShipAt(r, c, shipLength) {
    if (!shipLength || !Number.isInteger(shipLength) || shipLength < 1) return false;
    if (getPlacedShipLengths().has(shipLength)) return false;
    const occupied = new Set();
    for (const ship of state.localShips) ship.forEach((p) => occupied.add(key(p.row, p.col)));
    const coords = [];
    for (let i = 0; i < shipLength; i++) {
      const rr = state.vertical ? r + i : r;
      const cc = state.vertical ? c : c + i;
      if (rr < 0 || rr >= state.gridSize || cc < 0 || cc >= state.gridSize) return false;
      if (occupied.has(key(rr, cc))) return false;
      coords.push({ row: rr, col: cc });
    }
    state.localShips.push(coords);
    updatePlacementLabel();
    renderPlacementPreview();
    return true;
  }

  function clearPlacementGhostPreview() {
    if (!ui.yourGrid) return;
    ui.yourGrid.querySelectorAll('.cell.preview-valid, .cell.preview-invalid').forEach((el) => {
      el.classList.remove('preview-valid', 'preview-invalid');
    });
  }

  function showPlacementGhostPreview(r, c, shipLength) {
    clearPlacementGhostPreview();
    if (!Number.isInteger(shipLength) || shipLength < 1) return;
    if (getPlacedShipLengths().has(shipLength)) return;

    const occupied = new Set();
    for (const ship of state.localShips) ship.forEach((p) => occupied.add(key(p.row, p.col)));

    const coords = [];
    let valid = true;
    for (let i = 0; i < shipLength; i++) {
      const rr = state.vertical ? r + i : r;
      const cc = state.vertical ? c : c + i;
      if (rr < 0 || rr >= state.gridSize || cc < 0 || cc >= state.gridSize) {
        valid = false;
        continue;
      }
      if (occupied.has(key(rr, cc))) valid = false;
      coords.push({ row: rr, col: cc });
    }

    coords.forEach(({ row, col }) => {
      const cell = ui.yourGrid.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
      if (!cell) return;
      cell.classList.add(valid ? 'preview-valid' : 'preview-invalid');
    });
  }

  function bindDragDropPlacement(canPlaceShips) {
    clearPlacementGhostPreview();
    if (!canPlaceShips) return;
    ui.yourGrid.addEventListener('dragleave', (e) => {
      if (!ui.yourGrid.contains(e.relatedTarget)) clearPlacementGhostPreview();
    });
    ui.yourGrid.addEventListener('drop', () => clearPlacementGhostPreview());
    const cells = ui.yourGrid.querySelectorAll('.cell');
    cells.forEach((cell) => {
      cell.addEventListener('dragover', (e) => {
        e.preventDefault();
        const lengthFromDrag = parseInt(e.dataTransfer ? e.dataTransfer.getData('text/plain') : '', 10);
        const shipLength = Number.isInteger(lengthFromDrag) ? lengthFromDrag : state.draggingShipLength;
        const row = parseInt(cell.dataset.row, 10);
        const col = parseInt(cell.dataset.col, 10);
        showPlacementGhostPreview(row, col, shipLength);
      });
      cell.addEventListener('drop', (e) => {
        e.preventDefault();
        const lengthFromDrag = parseInt(e.dataTransfer ? e.dataTransfer.getData('text/plain') : '', 10);
        const shipLength = Number.isInteger(lengthFromDrag) ? lengthFromDrag : state.draggingShipLength;
        const row = parseInt(cell.dataset.row, 10);
        const col = parseInt(cell.dataset.col, 10);
        if (!Number.isInteger(row) || !Number.isInteger(col)) return;
        const placed = tryPlaceShipAt(row, col, shipLength);
        clearPlacementGhostPreview();
        if (!placed) setStatus('Invalid placement for that ship. Try another position or orientation.');
      });
    });
  }

  function buildGrid(container, gridSize, onClick) {
    container.innerHTML = '';
    container.style.gridTemplateColumns = `repeat(${gridSize}, var(--cell-size))`;
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        if (onClick) {
          cell.classList.add('fireable');
          cell.addEventListener('click', () => onClick(r, c));
        }
        container.appendChild(cell);
      }
    }
  }

  function paintGrid(container, gridSize, shipCells, hitCells, missCells, clickable, fireHandler) {
    container.innerHTML = '';
    container.style.gridTemplateColumns = `repeat(${gridSize}, var(--cell-size))`;
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const k = key(r, c);
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        if (shipCells.has(k)) cell.classList.add('ship');
        if (hitCells.has(k)) cell.classList.add('hit');
        if (missCells.has(k)) cell.classList.add('miss');
        if (clickable && !hitCells.has(k) && !missCells.has(k)) {
          cell.classList.add('fireable');
          cell.addEventListener('click', () => fireHandler(r, c));
        }
        container.appendChild(cell);
      }
    }
  }

  function updateServerIndicator(ok, text) {
    ui.serverIndicator.className = `indicator ${ok ? 'ok' : 'fail'}`;
    ui.serverIndicator.textContent = ok ? '✓' : '✕';
    ui.serverIndicatorText.textContent = text;
  }

  function showScreen(name) {
    ui.registerScreen.classList.toggle('hidden', name !== 'register');
    ui.lobbyScreen.classList.toggle('hidden', name !== 'lobby');
    ui.gameScreen.classList.toggle('hidden', name !== 'game');
  }

  async function refreshPlayersDirectory() {
    const players = await apiService.get('/api/players');
    state.playersById = {};
    for (const p of players) state.playersById[p.id] = p.username;
  }

  function getMoveCellsForPlayer(playerId) {
    const hits = new Set();
    const misses = new Set();
    for (const m of state.moves) {
      const coord = key(m.row, m.col);
      if (m.player_id === playerId) {
        if (m.result === 'hit') hits.add(coord);
        if (m.result === 'miss') misses.add(coord);
      }
    }
    return { hits, misses };
  }

  function getIncomingHitsOnMe(myShipSet) {
    const hits = new Set();
    for (const m of state.moves) {
      if (m.player_id === state.playerId) continue;
      if (m.result !== 'hit') continue;
      if (m.target_player_id != null && m.target_player_id !== state.playerId) continue;
      const k = key(m.row, m.col);
      if (myShipSet.has(k)) hits.add(k);
    }
    return hits;
  }

  async function renderLobby() {
    await refreshPlayersDirectory();
    const games = await apiService.get('/api/games');
    ui.gamesList.innerHTML = '';
    if (!games.length) {
      ui.gamesList.innerHTML = '<div class="list-row">No games yet.</div>';
      return;
    }
    for (const g of games) {
      const row = document.createElement('div');
      row.className = 'list-row';
      const info = document.createElement('div');
      info.textContent = `Game #${g.id} | ${g.status} | ${g.player_count}/${g.max_players} players | grid ${g.grid_size}`;
      const actions = document.createElement('div');
      if (g.status === 'waiting_setup') {
        const joinBtn = document.createElement('button');
        joinBtn.className = 'btn-radar';
        joinBtn.textContent = 'JOIN';
        if (g.player_count >= g.max_players) {
          joinBtn.disabled = true;
          joinBtn.textContent = 'FULL';
        }
        joinBtn.addEventListener('click', async () => {
          try {
            await apiService.post(`/api/games/${g.id}/join`, { player_id: state.playerId });
            state.currentGameId = g.id;
            showScreen('game');
            setStatus(`Joined game #${g.id}.`);
            startGamePolling();
          } catch (err) {
            setStatus(mapFriendlyError(err));
          }
        });
        actions.appendChild(joinBtn);
      }
      row.appendChild(info);
      row.appendChild(actions);
      ui.gamesList.appendChild(row);
    }
  }

  async function refreshStats() {
    let s = null;
    try {
      s = await apiService.get(`/api/players/${state.playerId}/stats`);
    } catch (err) {
      // Some team servers may not expose identical stats routes/shape.
      if (!(err && err.status === 404)) throw err;
      s = {
        wins: 0,
        losses: 0,
        games_played: 0,
        total_shots: 0,
        total_hits: 0,
        accuracy: 0,
      };
    }
    ui.statsPanel.innerHTML = `
      <div class="stat-item"><span class="stat-value">${s.wins}</span><span class="stat-label">WINS</span></div>
      <div class="stat-item"><span class="stat-value">${s.losses}</span><span class="stat-label">LOSSES</span></div>
      <div class="stat-item"><span class="stat-value">${s.games_played}</span><span class="stat-label">GAMES</span></div>
      <div class="stat-item"><span class="stat-value">${s.total_shots}</span><span class="stat-label">SHOTS</span></div>
      <div class="stat-item"><span class="stat-value">${s.total_hits}</span><span class="stat-label">HITS</span></div>
      <div class="stat-item"><span class="stat-value">${(s.accuracy * 100).toFixed(1)}%</span><span class="stat-label">ACCURACY</span></div>
    `;
  }

  async function renderGame() {
    if (!state.currentGameId) return;
    await refreshPlayersDirectory();
    const [game, rawMoves] = await Promise.all([
      apiService.get(`/api/games/${state.currentGameId}`),
      apiService.get(`/api/games/${state.currentGameId}/moves`),
    ]);
    state.game = game;
    state.moves = normalizeMovesPayload(rawMoves).map((m, i) => ({
      move_number: m.move_number != null ? m.move_number : i + 1,
      player_id: m.player_id ?? m.playerId ?? m.shooter_id ?? null,
      target_player_id: m.target_player_id ?? m.targetPlayerId ?? null,
      row: m.row ?? m.move_row ?? m.r,
      col: m.col ?? m.move_col ?? m.c,
      result: m.result,
      timestamp: m.timestamp ?? m.created_at ?? new Date().toISOString(),
    }));
    state.gridSize = game.grid_size;

    let serverShips = [];
    try {
      const myShipsData = await apiService.get(
        `/api/games/${state.currentGameId}/ships?player_id=${state.playerId}&requester_id=${state.playerId}`
      );
      serverShips = myShipsData.ships || [];
    } catch (err) {
      // Cross-team compatibility: some APIs expose placement via /place but not /ships.
      if (!(err && err.status === 404)) throw err;
      serverShips = [];
    }
    const serverPlaced = serverShips.length > 0;
    const myShipSet = new Set(serverShips.map((s) => key(s.row, s.col)));
    if (!serverPlaced && game.status === 'waiting_setup' && state.localShips.length > 0) {
      for (const ship of state.localShips) {
        for (const cell of ship) myShipSet.add(key(cell.row, cell.col));
      }
    }
    const incomingHits = getIncomingHitsOnMe(myShipSet);

    let gamePlayers = [];
    try {
      const rawPlayers = await apiService.get(`/api/games/${state.currentGameId}/players`);
      gamePlayers = normalizeGamePlayers(rawPlayers);
    } catch (err) {
      // Some teams do not expose /games/:id/players; fall back to game detail payload.
      if (!(err && err.status === 404)) throw err;
      gamePlayers = normalizeGamePlayers(game.players || []);
    }
    state.participants = gamePlayers
      .map((p) => p.player_id ?? p.playerId ?? p.id)
      .filter((id) => Number.isInteger(id));
    if (!state.participants.includes(state.playerId)) state.participants.push(state.playerId);

    // Miss ownership is explicit when target_player_id is present.
    // In 2-player games, legacy miss events may have null target_player_id,
    // so infer they were aimed at "the other player" for correct UX.
    const incomingMisses = new Set();
    const twoPlayerGame = state.participants.length === 2;
    for (const m of state.moves) {
      if (m.player_id === state.playerId) continue;
      if (m.result !== 'miss') continue;
      const targetedMe = m.target_player_id != null
        ? m.target_player_id === state.playerId
        : twoPlayerGame;
      if (!targetedMe) continue;
      incomingMisses.add(key(m.row, m.col));
    }

    const expectedId = game.current_turn_player_id;
    const isMyTurn = game.status === 'playing' && expectedId === state.playerId;

    ui.gameMeta.textContent = `Game #${game.game_id} | ${game.status}`;
    ui.turnIndicator.textContent = game.status === 'finished'
      ? 'Game finished'
      : expectedId == null
        ? 'Waiting for setup or next phase'
        : isMyTurn
          ? 'Your turn'
          : `Waiting for ${state.playersById[expectedId] || `Player ${expectedId}`}`;
    const canPlaceShips =
      game.status === 'waiting_setup' && !serverPlaced && state.localShips.length < SHIP_SPECS.length;
    ui.placementControls.classList.toggle('hidden', game.status !== 'waiting_setup' || serverPlaced);
    renderShipPalette();

    paintGrid(ui.yourGrid, state.gridSize, myShipSet, incomingHits, incomingMisses, canPlaceShips, onPlaceCellClick);
    bindDragDropPlacement(canPlaceShips);

    ui.opponentGrids.innerHTML = '';
    const myMoves = state.moves.filter((m) => m.player_id === state.playerId);
    state.myUsedCells = new Set(myMoves.map((m) => key(m.row, m.col)));
    for (const pid of state.participants) {
      if (pid === state.playerId) continue;
      const block = document.createElement('div');
      block.className = 'opponent-block';
      const label = document.createElement('h4');
      const participant = game.players.find((p) => p.player_id === pid);
      const shipsRemaining = participant ? participant.ships_remaining : null;
      const eliminated = shipsRemaining === 0 && game.status !== 'waiting_setup';
      label.textContent = `${state.playersById[pid] || `Player ${pid}`}${eliminated ? ' (ELIMINATED)' : ''}`;
      const grid = document.createElement('div');
      grid.className = 'radar-grid';
      // Server move payload does not include target player, so for >2 players
      // we can only render your aggregate outgoing marks on each opponent board.
      const marks = { hits: new Set(), misses: new Set() };
      for (const m of myMoves) {
        if (m.target_player_id != null && m.target_player_id !== pid) continue;
        const coord = key(m.row, m.col);
        if (m.result === 'hit') marks.hits.add(coord);
        if (m.result === 'miss') marks.misses.add(coord);
      }
      paintGrid(
        grid,
        state.gridSize,
        new Set(),
        marks.hits,
        marks.misses,
        isMyTurn && game.status === 'playing' && !eliminated,
        (r, c) => onFire(pid, r, c)
      );
      block.appendChild(label);
      block.appendChild(grid);
      ui.opponentGrids.appendChild(block);
    }

    ui.movesLog.innerHTML = '';
    for (const m of state.moves) {
      const row = document.createElement('div');
      row.className = 'list-row';
      const who = state.playersById[m.player_id] || `Player ${m.player_id}`;
      const num = m.move_number != null ? `#${m.move_number} ` : '';
      row.textContent = `${num}${who} fired (${m.row},${m.col}) -> ${m.result.toUpperCase()} @ ${new Date(m.timestamp).toLocaleTimeString()}`;
      ui.movesLog.appendChild(row);
    }
    if (!state.moves.length) ui.movesLog.innerHTML = '<div class="list-row">No moves yet.</div>';

    await refreshStats();
    if (game.status === 'finished') {
      setStatus('Match finished. Winner decided.');
      maybeShowFinishedPopup(game);
    }
  }

  function onPlaceCellClick(r, c) {
    const shipLength = SHIP_SPECS[state.localShips.length];
    if (!shipLength) return;
    const placed = tryPlaceShipAt(r, c, shipLength);
    if (!placed) setStatus('Invalid placement for that ship. Try another position or orientation.');
  }

  function renderPlacementPreview() {
    const shipSet = new Set();
    for (const s of state.localShips) for (const p of s) shipSet.add(key(p.row, p.col));
    paintGrid(ui.yourGrid, state.gridSize, shipSet, new Set(), new Set(), true, onPlaceCellClick);
    bindDragDropPlacement(state.localShips.length < SHIP_SPECS.length);
    renderShipPalette();
  }

  async function submitShips() {
    if (state.localShips.length !== 3) {
      setStatus('Place all 3 ships before submitting.');
      return;
    }
    const ships = state.localShips.map((ship) => ship.map((s) => [s.row, s.col]));
    try {
      try {
        await apiService.post(`/api/games/${state.currentGameId}/ships`, { player_id: state.playerId, ships });
      } catch (shipErr) {
        // Compatibility fallback for servers that use /place instead of /ships.
        if (shipErr && shipErr.status === 404) {
          await apiService.post(`/api/games/${state.currentGameId}/place`, { player_id: state.playerId, ships });
        } else
        // If ships were already submitted from this client/tab previously, continue gracefully.
        if (!/already placed ships/i.test((shipErr && shipErr.message) || '')) throw shipErr;
      }
      try {
        await apiService.post(`/api/games/${state.currentGameId}/start`, {});
      } catch (startErr) {
        // Expected while game is still filling or other players are placing.
        if (!(startErr && startErr.status === 400)) throw startErr;
      }
      state.localShips = [];
      updatePlacementLabel();
      renderShipPalette();
      setStatus('Ships submitted. Waiting for other players to join/place ships.');
      await renderGame();
    } catch (err) {
      setStatus(mapFriendlyError(err));
    }
  }

  async function onFire(_targetPlayerId, r, c) {
    if (state.myUsedCells.has(key(r, c))) {
      setStatus('You already fired at that location.');
      return;
    }
    try {
      const before = state.moves.filter((m) => m.player_id === state.playerId && m.result === 'hit').length;
      const out = await apiService.post(`/api/games/${state.currentGameId}/fire`, { player_id: state.playerId, row: r, col: c });
      if (out.result === 'hit') {
        ui.explosion.classList.remove('flash');
        void ui.explosion.offsetWidth;
        ui.explosion.classList.add('flash');
      }
      if (out.game_status === 'finished' && out.winner_id != null) {
        const winner = state.playersById[out.winner_id] || `Player ${out.winner_id}`;
        setStatus(`Game over. Winner: ${winner}.`);
      } else {
        const after = before + (out.result === 'hit' ? 1 : 0);
        setStatus(`${out.result === 'hit' ? 'Hit confirmed.' : 'Miss.'} Total hits: ${after}.`);
      }
      await renderGame();
    } catch (err) {
      setStatus(mapFriendlyError(err));
    }
  }

  function stopPolling() {
    if (state.pollingId) clearInterval(state.pollingId);
    state.pollingId = null;
  }
  function startLobbyPolling() {
    stopPolling();
    state.pollingId = setInterval(() => renderLobby().catch(() => {}), 3000);
  }
  function startGamePolling() {
    stopPolling();
    renderGame().catch((e) => setStatus(mapFriendlyError(e)));
    state.pollingId = setInterval(() => renderGame().catch(() => {}), 3000);
  }

  async function connectServer() {
    const selected = ui.serverInput.value.trim() || ui.serverSelect.value.trim();
    const rootBase = normalizeServerRoot(selected);
    if (!rootBase) {
      setStatus('Enter a valid server URL.');
      return;
    }
    try {
      const isReachable = await probeServerApi(rootBase);
      if (!isReachable) throw new Error('unreachable');
      apiService.setBaseUrl(rootBase);
      ui.serverInput.value = rootBase;
      updateServerIndicator(true, `Connected: ${rootBase}`);
      state.connected = true;
      setStatus(`Connected to ${rootBase}. Register or continue.`);
      showScreen('register');
      const savedForServer = getServerIdentity(rootBase);
      const savedUsername = (savedForServer && savedForServer.username) || getStoredIdentity(STORAGE_KEYS.username) || '';
      if (savedUsername) ui.usernameInput.value = savedUsername;
      const savedId = (savedForServer && savedForServer.playerId) || parseInt(getStoredIdentity(STORAGE_KEYS.playerId), 10);
      if (Number.isInteger(savedId) && savedUsername) {
        state.playerId = savedId;
        state.username = savedUsername;
        ui.identityLine.textContent = `Saved identity: ${state.username} (#${state.playerId})`;
      } else {
        ui.identityLine.textContent = '';
      }
      await refreshPlayersDirectory();
    } catch (_) {
      state.connected = false;
      updateServerIndicator(false, 'Offline');
      setStatus('Cannot reach that server. Check URL format (use server root, not a game route) and verify CORS/API is enabled.');
    }
  }

  async function registerPlayer() {
    const username = ui.usernameInput.value.trim();
    if (!username) { setStatus('Enter a username first.'); return; }
    try {
      let out = null;
      try {
        out = await apiService.post('/api/players', { username });
      } catch (err) {
        // Some servers reject duplicate usernames instead of returning existing player_id.
        if (!(err && err.status === 409)) throw err;
        const players = await apiService.get('/api/players');
        const found = (Array.isArray(players) ? players : [])
          .find((p) => (p.username || p.display_name || '').toLowerCase() === username.toLowerCase());
        const existingId = found ? (found.id ?? found.player_id) : null;
        if (!Number.isInteger(existingId)) throw err;
        out = { player_id: existingId };
      }
      state.playerId = parseInt(out.player_id, 10);
      if (!Number.isInteger(state.playerId)) throw new Error('Server returned invalid player id');
      state.username = username;
      state.playersById[state.playerId] = state.username;
      setStoredIdentity(STORAGE_KEYS.playerId, String(state.playerId));
      setStoredIdentity(STORAGE_KEYS.username, state.username);
      setServerIdentity(apiService.getBaseUrl(), state.playerId, state.username);
      ui.identityLine.textContent = `Logged in as ${state.username} (#${state.playerId})`;
      setStatus('Registration complete. Entering lobby.');
      showScreen('lobby');
      await renderLobby();
      startLobbyPolling();
    } catch (err) {
      setStatus(mapFriendlyError(err));
    }
  }

  async function createGame() {
    try {
      const gridSize = parseInt(ui.createGridSize.value, 10) || 10;
      const maxPlayers = parseInt(ui.createMaxPlayers.value, 10) || 3;
      const out = await apiService.post('/api/games', { creator_id: state.playerId, grid_size: gridSize, max_players: maxPlayers });
      state.currentGameId = out.game_id ?? out.id;
      if (!state.currentGameId) throw new Error('Connected server returned an unsupported game payload');
      state.gridSize = gridSize;
      state.localShips = [];
      updatePlacementLabel();
      renderShipPalette();
      showScreen('game');
      setStatus(`Created game #${out.game_id}. Place ships.`);
      startGamePolling();
    } catch (err) {
      setStatus(mapFriendlyError(err));
    }
  }

  async function backToLobby() {
    state.currentGameId = null;
    state.localShips = [];
    state.finishedPopupGameId = null;
    hideResultModal();
    updatePlacementLabel();
    renderShipPalette();
    showScreen('lobby');
    await renderLobby();
    startLobbyPolling();
  }

  function initServerOptions() {
    ui.serverSelect.innerHTML = '';
    for (const option of CLASS_SERVER_OPTIONS) {
      const el = document.createElement('option');
      el.value = option.url;
      el.textContent = option.label;
      ui.serverSelect.appendChild(el);
    }
    const stored = localStorage.getItem(STORAGE_KEYS.baseUrl);
    if (stored) {
      ui.serverInput.value = stored;
    } else if (ui.serverSelect.options.length > 0) {
      ui.serverInput.value = ui.serverSelect.options[0].value;
    }
  }

  function bindEvents() {
    ui.connectBtn.addEventListener('click', connectServer);
    if (ui.themeToggleBtn) {
      ui.themeToggleBtn.addEventListener('click', () => {
        const next = document.body.classList.contains('light-mode') ? 'dark' : 'light';
        applyTheme(next);
      });
    }
    ui.registerBtn.addEventListener('click', registerPlayer);
    ui.createGameBtn.addEventListener('click', createGame);
    ui.refreshLobbyBtn.addEventListener('click', () => renderLobby().catch(() => {}));
    ui.backToLobbyBtn.addEventListener('click', backToLobby);
    ui.orientH.addEventListener('click', () => { state.vertical = false; ui.orientH.classList.add('active-mini'); ui.orientV.classList.remove('active-mini'); });
    ui.orientV.addEventListener('click', () => { state.vertical = true; ui.orientV.classList.add('active-mini'); ui.orientH.classList.remove('active-mini'); });
    ui.clearShipsBtn.addEventListener('click', () => {
      state.localShips = [];
      updatePlacementLabel();
      renderPlacementPreview();
    });
    ui.submitShipsBtn.addEventListener('click', submitShips);
    if (ui.resultCloseBtn) ui.resultCloseBtn.addEventListener('click', hideResultModal);
  }

  initServerOptions();
  applyTheme(localStorage.getItem(STORAGE_KEYS.theme) || 'dark');
  updatePlacementLabel();
  renderShipPalette();
  bindEvents();
  showScreen('none');
})();
