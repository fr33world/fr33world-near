// The public economy page: everything comes from /v1/economy, and text goes in as text.
/* global location, document */
const API =
  location.hostname === 'localhost'
    ? 'http://localhost:7410'
    : 'https://fr33world-api.onrender.com';
const SCAN = 'https://testnet.nearblocks.io';
const usdc = (micro) => `${(Number(micro) / 1e6).toFixed(2)} USDC`;
const when = (t) => new Date(t).toLocaleString();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function link(href, text) {
  const a = el('a', '', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

function row(parent, parts, tx) {
  const li = el('li');
  for (const p of parts) li.append(p);
  if (tx) li.append(' ', link(`${SCAN}/txns/${tx}`, 'proof'));
  parent.append(li);
}

async function load() {
  const state = document.getElementById('state');
  state.textContent = 'Waking the server, this can take a minute…';
  const r = await fetch(`${API}/v1/economy`);
  if (!r.ok) throw new Error(`The API answered ${r.status}`);
  const e = await r.json();
  state.textContent = e.businesses.length ? '' : 'The economy has not started yet.';

  const names = new Map(e.businesses.map((b) => [b.id, b.name]));
  const nameOf = (id) => names.get(id) ?? id;
  const goods = { water: 'Water', sandwich: 'Sandwich', meal: 'Hot Meal' };
  const goodOf = (id) => goods[id] ?? id;

  const cards = document.getElementById('businesses');
  for (const b of e.businesses) {
    const c = el('article', 'card');
    c.append(el('h3', '', b.name));
    c.append(el('div', 'balance', b.wallet ? usdc(b.wallet.balance) : 'unavailable'));
    if (b.wallet) c.append(el('div', 'small', `${usdc(b.wallet.reserved)} held for jobs`));
    const stock = e.stock
      .filter((s) => s.business === b.id)
      .map((s) => `${goodOf(s.good)} ${s.qty}`);
    c.append(el('div', 'small', `Stock: ${stock.join(', ')}`));
    c.append(el('div', 'small', `Markup ${Math.round(b.markup * 100)}%, target ${b.target}`));
    const a = el('div', 'small');
    a.append(link(`${SCAN}/address/${b.account}`, b.account));
    c.append(a);
    cards.append(c);
  }

  const decisions = document.getElementById('decisions');
  for (const d of e.decisions)
    row(decisions, [
      el('span', `tag ${d.source === 'ai' ? 'ai' : ''}`, d.source === 'ai' ? 'AI' : 'Rule'),
      `${nameOf(d.business)}: ${d.summary} `,
      el('span', 'small', when(d.at)),
    ]);

  const orders = document.getElementById('orders');
  for (const o of e.orders)
    row(
      orders,
      [
        `${nameOf(o.buyer)} paid ${nameOf(o.seller)} ${usdc(o.amount)} for ${o.qty} ${goodOf(o.good)} `,
        el('span', 'small', o.status),
      ],
      o.tx,
    );

  const jobs = document.getElementById('jobs');
  for (const j of e.jobs)
    row(jobs, [`${nameOf(j.business)}: ${usdc(j.amount)} `, el('span', 'small', j.status)], j.tx);
}

load().catch((err) => {
  document.getElementById('state').textContent = err.message;
});
