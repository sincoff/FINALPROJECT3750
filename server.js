require('dotenv').config();

/**
 * Multiplayer Battleship API Server
 * Tech stack: Express.js, pg (PostgreSQL)
 * player_id and game_id are integers (SERIAL)
 */

const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const TEST_MODE = process.env.TEST_MODE || 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const E = {
  badRequest: (m) => ({ error: 'bad_request', message: m }),
  notFound: (m) => ({ error: 'not_found', message: m }),
  forbidden: (m) => ({ error: 'forbidden', message: m }),
  conflict: (m) => ({ error: 'conflict', message: m }),
  server: (m) => ({ error: 'internal_server_error', message: m }),
};

const USERNAME_REGEX = /^[A-Za-z0-9_]+$/;

async function maybeTransitionToPlaying(gameId, client) {
  const db = client || pool;
  const gRes = await db.query('SELECT status, max_players FROM games WHERE game_id = $1', [gameId]);
  if (gRes.rows.length === 0) return;
  const gpRes = await db.query(
    `SELECT COUNT(*)::int AS total,
     COALESCE(SUM(CASE WHEN ships_placed THEN 1 ELSE 0 END)::int, 0) AS placed
     FROM game_players WHERE game_id = $1`,
    [gameId]
  );
  const total = gpRes.rows[0].total || 0;
  const placed = gpRes.rows[0].placed || 0;
  const game = gRes.rows[0];
  if (game.status === 'waiting_setup' && total === game.max_players && total > 0 && placed === total) {
    await db.query('UPDATE games SET status = $1 WHERE game_id = $2', ['playing', gameId]);
  }
}

function isValidId(s) {
  const n = parseInt(s, 10);
  return !isNaN(n) && n >= 1;
}

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      DROP TABLE IF EXISTS moves CASCADE;
      DROP TABLE IF EXISTS ships CASCADE;
      DROP TABLE IF EXISTS game_players CASCADE;
      DROP TABLE IF EXISTS games CASCADE;
      DROP TABLE IF EXISTS players CASCADE;
    `);
    await client.query(`
      CREATE TABLE players (
        player_id SERIAL PRIMARY KEY,
        display_name TEXT UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        total_games INTEGER DEFAULT 0,
        total_wins INTEGER DEFAULT 0,
        total_losses INTEGER DEFAULT 0,
        total_moves INTEGER DEFAULT 0
      );

      CREATE TABLE games (
        game_id SERIAL PRIMARY KEY,
        grid_size INTEGER NOT NULL,
        max_players INTEGER NOT NULL,
        status TEXT DEFAULT 'waiting_setup',
        current_turn_index INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE game_players (
        game_id INTEGER REFERENCES games(game_id) ON DELETE CASCADE,
        player_id INTEGER REFERENCES players(player_id) ON DELETE CASCADE,
        turn_order INTEGER NOT NULL,
        is_eliminated BOOLEAN DEFAULT FALSE,
        ships_placed BOOLEAN DEFAULT FALSE,
        PRIMARY KEY (game_id, player_id)
      );

      CREATE TABLE ships (
        id SERIAL PRIMARY KEY,
        game_id INTEGER REFERENCES games(game_id) ON DELETE CASCADE,
        player_id INTEGER REFERENCES players(player_id) ON DELETE CASCADE,
        ship_row INTEGER NOT NULL,
        ship_col INTEGER NOT NULL
      );

      CREATE TABLE moves (
        id SERIAL PRIMARY KEY,
        game_id INTEGER REFERENCES games(game_id) ON DELETE CASCADE,
        player_id INTEGER REFERENCES players(player_id) ON DELETE CASCADE,
        target_player_id INTEGER REFERENCES players(player_id) ON DELETE CASCADE,
        move_row INTEGER NOT NULL,
        move_col INTEGER NOT NULL,
        result TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database tables initialized.');
  } finally {
    client.release();
  }
}

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Test-Password');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// GET /api/ and /api — API info (v2.3)
const apiInfoHandler = (req, res) => {
  res.status(200).json({
    name: 'Battleship API',
    version: '2.3.0',
    spec_version: '2.3',
    environment: 'production',
    test_mode: TEST_MODE === 'true',
  });
};
app.get('/api', apiInfoHandler);
app.get('/api/', apiInfoHandler);

app.get('/api/version', (req, res) => {
  res.status(200).json({ api_version: '2.3.0', spec_version: '2.3' });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime_seconds: Math.floor(process.uptime()) });
});

// Test mode middleware
app.use('/api/test', (req, res, next) => {
  if (TEST_MODE !== 'true') {
    return res.status(403).json(E.forbidden('Test mode disabled'));
  }
  const password = req.headers['x-test-password'];
  if (password !== 'clemson-test-2026') {
    return res.status(403).json(E.forbidden('Invalid or missing test password'));
  }
  next();
});

// Static files
app.use(express.static('.'));

// ========== Production Endpoints ==========

