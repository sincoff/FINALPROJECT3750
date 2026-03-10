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
        status TEXT DEFAULT 'waiting',
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

// Test mode middleware
app.use('/api/test', (req, res, next) => {
  if (TEST_MODE !== 'true') {
    return res.status(403).json({ error: 'Test mode disabled' });
  }
  const password = req.headers['x-test-password'];
  if (password !== 'clemson-test-2026') {
    return res.status(403).json({ error: 'Invalid or missing test password' });
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/players
app.post('/api/players', async (req, res) => {
  try {
    const { username, player_id: clientPlayerId } = req.body || {};
    if (clientPlayerId !== undefined) {
      return res.status(400).json({ error: 'Clients may not supply player_id' });
    }
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return res.status(400).json({ error: 'username is required and must be non-empty' });
    }
    const displayName = username.trim();
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/players/:id/stats
app.get('/api/players/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ error: 'Player not found' });
    const pid = parseInt(id, 10);
    const playerResult = await pool.query(
      'SELECT total_games, total_wins, total_losses, total_moves FROM players WHERE player_id = $1',
      [pid]
    );
    if (playerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }
    const row = playerResult.rows[0];
    const hitsResult = await pool.query(
      "SELECT COUNT(*)::int AS total_hits FROM moves WHERE player_id = $1 AND result = 'hit'",
      [pid]
    );
    const totalHits = hitsResult.rows[0].total_hits || 0;
    const totalShots = row.total_moves || 0;
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/games
app.post('/api/games', async (req, res) => {
  try {
    const { creator_id, grid_size, max_players } = req.body || {};
    if (grid_size == null || grid_size < 5 || grid_size > 15) {
      return res.status(400).json({ error: 'grid_size must be between 5 and 15 inclusive' });
    }
    if (max_players == null || max_players < 1) {
      return res.status(400).json({ error: 'max_players must be >= 1' });
    }
    if (creator_id == null) {
      return res.status(400).json({ error: 'creator_id is required' });
    }
    const cid = typeof creator_id === 'number' ? creator_id : parseInt(creator_id, 10);
    if (isNaN(cid) || cid < 1) {
      return res.status(400).json({ error: 'creator_id does not exist' });
    }
    const creatorCheck = await pool.query(
      'SELECT player_id FROM players WHERE player_id = $1',
      [cid]
    );
    if (creatorCheck.rows.length === 0) {
      return res.status(400).json({ error: 'creator_id does not exist' });
    }
    const gameResult = await pool.query(
      'INSERT INTO games (grid_size, max_players, status) VALUES ($1, $2, $3) RETURNING game_id',
      [grid_size, max_players, 'waiting']
    );
    const gameId = parseInt(gameResult.rows[0].game_id, 10);
    await pool.query(
      'INSERT INTO game_players (game_id, player_id, turn_order) VALUES ($1, $2, 0)',
      [gameId, cid]
    );
    res.status(201).json({
      game_id: gameId,
      grid_size: parseInt(grid_size, 10),
      status: 'waiting',
      max_players: parseInt(max_players, 10),
      current_turn_index: 0,
    });
  } catch (err) {
    console.error('POST /api/games:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/games/:id/join
app.post('/api/games/:id/join', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ error: 'Game not found' });
    const gameId = parseInt(id, 10);
    const { player_id } = req.body || {};
    if (player_id == null) {
      return res.status(400).json({ error: 'player_id is required' });
    }
    const pid = typeof player_id === 'number' ? player_id : parseInt(player_id, 10);
    if (isNaN(pid) || pid < 1) {
      return res.status(400).json({ error: 'Player does not exist' });
    }
    const gameResult = await pool.query(
      'SELECT * FROM games WHERE game_id = $1',
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      return res.status(404).json({ error: 'Game not found' });
    }
    const game = gameResult.rows[0];
    if (game.status !== 'waiting') {
      return res.status(400).json({ error: 'Game is not in waiting status' });
    }
    const playerCheck = await pool.query(
      'SELECT player_id FROM players WHERE player_id = $1',
      [pid]
    );
    if (playerCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Player does not exist' });
    }
    const existingJoin = await pool.query(
      'SELECT 1 FROM game_players WHERE game_id = $1 AND player_id = $2',
      [gameId, pid]
    );
    if (existingJoin.rows.length > 0) {
      return res.status(400).json({ error: 'Player already in this game' });
    }
    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM game_players WHERE game_id = $1',
      [gameId]
    );
    const currentCount = countResult.rows[0].cnt;
    if (currentCount >= game.max_players) {
      return res.status(400).json({ error: 'Game is full' });
    }
    await pool.query(
      'INSERT INTO game_players (game_id, player_id, turn_order) VALUES ($1, $2, $3)',
      [gameId, pid, currentCount]
    );
    const updated = await pool.query(
      'SELECT * FROM games WHERE game_id = $1',
      [gameId]
    );
    const g = updated.rows[0];
    res.status(200).json({
      game_id: parseInt(g.game_id, 10),
      grid_size: g.grid_size,
      status: g.status,
      current_turn_index: g.current_turn_index,
      max_players: g.max_players,
    });
  } catch (err) {
    console.error('POST /api/games/:id/join:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/games/:id
app.get('/api/games/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ error: 'Game not found' });
    const gameId = parseInt(id, 10);
    const gameResult = await pool.query(
      'SELECT * FROM games WHERE game_id = $1',
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      return res.status(404).json({ error: 'Game not found' });
    }
    const game = gameResult.rows[0];
    const activeResult = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM game_players WHERE game_id = $1 AND is_eliminated = FALSE',
      [gameId]
    );
    const activePlayers = activeResult.rows[0].cnt;
    res.status(200).json({
      game_id: parseInt(game.game_id, 10),
      grid_size: game.grid_size,
      status: game.status,
      current_turn_index: game.current_turn_index,
      active_players: activePlayers,
    });
  } catch (err) {
    console.error('GET /api/games/:id:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/games/:id/place — full implementation
app.post('/api/games/:id/place', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ error: 'Game not found' });
    const gameId = parseInt(id, 10);
    const { player_id, ships } = req.body || {};

    if (player_id == null) {
      return res.status(400).json({ error: 'player_id is required' });
    }
    const pid = typeof player_id === 'number' ? player_id : parseInt(player_id, 10);
    if (isNaN(pid) || pid < 1) {
      return res.status(400).json({ error: 'Invalid player_id' });
    }

    if (!Array.isArray(ships)) {
      return res.status(400).json({ error: 'ships must be an array' });
    }
    if (ships.length !== 3) {
      return res.status(400).json({ error: 'Exactly 3 ships required' });
    }

    const gameResult = await pool.query(
      'SELECT * FROM games WHERE game_id = $1',
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      return res.status(404).json({ error: 'Game not found' });
    }
    const game = gameResult.rows[0];
    if (game.status !== 'waiting') {
      return res.status(400).json({ error: 'Game is not in waiting status' });
    }

    const gpResult = await pool.query(
      'SELECT ships_placed FROM game_players WHERE game_id = $1 AND player_id = $2',
      [gameId, pid]
    );
    if (gpResult.rows.length === 0) {
      return res.status(400).json({ error: 'Player is not in this game' });
    }
    if (gpResult.rows[0].ships_placed) {
      return res.status(400).json({ error: 'Player has already placed ships' });
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
        return res.status(400).json({ error: 'Each ship must have row and col' });
      }
      if (isNaN(r) || isNaN(c)) {
        return res.status(400).json({ error: 'Each ship must have numeric row and col' });
      }
      if (r < 0 || r >= gridSize || c < 0 || c >= gridSize) {
        return res.status(400).json({ error: 'Ship coordinates must be within grid bounds' });
      }
      const key = `${r},${c}`;
      if (coordSet.has(key)) {
        return res.status(400).json({ error: 'Duplicate ship coordinates' });
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

    const updatedGame = await pool.query(
      'SELECT * FROM games WHERE game_id = $1',
      [gameId]
    );
    const g = updatedGame.rows[0];
    const activeResult = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM game_players WHERE game_id = $1 AND is_eliminated = FALSE',
      [gameId]
    );
    res.status(200).json({
      message: 'ships placed',
      player_id: pid,
      game_id: parseInt(g.game_id, 10),
      grid_size: parseInt(g.grid_size, 10),
      status: g.status,
      current_turn_index: parseInt(g.current_turn_index, 10),
      active_players: activeResult.rows[0].cnt,
    });
  } catch (err) {
    console.error('POST /api/games/:id/place:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/games/:id/fire — Stub
app.post('/api/games/:id/fire', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ error: 'Game not found' });
    res.status(200).json({ message: 'fire not yet implemented' });
  } catch (err) {
    console.error('POST /api/games/:id/fire:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/games/:id/moves — Stub
app.get('/api/games/:id/moves', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ error: 'Game not found' });
    res.status(200).json([]);
  } catch (err) {
    console.error('GET /api/games/:id/moves:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== Test Mode Endpoints ==========

// POST /api/test/games/:id/restart
app.post('/api/test/games/:id/restart', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ error: 'Game not found' });
    const gameId = parseInt(id, 10);
    const gameResult = await pool.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
    if (gameResult.rows.length === 0) {
      return res.status(404).json({ error: 'Game not found' });
    }
    await pool.query('DELETE FROM ships WHERE game_id = $1', [gameId]);
    await pool.query('DELETE FROM moves WHERE game_id = $1', [gameId]);
    await pool.query(
      'UPDATE game_players SET is_eliminated = FALSE, ships_placed = FALSE WHERE game_id = $1',
      [gameId]
    );
    await pool.query(
      'UPDATE games SET current_turn_index = 0, status = $1 WHERE game_id = $2',
      ['waiting', gameId]
    );
    const updated = await pool.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
    const g = updated.rows[0];
    res.status(200).json({
      game_id: parseInt(g.game_id, 10),
      grid_size: g.grid_size,
      status: g.status,
      current_turn_index: g.current_turn_index,
      max_players: g.max_players,
    });
  } catch (err) {
    console.error('POST /api/test/games/:id/restart:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/test/games/:id/board/:player_id
app.get('/api/test/games/:id/board/:player_id', async (req, res) => {
  try {
    const { id, player_id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ error: 'Game not found' });
    if (!isValidId(player_id)) return res.status(404).json({ error: 'Player not found' });
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
    res.status(500).json({ error: 'Internal server error' });
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
