(function () {
  'use strict';

  const SHIP_SPECS = [4, 3, 2];
  const STORAGE_KEYS = {
    baseUrl: 'battleship.baseUrl',
    playerId: 'battleship.playerId',
    username: 'battleship.username',
  };

  function getStoredIdentity(key) {
    // Keep identity per-tab to avoid two-player local testing sessions
    // overwriting each other in shared localStorage.
    return sessionStorage.getItem(key);
  }

  function setStoredIdentity(key, value) {
    sessionStorage.setItem(key, value);
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

  const ui = {
    status: document.getElementById('status'),
    serverSelect: document.getElementById('server-select'),
    serverInput: document.getElementById('server-input'),
    connectBtn: document.getElementById('connect-btn'),
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
    placementShipLabel: document.getElementById('placement-ship-label'),
    orientH: document.getElementById('orient-h'),
    orientV: document.getElementById('orient-v'),
    submitShipsBtn: document.getElementById('submit-ships-btn'),
    clearShipsBtn: document.getElementById('clear-ships-btn'),
    statsPanel: document.getElementById('stats-panel'),
    movesLog: document.getElementById('moves-log'),
    backToLobbyBtn: document.getElementById('back-to-lobby-btn'),
    explosion: document.getElementById('hit-explosion'),
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
    globallyUsedCells: new Set(),
  };

  function setStatus(msg) { ui.status.textContent = msg; }
  function key(r, c) { return `${r},${c}`; }
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
    const s = await apiService.get(`/api/players/${state.playerId}/stats`);
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
    const [game, moves] = await Promise.all([
      apiService.get(`/api/games/${state.currentGameId}`),
      apiService.get(`/api/games/${state.currentGameId}/moves`),
    ]);
    state.game = game;
    state.moves = moves;
    state.gridSize = game.grid_size;

    const myShipsData = await apiService.get(`/api/games/${state.currentGameId}/ships?player_id=${state.playerId}&requester_id=${state.playerId}`);
    const serverShips = myShipsData.ships || [];
    const serverPlaced = serverShips.length > 0;
    const myShipSet = new Set(serverShips.map((s) => key(s.row, s.col)));
    if (!serverPlaced && game.status === 'waiting_setup' && state.localShips.length > 0) {
      for (const ship of state.localShips) {
        for (const cell of ship) myShipSet.add(key(cell.row, cell.col));
      }
    }
    const incomingHits = getIncomingHitsOnMe(myShipSet);

    const gamePlayers = await apiService.get(`/api/games/${state.currentGameId}/players`);
    state.participants = gamePlayers.map((p) => p.player_id);
    if (!state.participants.includes(state.playerId)) state.participants.push(state.playerId);

    // Move payload does not reliably include target ownership for misses.
    // Do not render incoming misses on your fleet to avoid showing
    // another player's miss on the wrong board.
    const incomingMisses = new Set();

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

    paintGrid(ui.yourGrid, state.gridSize, myShipSet, incomingHits, incomingMisses, canPlaceShips, onPlaceCellClick);

    ui.opponentGrids.innerHTML = '';
    const myMoves = state.moves.filter((m) => m.player_id === state.playerId);
    state.globallyUsedCells = new Set(state.moves.map((m) => key(m.row, m.col)));
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
    if (game.status === 'finished') setStatus('Match finished. Winner decided.');
  }

  function onPlaceCellClick(r, c) {
    const shipLength = SHIP_SPECS[state.localShips.length];
    if (!shipLength) return;
    const occupied = new Set();
    for (const ship of state.localShips) ship.forEach((p) => occupied.add(key(p.row, p.col)));
    const coords = [];
    for (let i = 0; i < shipLength; i++) {
      const rr = state.vertical ? r + i : r;
      const cc = state.vertical ? c : c + i;
      if (rr < 0 || rr >= state.gridSize || cc < 0 || cc >= state.gridSize) return;
      if (occupied.has(key(rr, cc))) return;
      coords.push({ row: rr, col: cc });
    }
    state.localShips.push(coords);
    ui.placementShipLabel.textContent = SHIP_SPECS[state.localShips.length] ? `1x${SHIP_SPECS[state.localShips.length]}` : 'READY';
    renderPlacementPreview();
  }

  function renderPlacementPreview() {
    const shipSet = new Set();
    for (const s of state.localShips) for (const p of s) shipSet.add(key(p.row, p.col));
    paintGrid(ui.yourGrid, state.gridSize, shipSet, new Set(), new Set(), true, onPlaceCellClick);
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
      setStatus('Ships submitted. Waiting for other players to join/place ships.');
      await renderGame();
    } catch (err) {
      setStatus(mapFriendlyError(err));
    }
  }

  async function onFire(_targetPlayerId, r, c) {
    if (state.globallyUsedCells.has(key(r, c))) {
      setStatus('That coordinate was already used in this game.');
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
    const normalized = apiService.normalize(selected);
    if (!normalized) {
      setStatus('Enter a valid server URL.');
      return;
    }
    apiService.setBaseUrl(normalized);
    try {
      await apiService.get('/api/players');
      updateServerIndicator(true, 'Connected');
      state.connected = true;
      setStatus('Server reachable. Register or continue.');
      showScreen('register');
      const savedUsername = getStoredIdentity(STORAGE_KEYS.username) || '';
      if (savedUsername) ui.usernameInput.value = savedUsername;
      const savedId = getStoredIdentity(STORAGE_KEYS.playerId);
      if (savedId) {
        const parsedId = parseInt(savedId, 10);
        if (!isNaN(parsedId)) {
          state.playerId = parsedId;
          state.username = savedUsername;
          ui.identityLine.textContent = `Saved identity: ${state.username || 'Unknown'} (#${state.playerId})`;
        }
      }
      await refreshPlayersDirectory();
    } catch (_) {
      updateServerIndicator(false, 'Offline');
      setStatus('Cannot reach that server.');
    }
  }

  async function registerPlayer() {
    const username = ui.usernameInput.value.trim();
    if (!username) { setStatus('Enter a username first.'); return; }
    try {
      const out = await apiService.post('/api/players', { username });
      state.playerId = out.player_id;
      state.username = username;
      state.playersById[state.playerId] = state.username;
      setStoredIdentity(STORAGE_KEYS.playerId, String(state.playerId));
      setStoredIdentity(STORAGE_KEYS.username, state.username);
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
      state.currentGameId = out.game_id;
      state.gridSize = gridSize;
      state.localShips = [];
      ui.placementShipLabel.textContent = '1x4';
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
    ui.registerBtn.addEventListener('click', registerPlayer);
    ui.createGameBtn.addEventListener('click', createGame);
    ui.refreshLobbyBtn.addEventListener('click', () => renderLobby().catch(() => {}));
    ui.backToLobbyBtn.addEventListener('click', backToLobby);
    ui.orientH.addEventListener('click', () => { state.vertical = false; ui.orientH.classList.add('active-mini'); ui.orientV.classList.remove('active-mini'); });
    ui.orientV.addEventListener('click', () => { state.vertical = true; ui.orientV.classList.add('active-mini'); ui.orientH.classList.remove('active-mini'); });
    ui.clearShipsBtn.addEventListener('click', () => {
      state.localShips = [];
      ui.placementShipLabel.textContent = '1x4';
      renderPlacementPreview();
    });
    ui.submitShipsBtn.addEventListener('click', submitShips);
  }

  initServerOptions();
  bindEvents();
  showScreen('none');
})();
