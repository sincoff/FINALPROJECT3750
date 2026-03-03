require('dotenv').config();

/**
 * Multiplayer Battleship API Server
 * Tech stack: Express.js, pg (PostgreSQL), uuid
 */

const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const TEST_MODE = process.env.TEST_MODE || 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s) {
  return typeof s === 'string' && UUID_REGEX.test(s);
}

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS players (
        player_id UUID PRIMARY KEY,
        display_name TEXT UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        total_games INTEGER DEFAULT 0,
        total_wins INTEGER DEFAULT 0,
        total_losses INTEGER DEFAULT 0,
        total_moves INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS games (
        game_id UUID PRIMARY KEY,
        grid_size INTEGER NOT NULL,
        max_players INTEGER NOT NULL,
        status TEXT DEFAULT 'waiting',
        current_turn_index INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS game_players (
        game_id UUID REFERENCES games(game_id) ON DELETE CASCADE,
        player_id UUID REFERENCES players(player_id) ON DELETE CASCADE,
        turn_order INTEGER NOT NULL,
        is_eliminated BOOLEAN DEFAULT FALSE,
        ships_placed BOOLEAN DEFAULT FALSE,
        PRIMARY KEY (game_id, player_id)
      );

      CREATE TABLE IF NOT EXISTS ships (
        id SERIAL PRIMARY KEY,
        game_id UUID REFERENCES games(game_id) ON DELETE CASCADE,
        player_id UUID REFERENCES players(player_id) ON DELETE CASCADE,
        ship_row INTEGER NOT NULL,
        ship_col INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS moves (
        id SERIAL PRIMARY KEY,
        game_id UUID REFERENCES games(game_id) ON DELETE CASCADE,
        player_id UUID REFERENCES players(player_id) ON DELETE CASCADE,
        target_player_id UUID REFERENCES players(player_id) ON DELETE CASCADE,
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

// Test mode middleware: only allow /api/test/* when TEST_MODE=true and X-Test-Password is correct
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
    await pool.query('TRUNCATE players, games, game_players, ships, moves CASCADE');
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
      return res.status(200).json({ player_id: existing.rows[0].player_id });
    }
    const playerId = uuidv4();
    await pool.query(
      'INSERT INTO players (player_id, display_name) VALUES ($1, $2)',
      [playerId, displayName]
    );
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
    if (!isValidUuid(id)) return res.status(404).json({ error: 'Player not found' });
    const playerResult = await pool.query(
      'SELECT total_games, total_wins, total_losses, total_moves FROM players WHERE player_id = $1',
      [id]
    );
    if (playerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }
    const row = playerResult.rows[0];
    const hitsResult = await pool.query(
      "SELECT COUNT(*)::int AS total_hits FROM moves WHERE player_id = $1 AND result = 'hit'",
      [id]
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
    if (!creator_id) {
      return res.status(400).json({ error: 'creator_id is required' });
    }
    const creatorCheck = await pool.query(
      'SELECT player_id FROM players WHERE player_id = $1',
      [creator_id]
    );
    if (creatorCheck.rows.length === 0) {
      return res.status(400).json({ error: 'creator_id does not exist' });
    }
    const gameId = uuidv4();
    await pool.query(
      'INSERT INTO games (game_id, grid_size, max_players, status) VALUES ($1, $2, $3, $4)',
      [gameId, grid_size, max_players, 'waiting']
    );
    await pool.query(
      'INSERT INTO game_players (game_id, player_id, turn_order) VALUES ($1, $2, 0)',
      [gameId, creator_id]
    );
    res.status(201).json({
      game_id: gameId,
      grid_size,
      status: 'waiting',
      max_players: max_players,
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
    if (!isValidUuid(id)) return res.status(404).json({ error: 'Game not found' });
    const { player_id } = req.body || {};
    if (!player_id) {
      return res.status(400).json({ error: 'player_id is required' });
    }
    const gameResult = await pool.query(
      'SELECT * FROM games WHERE game_id = $1',
      [id]
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
      [player_id]
    );
    if (playerCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Player does not exist' });
    }
    const existingJoin = await pool.query(
      'SELECT 1 FROM game_players WHERE game_id = $1 AND player_id = $2',
      [id, player_id]
    );
    if (existingJoin.rows.length > 0) {
      return res.status(400).json({ error: 'Player already in this game' });
    }
    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM game_players WHERE game_id = $1',
      [id]
    );
    const currentCount = countResult.rows[0].cnt;
    if (currentCount >= game.max_players) {
      return res.status(400).json({ error: 'Game is full' });
    }
    await pool.query(
      'INSERT INTO game_players (game_id, player_id, turn_order) VALUES ($1, $2, $3)',
      [id, player_id, currentCount]
    );
    const updated = await pool.query(
      'SELECT * FROM games WHERE game_id = $1',
      [id]
    );
    const g = updated.rows[0];
    res.status(200).json({
      game_id: g.game_id,
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
    if (!isValidUuid(id)) return res.status(404).json({ error: 'Game not found' });
    const gameResult = await pool.query(
      'SELECT * FROM games WHERE game_id = $1',
      [id]
    );
    if (gameResult.rows.length === 0) {
      return res.status(404).json({ error: 'Game not found' });
    }
    const game = gameResult.rows[0];
    const activeResult = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM game_players WHERE game_id = $1 AND is_eliminated = FALSE',
      [id]
    );
    const activePlayers = activeResult.rows[0].cnt;
    res.status(200).json({
      game_id: game.game_id,
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

// POST /api/games/:id/place — Stub
app.post('/api/games/:id/place', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUuid(id)) return res.status(404).json({ error: 'Game not found' });
    res.status(200).json({ message: 'placement not yet implemented' });
  } catch (err) {
    console.error('POST /api/games/:id/place:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/games/:id/fire — Stub
app.post('/api/games/:id/fire', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUuid(id)) return res.status(404).json({ error: 'Game not found' });
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
    if (!isValidUuid(id)) return res.status(404).json({ error: 'Game not found' });
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
    if (!isValidUuid(id)) return res.status(404).json({ error: 'Game not found' });
    const gameResult = await pool.query('SELECT * FROM games WHERE game_id = $1', [id]);
    if (gameResult.rows.length === 0) {
      return res.status(404).json({ error: 'Game not found' });
    }
    await pool.query('DELETE FROM ships WHERE game_id = $1', [id]);
    await pool.query('DELETE FROM moves WHERE game_id = $1', [id]);
    await pool.query(
      'UPDATE game_players SET is_eliminated = FALSE, ships_placed = FALSE WHERE game_id = $1',
      [id]
    );
    await pool.query(
      'UPDATE games SET current_turn_index = 0, status = $1 WHERE game_id = $2',
      ['waiting', id]
    );
    const updated = await pool.query('SELECT * FROM games WHERE game_id = $1', [id]);
    const g = updated.rows[0];
    res.status(200).json({
      game_id: g.game_id,
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
    if (!isValidUuid(id)) return res.status(404).json({ error: 'Game not found' });
    if (!isValidUuid(player_id)) return res.status(404).json({ error: 'Player not found' });
    const shipsResult = await pool.query(
      'SELECT ship_row AS row, ship_col AS col FROM ships WHERE game_id = $1 AND player_id = $2',
      [id, player_id]
    );
    const hitsResult = await pool.query(
      'SELECT move_row AS row, move_col AS col FROM moves WHERE game_id = $1 AND target_player_id = $2 AND result = $3',
      [id, player_id, 'hit']
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
