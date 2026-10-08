-- LIQUIDITY POOL FISHING payout server: run this once in the D1 console (Storage & Databases > D1 > your database > Console).
CREATE TABLE IF NOT EXISTS players (
  wallet TEXT PRIMARY KEY, created INTEGER,
  bag_usd REAL DEFAULT 0, bag_n INTEGER DEFAULT 0,
  last_ore_at INTEGER, last_depth REAL DEFAULT 0, bucket REAL, bucket_at INTEGER,
  dia_day TEXT, dia_n INTEGER DEFAULT 0,
  last_cashout INTEGER DEFAULT 0, paid_day TEXT, paid_usd REAL DEFAULT 0, total_sol REAL DEFAULT 0,
  win_start INTEGER DEFAULT 0, win_sol REAL DEFAULT 0, lock_until INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS nonces (wallet TEXT PRIMARY KEY, nonce TEXT, exp INTEGER);
CREATE TABLE IF NOT EXISTS ores_seen (wallet TEXT, k TEXT, t INTEGER, PRIMARY KEY (wallet, k));
CREATE TABLE IF NOT EXISTS global (day TEXT PRIMARY KEY, paid_usd REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, sig TEXT UNIQUE, sigs TEXT, wallet TEXT, t INTEGER, day TEXT, usd REAL, lamports INTEGER, price REAL, ores INTEGER, lvh INTEGER, attempt INTEGER, status TEXT, busy_until INTEGER DEFAULT 0, err TEXT);
CREATE INDEX IF NOT EXISTS payouts_status ON payouts (status);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, t INTEGER, kind TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS payouts_t ON payouts (t);
CREATE INDEX IF NOT EXISTS events_t ON events (t);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
-- step 141: every ore in a bag is its own row (the worker also creates this itself if missing)
CREATE TABLE IF NOT EXISTS bag_items (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, ore INTEGER, usd REAL, payout INTEGER);
CREATE INDEX IF NOT EXISTS bag_items_w ON bag_items (wallet, payout);
CREATE INDEX IF NOT EXISTS bag_items_p ON bag_items (payout);
-- fishing: the all-time biggest-fish leaderboard (the worker also creates this itself if missing)
CREATE TABLE IF NOT EXISTS board (k TEXT PRIMARY KEY, name TEXT, kg REAL, fish TEXT, t INTEGER);
