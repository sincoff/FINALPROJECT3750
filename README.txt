================================================================================
BATTLESHIP RADAR COMMAND — CPSC 3750 Exam 1
================================================================================

FOLDER NAME FOR HTDOCS
-----------------------
battleship_exam

LOCALHOST URL
-------------
http://localhost:3000

NOTE: This is a Node.js application (Express server), NOT a PHP application.
It does not use Apache — it runs its own HTTP server on port 3000.

SETUP INSTRUCTIONS
------------------
1. Unzip Exam1_LastName_FirstName.zip
2. Place the battleship_exam folder anywhere (e.g., c:\xampp\htdocs\battleship_exam)
3. Open a terminal / command prompt
4. Navigate to the battleship_exam folder:
     cd battleship_exam
5. Install dependencies:
     npm install
6. Start the server:
     node server.js
7. Open browser to: http://localhost:3000
8. The game is ready to play.

REQUIREMENTS
------------
- Node.js v18 or higher (https://nodejs.org)
- npm (comes with Node.js)

NO ADDITIONAL SETUP REQUIRED
- No MySQL database needed
- No Apache needed
- No manual file editing needed
- JSON files (game-state.json, scoreboard.json) are auto-created at runtime

WHICH FEATURE USES JSON PERSISTENT STORAGE
-------------------------------------------
Feature 1: Persistent Scoreboard — uses scoreboard.json

The scoreboard tracks wins, losses, total games, shot accuracy, best game
(fewest shots to win), win/loss streaks, and a history of the last 20 games.
All data is stored in scoreboard.json and persists across:
  - Browser refresh
  - Server restart
  - New games

The existing game state also uses JSON persistence (game-state.json), but
the scoreboard is the NEW persistent feature added for this exam.

TWO NEW FEATURES IMPLEMENTED
------------------------------

Feature 1: Persistent Scoreboard/Statistics (JSON-based)
  - Tracks wins, losses, accuracy, best game, streaks, game history
  - Stored in scoreboard.json (separate from game state)
  - Displayed in "COMBAT RECORD" panel below the game grids
  - Includes scrollable game history with per-game details
  - Reset button to clear all statistics
  - Data persists across refresh and server restart

Feature 2: AI Difficulty Levels (Easy / Medium / Hard)
  - Three distinct AI algorithms, not just parameter tweaks
  - EASY: Pure random — no targeting intelligence, no memory
  - MEDIUM: Hunt/target with memory (original AI behavior)
  - HARD: Checkerboard hunting + scored targeting with line detection
  - Selectable via buttons in the header during ship placement
  - Difficulty locked during gameplay (cannot change mid-battle)
  - Difficulty shown in status bar during play
  - Difficulty recorded per game in scoreboard history
  - Persists in game state across server restarts

HOW TO TEST EACH FEATURE
--------------------------

Testing Scoreboard Persistence:
  1. Start server and play a game to completion (win or lose)
  2. Verify stats appear in COMBAT RECORD panel
  3. Refresh the browser — stats should still be there
  4. Stop the server (Ctrl+C), restart it (node server.js)
  5. Refresh browser — stats should still be there
  6. Play more games, verify stats accumulate correctly
  7. Click RESET to clear stats, verify they reset to zero

Testing AI Difficulty:
  1. Start a new game
  2. During ship placement, click EASY/MEDIUM/HARD buttons
  3. Notice the active button changes and status bar shows difficulty
  4. Place ships and start battle
  5. During gameplay, difficulty buttons are disabled (grayed out)
  6. Play against each difficulty and observe AI behavior:
     - EASY: AI shoots randomly, often misses near previous hits
     - MEDIUM: AI targets neighbors after a hit, systematically destroys ships
     - HARD: AI uses efficient patterns and smart targeting
  7. After game over, check that difficulty is recorded in game history

FILE STRUCTURE
--------------
battleship_exam/
  index.html          — Main HTML page
  game.js             — Client-side game logic (UI, API calls, scoreboard display)
  server.js           — Express server (game state, AI, scoreboard, persistence)
  styles.css          — Radar-themed CSS styling
  package.json        — Node.js project config and dependencies
  package-lock.json   — Locked dependency versions
  AI_Reflection.txt   — Part 1 reflection + Part 2 feature documentation
  README.txt          — This file
  game-state.json     — Auto-generated at runtime (game state persistence)
  scoreboard.json     — Auto-generated at runtime (scoreboard persistence)

LOOM VIDEO LINK
---------------
[INSERT LOOM VIDEO LINK HERE]

Record a video (under 3 minutes) demonstrating:
  1. Starting a new game and selecting difficulty
  2. Playing a game to completion
  3. Showing scoreboard updates after the game
  4. Refreshing the browser to prove persistence
  5. Restarting the server to prove persistence survives restart
  6. Briefly explain the two features with audio narration

================================================================================
