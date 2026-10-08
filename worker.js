// LIQUIDITY POOL FISHING: game + payout server (Cloudflare Worker + D1 + one Durable Object per room). No dependencies.
// Built from the FEEMINERS server: the same wallet sign-in, holdings tiers, bag, cash outs, payouts, checker and dashboard.
//
//   1. Login: the player signs a one-time message with their wallet; we check it and hand back a session token.
//   2. Fishing: the ROOM (class Pond) picks every fish that bites, times the fight, and on landing puts the fish straight
//      into the player's bag (bag_items), priced by the server. The browser never says what it caught or what it is worth.
//   3. Cash out: holder check, cooldown, caps; the bag's value goes to the wallet in SOL from the payout wallet.
import { GAME } from './fishdata.js';
import { DASH } from './dashboard.js';

// ---------------- settings (each can be overridden with a Worker variable of the same name) ----------------
const DEF = {
  MIN_HOLD_SOL: 0.4,
  MIN_HOLD_USD: 30,             // HOLD_MODE=supply: hold at least this many dollars of the coin (live price) to sell your catch
  MIN_HOLD_PCT: 0.05,           // HOLD_MODE=supply: the share of the coin's supply (in %) a wallet must hold to cash out            // must hold at least this much to cash out
  HOLD_MODE: 'supply',             // 'sol' = the wallet's SOL balance (testing) · 'supply' = % of the coin's supply held (launch; needs GEM_MINT) · 'token' = coin valued in SOL
  GEM_MINT: '4Vm5qvmffPRHjkhLpR6gTBMKepsf1JhQLrcLwWxbpump',                 // the $GEM token mint address (for HOLD_MODE=token)
  COOLDOWN_MIN: 6.5,             // minutes between cash outs (after every cash out)
  MAX_CASHOUT_USD: 120,         // most one cash out can pay (room for one Diamond)
  WALLET_DAILY_USD: 160,        // backstop: most one wallet can be paid per UTC day (the SOL limit below normally bites first)
  WALLET_LIMIT_USD: 160,        // hidden: once a wallet has been paid this many dollars within 24 hours, it is locked out for 24 hours (tracked in players.win_sol, which holds DOLLARS)
  LIMIT_HOURS: 24,
  GLOBAL_DAILY_USD: 1000,       // most the whole game can pay out per UTC day
  EARN_RATE_USD_MIN: 40,         // fish value a wallet can earn per minute of play (refills a bucket)
  EARN_BURST_USD: 80,           // the bucket's size
  BAG_MAX: 40,                  // fish a bag holds
  MAX_FISH_USD: 15,             // no single fish pays more than this
  FISH_SOL_USD: 119,            // the game's fish prices are set in SOL at this rate, then paid in dollars
  ROOM_CAP: 200,                // players per room (a full room sends players to the next one)
  MIN_PAYOUT_USD: 0.25,         // smaller bags wait (keeps fees sensible)
  FLOAT_FLOOR_SOL: 0.05,        // never empty the payout wallet below this (rent + fees)
  USD_PER_SOL_FALLBACK: 120,    // used if the live price cannot be fetched
  MAX_ATTEMPTS: 5,              // a payout that provably did not land is re-sent up to this many times, then the ores go back to the player
  PAYOUTS_ENABLED: 'true',      // set to 'false' to switch every payout off at once
  ALLOWED_ORIGIN: '*',        // which sites may call the API ('*' = any; sign-in uses a bearer token, not cookies). Comma list also works; a listed *.pages.dev site also allows its per-upload links
};
const cfg = (env, k) => { const v = env[k]; if (v === undefined || v === '') return DEF[k]; return typeof DEF[k] === 'number' ? Number(v) : v; };

// ---------------- small helpers ----------------
const enc = new TextEncoder();
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58dec(s) { let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } for (const c of s) { if (c !== '1') break; out.unshift(0); } return new Uint8Array(out); }
function b58enc(b) { let n = 0n; for (const x of b) n = (n << 8n) + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x !== 0) break; s = '1' + s; } return s; }
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const hex = (u8) => [...u8].map((x) => x.toString(16).padStart(2, '0')).join('');
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const isWallet = (w) => typeof w === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w) && (() => { try { return b58dec(w).length === 32; } catch { return false; } })();

const originOk = (allow, o) => allow.some((a) => { if (a === '*' || a === o) return true; try { const A = new URL(a), O = new URL(o); return A.protocol === O.protocol && A.hostname.endsWith('.pages.dev') && O.hostname.endsWith('.' + A.hostname); } catch { return false; } });      // the Pages site and its per-upload links (abc123.site.pages.dev)
function cors(env, req) { const o = req.headers.get('Origin') || ''; const allow = cfg(env, 'ALLOWED_ORIGIN').split(',').map((s) => s.trim()); return { 'Access-Control-Allow-Origin': o && originOk(allow, o) ? o : allow.includes('*') ? '*' : allow[0], 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Vary': 'Origin' }; }
const json = (env, req, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(env, req) } });

// ---------------- session tokens (HMAC-signed, 12 hours) ----------------
async function hmacKey(env) { return crypto.subtle.importKey('raw', enc.encode(env.SESSION_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function makeToken(env, wallet) { const body = b64url(enc.encode(JSON.stringify({ w: wallet, exp: Date.now() + 12 * 3600e3 }))); const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body))); return body + '.' + b64url(sig); }
async function readToken(env, req) {
  const h = req.headers.get('Authorization') || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : ''; const [body, sig] = t.split('.'); if (!body || !sig) return null;
  if (!(await crypto.subtle.verify('HMAC', await hmacKey(env), unb64url(sig), enc.encode(body)))) return null;
  const p = JSON.parse(new TextDecoder().decode(unb64url(body))); return p.exp > Date.now() && isWallet(p.w) ? p.w : null;
}