// POST /api/reset
app.post('/api/reset', async (req, res) => {
  try {
    await pool.query('TRUNCATE players, games, game_players, ships, moves RESTART IDENTITY CASCADE');
    res.status(200).json({ status: 'reset' });
  } catch (err) {
    console.error('POST /api/reset:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// POST /api/players
app.post('/api/players', async (req, res) => {
  try {
    const { username, player_id: clientPlayerId } = req.body || {};
    if (clientPlayerId !== undefined) {
      return res.status(400).json(E.badRequest('Clients may not supply player_id'));
    }
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return res.status(400).json(E.badRequest('username is required and must be non-empty'));
    }
    const displayName = username.trim();
    if (displayName.length > 30) {
      return res.status(400).json(E.badRequest('Username must be at most 30 characters'));
    }
    if (!USERNAME_REGEX.test(displayName)) {
      return res
        .status(400)
        .json(E.badRequest('Username must be alphanumeric with underscores only'));
    }
    const existing = await pool.query(
      'SELECT player_id FROM players WHERE display_name = $1',
      [displayName]
    );
    if (existing.rows.length > 0) {
      return res.status(200).json({ player_id: parseInt(existing.rows[0].player_id, 10) });
    }
    const result = await pool.query(
      'INSERT INTO players (display_name) VALUES ($1) RETURNING player_id',
      [displayName]
    );
    const playerId = parseInt(result.rows[0].player_id, 10);
    res.status(201).json({ player_id: playerId });
  } catch (err) {
    console.error('POST /api/players:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// GET /api/players
app.get('/api/players', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT player_id, display_name FROM players ORDER BY player_id ASC'
    );
    const players = result.rows.map((p) => ({
      id: parseInt(p.player_id, 10),
      username: p.display_name,
    }));
    res.status(200).json(players);
  } catch (err) {
    console.error('GET /api/players:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// GET /api/players/:id
app.get('/api/players/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Player not found'));
    const pid = parseInt(id, 10);
    const result = await pool.query(
      'SELECT player_id, display_name FROM players WHERE player_id = $1',
      [pid]
    );
    if (result.rows.length === 0) {
      return res.status(404).json(E.notFound('Player not found'));
    }
    const player = result.rows[0];
    res.status(200).json({
      id: parseInt(player.player_id, 10),
      username: player.display_name,
    });
  } catch (err) {
    console.error('GET /api/players/:id:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// GET /api/players/:id/stats
app.get('/api/players/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Player not found'));
    const pid = parseInt(id, 10);
    const playerResult = await pool.query(
      'SELECT total_games, total_wins, total_losses FROM players WHERE player_id = $1',
      [pid]
    );
    if (playerResult.rows.length === 0) {
      return res.status(404).json(E.notFound('Player not found'));
    }
    const row = playerResult.rows[0];
    const totalsResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total_shots,
         COALESCE(SUM(CASE WHEN result = 'hit' THEN 1 ELSE 0 END)::int, 0) AS total_hits
       FROM moves
       WHERE player_id = $1`,
      [pid]
    );
    const totalShots = totalsResult.rows[0].total_shots || 0;
    const totalHits = totalsResult.rows[0].total_hits || 0;
    const accuracy = totalShots > 0 ? totalHits / totalShots : 0;
    res.status(200).json({
      games_played: row.total_games || 0,
      wins: row.total_wins || 0,
      losses: row.total_losses || 0,
      total_shots: totalShots,
      total_hits: totalHits,
      accuracy,
    });
  } catch (err) {
    console.error('GET /api/players/:id/stats:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// POST /api/games
app.post('/api/games', async (req, res) => {
  try {
    const { creator_id, grid_size, max_players } = req.body || {};
    if (grid_size == null || grid_size < 5 || grid_size > 15) {
      return res.status(400).json(E.badRequest('grid_size must be between 5 and 15 inclusive'));
    }
    if (max_players == null || max_players < 2) {
      return res.status(400).json(E.badRequest('max_players must be >= 2'));
    }
    if (max_players > 10) {
      return res.status(400).json(E.badRequest('max_players must be <= 10'));
    }
    if (creator_id == null) {
      return res.status(400).json(E.badRequest('creator_id is required'));
    }
    const cid = typeof creator_id === 'number' ? creator_id : parseInt(creator_id, 10);
    if (isNaN(cid) || cid < 1) {
      return res.status(400).json(E.badRequest('creator_id does not exist'));
    }
    const creatorCheck = await pool.query(
      'SELECT player_id FROM players WHERE player_id = $1',
      [cid]
    );
    if (creatorCheck.rows.length === 0) {
      return res.status(400).json(E.badRequest('creator_id does not exist'));
    }
    const gameResult = await pool.query(
      'INSERT INTO games (grid_size, max_players, status) VALUES ($1, $2, $3) RETURNING game_id',
      [grid_size, max_players, 'waiting_setup']
    );
    const gameId = parseInt(gameResult.rows[0].game_id, 10);
    await pool.query(
      'INSERT INTO game_players (game_id, player_id, turn_order) VALUES ($1, $2, 0)',
      [gameId, cid]
    );
    res.status(201).json({
      game_id: gameId,
      status: 'waiting_setup',
    });
  } catch (err) {
    console.error('POST /api/games:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// GET /api/games
app.get('/api/games', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         g.game_id,
         g.status,
         g.grid_size,
         g.max_players,
         COUNT(gp.player_id)::int AS player_count
       FROM games g
       LEFT JOIN game_players gp ON gp.game_id = g.game_id
       GROUP BY g.game_id, g.status, g.grid_size, g.max_players
       ORDER BY g.game_id ASC`
    );
    const games = result.rows.map((g) => ({
      id: parseInt(g.game_id, 10),
      status: g.status,
      grid_size: parseInt(g.grid_size, 10),
      player_count: g.player_count || 0,
      max_players: parseInt(g.max_players, 10),
    }));
    res.status(200).json(games);
  } catch (err) {
    console.error('GET /api/games:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// POST /api/games/:id/join
app.post('/api/games/:id/join', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Game not found'));
    const gameId = parseInt(id, 10);
    const { player_id } = req.body || {};
    if (player_id == null) {
      return res.status(400).json(E.badRequest('player_id is required'));
    }
    const pid = typeof player_id === 'number' ? player_id : parseInt(player_id, 10);
    if (isNaN(pid) || pid < 1) {
      return res.status(400).json(E.badRequest('Player does not exist'));
    }
    const gameResult = await pool.query(
      'SELECT * FROM games WHERE game_id = $1',
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      return res.status(404).json(E.notFound('Game not found'));
    }
    const game = gameResult.rows[0];
    if (game.status !== 'waiting_setup') {
      return res.status(400).json(E.badRequest('Game is not accepting joins'));
    }
    const playerCheck = await pool.query(
      'SELECT player_id FROM players WHERE player_id = $1',
      [pid]
    );
    if (playerCheck.rows.length === 0) {
      return res.status(400).json(E.badRequest('Player does not exist'));
    }
    const existingJoin = await pool.query(
      'SELECT 1 FROM game_players WHERE game_id = $1 AND player_id = $2',
      [gameId, pid]
    );
    if (existingJoin.rows.length > 0) {
      return res.status(400).json(E.badRequest('Player already in this game'));
    }
    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM game_players WHERE game_id = $1',
      [gameId]
    );
    const currentCount = countResult.rows[0].cnt;
    if (currentCount >= game.max_players) {
      return res.status(400).json(E.badRequest('Game is full'));
    }
    await pool.query(
      'INSERT INTO game_players (game_id, player_id, turn_order) VALUES ($1, $2, $3)',
      [gameId, pid, currentCount]
    );
    res.status(200).json({ status: 'joined' });
  } catch (err) {
    console.error('POST /api/games/:id/join:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// GET /api/games/:id
app.get('/api/games/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Game not found'));
    const gameId = parseInt(id, 10);
    const gameResult = await pool.query(
      'SELECT * FROM games WHERE game_id = $1',
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      return res.status(404).json(E.notFound('Game not found'));
    }
    const game = gameResult.rows[0];

    const playersRes = await pool.query(
      `SELECT gp.player_id,
        (
          SELECT COUNT(*)::int FROM ships s
          WHERE s.game_id = $1 AND s.player_id = gp.player_id
          AND NOT EXISTS (
            SELECT 1 FROM moves m
            WHERE m.game_id = $1 AND m.target_player_id = gp.player_id
            AND m.result = 'hit'
            AND m.move_row = s.ship_row AND m.move_col = s.ship_col
          )
        ) AS ships_remaining
       FROM game_players gp
       WHERE gp.game_id = $1
       ORDER BY gp.turn_order ASC`,
      [gameId]
    );

    const movesCountRes = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM moves WHERE game_id = $1',
      [gameId]
    );
    const totalMoves = movesCountRes.rows[0].cnt || 0;

    let currentTurnPlayerId = null;
    if (game.status === 'playing') {
      const activeRes = await pool.query(
        'SELECT player_id FROM game_players WHERE game_id = $1 AND is_eliminated = FALSE ORDER BY turn_order ASC',
        [gameId]
      );
      if (activeRes.rows.length > 0) {
        const idx =
          (parseInt(game.current_turn_index, 10) || 0) % activeRes.rows.length;
        currentTurnPlayerId = parseInt(activeRes.rows[idx].player_id, 10);
      }
    }

    res.status(200).json({
      game_id: parseInt(game.game_id, 10),
      grid_size: parseInt(game.grid_size, 10),
      status: game.status,
      players: playersRes.rows.map((r) => ({
        player_id: parseInt(r.player_id, 10),
        ships_remaining: parseInt(r.ships_remaining, 10) || 0,
      })),
      current_turn_player_id: game.status === 'finished' ? null : currentTurnPlayerId,
      total_moves: totalMoves,
    });
  } catch (err) {
    console.error('GET /api/games/:id:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// GET /api/games/:id/players
app.get('/api/games/:id/players', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Game not found'));
    const gameId = parseInt(id, 10);

    const gameExists = await pool.query('SELECT 1 FROM games WHERE game_id = $1', [gameId]);
    if (gameExists.rows.length === 0) {
      return res.status(404).json(E.notFound('Game not found'));
    }

    const result = await pool.query(
      `SELECT
         gp.player_id,
         p.display_name AS username,
         gp.turn_order,
         gp.is_eliminated,
         gp.ships_placed
       FROM game_players gp
       JOIN players p ON p.player_id = gp.player_id
       WHERE gp.game_id = $1
       ORDER BY gp.turn_order ASC`,
      [gameId]
    );

    res.status(200).json(
      result.rows.map((r) => ({
        player_id: parseInt(r.player_id, 10),
        username: r.username,
        turn_order: parseInt(r.turn_order, 10),
        is_eliminated: !!r.is_eliminated,
        ships_placed: !!r.ships_placed,
      }))
    );
  } catch (err) {
    console.error('GET /api/games/:id/players:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// POST /api/games/:id/place — full implementation
app.post('/api/games/:id/place', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Game not found'));
    const gameId = parseInt(id, 10);
    const { player_id, ships } = req.body || {};

    if (player_id == null) {
      return res.status(400).json(E.badRequest('player_id is required'));
    }
    const pid = typeof player_id === 'number' ? player_id : parseInt(player_id, 10);
    if (isNaN(pid) || pid < 1) {
      return res.status(400).json(E.badRequest('Invalid player_id'));
    }

    const playerExists = await pool.query('SELECT 1 FROM players WHERE player_id = $1', [pid]);
    if (playerExists.rows.length === 0) {
      return res.status(400).json(E.badRequest('Player does not exist'));
    }

    if (!Array.isArray(ships)) {
      return res.status(400).json(E.badRequest('ships must be an array'));
    }
    if (ships.length !== 3) {
      return res.status(400).json(E.badRequest('Exactly 3 ships required'));
    }

    const gameResult = await pool.query(
      'SELECT * FROM games WHERE game_id = $1',
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      return res.status(404).json(E.notFound('Game not found'));
    }
    const game = gameResult.rows[0];
    if (game.status !== 'waiting_setup') {
      return res.status(400).json(E.badRequest('Game is not in setup phase'));
    }

    const gpResult = await pool.query(
      'SELECT ships_placed FROM game_players WHERE game_id = $1 AND player_id = $2',
      [gameId, pid]
    );
    if (gpResult.rows.length === 0) {
      return res.status(400).json(E.badRequest('Player is not in this game'));
    }
    if (gpResult.rows[0].ships_placed) {
      return res.status(400).json(E.badRequest('Player has already placed ships'));
    }

    const gridSize = game.grid_size;
    const coordSet = new Set();
    const coords = [];

    for (const s of ships) {
      let r, c;
      if (Array.isArray(s) && s.length >= 2) {
        r = parseInt(s[0], 10);
        c = parseInt(s[1], 10);
      } else if (typeof s === 'object' && s != null) {
        r = parseInt(s.row ?? s.ship_row, 10);
        c = parseInt(s.col ?? s.ship_col, 10);
      } else {
        return res.status(400).json(E.badRequest('Each ship must have row and col'));
      }
      if (isNaN(r) || isNaN(c)) {
        return res.status(400).json(E.badRequest('Each ship must have numeric row and col'));
      }
      if (r < 0 || r >= gridSize || c < 0 || c >= gridSize) {
        return res.status(400).json(E.badRequest('Ship coordinates must be within grid bounds'));
      }
      const key = `${r},${c}`;
      if (coordSet.has(key)) {
        return res.status(400).json(E.badRequest('Duplicate ship coordinates'));
      }
      coordSet.add(key);
      coords.push({ row: r, col: c });
    }

    for (const { row: r, col: c } of coords) {
      await pool.query(
        'INSERT INTO ships (game_id, player_id, ship_row, ship_col) VALUES ($1, $2, $3, $4)',
        [gameId, pid, r, c]
      );
    }

    await pool.query(
      'UPDATE game_players SET ships_placed = TRUE WHERE game_id = $1 AND player_id = $2',
      [gameId, pid]
    );

    await maybeTransitionToPlaying(gameId);

    res.status(200).json({ status: 'placed' });
  } catch (err) {
    console.error('POST /api/games/:id/place:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// POST /api/games/:id/ships — production alias for ship placement
app.post('/api/games/:id/ships', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Game not found'));
    const gameId = parseInt(id, 10);
    const { player_id, ships } = req.body || {};

    if (player_id == null) {
      return res.status(400).json(E.badRequest('player_id is required'));
    }
    const pid = typeof player_id === 'number' ? player_id : parseInt(player_id, 10);
    if (isNaN(pid) || pid < 1) {
      return res.status(400).json(E.badRequest('Invalid player_id'));
    }

    const playerExists = await pool.query('SELECT 1 FROM players WHERE player_id = $1', [pid]);
    if (playerExists.rows.length === 0) {
      return res.status(400).json(E.badRequest('Player does not exist'));
    }

    if (!Array.isArray(ships)) {
      return res.status(400).json(E.badRequest('ships must be an array'));
    }
    if (ships.length !== 3) {
      return res.status(400).json(E.badRequest('Exactly 3 ships required'));
    }

    const gameResult = await pool.query(
      'SELECT * FROM games WHERE game_id = $1',
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      return res.status(404).json(E.notFound('Game not found'));
    }
    const game = gameResult.rows[0];
    if (game.status !== 'waiting_setup') {
      return res.status(400).json(E.badRequest('Game is not in setup phase'));
    }

    const gpResult = await pool.query(
      'SELECT ships_placed FROM game_players WHERE game_id = $1 AND player_id = $2',
      [gameId, pid]
    );
    if (gpResult.rows.length === 0) {
      return res.status(400).json(E.badRequest('Player is not in this game'));
    }
    if (gpResult.rows[0].ships_placed) {
      return res.status(400).json(E.badRequest('Player has already placed ships'));
    }

    const gridSize = game.grid_size;
    const coordSet = new Set();
    const coords = [];

    for (const s of ships) {
      let r, c;
      if (Array.isArray(s) && s.length >= 2) {
        r = parseInt(s[0], 10);
        c = parseInt(s[1], 10);
      } else if (typeof s === 'object' && s != null) {
        r = parseInt(s.row ?? s.ship_row, 10);
        c = parseInt(s.col ?? s.ship_col, 10);
      } else {
        return res.status(400).json(E.badRequest('Each ship must have row and col'));
      }
      if (isNaN(r) || isNaN(c)) {
        return res.status(400).json(E.badRequest('Each ship must have numeric row and col'));
      }
      if (r < 0 || r >= gridSize || c < 0 || c >= gridSize) {
        return res.status(400).json(E.badRequest('Ship coordinates must be within grid bounds'));
      }
      const key = `${r},${c}`;
      if (coordSet.has(key)) {
        return res.status(400).json(E.badRequest('Duplicate ship coordinates'));
      }
      coordSet.add(key);
      coords.push({ row: r, col: c });
    }

    for (const { row: r, col: c } of coords) {
      await pool.query(
        'INSERT INTO ships (game_id, player_id, ship_row, ship_col) VALUES ($1, $2, $3, $4)',
        [gameId, pid, r, c]
      );
    }

    await pool.query(
      'UPDATE game_players SET ships_placed = TRUE WHERE game_id = $1 AND player_id = $2',
      [gameId, pid]
    );

    await maybeTransitionToPlaying(gameId);

    res.status(200).json({ status: 'placed' });
  } catch (err) {
    console.error('POST /api/games/:id/ships:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// GET /api/games/:id/ships?player_id=X[&requester_id=Y]
app.get('/api/games/:id/ships', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Game not found'));
    const gameId = parseInt(id, 10);

    const rawPlayerId = req.query.player_id;
    if (rawPlayerId == null) {
      return res.status(400).json(E.badRequest('player_id query parameter is required'));
    }
    const targetPlayerId = parseInt(rawPlayerId, 10);
    if (isNaN(targetPlayerId) || targetPlayerId < 1) {
      return res.status(400).json(E.badRequest('Invalid player_id'));
    }

    const rawRequesterId = req.query.requester_id;
    const requesterId =
      rawRequesterId == null ? targetPlayerId : parseInt(rawRequesterId, 10);
    if (isNaN(requesterId) || requesterId < 1) {
      return res.status(400).json(E.badRequest('Invalid requester_id'));
    }

    const gameResult = await pool.query(
      'SELECT game_id, status FROM games WHERE game_id = $1',
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      return res.status(404).json(E.notFound('Game not found'));
    }
    const game = gameResult.rows[0];

    const membershipResult = await pool.query(
      'SELECT 1 FROM game_players WHERE game_id = $1 AND player_id = $2',
      [gameId, targetPlayerId]
    );
    if (membershipResult.rows.length === 0) {
      return res.status(404).json(E.notFound('Player is not in this game'));
    }

    const canViewShips = game.status === 'finished' || requesterId === targetPlayerId;
    if (!canViewShips) {
      return res
        .status(403)
        .json(E.forbidden('Cannot view this player\'s ships before game is finished'));
    }

    const shipsResult = await pool.query(
      'SELECT ship_row AS row, ship_col AS col FROM ships WHERE game_id = $1 AND player_id = $2 ORDER BY id ASC',
      [gameId, targetPlayerId]
    );

    res.status(200).json({
      game_id: gameId,
      player_id: targetPlayerId,
      ships: shipsResult.rows,
    });
  } catch (err) {
    console.error('GET /api/games/:id/ships:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// POST /api/games/:id/start
app.post('/api/games/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Game not found'));
    const gameId = parseInt(id, 10);

    const gameResult = await pool.query(
      'SELECT game_id, grid_size, max_players, status, current_turn_index FROM games WHERE game_id = $1',
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      return res.status(404).json(E.notFound('Game not found'));
    }
    const gameRow = gameResult.rows[0];

    const placedResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COALESCE(SUM(CASE WHEN ships_placed THEN 1 ELSE 0 END)::int, 0) AS placed
       FROM game_players
       WHERE game_id = $1`,
      [gameId]
    );
    const total = placedResult.rows[0].total || 0;
    const placed = placedResult.rows[0].placed || 0;
    if (total !== gameRow.max_players || placed !== total) {
      return res
        .status(400)
        .json(E.badRequest('Not all players have joined or placed ships'));
    }

    await pool.query(
      'UPDATE games SET status = $1 WHERE game_id = $2',
      ['playing', gameId]
    );

    const updated = await pool.query(
      'SELECT game_id, grid_size, max_players, status, current_turn_index FROM games WHERE game_id = $1',
      [gameId]
    );
    const g = updated.rows[0];
    const playerCountResult = await pool.query(
      'SELECT COUNT(*)::int AS player_count FROM game_players WHERE game_id = $1',
      [gameId]
    );

    res.status(200).json({
      id: parseInt(g.game_id, 10),
      status: g.status,
      grid_size: parseInt(g.grid_size, 10),
      player_count: playerCountResult.rows[0].player_count || 0,
      max_players: parseInt(g.max_players, 10),
      current_turn_index: parseInt(g.current_turn_index, 10) || 0,
    });
  } catch (err) {
    console.error('POST /api/games/:id/start:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// POST /api/games/:id/fire
app.post('/api/games/:id/fire', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Game not found'));
    const gameId = parseInt(id, 10);

    const { player_id, row, col } = req.body || {};
    if (player_id == null) return res.status(400).json(E.badRequest('player_id is required'));
    if (row == null || col == null) return res.status(400).json(E.badRequest('row and col are required'));

    const pid = typeof player_id === 'number' ? player_id : parseInt(player_id, 10);
    const r = typeof row === 'number' ? row : parseInt(row, 10);
    const c = typeof col === 'number' ? col : parseInt(col, 10);

    if (isNaN(pid) || pid < 1) return res.status(403).json(E.forbidden('Invalid player'));
    if (isNaN(r) || isNaN(c)) return res.status(400).json(E.badRequest('Invalid coordinates'));

    const gameResult = await pool.query(
      'SELECT game_id, grid_size, max_players, status, current_turn_index FROM games WHERE game_id = $1',
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      return res.status(404).json(E.notFound('Game not found'));
    }
    const game = gameResult.rows[0];

    if (game.status === 'finished') {
      return res.status(400).json(E.badRequest('Game is already finished'));
    }

    const playerExists = await pool.query('SELECT 1 FROM players WHERE player_id = $1', [pid]);
    if (playerExists.rows.length === 0) {
      return res.status(403).json(E.forbidden('Invalid player'));
    }

    const playerInGame = await pool.query(
      'SELECT 1 FROM game_players WHERE game_id = $1 AND player_id = $2',
      [gameId, pid]
    );
    if (playerInGame.rows.length === 0) {
      return res.status(403).json(E.forbidden('Player not in this game'));
    }

    const activePlayers = await pool.query(
      'SELECT player_id FROM game_players WHERE game_id = $1 AND is_eliminated = FALSE ORDER BY turn_order ASC',
      [gameId]
    );
    if (activePlayers.rows.length === 0) {
      return res.status(400).json(E.badRequest('No active players'));
    }

    const currentTurnIndex = parseInt(game.current_turn_index, 10) || 0;
    const expectedTurnPlayerId =
      activePlayers.rows[currentTurnIndex % activePlayers.rows.length].player_id;

    if (expectedTurnPlayerId !== pid) {
      return res.status(403).json(E.forbidden('Not your turn'));
    }

    const coordBoundsOk = r >= 0 && r < game.grid_size && c >= 0 && c < game.grid_size;
    if (!coordBoundsOk) {
      return res.status(400).json(E.badRequest('Coordinates out of bounds'));
    }

    const allPlacedResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COALESCE(SUM(CASE WHEN ships_placed THEN 1 ELSE 0 END)::int, 0) AS placed
       FROM game_players
       WHERE game_id = $1`,
      [gameId]
    );
    const totalJoined = allPlacedResult.rows[0].total || 0;
    const placedPlayers = allPlacedResult.rows[0].placed || 0;
    if (totalJoined !== game.max_players || placedPlayers !== totalJoined) {
      return res.status(400).json(E.badRequest('Not all players have joined or placed ships'));
    }

    if (game.status !== 'playing') {
      return res.status(400).json(E.badRequest('Game has not started yet'));
    }

    // ---- Transactional move execution ----
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const targetRes = await client.query(
        `SELECT gp.player_id
         FROM game_players gp
         JOIN ships s
           ON s.game_id = gp.game_id
          AND s.player_id = gp.player_id
         WHERE gp.game_id = $1
           AND gp.is_eliminated = FALSE
           AND gp.player_id <> $2
           AND s.ship_row = $3
           AND s.ship_col = $4
         ORDER BY gp.turn_order ASC
         LIMIT 1`,
        [gameId, pid, r, c]
      );

      const targetPlayerId = targetRes.rows.length > 0 ? targetRes.rows[0].player_id : null;
      const result = targetPlayerId ? 'hit' : 'miss';

      const dupCheck = await client.query(
        `SELECT 1
         FROM moves
         WHERE game_id = $1
           AND player_id = $2
           AND move_row = $3
           AND move_col = $4
           AND target_player_id IS NOT DISTINCT FROM $5
         LIMIT 1`,
        [gameId, pid, r, c, targetPlayerId]
      );

      if (dupCheck.rows.length > 0) {
        const err = new Error('Cell already fired upon');
        err.status = 409;
        throw err;
      }

      await client.query(
        `INSERT INTO moves (game_id, player_id, target_player_id, move_row, move_col, result, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [gameId, pid, targetPlayerId, r, c, result]
      );

      // Must happen in the same transaction as the move insert.
      await client.query('UPDATE players SET total_moves = total_moves + 1 WHERE player_id = $1', [pid]);

      if (result === 'hit') {
        const totalShipsRes = await client.query(
          'SELECT COUNT(*)::int AS total_ships FROM ships WHERE game_id = $1 AND player_id = $2',
          [gameId, targetPlayerId]
        );
        const totalShips = totalShipsRes.rows[0].total_ships || 0;

        const hitCoordsRes = await client.query(
          `SELECT COUNT(DISTINCT (move_row::text || ',' || move_col::text))::int AS distinct_hit_coords
           FROM moves
           WHERE game_id = $1
             AND target_player_id = $2
             AND result = 'hit'`,
          [gameId, targetPlayerId]
        );
        const distinctHitCoords = hitCoordsRes.rows[0].distinct_hit_coords || 0;

        if (totalShips > 0 && distinctHitCoords >= totalShips) {
          await client.query(
            'UPDATE game_players SET is_eliminated = TRUE WHERE game_id = $1 AND player_id = $2 AND is_eliminated = FALSE',
            [gameId, targetPlayerId]
          );
        }
      }

      const remainingRes = await client.query(
        'SELECT COUNT(*)::int AS remaining FROM game_players WHERE game_id = $1 AND is_eliminated = FALSE',
        [gameId]
      );
      const remaining = remainingRes.rows[0].remaining || 0;

      let winnerId = null;
      if (remaining === 1) {
        const winnerRes = await client.query(
          'SELECT player_id FROM game_players WHERE game_id = $1 AND is_eliminated = FALSE ORDER BY turn_order ASC LIMIT 1',
          [gameId]
        );
        winnerId = winnerRes.rows.length > 0 ? winnerRes.rows[0].player_id : null;
      }

      // Advance turn regardless; winners return next_player_id=null.
      const turnUpdateRes = await client.query(
        'UPDATE games SET current_turn_index = current_turn_index + 1 WHERE game_id = $1 RETURNING current_turn_index',
        [gameId]
      );
      const newCurrentTurnIndex = turnUpdateRes.rows[0].current_turn_index;

      if (winnerId != null && remaining === 1) {
        await client.query('UPDATE games SET status = $1 WHERE game_id = $2', ['finished', gameId]);

        // Update statistics for all players in the game.
        await client.query(
          `UPDATE players p
           SET total_games = total_games + 1
           FROM game_players gp
           WHERE gp.game_id = $1
             AND p.player_id = gp.player_id`,
          [gameId]
        );

        await client.query('UPDATE players SET total_wins = total_wins + 1 WHERE player_id = $1', [winnerId]);
        await client.query(
          `UPDATE players p
           SET total_losses = total_losses + 1
           FROM game_players gp
           WHERE gp.game_id = $1
             AND p.player_id = gp.player_id
             AND p.player_id <> $2`,
          [gameId, winnerId]
        );
      } else {
        await client.query('UPDATE games SET status = $1 WHERE game_id = $2', ['playing', gameId]);
      }

      await client.query('COMMIT');

      if (winnerId != null && remaining === 1) {
        return res.status(200).json({
          result,
          next_player_id: null,
          game_status: 'finished',
          winner_id: winnerId,
        });
      }

      const activeAfterRes = await pool.query(
        'SELECT player_id FROM game_players WHERE game_id = $1 AND is_eliminated = FALSE ORDER BY turn_order ASC',
        [gameId]
      );
      const activeAfter = activeAfterRes.rows.map((x) => x.player_id);

      const nextPlayerId =
        activeAfter.length > 0 ? activeAfter[newCurrentTurnIndex % activeAfter.length] : null;

      return res.status(200).json({
        result,
        next_player_id: nextPlayerId,
        game_status: 'playing',
        winner_id: null,
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (res.headersSent) return;
    const status = err && err.status ? err.status : null;
    if (status === 409) {
      return res.status(409).json(E.conflict(err.message || 'Cell already fired upon'));
    }
    if (status && status >= 400 && status < 600) {
      const msg = err.message || 'Request failed';
      if (status === 403) return res.status(403).json(E.forbidden(msg));
      if (status === 400) return res.status(400).json(E.badRequest(msg));
      return res.status(status).json(E.badRequest(msg));
    }
    console.error('POST /api/games/:id/fire:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// GET /api/games/:id/moves
app.get('/api/games/:id/moves', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Game not found'));
    const gameId = parseInt(id, 10);
    const gameResult = await pool.query('SELECT 1 FROM games WHERE game_id = $1', [gameId]);
    if (gameResult.rows.length === 0) {
      return res.status(404).json(E.notFound('Game not found'));
    }

    const movesRes = await pool.query(
      `SELECT player_id, target_player_id, move_row, move_col, result, created_at
       FROM moves
       WHERE game_id = $1
       ORDER BY created_at ASC, id ASC`,
      [gameId]
    );

    const moves = movesRes.rows.map((m, i) => ({
      move_number: i + 1,
      player_id: m.player_id,
      row: m.move_row,
      col: m.move_col,
      result: m.result,
      timestamp: m.created_at ? new Date(m.created_at).toISOString() : null,
    }));

    res.status(200).json(moves);
  } catch (err) {
    console.error('GET /api/games/:id/moves:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// ========== Test Mode Endpoints ==========

// POST /api/test/games/:id/restart
app.post('/api/test/games/:id/restart', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Game not found'));
    const gameId = parseInt(id, 10);
    const gameResult = await pool.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
    if (gameResult.rows.length === 0) {
      return res.status(404).json(E.notFound('Game not found'));
    }
    await pool.query('DELETE FROM ships WHERE game_id = $1', [gameId]);
    await pool.query('DELETE FROM moves WHERE game_id = $1', [gameId]);
    await pool.query(
      'UPDATE game_players SET is_eliminated = FALSE, ships_placed = FALSE WHERE game_id = $1',
      [gameId]
    );
    await pool.query(
      'UPDATE games SET current_turn_index = 0, status = $1 WHERE game_id = $2',
      ['waiting_setup', gameId]
    );
    res.status(200).json({ status: 'reset' });
  } catch (err) {
    console.error('POST /api/test/games/:id/restart:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// POST /api/test/games/:id/ships
// Test-only deterministic ship placement (allows override).
app.post('/api/test/games/:id/ships', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Game not found'));
    const gameId = parseInt(id, 10);

    const { player_id, ships } = req.body || {};
    if (player_id == null) return res.status(400).json(E.badRequest('player_id is required'));
    const pid = typeof player_id === 'number' ? player_id : parseInt(player_id, 10);
    if (isNaN(pid) || pid < 1) return res.status(400).json(E.badRequest('Invalid player_id'));

    if (!Array.isArray(ships)) return res.status(400).json(E.badRequest('ships must be an array'));
    if (ships.length !== 3) {
      return res.status(400).json(E.badRequest('Exactly 3 ships required'));
    }

    const gameResult = await pool.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
    if (gameResult.rows.length === 0) {
      return res.status(404).json(E.notFound('Game not found'));
    }
    const game = gameResult.rows[0];

    if (game.status !== 'waiting_setup') {
      return res.status(400).json(E.badRequest('Game is not in setup phase'));
    }

    const playerExists = await pool.query('SELECT 1 FROM players WHERE player_id = $1', [pid]);
    if (playerExists.rows.length === 0) {
      return res.status(400).json(E.badRequest('Player does not exist'));
    }

    const gpResult = await pool.query(
      'SELECT ships_placed FROM game_players WHERE game_id = $1 AND player_id = $2',
      [gameId, pid]
    );
    if (gpResult.rows.length === 0) {
      return res.status(400).json(E.badRequest('Player is not in this game'));
    }

    const gridSize = game.grid_size;
    const coordSet = new Set();
    const coords = [];

    for (const s of ships) {
      let r, c;
      if (Array.isArray(s) && s.length >= 2) {
        r = parseInt(s[0], 10);
        c = parseInt(s[1], 10);
      } else if (typeof s === 'object' && s != null) {
        r = parseInt(s.row ?? s.ship_row, 10);
        c = parseInt(s.col ?? s.ship_col, 10);
      } else {
        return res.status(400).json(E.badRequest('Each ship must have row and col'));
      }

      if (isNaN(r) || isNaN(c)) {
        return res.status(400).json(E.badRequest('Each ship must have numeric row and col'));
      }
      if (r < 0 || r >= gridSize || c < 0 || c >= gridSize) {
        return res.status(400).json(E.badRequest('Ship coordinates must be within grid bounds'));
      }

      const key = `${r},${c}`;
      if (coordSet.has(key)) {
        return res.status(400).json(E.badRequest('Duplicate ship coordinates'));
      }
      coordSet.add(key);
      coords.push({ row: r, col: c });
    }

    await pool.query('DELETE FROM ships WHERE game_id = $1 AND player_id = $2', [gameId, pid]);

    for (const { row: r, col: c } of coords) {
      await pool.query(
        'INSERT INTO ships (game_id, player_id, ship_row, ship_col) VALUES ($1, $2, $3, $4)',
        [gameId, pid, r, c]
      );
    }

    await pool.query(
      'UPDATE game_players SET ships_placed = TRUE WHERE game_id = $1 AND player_id = $2',
      [gameId, pid]
    );

    await maybeTransitionToPlaying(gameId);

    const updatedGame = await pool.query('SELECT status, game_id FROM games WHERE game_id = $1', [gameId]);
    const g = updatedGame.rows[0];

    const wasAlreadyPlaced = !!gpResult.rows[0].ships_placed;
    res.status(wasAlreadyPlaced ? 200 : 201).json({
      message: 'ships placed (test mode)',
      game_id: parseInt(g.game_id, 10),
      status: g.status,
      player_id: pid,
    });
  } catch (err) {
    console.error('POST /api/test/games/:id/ships:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// GET /api/test/games/:id/board/:player_id
app.get('/api/test/games/:id/board/:player_id', async (req, res) => {
  try {
    const { id, player_id } = req.params;
    if (!isValidId(id)) return res.status(404).json(E.notFound('Game not found'));
    if (!isValidId(player_id)) return res.status(404).json(E.notFound('Player not found'));
    const gameId = parseInt(id, 10);
    const pid = parseInt(player_id, 10);
    const shipsResult = await pool.query(
      'SELECT ship_row AS row, ship_col AS col FROM ships WHERE game_id = $1 AND player_id = $2',
      [gameId, pid]
    );
    const hitsResult = await pool.query(
      'SELECT move_row AS row, move_col AS col FROM moves WHERE game_id = $1 AND target_player_id = $2 AND result = $3',
      [gameId, pid, 'hit']
    );
    res.status(200).json({
      ships: shipsResult.rows,
      hits: hitsResult.rows,
    });
  } catch (err) {
    console.error('GET /api/test/games/:id/board/:player_id:', err);
    res.status(500).json(E.server('Internal server error'));
  }
});

// ========== Startup ==========

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Battleship API server listening on port ${PORT}`);
    console.log(`TEST_MODE: ${TEST_MODE}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
