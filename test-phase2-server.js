/* eslint-disable no-console */
const RAW_BASE_URL = process.argv[2] || 'http://localhost:3000';
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, '');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch (_) {}

  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

const get = (path, headers) => request(path, { headers });
const post = (path, body, headers) => request(path, { method: 'POST', body, headers });
const optionsReq = (path, headers) => request(path, { method: 'OPTIONS', headers });

async function main() {
  console.log(`Running Phase 2 server endpoint tests against ${BASE_URL}`);

  let r = await get('/api/');
  assert(r.status === 200, `GET /api/ expected 200, got ${r.status}`);
  assert(r.data && r.data.version === '2.3.0', 'GET /api/ version mismatch');
  console.log('PASS: GET /api/');

  r = await get('/api/version');
  assert(r.status === 200 && r.data.api_version === '2.3.0', 'GET /api/version');
  console.log('PASS: GET /api/version');

  r = await get('/api/health');
  assert(r.status === 200 && r.data.status === 'ok', 'GET /api/health');
  assert(Number.isInteger(r.data.uptime_seconds), 'uptime_seconds');
  console.log('PASS: GET /api/health');

  r = await post('/api/reset', {});
  assert(r.status === 200, `POST /api/reset expected 200, got ${r.status}`);
  console.log('PASS: POST /api/reset');

  r = await post('/api/players', { username: 'alice' });
  assert(r.status === 201 || r.status === 200, `POST /api/players alice expected 201/200, got ${r.status}`);
  const aliceId = r.data && r.data.player_id;
  assert(Number.isInteger(aliceId), 'alice player_id missing/invalid');
  console.log(`PASS: POST /api/players alice -> id=${aliceId}`);

  r = await post('/api/players', { username: 'bob' });
  assert(r.status === 201 || r.status === 200, `POST /api/players bob expected 201/200, got ${r.status}`);
  const bobId = r.data && r.data.player_id;
  assert(Number.isInteger(bobId), 'bob player_id missing/invalid');
  console.log(`PASS: POST /api/players bob -> id=${bobId}`);

  r = await get('/api/players');
  assert(r.status === 200, `GET /api/players expected 200, got ${r.status}`);
  assert(Array.isArray(r.data), 'GET /api/players expected array');
  const aliceRow = r.data.find((p) => p && p.id === aliceId && p.username === 'alice');
  const bobRow = r.data.find((p) => p && p.id === bobId && p.username === 'bob');
  assert(aliceRow, 'GET /api/players missing alice with {id, username}');
  assert(bobRow, 'GET /api/players missing bob with {id, username}');
  console.log('PASS: GET /api/players contains alice and bob');

  r = await get(`/api/players/${aliceId}`);
  assert(r.status === 200, `GET /api/players/:id expected 200, got ${r.status}`);
  assert(r.data && r.data.id === aliceId && r.data.username === 'alice', 'GET /api/players/:id payload');
  console.log('PASS: GET /api/players/:id');

  r = await post('/api/games', { creator_id: aliceId, grid_size: 10, max_players: 2 });
  assert(r.status === 201, `POST /api/games expected 201, got ${r.status}`);
  assert(r.data.game_id != null && r.data.status === 'waiting_setup', 'POST /api/games response shape');
  const gameId = r.data.game_id;
  console.log(`PASS: POST /api/games -> game=${gameId}`);

  r = await get('/api/games');
  assert(r.status === 200, `GET /api/games expected 200, got ${r.status}`);
  let gameRow = r.data.find((g) => g && g.id === gameId);
  assert(gameRow && gameRow.status === 'waiting_setup', 'list status waiting_setup');
  assert(gameRow.grid_size === 10, 'grid_size');
  assert(Number.isInteger(gameRow.player_count), 'player_count');
  console.log('PASS: GET /api/games contains created game');

  r = await post(`/api/games/${gameId}/join`, { player_id: bobId });
  assert(r.status === 200, `join expected 200, got ${r.status}`);
  assert(r.data && r.data.status === 'joined', 'join response');
  console.log('PASS: POST /api/games/:id/join bob');

  r = await get('/api/games');
  gameRow = r.data.find((g) => g && g.id === gameId);
  assert(gameRow.player_count === 2, `player_count expected 2, got ${gameRow.player_count}`);
  console.log('PASS: GET /api/games player_count updated to 2');

  const aliceShips = [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }];
  r = await post(`/api/games/${gameId}/ships`, { player_id: aliceId, ships: aliceShips });
  assert(r.status === 200, `ships alice expected 200, got ${r.status}`);
  assert(r.data && r.data.status === 'placed', 'ships response');
  console.log('PASS: POST /api/games/:id/ships alice');

  r = await get(`/api/games/${gameId}/ships?player_id=${aliceId}`);
  assert(r.status === 200, `GET ships alice expected 200, got ${r.status}`);
  assert(r.data && Array.isArray(r.data.ships) && r.data.ships.length === 3, 'alice ships');
  console.log('PASS: GET /api/games/:id/ships returns alice ships');

  const bobShips = [{ row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 }];
  r = await post(`/api/games/${gameId}/ships`, { player_id: bobId, ships: bobShips });
  assert(r.status === 200, `ships bob expected 200, got ${r.status}`);
  assert(r.data && r.data.status === 'placed', 'bob ships response');
  console.log('PASS: POST /api/games/:id/ships bob');

  r = await get(`/api/games/${gameId}`);
  assert(r.status === 200, `GET /api/games/:id expected 200`);
  assert(r.data.status === 'playing', `game detail status playing, got ${r.data.status}`);
  assert(Array.isArray(r.data.players) && r.data.players.length === 2, 'players array');
  assert(r.data.current_turn_player_id != null, 'current_turn_player_id');
  assert(r.data.total_moves === 0, 'total_moves');
  console.log('PASS: GET /api/games/:id after both placed');

  r = await post(`/api/games/${gameId}/start`, {});
  assert(r.status === 200, `start expected 200`);
  assert(r.data.status === 'playing', 'start still playing');
  console.log('PASS: POST /api/games/:id/start');

  r = await get('/api/games', { Origin: 'http://localhost:8080' });
  const allowOrigin = r.headers.get('access-control-allow-origin');
  assert(allowOrigin != null && allowOrigin.length > 0, 'CORS header Access-Control-Allow-Origin missing');
  console.log(`PASS: CORS allow-origin present (${allowOrigin})`);

  r = await optionsReq('/api/games', {
    Origin: 'http://localhost:8080',
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'Content-Type',
  });
  assert(r.status === 200, `OPTIONS /api/games expected 200, got ${r.status}`);
  const preAllowOrigin = r.headers.get('access-control-allow-origin');
  const preAllowMethods = r.headers.get('access-control-allow-methods');
  assert(preAllowOrigin != null && preAllowOrigin.length > 0, 'OPTIONS missing Access-Control-Allow-Origin');
  assert(preAllowMethods != null && preAllowMethods.length > 0, 'OPTIONS missing Access-Control-Allow-Methods');
  console.log('PASS: OPTIONS preflight CORS headers');

  console.log('All Phase 2 server endpoint tests passed.');
}

main().catch((err) => {
  console.error(`Phase 2 server test failed: ${err.message}`);
  process.exit(1);
});