// ---------------- Solana RPC ----------------
async function rpc(env, method, params) {      // retries when the RPC is rate-limited (429) or answers with something that is not JSON
  for (let a = 0; ; a++) {
    let r, j = null; try { r = await fetch(env.RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); j = await r.json().catch(() => null); } catch {}
    const busy = !r || r.status === 429 || r.status >= 500 || !j || (j.error && (j.error.code === 429 || /rate|too many/i.test(j.error.message || '')));
    if (!busy) { if (j.error) throw new Error(method + ': ' + (j.error.message || JSON.stringify(j.error))); return j.result; }
    if (a >= 3) throw new Error(method + ': RPC busy (' + (r ? r.status : 'no answer') + ')');
    await new Promise((res) => setTimeout(res, 300 * Math.pow(3, a) + Math.random() * 200));
  }
}
const HC = (globalThis.__hc ||= { w: new Map(), sup: null, px: null });      // short caches so a crowd of players polling does not hammer the RPC
async function solPriceUsd(env) {
  try { const r = await fetch('https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112'); const j = await r.json(); const p = Number(j?.So11111111111111111111111111111111111111112?.usdPrice); if (p > 1) return p; } catch {}
  return cfg(env, 'USD_PER_SOL_FALLBACK');
}
async function coinUsd(env, mint) {      // the coin's live price in dollars: Jupiter, then DexScreener (covers pump.fun's bonding curve); null if neither answers
  if (env.TEST_PRICE_USD) return Number(env.TEST_PRICE_USD);
  try { const j = await (await fetch('https://lite-api.jup.ag/price/v3?ids=' + mint)).json(); const p = Number(j?.[mint]?.usdPrice); if (p > 0) return p; } catch {}
  try { const d = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mint)).json(); const p = Number((d?.pairs || []).find((x) => x?.baseToken?.address === mint)?.priceUsd); if (p > 0) return p; } catch {}
  return null;
}
async function holdInfo(env, wallet, maxAge = 15e3) {      // cached per wallet for 15 s; if the RPC is down, the last answer (up to 10 min old) is used
  const c = HC.w.get(wallet), now = Date.now(); if (c && now - c.t < maxAge) return c.v;
  try { const v = await holdInfoRaw(env, wallet); HC.w.set(wallet, { t: now, v }); if (HC.w.size > 5000) HC.w.delete(HC.w.keys().next().value); return v; }
  catch (e) { if (c && now - c.t < 600e3) return c.v; throw e; }
}
async function tokenSupply(env, mint) { const now = Date.now(); if (HC.sup && HC.sup.m === mint && now - HC.sup.t < 120e3) return HC.sup.v; const v = await rpc(env, 'getTokenSupply', [mint, { commitment: 'confirmed' }]); HC.sup = { m: mint, t: now, v }; return v; }
async function coinUsdC(env, mint) { const now = Date.now(); if (HC.px && HC.px.m === mint && now - HC.px.t < 30e3) return HC.px.v; const v = await coinUsd(env, mint); if (v != null) HC.px = { m: mint, t: now, v }; return v ?? HC.px?.v ?? null; }
async function holdInfoRaw(env, wallet) {
  if (cfg(env, 'HOLD_MODE') !== 'supply') { const h = await holdingSol(env, wallet); return { pct: h, usd: null, ok: h >= holdMin(env) }; }
  const mint = cfg(env, 'GEM_MINT'); if (!mint) throw new Error('GEM_MINT not set');
  const [res, sup, price] = await Promise.all([rpc(env, 'getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]), tokenSupply(env, mint), coinUsdC(env, mint)]);
  const amt = res.value.reduce((a, v) => a + Number(v.account.data.parsed.info.tokenAmount.uiAmount || 0), 0), total = Number(sup.value.uiAmount || 0), pct = total > 0 ? (amt / total) * 100 : 0;
  const usd = price != null ? amt * price : null;
  return { pct, usd, ok: usd != null ? usd >= cfg(env, 'MIN_HOLD_USD') : pct >= cfg(env, 'MIN_HOLD_PCT') };      // no price available: fall back to the share of supply
}
async function holdingSol(env, wallet) {      // what this wallet holds: SOL (sol/token modes) or % of supply (supply mode)
  if (cfg(env, 'HOLD_MODE') === 'supply') {
    const mint = cfg(env, 'GEM_MINT'); if (!mint) throw new Error('GEM_MINT not set');
    const [res, sup] = await Promise.all([rpc(env, 'getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]), rpc(env, 'getTokenSupply', [mint, { commitment: 'confirmed' }])]);
    const amt = res.value.reduce((a, v) => a + Number(v.account.data.parsed.info.tokenAmount.uiAmount || 0), 0), total = Number(sup.value.uiAmount || 0);
    return total > 0 ? (amt / total) * 100 : 0;
  }
  if (cfg(env, 'HOLD_MODE') === 'token') {
    const mint = cfg(env, 'GEM_MINT'); if (!mint) throw new Error('GEM_MINT not set');
    const res = await rpc(env, 'getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const amt = res.value.reduce((a, v) => a + Number(v.account.data.parsed.info.tokenAmount.uiAmount || 0), 0); if (!amt) return 0;
    const pr = await (await fetch('https://lite-api.jup.ag/price/v3?ids=' + mint)).json(); const usd = Number(pr?.[mint]?.usdPrice || 0);
    return (amt * usd) / (await solPriceUsd(env));
  }
  const r = await rpc(env, 'getBalance', [wallet, { commitment: 'confirmed' }]); return r.value / 1e9;
}

// ---------------- the payout transfer, built and signed by hand (one System Program transfer) ----------------
const cu16 = (n) => { const o = []; do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
async function payoutKey(env) {      // PAYOUT_SECRET: the payout wallet's secret key, base58 (64 bytes, as Phantom/solana-keygen export it)
  const raw = String(env.PAYOUT_SECRET || '').trim(); if (!raw) throw new Error('PAYOUT_SECRET is not set'); let sk; try { sk = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : b58dec(raw); } catch { throw new Error('PAYOUT_SECRET is not a valid secret key (paste the private key exactly as Phantom shows it)'); } if (sk.length !== 64) throw new Error('PAYOUT_SECRET must be a 64-byte base58 secret key');
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...sk.slice(0, 32)]);
  return { key: await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']), pub: sk.slice(32) };
}
async function buildTransfer(env, toWallet, lamports) {
  const { key, pub } = await payoutKey(env), to = b58dec(toWallet); if (b58enc(pub) === toWallet) throw new Error('cannot pay the payout wallet');
  const lb = (await rpc(env, 'getLatestBlockhash', [{ commitment: 'finalized' }])).value, bh = b58dec(lb.blockhash);
  const data = new Uint8Array(12); const dv = new DataView(data.buffer); dv.setUint32(0, 2, true); dv.setBigUint64(4, BigInt(lamports), true);
  const msg = new Uint8Array([1, 0, 1, ...cu16(3), ...pub, ...to, ...new Uint8Array(32), ...bh, ...cu16(1), 2, ...cu16(2), 0, 1, ...cu16(12), ...data]);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, msg));
  return { tx: new Uint8Array([...cu16(1), ...sig, ...msg]), sig: b58enc(sig), from: b58enc(pub), lvh: Number(lb.lastValidBlockHeight) };
}

// ---------------- fish: the server's own copy of the game's rules (fishdata.js, generated from the game) ----------------
const FIDX = new Map(GAME.fish.map((f, i) => [f.name, i]));
const tripAt = (clock, dock = 300, sail = 300) => { const leg = Math.floor(clock / (dock + sail)); return { isle: GAME.isles[((leg % GAME.isles.length) + GAME.isles.length) % GAME.isles.length], docked: clock - leg * (dock + sail) < dock }; };
function rollFish(luck, zone, top) {      // same odds as the game's rollFish: luck lifts every tier above Common, top lifts epic and up
  const w = (i) => GAME.rarity[i].weight * (i > 0 ? luck : 1) * (i >= 3 ? top : 1), total = GAME.rarity.reduce((t, _, i) => t + w(i), 0);
  let x = Math.random() * total, r = 0; for (; r < GAME.rarity.length - 1; r++) { x -= w(r); if (x < 0) break; }
  const here = (f) => !f.item && (!f.at || (zone === 'sea' ? f.at === 'sea' : f.at === 'pond' || f.at === zone));      // item fish (clothes) are not caught here
  let pool = []; for (; r >= 0 && !pool.length; r--) pool = GAME.fish.filter((f) => f.r === r && here(f)); r++;
  const pw = (f) => (f.trash ? 0.2 : f.at === zone && zone !== 'sea' ? 1.6 : 1);
  let pick = Math.random() * pool.reduce((t, f) => t + pw(f), 0), f = pool[0]; for (const c of pool) { pick -= pw(c); if (pick < 0) { f = c; break; } }
  const kg = f.kg[0] + (f.kg[1] - f.kg[0]) * Math.random() ** 1.8;
  return { i: FIDX.get(f.name), name: f.name, r: f.r, trash: f.trash, kg: kg >= 10 ? Math.round(kg) : Math.round(kg * 100) / 100 };
}
function priceFish(env, f) {      // rarity sets the range, weight picks the spot inside it (the game's payoutFor), in dollars
  if (f.trash) return 0; const F = GAME.fish[f.i], [lo, hi] = F.kg, u = Math.max(0, Math.min(1, (f.kg - lo) / (hi - lo || 1))), [a, b] = GAME.pay[f.r] || [0, 0];
  return Math.min(cfg(env, 'MAX_FISH_USD'), Math.round((a + (b - a) * u) * cfg(env, 'FISH_SOL_USD') * 100) / 100);
}
const poleTier = () => GAME.poles.length;      // no tool tiers in this game: every pole is free; holding the coin is what lets you sell
// put one landed fish in a wallet's bag: the earning bucket (no faster than a person can fish) and the bag size apply
async function bankFish(env, w, f, usd) {
  const p = await player(env, w), now = Date.now();
  if ((p.bag_n || 0) >= cfg(env, 'BAG_MAX')) return { ok: false, why: 'bag full', bag_usd: p.bag_usd, bag_n: p.bag_n };
  let bucket = Math.min(cfg(env, 'EARN_BURST_USD'), (p.bucket ?? cfg(env, 'EARN_BURST_USD')) + ((now - (p.bucket_at || now)) / 60e3) * cfg(env, 'EARN_RATE_USD_MIN')), got = Math.min(usd, Math.max(0, bucket)); bucket -= got;
  await env.DB.batch([env.DB.prepare('INSERT INTO bag_items (wallet, ore, usd) VALUES (?, ?, ?)').bind(w, f.i, got),
    env.DB.prepare('UPDATE players SET bag_usd = bag_usd + ?, bag_n = bag_n + 1, last_ore_at = ?, bucket = ?, bucket_at = ? WHERE wallet = ?').bind(got, now, bucket, now, w)]);
  if (got < usd) await log(env, w, 'capped', { fish: f.name, kg: f.kg, priced: usd, counted: got });
  return { ok: true, usd: got, capped: got < usd, bag_usd: (p.bag_usd || 0) + got, bag_n: (p.bag_n || 0) + 1 };
}

// ---------------- player rows ----------------
async function player(env, w) {
  await env.DB.prepare('INSERT OR IGNORE INTO players (wallet, created) VALUES (?, ?)').bind(w, Date.now()).run();
  return env.DB.prepare('SELECT * FROM players WHERE wallet = ?').bind(w).first();
}
const log = (env, w, kind, detail) => env.DB.prepare('INSERT INTO events (wallet, t, kind, detail) VALUES (?, ?, ?, ?)').bind(w, Date.now(), kind, JSON.stringify(detail).slice(0, 500)).run();

// ---------------- the bag: every ore a player holds is its own row (bag_items), so nothing is ever lumped together ----------------
// payout: NULL = in the bag · negative = locked by a cash out in progress (minus the time it started) · a payout id = being paid by that payout
let bagReady = false;
async function bagTable(env) { if (bagReady) return; await env.DB.batch([
  env.DB.prepare('CREATE TABLE IF NOT EXISTS bag_items (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, ore INTEGER, usd REAL, payout INTEGER)'),
  env.DB.prepare('CREATE INDEX IF NOT EXISTS bag_items_w ON bag_items (wallet, payout)'), env.DB.prepare('CREATE INDEX IF NOT EXISTS bag_items_p ON bag_items (payout)')]); bagReady = true; }
const recalcSQL = (env, w) => env.DB.prepare('UPDATE players SET bag_usd = COALESCE((SELECT SUM(usd) FROM bag_items WHERE wallet = ?1 AND payout IS NULL), 0), bag_n = (SELECT COUNT(*) FROM bag_items WHERE wallet = ?1 AND payout IS NULL) WHERE wallet = ?1').bind(w);
async function recalc(env, w) {      // the totals always come from the ores themselves; a cash out that died half way (over 10 min ago) lets go of its ores
  await env.DB.prepare('UPDATE bag_items SET payout = NULL WHERE wallet = ? AND payout < 0 AND payout > ?').bind(w, -(Date.now() - 600e3)).run(); await recalcSQL(env, w).run(); }
async function bagList(env, w) { return (await env.DB.prepare('SELECT ore, COUNT(*) AS n, SUM(usd) AS usd FROM bag_items WHERE wallet = ? AND payout IS NULL GROUP BY ore').bind(w).all()).results.map((r) => [r.ore, r.n, r.usd]); }

// ---------------- routes ----------------
async function route(req, env) {
  const url = new URL(req.url), P = url.pathname;
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env, req) });
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (P === '/config') return json(env, req, { mint: cfg(env, 'GEM_MINT') || null, mode: cfg(env, 'HOLD_MODE'), min_usd: cfg(env, 'MIN_HOLD_USD') });      // public: which coin the game is tied to
  if (P === '/paid') {      // public: the latest 20 payouts to anyone, for the WALLETS PAID panels (short wallet, amount, transaction)
    if (!globalThis.__paid || Date.now() - globalThis.__paid.t > 10e3) { const r = await env.DB.prepare("SELECT wallet, sig, t, usd, lamports, status FROM payouts WHERE status IN ('confirmed', 'pending') ORDER BY id DESC LIMIT 20").all();
      globalThis.__paid = { t: Date.now(), list: r.results.map((x) => ({ w: x.wallet.slice(0, 4) + '…' + x.wallet.slice(-4), sol: x.lamports / 1e9, usd: x.usd, tx: x.sig, t: x.t, st: x.status })) }; }
    return json(env, req, { list: globalThis.__paid.list });
  }
  if (P === '/health') return json(env, req, { ok: true, payouts: !(await paused(env)) });

  if (P === '/nonce') {      // step 1 of login
    const w = url.searchParams.get('wallet'); if (!isWallet(w)) return json(env, req, { error: 'bad wallet' }, 400);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    await env.DB.prepare('INSERT OR REPLACE INTO nonces (wallet, nonce, exp) VALUES (?, ?, ?)').bind(w, nonce, Date.now() + 5 * 60e3).run();
    return json(env, req, { message: loginMessage(w, nonce) });
  }
  if (P === '/login') {      // step 2: check the wallet really signed it
    const { wallet: w, signature } = body; if (!isWallet(w) || typeof signature !== 'string') return json(env, req, { error: 'bad request' }, 400);
    const row = await env.DB.prepare('DELETE FROM nonces WHERE wallet = ? AND exp > ? RETURNING nonce').bind(w, Date.now()).first();      // one use only
    if (!row) return json(env, req, { error: 'login expired, try again' }, 401);
    let ok = false; try { const k = await crypto.subtle.importKey('raw', b58dec(w), { name: 'Ed25519' }, false, ['verify']); ok = await crypto.subtle.verify('Ed25519', k, b58dec(signature), enc.encode(loginMessage(w, row.nonce))); } catch {}
    if (!ok) return json(env, req, { error: 'signature did not match' }, 401);
    await player(env, w); await log(env, w, 'login', {}); 
    let hi = {}; try { hi = await holdInfo(env, w); } catch {}
    return json(env, req, { token: await makeToken(env, w), tier: poleTier(env, hi), holding: hi.pct ?? null, usd: hi.usd ?? null, ok_hold: hi.ok ?? null, min: holdMin(env), min_usd: cfg(env, 'MIN_HOLD_USD'), mode: cfg(env, 'HOLD_MODE') });
  }

  if (P === '/ws') {      // a room: ?room=1..ROOMS (the game tries the next one when a room is full)
    if (!env.POND) return new Response('multiplayer not set up', { status: 503 });
    const r = Math.max(1, Math.min(20, Number(url.searchParams.get('room')) || 1)); return pondStub(env, r).fetch(new Request(url.origin + '/ws?room=' + r, { headers: req.headers }));
  }
  if (P === '/world') { if (!env.POND) return json(env, req, { off: true }); const rooms = []; for (let r = 1; r <= 3; r++) rooms.push((await (await pondStub(env, r).fetch('https://w/stats')).json()).online); return json(env, req, { rooms, online: rooms.reduce((a, b) => a + b, 0) }); }
  if (P === '/' || P === '') return Response.redirect(url.origin + '/dashboard', 302);      // the bare address opens the dashboard
  if (P === '/dashboard') return new Response(DASH, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:" } });
  if (P.startsWith('/admin')) {      // Peter only: the key goes in the X-Admin-Key header (the dashboard does this) or ?key=
    const k = req.headers.get('X-Admin-Key') || url.searchParams.get('key') || '';
    if (!env.ADMIN_KEY || k.length !== env.ADMIN_KEY.length || !(await safeEq(k, env.ADMIN_KEY))) return json(env, req, { error: 'wrong admin key' }, 403);
    if (P === '/admin/pause' && req.method === 'POST') { await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('paused', ?)").bind(body.paused ? '1' : '0').run(); await log(env, 'admin', body.paused ? 'paused' : 'resumed', {}); return json(env, req, { ok: true, paused: !!body.paused }); }
    if (P === '/admin/world-reset' && req.method === 'POST') { await env.DB.prepare('DELETE FROM board').run().catch(() => {}); await log(env, 'admin', 'board_reset', {}); return json(env, req, { ok: true }); }      // clears the leaderboard
    if (P === '/admin/check' && req.method === 'POST') return json(env, req, { checked: await reconcile(env) });
    const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
    const [g, pays, reqs, pend, all, flags] = await env.DB.batch([
      q('SELECT * FROM global WHERE day = ?', day()),
      q('SELECT id, sig, sigs, wallet, t, usd, lamports, status, attempt FROM payouts ORDER BY id DESC LIMIT 100'),
      q("SELECT wallet, t, kind, detail FROM events WHERE kind IN ('request', 'returned', 'retry', 'float_low', 'error', 'send_error', 'paused', 'resumed') ORDER BY id DESC LIMIT 150"),
      q("SELECT COUNT(*) AS n, COALESCE(SUM(lamports), 0) AS lam FROM payouts WHERE status = 'pending'"),
      q("SELECT COUNT(*) AS n, COALESCE(SUM(lamports), 0) AS lam, COALESCE(SUM(usd), 0) AS usd FROM payouts WHERE status = 'confirmed'"),
      q("SELECT v FROM settings WHERE k = 'paused'"),
    ]);
    let float = null, addr = null; try { const { pub } = await payoutKey(env); addr = b58enc(pub); float = (await rpc(env, 'getBalance', [addr])).value / 1e9; } catch (e) { float = 'error: ' + String(e.message).slice(0, 80); }
    return json(env, req, { now: Date.now(), paused: await paused(env), envOff: cfg(env, 'PAYOUTS_ENABLED') !== 'true', payout_wallet: addr, float_sol: float, floor_sol: cfg(env, 'FLOAT_FLOOR_SOL'),
      today_usd: g.results[0]?.paid_usd || 0, budget_usd: cfg(env, 'GLOBAL_DAILY_USD'), pending: pend.results[0], all_time: all.results[0], payouts: pays.results, requests: reqs.results });
  }
  const w = await readToken(env, req); if (!w) return json(env, req, { error: 'please connect your wallet again' }, 401);
  await bagTable(env);

  if (P === '/me') { await player(env, w); await recalc(env, w); const p = await player(env, w); let hi = {}; try { hi = await holdInfo(env, w); } catch {} return json(env, req, { ...view(env, p, hi), tier: poleTier(env, hi), bag: await bagList(env, w) }); }

  if (P === '/drop' && req.method === 'POST') {      // the player threw fish out of the bag: those fish are deleted, gone for good
    const ore = Number(body.ore), n = Math.max(0, Math.min(1000, Math.floor(Number(body.n) || 0)));
    if (Number.isInteger(ore) && n > 0) await env.DB.batch([env.DB.prepare('DELETE FROM bag_items WHERE id IN (SELECT id FROM bag_items WHERE wallet = ? AND ore = ? AND payout IS NULL ORDER BY usd DESC LIMIT ?)').bind(w, ore, n), recalcSQL(env, w)]);
    return json(env, req, { ok: true, bag: await bagList(env, w) });
  }
  if (P === '/cashout') {      // every request is written down with its result, for the dashboard
    const res = await cashout(env, req, w); let b = {}; try { b = await res.clone().json(); } catch {}
    await log(env, w, 'request', { ok: !!b.ok, status: b.status || null, usd: b.usd ?? null, sol: b.sol ?? null, sig: b.signature || null, why: b.ok ? null : (b.why || b.error || null) });
    return res;
  }

  return json(env, req, { error: 'not found' }, 404);
}
async function paused(env) { if (cfg(env, 'PAYOUTS_ENABLED') !== 'true') return true; const r = await env.DB.prepare("SELECT v FROM settings WHERE k = 'paused'").first(); return r?.v === '1'; }
async function safeEq(a, b) { const k = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.sign('HMAC', k, enc.encode(v)))); const X = new Uint8Array(x), Y = new Uint8Array(y); let d = 0; for (let i = 0; i < X.length; i++) d |= X[i] ^ Y[i]; return d === 0; }
const holdMin = (env) => (cfg(env, 'HOLD_MODE') === 'supply' ? cfg(env, 'MIN_HOLD_PCT') : cfg(env, 'MIN_HOLD_SOL'));
const holdUnit = (env) => (cfg(env, 'HOLD_MODE') === 'supply' ? '% of the supply' : ' SOL');
const loginMessage = (w, nonce) => `Sign in to Liquidity Pool Fishing\n\nWallet: ${w}\nNonce: ${nonce}\n\nThis only proves you own this wallet. It costs nothing and moves no funds.`;
function view(env, p, hi) { const cd = cfg(env, 'COOLDOWN_MIN') * 60e3; return { wallet: p.wallet, bag_usd: p.bag_usd, bag_n: p.bag_n, holding: hi.pct ?? null, usd: hi.usd ?? null, ok_hold: hi.ok ?? null, min_usd: cfg(env, 'MIN_HOLD_USD'), min: holdMin(env), mode: cfg(env, 'HOLD_MODE'), next_cashout_ms: Math.max(0, (p.last_cashout || 0) + cd - Date.now()), paid_today_usd: p.paid_day === day() ? p.paid_usd : 0, total_paid_sol: p.total_sol }; }

async function cashout(env, req, w) {
  if (await paused(env)) return json(env, req, { ok: false, why: 'Payouts are paused right now. Your bag is safe.' });
  const p = await player(env, w), now = Date.now(), cd = cfg(env, 'COOLDOWN_MIN') * 60e3;
  const H = cfg(env, 'LIMIT_HOURS') * 3600e3, comeBack = (ms) => { const m = Math.ceil(ms / 60e3); return 'You have reached your cash out limit. Come back in ' + Math.floor(m / 60) + 'h ' + (m % 60) + 'm.'; };
  if ((p.lock_until || 0) > now) return json(env, req, { ok: false, why: comeBack(p.lock_until - now), locked_ms: p.lock_until - now });
  if (now - (p.last_cashout || 0) < cd) return json(env, req, { ok: false, why: 'cooldown', next_cashout_ms: (p.last_cashout || 0) + cd - now });
  await recalc(env, w); { const q = await player(env, w); p.bag_usd = q.bag_usd; p.bag_n = q.bag_n; }      // the bag is exactly the ores in it
  if ((p.bag_usd || 0) < cfg(env, 'MIN_PAYOUT_USD')) return json(env, req, { ok: false, why: 'Your bag is worth less than $' + cfg(env, 'MIN_PAYOUT_USD') + '. Catch a few more.' });
  let hi; try { hi = await holdInfo(env, w, 5e3); } catch { return json(env, req, { ok: false, why: 'Could not check your wallet. Try again in a minute.' }); }
  if (!hi.ok) return json(env, req, { ok: false, why: cfg(env, 'HOLD_MODE') === 'supply' && hi.usd != null ? 'You need at least $' + cfg(env, 'MIN_HOLD_USD') + ' of the coin in your wallet to cash out (you hold $' + hi.usd.toFixed(2) + ').' : 'You need to hold at least ' + holdMin(env) + holdUnit(env) + ' to cash out.', holding: hi.pct, usd: hi.usd, ok_hold: false });

  // claim the bag in one step: only one cash out can win, even if two requests arrive together
  const won = await env.DB.prepare('UPDATE players SET last_cashout = ? WHERE wallet = ? AND COALESCE(last_cashout, 0) = ? RETURNING wallet').bind(now, w, p.last_cashout || 0).first();      // only one cash out can win, even if two arrive together
  if (!won) return json(env, req, { ok: false, why: 'cooldown' });
  const lock = -now, items = (await env.DB.prepare('UPDATE bag_items SET payout = ? WHERE wallet = ? AND payout IS NULL RETURNING id, ore, usd').bind(lock, w).all()).results.sort((a, b) => b.usd - a.usd);      // these ores are this cash out's; ore mined from now on is not
  await recalc(env, w); p.bag_usd = items.reduce((a, i) => a + i.usd, 0); p.bag_n = items.length;
  const st = { global: 0, sent: false, items, lock, oldCash: p.last_cashout || 0 };
  if (p.bag_usd < cfg(env, 'MIN_PAYOUT_USD')) { await unlockBag(env, w, st); return json(env, req, { ok: false, why: 'Your bag is worth less than $' + cfg(env, 'MIN_PAYOUT_USD') + '. Catch a few more.' }); }
  try { return await payBag(env, req, w, p, now, cd, st); }
  catch (e) {      // anything going wrong after the claim: put the bag (and the day's budget) back unless the SOL already left
    console.log('ERR cashout', e?.stack || e); await log(env, w, 'error', { at: 'cashout', e: String(e?.message || e) });
    if (st.recorded) return json(env, req, { ok: true, usd: 0, status: 'pending', why: 'Payout on its way. It can take a few minutes to show in your wallet.' });      // written down: the checker finishes it
    if (st.global) await env.DB.prepare('UPDATE global SET paid_usd = paid_usd - ? WHERE day = ?').bind(st.global, day()).run();
    await unlockBag(env, w, st); return json(env, req, { ok: false, why: 'Payout failed. Your bag is safe, try again later.', bag: await bagList(env, w) });
  }
}
async function unlockBag(env, w, st) {      // the cash out did not go ahead: every fish back in the bag, the cooldown as it was
  await env.DB.batch([env.DB.prepare('UPDATE bag_items SET payout = NULL WHERE wallet = ? AND payout = ?').bind(w, st.lock), env.DB.prepare('UPDATE players SET last_cashout = ? WHERE wallet = ?').bind(st.oldCash, w), recalcSQL(env, w)]); }
async function payBag(env, req, w, p, now, cd, st) {
  const H = cfg(env, 'LIMIT_HOURS') * 3600e3, comeBack = (ms) => { const m = Math.ceil(ms / 60e3); return 'You have reached your cash out limit. Come back in ' + Math.floor(m / 60) + 'h ' + (m % 60) + 'm.'; };
  const claim = { bag_usd: p.bag_usd, bag_n: p.bag_n, paid_day: p.paid_day, paid_usd: p.paid_usd };
  const today = day(), paidToday = claim.paid_day === today ? claim.paid_usd : 0;
  let usd = Math.min(claim.bag_usd, cfg(env, 'MAX_CASHOUT_USD'), Math.max(0, cfg(env, 'WALLET_DAILY_USD') - paidToday));
  const refund = async (why, extra = {}) => { await unlockBag(env, w, st); return json(env, req, { ok: false, why, bag: await bagList(env, w), ...extra }); };
  if (usd < cfg(env, 'MIN_PAYOUT_USD')) return refund('You have hit today\'s payout limit for this wallet. It resets at midnight UTC.');

  // the whole game's daily budget, claimed the same way
  await env.DB.prepare('INSERT OR IGNORE INTO global (day, paid_usd) VALUES (?, 0)').bind(today).run();
  const g = await env.DB.prepare('UPDATE global SET paid_usd = paid_usd + ? WHERE day = ? AND paid_usd + ? <= ? RETURNING paid_usd').bind(usd, today, usd, cfg(env, 'GLOBAL_DAILY_USD')).first();
  if (!g) return refund('The mine has paid out its daily budget. Try again tomorrow (midnight UTC).');
  st.global = usd; const giveBack = async () => { await env.DB.prepare('UPDATE global SET paid_usd = paid_usd - ? WHERE day = ?').bind(st.global, today).run(); st.global = 0; };

  const price = await solPriceUsd(env), inWin = now - (p.win_start || 0) < H, winUsd = inWin ? p.win_sol || 0 : 0, winStart = inWin ? p.win_start : now;
  const room = cfg(env, 'WALLET_LIMIT_USD') - winUsd; let lamports = Math.floor((usd / price) * 1e9);
  if (usd > room) { const before = usd; await giveBack(); usd = Math.max(0, room); lamports = Math.floor((usd / price) * 1e9); await env.DB.prepare('INSERT OR IGNORE INTO global (day, paid_usd) VALUES (?, 0)').bind(today).run(); await env.DB.prepare('UPDATE global SET paid_usd = paid_usd + ? WHERE day = ?').bind(usd, today).run(); st.global = usd; await log(env, w, 'limit', { wanted: before, paid: usd }); }      // the hidden limit trims this payout to what is left
  if (usd < cfg(env, 'MIN_PAYOUT_USD')) { await giveBack(); await env.DB.prepare('UPDATE players SET lock_until = ? WHERE wallet = ?').bind(now + H, w).run(); return refund(comeBack(H)); }
  let tx; try {
    const { pub } = await payoutKey(env); const float = (await rpc(env, 'getBalance', [b58enc(pub), { commitment: 'confirmed' }])).value;
    const pend = (await env.DB.prepare("SELECT COALESCE(SUM(lamports), 0) AS l FROM payouts WHERE status = 'pending'").first()).l;      // SOL already promised to payouts still landing
    const avail = Math.floor(float - pend - cfg(env, 'FLOAT_FLOOR_SOL') * 1e9 - 20000);
    if (lamports > avail) {      // the treasury cannot cover the whole bag: pay the most it can, the rest stays in the player's bag
      const want = usd, cut = Math.max(0, avail), cutUsd = (cut / 1e9) * price;
      if (cutUsd < cfg(env, 'MIN_PAYOUT_USD')) { await giveBack(); await log(env, w, 'float_low', { float, pend, lamports }); return refund('The treasury is empty right now. Your bag is safe, try again later.'); }
      await giveBack(); lamports = cut; usd = cutUsd; await env.DB.prepare('UPDATE global SET paid_usd = paid_usd + ? WHERE day = ?').bind(usd, today).run(); st.global = usd; st.short = true;
      await log(env, w, 'treasury_short', { wanted: want, paid: usd });
    }
    // whole ores only, best first, as many as the amount allowed covers: the ones that do not fit stay in the bag exactly as they are
    let sum = 0; st.pick = []; for (const it of st.items) if (sum + it.usd <= usd + 1e-9) { st.pick.push(it); sum += it.usd; }
    if (sum < cfg(env, 'MIN_PAYOUT_USD')) { await giveBack(); return refund(st.short ? 'The treasury is empty right now. Your bag is safe, try again later.' : 'You have reached your cash out limit for now. Your bag is safe.'); }
    if (sum < usd - 1e-9) { await env.DB.prepare('UPDATE global SET paid_usd = MAX(0, paid_usd - ?) WHERE day = ?').bind(usd - sum, today).run(); st.global -= usd - sum; usd = sum; lamports = Math.floor((usd / price) * 1e9); if (!st.short && st.items.length > st.pick.length) st.limited = true; }
    lamports += 1 + (crypto.getRandomValues(new Uint16Array(1))[0] % 999);      // a few random lamports (a tiny fraction of a cent) so no two payouts are ever the same transaction
    tx = await buildTransfer(env, w, lamports);
  } catch (e) { await giveBack(); await log(env, w, 'error', { at: 'build', e: String(e.message) }); return refund('Payout failed to start. Your bag is safe, try again later.'); }

  // write it down BEFORE sending: the limits count it, and the ledger row is what the checker uses to finish it, retry it or give the ores back
  const leftover = claim.bag_usd - usd, sol = lamports / 1e9, winNow = winUsd + usd, hit = winNow >= cfg(env, 'WALLET_LIMIT_USD') - 0.005, ids = st.pick.map((i) => i.id);
  const ins = await env.DB.batch([
    env.DB.prepare('UPDATE players SET paid_day = ?, paid_usd = ?, total_sol = COALESCE(total_sol, 0) + ?, win_start = ?, win_sol = ?, lock_until = ? WHERE wallet = ?').bind(today, paidToday + usd, sol, winStart, winNow, hit ? now + H : (p.lock_until || 0), w),
    env.DB.prepare("INSERT INTO payouts (sig, sigs, wallet, t, day, usd, lamports, price, ores, lvh, attempt, status, busy_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?) RETURNING id").bind(tx.sig, tx.sig, w, now, today, usd, lamports, price, ids.length, tx.lvh, now + 90e3),
    env.DB.prepare('UPDATE bag_items SET payout = (SELECT id FROM payouts WHERE sig = ?) WHERE wallet = ? AND payout = ? AND id IN (SELECT value FROM json_each(?))').bind(tx.sig, w, st.lock, JSON.stringify(ids)),
    env.DB.prepare('UPDATE bag_items SET payout = NULL WHERE wallet = ? AND payout = ?').bind(w, st.lock),      // the ores this payout could not cover: back in the bag, unchanged
    recalcSQL(env, w),
  ]);
  st.recorded = true; const id = ins[1].results[0].id;
  try { await rpc(env, 'sendTransaction', [b64(tx.tx), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]); }
  catch (e) { await log(env, w, 'send_error', { id, e: String(e.message).slice(0, 200) }); }      // NOT treated as failed: it may still land. The checker decides.
  let status = 'pending';
  for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 1500)); try { const s = (await rpc(env, 'getSignatureStatuses', [[tx.sig]])).value[0]; if (s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) { status = 'confirmed'; break; } if (s?.err) break; } catch {} }
  await env.DB.prepare('UPDATE payouts SET status = ?, busy_until = 0 WHERE id = ? AND status = ?').bind(status, id, 'pending').run();
  if (status === 'confirmed') await env.DB.prepare('DELETE FROM bag_items WHERE payout = ?').bind(id).run();      // paid: those ores are sold and gone
  await log(env, w, status === 'confirmed' ? 'paid' : 'pending', { id, usd, sol, sig: tx.sig });
  const base = { usd, sol, signature: tx.sig, capped: leftover > 0.005 ? leftover : 0, capped_why: st.short ? 'treasury' : 'limit', kept: st.items.length - st.pick.length, next_cashout_ms: hit ? H : cd, limit_hit: hit, bag: await bagList(env, w) };
  if (status === 'confirmed') return json(env, req, { ok: true, status, ...base, why: hit ? comeBack(H) : undefined });
  return json(env, req, { ok: true, status: 'pending', ...base, why: 'Payout on its way. If the network drops it, it is sent again automatically, or your ores come back to your bag.' });
}

