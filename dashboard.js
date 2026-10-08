// The payout dashboard, served at /dashboard. Asks for the admin key once, keeps it only in this browser tab.
export const DASH = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Liquidity Pool Fishing · Payouts</title>
<style>
:root{--bg:#0d0f14;--card:#161a22;--line:#262c38;--txt:#e8ebf2;--mut:#8a93a6;--ok:#19c37d;--warn:#f5b13d;--bad:#ff5d5d;--acc:#9b6bff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.45 Inter,system-ui,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
h1{font-size:17px;margin:0;margin-right:auto}h2{font-size:14px;margin:0 0 10px;color:var(--mut);text-transform:uppercase;letter-spacing:.08em}
button{font:600 13px Inter,system-ui;border:1px solid var(--line);background:var(--card);color:var(--txt);padding:8px 14px;border-radius:8px;cursor:pointer}
button.stop{background:#3a1518;border-color:#6b2328;color:#ffb3b3}button.go{background:#123524;border-color:#1f5c3d;color:#9ff0c8}
main{padding:20px;max-width:1300px;margin:0 auto}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:20px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.tile b{display:block;font-size:22px;margin-top:4px}.tile span{color:var(--mut);font-size:12px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:900px){.cols{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;overflow:auto;max-height:70vh}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--mut);font-weight:500;padding:6px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card)}
td{padding:6px;border-bottom:1px solid var(--line);white-space:nowrap}td.why{white-space:normal;color:var(--mut)}a{color:var(--acc);text-decoration:none}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600}.ok{background:#123524;color:var(--ok)}.pend{background:#3a2c10;color:var(--warn)}.bad{background:#3a1518;color:var(--bad)}.mut{background:#20242e;color:var(--mut)}
#state{font-weight:700}#login{max-width:360px;margin:15vh auto;text-align:center}#login input{width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--txt);margin:12px 0}
.note{color:var(--mut);font-size:12px}
</style></head><body>
<div id="login"><h1>Liquidity Pool Fishing · Payouts</h1><p class="note">Enter your ADMIN_KEY. It stays in this tab only.</p><input id="k" type="password" autocomplete="off"><button id="go">Open</button><p id="err" class="note"></p></div>
<div id="app" hidden><header><h1>Liquidity Pool Fishing · Payouts</h1><span id="state"></span><button id="pause"></button><button id="check">Run checker now</button><button id="wreset" class="stop">Reset leaderboard</button><button id="out">Lock</button></header>
<main><div class="tiles" id="tiles"></div><div class="cols">
<div class="card"><h2>Cash out requests</h2><table><thead><tr><th>Time</th><th>Wallet</th><th>Result</th><th>Amount</th><th>Why</th></tr></thead><tbody id="reqs"></tbody></table></div>
<div class="card"><h2>Payouts</h2><table><thead><tr><th>Time</th><th>Wallet</th><th>Status</th><th>SOL</th><th>$</th><th>Tries</th><th>Tx</th></tr></thead><tbody id="pays"></tbody></table></div>
</div><p class="note" id="upd"></p></main></div>
<script>
let KEY = sessionStorage.getItem('mine-admin') || '', D = null;
const $ = (id) => document.getElementById(id), el = (t, txt, cls) => { const e = document.createElement(t); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; };
const short = (w) => w ? w.slice(0, 4) + '…' + w.slice(-4) : '';
const link = (href, txt) => { const a = el('a', txt); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
const when = (t) => { const d = new Date(t); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
async function api(path, body) { const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'X-Admin-Key': KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (r.status === 403) throw new Error('Wrong admin key'); return j; }
function tile(label, val, sub) { const t = el('div', null, 'tile'); t.append(el('span', label), el('b', val)); if (sub) t.append(el('span', sub)); return t; }
function render() {
  const d = D, off = d.paused; $('state').textContent = off ? (d.envOff ? '■ PAUSED (PAYOUTS_ENABLED=false in Cloudflare)' : '■ PAYOUTS PAUSED') : '● PAYOUTS LIVE'; $('state').style.color = off ? 'var(--bad)' : 'var(--ok)';
  $('pause').textContent = off ? 'Resume payouts' : 'Pause all payouts'; $('pause').className = off ? 'go' : 'stop'; $('pause').disabled = d.envOff;
  const fl = typeof d.float_sol === 'number' ? d.float_sol : null;
  $('tiles').replaceChildren(
    tile('Payout wallet balance', fl == null ? 'error' : fl.toFixed(4) + ' SOL', fl == null ? String(d.float_sol || '').replace(/^error: /, '') : fl < d.floor_sol + 0.1 ? '⚠ top it up' : short(d.payout_wallet)),
    tile('Paid today', '$' + d.today_usd.toFixed(2), 'of $' + d.budget_usd + ' daily budget'),
    tile('Waiting to confirm', String(d.pending.n), (d.pending.lam / 1e9).toFixed(4) + ' SOL'),
    tile('Paid all time', (d.all_time.lam / 1e9).toFixed(4) + ' SOL', d.all_time.n + ' payouts · $' + d.all_time.usd.toFixed(2)));
  const bySig = {}, byId = {}; for (const p of d.payouts) { byId[p.id] = p.status; for (const g of String(p.sigs || p.sig || '').split(',')) if (g) bySig[g] = p.status; }      // what finally happened to each payout
  const rq = d.requests.map((e) => { let x = {}; try { x = JSON.parse(e.detail); } catch {} const tr = el('tr');
    let res, amt = '', why = '';
    if (e.kind === 'request') { const fin = x.ok && x.status === 'pending' ? bySig[x.sig] : null, st = fin || x.status;      // a payout that was pending when asked for shows how it ended
      res = x.ok ? el('span', st === 'confirmed' ? 'paid' : st === 'returned' ? 'fish returned' : st || 'ok', 'pill ' + (st === 'confirmed' ? 'ok' : st === 'returned' ? 'bad' : 'pend')) : el('span', 'refused', 'pill mut'); amt = x.usd != null && x.ok ? '$' + Number(x.usd).toFixed(2) : ''; why = fin === 'confirmed' ? 'confirmed after it was sent' : fin === 'returned' ? 'never landed: ores back in the bag' : x.why || ''; }
    else { const map = { returned: ['fish returned', 'bad'], retry: ['re-sent', 'pend'], float_low: ['wallet low', 'bad'], error: ['error', 'bad'], send_error: ['send error', 'pend'], paused: ['you paused', 'mut'], resumed: ['you resumed', 'mut'] }; const m = map[e.kind] || [e.kind, 'mut']; res = el('span', m[0], 'pill ' + m[1]); why = x.e || (x.attempts ? 'after ' + x.attempts + ' tries' : x.attempt ? 'try ' + x.attempt + (byId[x.id] === 'confirmed' ? ' · landed, paid' : '') : ''); if (x.usd) amt = '$' + Number(x.usd).toFixed(2); }
    const wc = el('td'); if (e.wallet && e.wallet !== 'admin') wc.append(link('https://solscan.io/account/' + e.wallet, short(e.wallet))); else wc.textContent = e.wallet || '';
    const rc = el('td'); rc.append(res); tr.append(el('td', when(e.t)), wc, rc, el('td', amt), el('td', why, 'why')); return tr; });
  $('reqs').replaceChildren(...(rq.length ? rq : [el('tr')]));
  const py = d.payouts.map((p) => { const tr = el('tr'), s = p.status, cls = s === 'confirmed' ? 'ok' : s === 'pending' ? 'pend' : 'bad', lbl = s === 'confirmed' ? 'paid' : s === 'returned' ? 'fish returned' : s;
    const wc = el('td'); wc.append(link('https://solscan.io/account/' + p.wallet, short(p.wallet))); const sc = el('td'); sc.append(el('span', lbl, 'pill ' + cls));
    const tc = el('td'); if (p.sig && s !== 'returned') tc.append(link('https://solscan.io/tx/' + p.sig, 'view'));
    tr.append(el('td', when(p.t)), wc, sc, el('td', (p.lamports / 1e9).toFixed(5)), el('td', Number(p.usd).toFixed(2)), el('td', String(p.attempt)), tc); return tr; });
  $('pays').replaceChildren(...py);
  $('upd').textContent = 'Updated ' + new Date().toLocaleTimeString() + ' · refreshes every 15 s';
}
async function load() { try { D = await api('/admin'); render(); } catch (e) { if (String(e.message).includes('admin key')) { KEY = ''; sessionStorage.removeItem('mine-admin'); show(); $('err').textContent = 'Wrong admin key'; } } }
function show() { $('login').hidden = !!KEY; $('app').hidden = !KEY; if (KEY) load(); }
$('go').onclick = () => { KEY = $('k').value.trim(); sessionStorage.setItem('mine-admin', KEY); show(); }; $('k').onkeydown = (e) => { if (e.key === 'Enter') $('go').click(); };
$('pause').onclick = async () => { const p = !D.paused; if (p && !confirm('Pause ALL payouts? Players keep their bags; nothing is lost.')) return; await api('/admin/pause', { paused: p }); load(); };
$('wreset').onclick = async () => { const t = prompt('Clear the all-time leaderboard (biggest fish)? Type RESET to confirm.'); if (t !== 'RESET') return; const r = await api('/admin/world-reset', {}); alert(r.ok ? 'Leaderboard cleared.' : 'Failed: ' + (r.error || 'unknown')); };
$('check').onclick = async () => { $('check').disabled = true; const r = await api('/admin/check', {}); $('check').disabled = false; alert((r.checked || []).length ? r.checked.map((c) => '#' + c.id + ': ' + c.out).join('\\n') : 'Nothing waiting. All payouts are settled.'); load(); };
$('out').onclick = () => { KEY = ''; sessionStorage.removeItem('mine-admin'); show(); };
show(); setInterval(() => { if (KEY && !document.hidden) load(); }, 15000);
</script></body></html>`;
