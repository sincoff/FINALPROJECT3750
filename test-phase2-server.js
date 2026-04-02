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

  // 1) POST /api/reset
  let r = await post('/api/reset', {});
  assert(r.status === 200, `POST /api/reset expected 200, got ${r.status}`);
  console.log('PASS: POST /api/reset');

  // 2) POST /api/players alice
  r = await post('/api/players', { username: 'alice' });
  assert(r.status === 201 || r.status === 200, `POST /api/players alice expected 201/200, got ${r.status}`);
  const aliceId = r.data && r.data.player_id;
  assert(Number.isInteger(aliceId), 'alice player_id missing/invalid');
  console.log(`PASS: POST /api/players alice -> id=${aliceId}`);

  // 3) POST /api/players bob
  r = await post('/api/players', { username: 'bob' });
  assert(r.status === 201 || r.status === 200, `POST /api/players bob expected 201/200, got ${r.status}`);
  const bobId = r.data && r.data.player_id;
  assert(Number.isInteger(bobId), 'bob player_id missing/invalid');
  console.log(`PASS: POST /api/players bob -> id=${bobId}`);

  // 4) GET /api/players
  r = await get('/api/players');
  assert(r.status === 200, `GET /api/players expected 200, got ${r.status}`);
  assert(Array.isArray(r.data), 'GET /api/players expected array');
  const aliceRow = r.data.find((p) => p && p.id === aliceId && p.username === 'alice');
  const bobRow = r.data.find((p) => p && p.id === bobId && p.username === 'bob');
  assert(aliceRow, 'GET /api/players missing alice with {id, username}');
  assert(bobRow, 'GET /api/players missing bob with {id, username}');
  console.log('PASS: GET /api/players contains alice and bob');

  // 5) GET /api/players/:id for alice
  r = await get(`/api/players/${aliceId}`);
  assert(r.status === 200, `GET /api/players/:id expected 200, got ${r.status}`);
  assert(r.data && r.data.id === aliceId && r.data.username === 'alice', 'GET /api/players/:id returned wrong payload');
  console.log('PASS: GET /api/players/:id');

  // 6) POST /api/games create
  r = await post('/api/games', { creator_id: aliceId, grid_size: 10, max_players: 3 });
  assert(r.status === 201, `POST /api/games expected 201, got ${r.status}`);
  const gameId = r.data && r.data.game_id;
  assert(Number.isInteger(gameId), 'game_id missing/invalid');
  console.log(`PASS: POST /api/games -> game=${gameId}`);

  // 7) GET /api/games includes game
  r = await get('/api/games');
  assert(r.status === 200, `GET /api/games expected 200, got ${r.status}`);
  assert(Array.isArray(r.data), 'GET /api/games expected array');
  let gameRow = r.data.find((g) => g && g.id === gameId);
  assert(gameRow, 'GET /api/games missing created game');
  assert(typeof gameRow.status === 'string', 'GET /api/games game missing status');
  assert(gameRow.grid_size === 10, 'GET /api/games grid_size mismatch');
  assert(Number.isInteger(gameRow.player_count), 'GET /api/games player_count missing/invalid');
  console.log('PASS: GET /api/games contains created game');

  // 8) POST /api/games/:id/join bob
  r = await post(`/api/games/${gameId}/join`, { player_id: bobId });
  assert(r.status === 200, `POST /api/games/:id/join expected 200, got ${r.status}`);
  console.log('PASS: POST /api/games/:id/join bob');

  // 9) GET /api/games player_count now 2
  r = await get('/api/games');
  assert(r.status === 200, `GET /api/games after join expected 200, got ${r.status}`);
  gameRow = r.data.find((g) => g && g.id === gameId);
  assert(gameRow, 'GET /api/games missing game after join');
  assert(gameRow.player_count === 2, `player_count expected 2 after join, got ${gameRow.player_count}`);
  console.log('PASS: GET /api/games player_count updated to 2');

  // 10) POST /api/games/:id/ships alice
  const aliceShips = [[0, 0], [0, 1], [0, 2]];
  r = await post(`/api/games/${gameId}/ships`, { player_id: aliceId, ships: aliceShips });
  assert(r.status === 200 || r.status === 201, `POST /api/games/:id/ships alice expected 200/201, got ${r.status}`);
  console.log('PASS: POST /api/games/:id/ships alice');

  // 11) GET /api/games/:id/ships?player_id=alice_id
  r = await get(`/api/games/${gameId}/ships?player_id=${aliceId}`);
  assert(r.status === 200, `GET /api/games/:id/ships for alice expected 200, got ${r.status}`);
  assert(r.data && Array.isArray(r.data.ships), 'GET /api/games/:id/ships expected ships array');
  assert(r.data.ships.length >= 3, `expected at least 3 ships for alice, got ${r.data.ships.length}`);
  console.log('PASS: GET /api/games/:id/ships returns alice ships');

  // 12) POST /api/games/:id/ships bob
  const bobShips = [[1, 0], [1, 1], [1, 2]];
  r = await post(`/api/games/${gameId}/ships`, { player_id: bobId, ships: bobShips });
  assert(r.status === 200 || r.status === 201, `POST /api/games/:id/ships bob expected 200/201, got ${r.status}`);
  console.log('PASS: POST /api/games/:id/ships bob');

  // 13) POST /api/games/:id/start active or already auto-active
  r = await post(`/api/games/${gameId}/start`, {});
  if (r.status === 200) {
    assert(r.data && r.data.status === 'active', `start response status expected active, got ${r.data && r.data.status}`);
    console.log('PASS: POST /api/games/:id/start -> active');
  } else {
    // fallback verify auto activation via GET /api/games
    const g = await get('/api/games');
    assert(g.status === 200, `GET /api/games fallback expected 200, got ${g.status}`);
    const row = g.data.find((x) => x.id === gameId);
    assert(row && row.status === 'active', `game should be active (auto-activated), got ${row && row.status}`);
    console.log('PASS: game is active (auto-activated)');
  }

  // 14) CORS header check with Origin
  r = await get('/api/games', { Origin: 'http://localhost:8080' });
  const allowOrigin = r.headers.get('access-control-allow-origin');
  assert(allowOrigin != null && allowOrigin.length > 0, 'CORS header Access-Control-Allow-Origin missing');
  console.log(`PASS: CORS allow-origin present (${allowOrigin})`);

  // 15) OPTIONS preflight check on /api/games
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