// ---------------- the checker: runs every minute (Cron Trigger) and finishes every payout that is still pending ----------------
// It only ever re-sends a payout after proving the last attempt can NEVER land (its blockhash has expired and it is not on chain),
// so a payout can never be paid twice. After MAX_ATTEMPTS dead attempts, the ores go back into the player's bag.
async function reconcile(env) {
  await bagTable(env);
  const now = Date.now(), rows = (await env.DB.prepare("SELECT id FROM payouts WHERE status = 'pending' AND COALESCE(busy_until, 0) < ? ORDER BY id LIMIT 10").bind(now).all()).results, done = [];
  for (const { id } of rows) {
    const r = await env.DB.prepare("UPDATE payouts SET busy_until = ? WHERE id = ? AND status = 'pending' AND COALESCE(busy_until, 0) < ? RETURNING *").bind(now + 50e3, id, now).first();      // only one checker works on a row
    if (!r) continue; let out = 'waiting';
    try { out = await settle(env, r); } catch (e) { out = 'error: ' + String(e.message).slice(0, 120); }      // RPC down: leave it pending (fails closed)
    await env.DB.prepare('UPDATE payouts SET busy_until = 0 WHERE id = ?').bind(id).run(); done.push({ id, out });
  }
  return done;
}
async function settle(env, r) {
  const s = (await rpc(env, 'getSignatureStatuses', [[r.sig], { searchTransactionHistory: true }])).value[0];
  if (s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) { await env.DB.batch([env.DB.prepare("UPDATE payouts SET status = 'confirmed' WHERE id = ?").bind(r.id), env.DB.prepare('DELETE FROM bag_items WHERE payout = ?').bind(r.id)]); await log(env, r.wallet, 'paid', { id: r.id, sig: r.sig, by: 'checker' }); return 'confirmed'; }
  if (s && !s.err) return 'landing';                                                                // seen but not confirmed yet
  if (!s) { const h = await rpc(env, 'getBlockHeight', [{ commitment: 'finalized' }]); if (h <= r.lvh) return 'waiting'; }      // could still land: wait
  // proven dead (expired and never landed, or landed with an error that moved nothing): safe to try again
  if (r.attempt >= cfg(env, 'MAX_ATTEMPTS')) {      // give the ores back and undo the limits it was counted against
    const p = await env.DB.prepare('SELECT * FROM players WHERE wallet = ?').bind(r.wallet).first(), sol = r.lamports / 1e9;
    await env.DB.batch([
      env.DB.prepare("UPDATE payouts SET status = 'returned' WHERE id = ? AND status = 'pending'").bind(r.id),
      env.DB.prepare('UPDATE players SET total_sol = MAX(0, total_sol - ?), win_sol = MAX(0, win_sol - ?), paid_usd = CASE WHEN paid_day = ? THEN MAX(0, paid_usd - ?) ELSE paid_usd END, lock_until = CASE WHEN win_sol - ? < ? THEN 0 ELSE lock_until END WHERE wallet = ?')
        .bind(sol, r.usd, r.day, r.usd, r.usd, cfg(env, 'WALLET_LIMIT_USD') - 0.005, r.wallet),
      env.DB.prepare('UPDATE bag_items SET payout = NULL WHERE payout = ?').bind(r.id),      // the very same ores go back in the bag
      recalcSQL(env, r.wallet),
      env.DB.prepare('UPDATE global SET paid_usd = MAX(0, paid_usd - ?) WHERE day = ?').bind(r.usd, r.day),
    ]);
    await log(env, r.wallet, 'returned', { id: r.id, usd: r.usd, attempts: r.attempt }); return 'returned';
  }
  if (await paused(env)) return 'paused';
  const { pub } = await payoutKey(env), float = (await rpc(env, 'getBalance', [b58enc(pub), { commitment: 'confirmed' }])).value;
  if (float - r.lamports < cfg(env, 'FLOAT_FLOOR_SOL') * 1e9) return 'float low';                     // waits for a top up; does not use up an attempt
  const tx = await buildTransfer(env, r.wallet, r.lamports);
  const upd = await env.DB.prepare("UPDATE payouts SET sig = ?, sigs = sigs || ',' || ?, lvh = ?, attempt = attempt + 1 WHERE id = ? AND status = 'pending' AND sig = ? RETURNING id").bind(tx.sig, tx.sig, tx.lvh, r.id, r.sig).first();      // write the new attempt down first
  if (!upd) return 'changed';
  try { await rpc(env, 'sendTransaction', [b64(tx.tx), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]); } catch (e) { await log(env, r.wallet, 'send_error', { id: r.id, e: String(e.message).slice(0, 200) }); }
  await log(env, r.wallet, 'retry', { id: r.id, attempt: r.attempt + 1, sig: tx.sig }); return 'retried';
}

