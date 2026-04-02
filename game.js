(function () {
  'use strict';

  const SHIP_SPECS = [1, 1, 1];
  const STORAGE_KEYS = {
    baseUrl: 'battleship.baseUrl',
    playerId: 'battleship.playerId',
    username: 'battleship.username',
  };
  const CLASS_SERVER_OPTIONS = [
    { label: 'Localhost (3000)', url: 'http://localhost:3000' },
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
        const msg = data && data.error ? data.error : `Request failed (${res.status})`;
        const err = new Error(msg);
        err.status = res.status;
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
  };

  function setStatus(msg) { ui.status.textContent = msg; }
  function key(r, c) { return `${r},${c}`; }
  function mapFriendlyError(err) {
    const msg = (err && err.message) || '';
    if (/Not this player/i.test(msg)) return 'Hold fire - it is not your turn.';
    if (/Duplicate fire/i.test(msg)) return 'You already fired at that location.';
    if (/finished/i.test(msg)) return 'Game over. Return to lobby to start another game.';
    if (/not active/i.test(msg)) return 'Game is waiting for players to place ships.';
    if (/not in this game/i.test(msg)) return 'You are not part of this game.';
    return 'Action failed. Check server state and try again.';
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

  function loadParticipantsByProbing() {
    const allIds = Object.keys(state.playersById).map((id) => parseInt(id, 10));
    return Promise.all(allIds.map(async (pid) => {
      try {
        await apiService.get(`/api/games/${state.currentGameId}/ships?player_id=${pid}&requester_id=${state.playerId}`);
        return pid;
      } catch (_) {
        return null;
      }
    })).then((ids) => ids.filter((x) => x != null));
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

  function getIncomingHitsOnMe() {
    const hits = new Set();
    for (const m of state.moves) {
      if (m.player_id !== state.playerId && m.result === 'hit') {
        hits.add(key(m.row, m.col));
      }
    }
    return hits;
  }

  async function renderLobby() {
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
      if (g.status === 'waiting') {
        const joinBtn = document.createElement('button');
        joinBtn.className = 'btn-radar';
        joinBtn.textContent = 'JOIN';
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
    const [game, moves] = await Promise.all([
      apiService.get(`/api/games/${state.currentGameId}`),
      apiService.get(`/api/games/${state.currentGameId}/moves`),
    ]);
    state.game = game;
    state.moves = moves;
    state.gridSize = game.grid_size;

    const myShipsData = await apiService.get(`/api/games/${state.currentGameId}/ships?player_id=${state.playerId}&requester_id=${state.playerId}`);
    const myShipSet = new Set((myShipsData.ships || []).map((s) => key(s.row, s.col)));
    if (myShipSet.size === 0 && game.status === 'waiting' && state.localShips.length > 0) {
      for (const ship of state.localShips) {
        for (const cell of ship) myShipSet.add(key(cell.row, cell.col));
      }
    }
    const incomingHits = getIncomingHitsOnMe();
    const incomingMisses = new Set();

    for (const m of state.moves) {
      if (m.player_id !== state.playerId && m.result === 'miss') incomingMisses.add(key(m.row, m.col));
    }

    const activePlayers = await loadParticipantsByProbing();
    state.participants = activePlayers.length ? activePlayers : [state.playerId];
    const meIdx = state.participants.indexOf(state.playerId);
    const expectedId = state.participants[(game.current_turn_index % state.participants.length + state.participants.length) % state.participants.length];
    const isMyTurn = game.status === 'active' && expectedId === state.playerId;

    ui.gameMeta.textContent = `Game #${game.game_id} | ${game.status}`;
    ui.turnIndicator.textContent = game.status === 'finished'
      ? 'Game finished'
      : isMyTurn ? 'Your turn' : `Waiting for ${state.playersById[expectedId] || `Player ${expectedId}`}`;
    ui.placementControls.classList.toggle('hidden', myShipSet.size > 0 || game.status !== 'waiting');

    paintGrid(ui.yourGrid, state.gridSize, myShipSet, incomingHits, incomingMisses, game.status === 'waiting' && myShipSet.size === 0, onPlaceCellClick);

    ui.opponentGrids.innerHTML = '';
    for (const pid of state.participants) {
      if (pid === state.playerId) continue;
      const block = document.createElement('div');
      block.className = 'opponent-block';
      const label = document.createElement('h4');
      label.textContent = state.playersById[pid] || `Player ${pid}`;
      const grid = document.createElement('div');
      grid.className = 'radar-grid';
      const marks = getMoveCellsForPlayer(state.playerId);
      paintGrid(grid, state.gridSize, new Set(), marks.hits, marks.misses, isMyTurn && game.status === 'active', (r, c) => onFire(pid, r, c));
      block.appendChild(label);
      block.appendChild(grid);
      ui.opponentGrids.appendChild(block);
    }

    ui.movesLog.innerHTML = '';
    for (const m of state.moves) {
      const row = document.createElement('div');
      row.className = 'list-row';
      const who = state.playersById[m.player_id] || `Player ${m.player_id}`;
      row.textContent = `${who} fired (${m.row},${m.col}) -> ${m.result.toUpperCase()} @ ${new Date(m.timestamp).toLocaleTimeString()}`;
      ui.movesLog.appendChild(row);
    }
    if (!state.moves.length) ui.movesLog.innerHTML = '<div class="list-row">No moves yet.</div>';

    await refreshStats();
    if (game.status === 'finished') setStatus('Match finished. Winner decided.');
    if (meIdx === -1) setStatus('You are no longer in this game.');
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
    ui.placementShipLabel.textContent = SHIP_SPECS[state.localShips.length] ? `SHIP ${state.localShips.length + 1}` : 'READY';
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
    const ships = state.localShips.map((ship) => [ship[0].row, ship[0].col]);
    try {
      await apiService.post(`/api/games/${state.currentGameId}/ships`, { player_id: state.playerId, ships });
      await apiService.post(`/api/games/${state.currentGameId}/start`, {});
      state.localShips = [];
      setStatus('Ships submitted.');
      await renderGame();
    } catch (err) {
      setStatus(mapFriendlyError(err));
    }
  }

  async function onFire(_targetPlayerId, r, c) {
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
      const savedUsername = localStorage.getItem(STORAGE_KEYS.username) || '';
      if (savedUsername) ui.usernameInput.value = savedUsername;
      const savedId = localStorage.getItem(STORAGE_KEYS.playerId);
      if (savedId) {
        state.playerId = parseInt(savedId, 10);
        state.username = savedUsername;
        ui.identityLine.textContent = `Saved identity: ${state.username || 'Unknown'} (#${state.playerId})`;
      }
      const players = await apiService.get('/api/players');
      state.playersById = {};
      for (const p of players) state.playersById[p.id] = p.username;
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
      localStorage.setItem(STORAGE_KEYS.playerId, String(state.playerId));
      localStorage.setItem(STORAGE_KEYS.username, state.username);
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
      state.gridSize = out.grid_size;
      state.localShips = [];
      ui.placementShipLabel.textContent = 'SHIP 1';
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
    if (stored) ui.serverInput.value = stored;
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
      ui.placementShipLabel.textContent = 'SHIP 1';
      renderPlacementPreview();
    });
    ui.submitShipsBtn.addEventListener('click', submitShips);
  }

  initServerOptions();
  bindEvents();
  showScreen('register');
})();
