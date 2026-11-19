// Mengambil trade KOL dan smart money dari GMGN lewat gmgn-cli,
// lalu merangkumnya per token ke site/data/signals.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHAINS = (process.env.CHAINS || 'sol').split(',').map(s => s.trim()).filter(Boolean);
const WINDOW_MIN = Number(process.env.WINDOW_MIN || 60);
const CLUSTER_MIN = 30;
const KINDS = ['smartmoney', 'kol'];
const now = Math.floor(Date.now() / 1000);

const short = a => (a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a);

function parseJson(text) {
  const i = text.search(/[\[{]/);
  if (i < 0) throw new Error('output tidak berisi JSON');
  return JSON.parse(text.slice(i));
}

function toList(j) {
  if (Array.isArray(j)) return j;
  for (const v of [j?.list, j?.data?.list, j?.data]) if (Array.isArray(v)) return v;
  return [];
}

const status = {};
const rows = [];

for (const chain of CHAINS) {
  status[chain] = { trades: 0, errors: [] };
  for (const kind of KINDS) {
    try {
      const out = execFileSync(
        'gmgn-cli',
        ['track', kind, '--chain', chain, '--limit', '200', '--raw'],
        { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      for (const t of toList(parseJson(out))) {
        let ts = Number(t.timestamp);
        if (ts > 1e12) ts = Math.floor(ts / 1000);
        if (!t.base_address || !ts || ts < now - WINDOW_MIN * 60) continue;
        rows.push({
          chain, kind, ts,
          side: t.side,
          address: t.base_address,
          symbol: t.base_token?.symbol || '?',
          maker: t.maker,
          usd: Number(t.amount_usd) || 0,
          label: t.maker_info?.name || (t.maker_info?.twitter_username ? '@' + t.maker_info.twitter_username : ''),
        });
        status[chain].trades++;
      }
    } catch (e) {
      const msg = String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 160);
      status[chain].errors.push(`${kind}: ${msg}`);
      console.error(`[${chain}/${kind}] ${msg}`);
    }
  }
}

if (Object.values(status).every(s => s.errors.length === KINDS.length)) {
  console.error('Semua permintaan gagal. Cek API key, dan pastikan koneksi memakai IPv4.');
  process.exit(1);
}

const tokens = new Map();
for (const r of rows) {
  const key = `${r.chain}:${r.address}`;
  let t = tokens.get(key);
  if (!t) {
    t = {
      chain: r.chain, address: r.address, symbol: r.symbol,
      buy: { smartmoney: new Map(), kol: new Map() },
      sell: { smartmoney: new Set(), kol: new Set() },
      usd: 0, first: Infinity, last: 0,
    };
    tokens.set(key, t);
  }
  if (r.side === 'buy') {
    const m = t.buy[r.kind];
    const w = m.get(r.maker) || { label: r.label || short(r.maker), usd: 0, ts: r.ts };
    w.usd += r.usd;
    w.ts = Math.max(w.ts, r.ts);
    m.set(r.maker, w);
    t.usd += r.usd;
    t.first = Math.min(t.first, r.ts);
    t.last = Math.max(t.last, r.ts);
  } else if (r.side === 'sell') {
    t.sell[r.kind].add(r.maker);
  }
}

const RANK = { very_strong: 4, strong: 3, medium: 2, weak: 1 };
const signals = [];

for (const t of tokens.values()) {
  const smart = t.buy.smartmoney.size;
  const kol = t.buy.kol.size;
  if (!smart && !kol) continue;
  const smart30 = [...t.buy.smartmoney.values()].filter(w => w.ts >= now - CLUSTER_MIN * 60).length;

  let strength = 'weak';
  if (smart30 >= 3 && kol >= 1) strength = 'very_strong';
  else if (smart30 >= 3) strength = 'strong';
  else if (smart >= 2) strength = 'medium';

  const buyers = [
    ...[...t.buy.smartmoney.values()].map(w => ({ tag: 'smart', label: w.label, usd: Math.round(w.usd) })),
    ...[...t.buy.kol.values()].map(w => ({ tag: 'kol', label: w.label, usd: Math.round(w.usd) })),
  ].sort((a, b) => b.usd - a.usd).slice(0, 5);

  signals.push({
    chain: t.chain, address: t.address, symbol: t.symbol, strength,
    smart, kol, smart30,
    smartSells: t.sell.smartmoney.size, kolSells: t.sell.kol.size,
    usd: Math.round(t.usd), first: t.first, last: t.last, buyers,
  });
}

signals.sort((a, b) => RANK[b.strength] - RANK[a.strength] || b.smart - a.smart || b.usd - a.usd);

mkdirSync('site/data', { recursive: true });
writeFileSync('site/data/signals.json', JSON.stringify({
  updatedAt: now, windowMin: WINDOW_MIN, clusterMin: CLUSTER_MIN, chains: status, signals: signals.slice(0, 100),
}));
console.log(`OK: ${signals.length} token, ${rows.length} trade dalam ${WINDOW_MIN} menit.`);