export default {
  async scheduled(ev, env, ctx) { ctx.waitUntil(reconcile(env)); },      // Cron Trigger: * * * * *
  async fetch(req, env) {
    try { return await route(req, env); }
    catch (e) { console.log('ERR', e?.stack || e); return json(env, req, { error: 'server error' }, 500); }
  },
};


// ---------------- the rooms: everyone on the yacht and the islands together (one Durable Object per room, class Pond) ----------------
// Speaks the game's own protocol (hello / pos / chat / wear / hook / lost / land). The room picks every fish, times the fight,
// and puts a landed fish straight into the angler's bag. Players connect over a WebSocket at /ws?room=N.
const TICK_MS = 125, CLOTHES = new Set(GAME.clothes), POLES = GAME.poles, BAIT = GAME.bait;
const S_ = (v, n) => String(v ?? '').replace(/[<>]/g, '').slice(0, n);
const cleanName = (v) => String(v || '').replace(/[^\w .\-]/g, '').trim().slice(0, 16);
const SPECIES = ['frog', 'raccoon', 'dog', 'cat', 'fox', 'panda', 'wolf', 'bull', 'duck', 'shark'];
const num = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : 0);
let boardReady = false;
async function boardTable(env) { if (boardReady) return; await env.DB.prepare('CREATE TABLE IF NOT EXISTS board (k TEXT PRIMARY KEY, name TEXT, kg REAL, fish TEXT, t INTEGER)').run(); boardReady = true; }
export class Pond {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.live = new Map(); this.buck = new Map(); this.timer = null; this.nextId = 1; this.board = null;
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch {}
    for (const ws of ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (!a) continue; if (a.id >= this.nextId) this.nextId = a.id + 1; if (a.on) this.live.set(ws, a); }
    if (this.live.size) this.timer = setInterval(() => this.tick(), TICK_MS);
  }
  cast(o, except) { const s = JSON.stringify(o); for (const ws of this.live.keys()) if (ws !== except) { try { ws.send(s); } catch {} } }
  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch {} }
  pub(a) { return { id: a.id, name: a.name, sp: a.sp, look: a.look, worn: a.worn, x: a.x, z: a.z, f: a.f, st: a.st, lx: a.lx, lz: a.lz }; }
  save(ws, a) { try { ws.serializeAttachment({ id: a.id, on: a.on, w: a.w, name: a.name, sp: a.sp, look: a.look, worn: a.worn, x: a.x, z: a.z, f: a.f, st: 0, lx: 0, lz: 0, tier: a.tier, tierAt: a.tierAt }); } catch {} }
  async boardMsg() {      // the all-time top five biggest fish, shared by every room (kept in D1)
    if (!this.board || Date.now() - this.board.t > 5000) { await boardTable(this.env); const r = (await this.env.DB.prepare('SELECT k, name, kg, fish FROM board ORDER BY kg DESC LIMIT 10').all()).results; this.board = { t: Date.now(), rows: r }; }
    const byKey = new Map([...this.live.values()].map((a) => [a.w ? 'w:' + a.w : 'n:' + a.name, a.id]));
    return { t: 'board', rows: this.board.rows.map((e) => ({ id: byKey.get(e.k) || 0, name: e.name, kg: e.kg, fish: e.fish })) };
  }
  async tierOf(a) {      // which poles this angler's wallet unlocks (checked at most every 15 s)
    if (!a.w) return 0; if (a.tierAt && Date.now() - a.tierAt < 15e3) return a.tier || 0;
    try { a.tier = poleTier(this.env, await holdInfo(this.env, a.w)); a.tierAt = Date.now(); } catch {} return a.tier || 0;
  }
  async fetch(req) {
    const url = new URL(req.url); this.room = Number(url.searchParams.get('room')) || this.room || 1;
    if (url.pathname === '/stats') return Response.json({ online: this.live.size });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server); server.serializeAttachment({ id: this.nextId++, on: false });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 4000) return;
    let m; try { m = JSON.parse(raw); } catch { return; } if (!m || typeof m !== 'object') return;
    const a = this.live.get(ws) || ws.deserializeAttachment(); if (!a) return;
    let b = this.buck.get(a.id); if (!b) this.buck.set(a.id, b = { msg: 40, ch: 6, at: Date.now() });
    const now = Date.now(), dt = (now - b.at) / 1000; b.at = now; b.msg = Math.min(40, b.msg + dt * 40); b.ch = Math.min(6, b.ch + dt * 0.6);
    if (b.msg < 1) return; b.msg--;      // flood guard
    const sec = now / 1000;
    if (m.t === 'hello' || m.t === 'auth') {      // a signed-in wallet (session token from /login) ties this angler's catches to it
      if (typeof m.tk === 'string' && m.tk.length < 1000) { const w = await readToken(this.env, new Request('https://w/', { headers: { Authorization: 'Bearer ' + m.tk } })).catch(() => null); if (w && w !== a.w) { a.w = w; a.tierAt = 0; } }
      else if (m.t === 'auth' && !m.tk) a.w = '';
      if (m.t === 'auth' || a.on) { this.save(ws, a); if (a.on) this.send(ws, { t: 'tier', tier: await this.tierOf(a) }); return; }
      if (this.live.size >= cfg(this.env, 'ROOM_CAP')) { this.send(ws, { t: 'full' }); try { ws.close(4001, 'full'); } catch {} return; }
      for (const [o, oa] of this.live) if (a.w && oa.w === a.w) { this.send(o, { t: 'kick', why: 'You joined from somewhere else.' }); try { o.close(4002, 'replaced'); } catch {} this.bye(o); }      // one session per wallet
      Object.assign(a, { on: true, name: cleanName(m.name) || 'angler', sp: SPECIES.includes(m.sp) ? m.sp : 'frog',
        look: [/^[a-z]{1,10}$/.test(m.look?.[0]) ? m.look[0] : 'normal', /^[a-z]{1,10}$/.test(m.look?.[1]) ? m.look[1] : 'normal'], worn: {}, x: 0, z: 27.5, f: Math.PI, st: 0, lx: 0, lz: 0, d: 1 });
      this.live.set(ws, a); this.save(ws, a);
      this.send(ws, { t: 'welcome', id: a.id, room: this.room || 1, now: sec, solUsd: cfg(this.env, 'FISH_SOL_USD'), mode: 'live', players: [...this.live.values()].filter((o) => o !== a).map((o) => this.pub(o)), count: this.live.size, tier: await this.tierOf(a) });
      this.send(ws, await this.boardMsg());
      this.cast({ t: 'join', p: this.pub(a) }, ws); this.cast({ t: 'count', n: this.live.size });
      if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS); return;
    }
    if (!a.on) return;
    if (m.t === 'pos' && Array.isArray(m.p)) { const q = m.p; a.x = num(q[0], -200, 200); a.z = num(q[1], -200, 200); a.f = num(q[2], -10, 10); a.st = num(q[3], 0, 4) | 0; a.lx = num(q[4], -200, 200); a.lz = num(q[5], -200, 200); a.d = 1; return; }
    if (m.t === 'chat') { if (b.ch < 1) return; b.ch--; const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 90).replace(/[<>]/g, ''); if (text) this.cast({ t: 'chat', id: a.id, name: a.name, text }, ws); return; }
    if (m.t === 'wear') {      // clothes and bait are free; a pole only if the wallet's holding unlocks it
      const tier = await this.tierOf(a), w = {};
      for (const sl of ['hats', 'shirts', 'shoes', 'face']) { const id = m.worn?.[sl]; w[sl] = typeof id === 'string' && CLOTHES.has(id) ? id : null; }
      const pi = POLES.findIndex((p) => p.id === m.worn?.poles); w.poles = pi >= 0 && pi < tier ? POLES[pi].id : null;
      w.bait = BAIT.some((x) => x.id === m.worn?.bait) ? m.worn.bait : null;
      a.worn = w; this.save(ws, a); this.cast({ t: 'worn', id: a.id, worn: w }, ws); return;
    }
    if (m.t === 'hook') {      // a fish bites: the room decides which one
      if (a.pending || sec < (a.freeAt || 0)) return this.send(ws, { t: 'fish', no: 1 });
      const trip = tripAt(sec), zone = m.zone === 'sea' ? 'sea' : trip.docked && m.zone === trip.isle ? trip.isle : null;
      if (!zone) return this.send(ws, { t: 'fish', no: 1 });
      const tier = await this.tierOf(a), w = a.worn || {}, pole = POLES.find((p, i) => p.id === w.poles && i < tier) || {}, bait = BAIT.find((x) => x.id === w.bait) || {};
      const clothes = ['hats', 'shirts', 'shoes', 'face'].filter((sl) => w[sl]).length;
      const luck = (m.lucky ? GAME.lucky : 1) * (1 + GAME.luck * clothes + (pole.luck || 0) + (bait.luck || 0)), top = 1 + (pole.top || 0) + (bait.top || 0);
      const f = rollFish(luck, zone, top), heavy = (pole.heavy || 0) + (bait.heavy || 0);
      if (heavy && !f.trash) { const kg = f.kg * (1 + heavy); f.kg = kg >= 10 ? Math.round(kg) : Math.round(kg * 100) / 100; }
      const q = Number.isFinite(+m.q) ? Math.max(0.3, Math.min(1.15, +m.q)) : 1;      // cast + shake quality from the player (clamped)      // cast quality: a weak or late cast makes the catch pay less
      a.pending = { ...f, at: sec, q }; return this.send(ws, { t: 'fish', name: f.name, kg: f.kg });
    }
    if (m.t === 'lost') { if (a.pending) { a.pending = null; a.freeAt = sec + 1.5; } return; }
    if (m.t === 'land') {      // reeled in: into the bag
      const f = a.pending; if (!f) return; if (sec - f.at < 1.2 * GAME.fight[f.trash ? 0 : f.r]) return;      // nobody reels that fast
      a.pending = null; a.freeAt = sec + 1.5;
      const usd = Math.round(priceFish(this.env, f) * (f.q ?? 1) * 100) / 100; let res = { ok: false, why: a.w ? null : 'no wallet' };
      if (a.w && !f.trash) { try { await bagTable(this.env); res = await bankFish(this.env, a.w, f, usd); } catch (e) { res = { ok: false, why: 'error' }; console.log('bank', e?.message); } }
      this.send(ws, { t: 'banked', fish: f.name, kg: f.kg, priced: usd, ...res });
      this.cast({ t: 'catch', id: a.id, name: a.name, fish: f.name, kg: f.kg, usd: f.trash ? 0 : (res.ok ? res.usd : usd) }, ws);
      if (!f.trash) {      // the leaderboard: everyone's biggest fish
        await boardTable(this.env); const k = a.w ? 'w:' + a.w : 'n:' + a.name;
        const r = await this.env.DB.prepare('INSERT INTO board (k, name, kg, fish, t) VALUES (?, ?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET name = excluded.name, kg = excluded.kg, fish = excluded.fish, t = excluded.t WHERE excluded.kg > board.kg').bind(k, a.name, f.kg, f.name, now).run();
        if (r.meta.changes) { this.board = null; this.cast(await this.boardMsg()); }
      }
      return;
    }
  }
  tick() {      // eight times a second: who moved
    if (!this.live.size) { clearInterval(this.timer); this.timer = null; return; }
    const moved = []; for (const a of this.live.values()) if (a.d) { a.d = 0; moved.push([a.id, +a.x.toFixed(2), +a.z.toFixed(2), +a.f.toFixed(2), a.st, +a.lx.toFixed(1), +a.lz.toFixed(1)]); }
    if (moved.length) this.cast({ t: 's', p: moved });
  }
  bye(ws) { const a = this.live.get(ws); this.live.delete(ws); if (!a) return; this.buck.delete(a.id); if (a.on) { a.on = false; try { ws.serializeAttachment({ id: a.id, on: false }); } catch {} this.cast({ t: 'leave', id: a.id }); this.cast({ t: 'count', n: this.live.size }); } }
  async webSocketClose(ws) { this.bye(ws); try { ws.close(); } catch {} }
  async webSocketError(ws) { this.bye(ws); }
}
const pondStub = (env, r = 1) => env.POND.get(env.POND.idFromName('room' + r));
