================================================================================
BATTLESHIP RADAR COMMAND — Multiplayer API Server
================================================================================

## GitHub Repository (Ongoing Requirement)
- Public or shared repo: `https://github.com/<your-org>/<your-team-repo>`
- Both members contributing commits: documented in the commit history/graph.
- Clear commit history: use meaningful commit messages for each feature/bugfix.

## Project Overview
A multiplayer Battleship REST API backend built with Express.js, PostgreSQL,
and integer IDs. Serves static files (index.html, game.js, styles.css) for future
client phases.

Purpose:
Demonstrates engineering discipline and collaboration through incremental milestones,
test-driven verification, and shared ownership of the API/game-state architecture.

Live URL (Render):
------------------
https://finalproject3750.onrender.com

Local URL:
----------
http://localhost:3000

================================================================================
TECH STACK
================================================================================

- Express.js     — Web server and REST API
- pg (node-postgres) — PostgreSQL connection pool
- (SERIAL) IDs — PostgreSQL integer identifiers for players and games
- dotenv         — Environment variable loading from .env

================================================================================
REQUIREMENTS
================================================================================

- Node.js v18 or higher (https://nodejs.org)
- npm (comes with Node.js)
- PostgreSQL database (e.g. NeonDB, Render Postgres, local PostgreSQL)

================================================================================
ENVIRONMENT VARIABLES
================================================================================

Create a .env file in the project root (or set these in your environment):

  DATABASE_URL   — PostgreSQL connection string (REQUIRED)
                   Example: postgresql://user:pass@host:5432/dbname?sslmode=require

  PORT           — Port to listen on (default: 3000)

  TEST_MODE      — "true" or "false" (default: "false")
                   When "true", enables /api/test/* endpoints (requires
                   X-Test-Password: clemson-test-2026 header)

The .env file is in .gitignore and should never be committed.

================================================================================
SETUP INSTRUCTIONS
================================================================================

1. Clone or download the project
2. Navigate to the project folder:
     cd FINALPROJECT3750
3. Create .env and set DATABASE_URL (see Environment Variables section)
4. Install dependencies:
     npm install
5. Start the server:
     npm start
     (or: node server.js)
6. Open browser to http://localhost:3000 (static UI)
   API base: http://localhost:3000/api

================================================================================
DATABASE
================================================================================

The server auto-creates all tables on startup using CREATE TABLE IF NOT EXISTS.
No manual schema setup required.

Tables:
  players       — player_id (SERIAL integer), display_name, total_games, wins, losses, moves
  games         — game_id (SERIAL integer), grid_size, max_players, status, current_turn_index
  game_players  — links games and players, turn_order, is_eliminated, ships_placed
  ships         — ship positions per game/player
  moves         — shot history with result (hit/miss)

The pg pool uses ssl: { rejectUnauthorized: false } for NeonDB compatibility.

## Architecture Summary
================================================================================
ARCHITECTURE SUMMARY
================================================================================

- Frontend: Single-page HTML/CSS/JS (index.html, game.js, styles.css) served
  statically by Express. The browser calls the REST API for all game state.

- Backend: Express.js + PostgreSQL API in server.js. All state (players, games,
  participation, ships, moves) lives in the database; the server is stateless
  between requests aside from the DB.

- Identity: Players and games use integer primary keys. Identity is persistent
  across games, and POST /api/players reuses the same player_id for the same
  display_name.

================================================================================
## API Description
API ENDPOINTS
================================================================================

PRODUCTION ENDPOINTS
--------------------

  POST   /api/reset
         Truncate all tables. Returns 200 { "status": "reset" }

  POST   /api/players
         Body: { "username": "dan" }
         Create or reuse player. Returns 201 { "player_id": "<id>" } for new,
         200 { "player_id": "<id>" } for existing. 400 if username missing/empty
         or if client sends player_id (forbidden).

  GET    /api/players/:id/stats
         Player statistics: games_played, wins, losses, total_shots, total_hits,
         accuracy. 404 if player not found or invalid id.

  POST   /api/games
         Body: { "creator_id": "<id>", "grid_size": 5-15, "max_players": >=1 }
         Create a game. Returns 201 with game object. 400 on validation error.

  POST   /api/games/:id/join
         Body: { "player_id": "<id>" }
         Join a waiting game. Returns 200 with game state. 400 if game full,
         already joined, player doesn't exist, or not waiting. 404 if game not found.

  GET    /api/games/:id
         Get game state: game_id, grid_size, status, current_turn_index,
         active_players. 404 if not found or invalid id.

  POST   /api/games/:id/place
         Body: { "player_id": "<id>", "ships": [...] } (3 ships, in-bounds, no
         overlaps). Validates game is waiting, player is in game, and ship
         coordinates are valid. Inserts ships and marks ships_placed=TRUE for
         that player. Returns 200 with basic game info; does not advance game
         state in Phase 1.

  POST   /api/games/:id/fire
         Full turn-based fire endpoint.
         Validates: game exists (404), game is active/finished rules (403),
         identity/turn (403), placement gating until all players have placed (400/409),
         coordinates in bounds (400), and duplicate shots (400).
         Applies hit/miss against all non-eliminated opponents, performs elimination,
         advances `current_turn_index` (skipping eliminated players), and updates player
         statistics on game finish.

  GET    /api/games/:id/moves
         Returns chronological move history for the game.
         Each move includes: { player_id, row, col, result, timestamp }.
         Returns 200 with [] if no moves exist, or 404 if the game does not exist.

Invalid ids in URL params return 404 (Player/Game not found) to avoid
PostgreSQL errors on malformed input.

TEST MODE ENDPOINTS (require TEST_MODE=true and X-Test-Password: clemson-test-2026)
-----------------------------------------------------------------------------------

  POST   /api/test/games/:id/restart
         Delete ships and moves, reset game_players (is_eliminated=false,
         ships_placed=false), set game status='waiting'. Returns updated game.

  POST   /api/test/games/:id/ships
         TEST MODE-only deterministic ship placement (override allowed).
         Accepts { "player_id": 1, "ships": [ { "row": 0, "col": 0 }, ... ] }.
         Validates bounds/overlap/exactly 3 ships, deletes any old ships for that player,
         replaces them, sets `ships_placed=true`, and activates the game when all players
         have placed ships.

  GET    /api/test/games/:id/board/:player_id
         Return { "ships": [...], "hits": [...] } for a player in a game.

================================================================================
FILE STRUCTURE
================================================================================

  index.html           — Main HTML page (static, served by Express)
  game.js              — Client-side game logic (static, for future phases)
  styles.css           — Radar-themed CSS
  server.js            — Express API server + PostgreSQL
  package.json         — Node.js config and dependencies
  package-lock.json    — Locked dependency versions
  .env                 — Environment variables (create from template, in .gitignore)
  .gitignore           — Ignores node_modules, .env, game-state.json, scoreboard.json
  test-checkpoint-a.js — Automated Checkpoint A API tests
  test-checkpoint-b.js — Automated Checkpoint B API tests
  README.md            — This file

================================================================================
RUNNING TESTS
================================================================================

The test scripts use Node's built-in fetch (Node 18+). No extra test libs needed.

  # Run against local server (must be running on port 3000):
  node test-checkpoint-a.js
  node test-checkpoint-b.js

Checkpoint B requires `TEST_MODE=true` so `/api/test/*` endpoints are enabled.
When using test-mode endpoints, include header `X-Test-Password: clemson-test-2026`.

  # Run against remote (e.g. Render):
  node test-checkpoint-a.js https://finalproject3750.onrender.com
  node test-checkpoint-b.js https://finalproject3750.onrender.com

  # Or with full API path:
  node test-checkpoint-a.js https://finalproject3750.onrender.com/api

The script runs 31 Checkpoint A tests including: reset, player create/reuse,
validation errors, game create/join, stats, id handling, boundary values,
and post-reset behavior.

================================================================================
DEPLOYMENT (RENDER)
================================================================================

1. Connect your GitHub repo to Render
2. Set environment variables: DATABASE_URL, optionally PORT, TEST_MODE
3. Build command: npm install
4. Start command: npm start

Ensure your PostgreSQL provider (e.g. NeonDB) allows connections from Render's
IP range and that SSL is configured (the server uses rejectUnauthorized: false
for NeonDB compatibility).

================================================================================
## Team Member Names
TEAM
================================================================================

- Anthony Martino
  Role: Co-Engineer (shared responsibilities).
  Responsibilities: Designing the persistent multiplayer system and identity
  model, modeling the relational schema (`players`, `games`, `game_players`, `ships`,
  `moves`), and implementing/validating the REST API to satisfy Checkpoint A and
  Checkpoint B (`/place`, `/fire`, `/moves`, and test-mode placement).

- Ian Sincoff
  Role: Co-Engineer (shared responsibilities).
  Responsibilities: Front-end UI and UX work for the Battleship client,
  integrating the browser game with the API, deployment configuration, and
  additional testing/verification (including `test-checkpoint-b.js`).

================================================================================
## AI Tool(s) Used
AI TOOLS AND HUMAN OVERSIGHT
================================================================================

AI tools used:
- Cursor AI assistant (GPT-based)
- Claude (for early architecture and prompt design help)

## Major Role of Each Human + AI

Major roles:
- AI: Helped reason about the Phase 1 spec, hidden edge cases for Checkpoint A,
  and database schema design (5-table model). Assisted in drafting and refining
  `server.js` endpoints and the automated Checkpoint A/B test scripts
  (`test-checkpoint-a.js`, `test-checkpoint-b.js`).
- Humans (Anthony & Ian): Reviewed all AI suggestions, caught and corrected
  mistakes (e.g., PORT handling, integer vs id values, deployment details),
  made final architecture decisions, and implemented, tested, and debugged
  the codebase.
================================================================================
RUBRIC (GitHub Usage Phase 1)
================================================================================

| Criteria | Ratings | Pts |
|---|---:|---:|
| Both members contributing commits | 5 pts Full Marks / 0 pts No Marks | 5 |
| Clear commit history | 5 pts Full Marks / 0 pts No Marks | 5 |
| Readme File (see details) | 5 pts Full Marks / 0 pts No Marks | 5 |