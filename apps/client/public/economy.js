// The public economy page: everything comes from /v1/economy, and text goes in as text.
/* global location, document */
const API =
  location.hostname === 'localhost'
    ? 'http://localhost:7410'
    : 'https://fr33world-api.onrender.com';
const SCAN = 'https://testnet.nearblocks.io';
const CARS = 'cars.fr33world.testnet';
const usdc = (micro) => `${(Number(micro) / 1e6).toFixed(2)} USDC`;
const dollars = (cents) => `$${Math.round(Number(cents) / 100).toLocaleString('en-US')}`;
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

  const cards = document.getElementById('businesses');
  for (const b of e.businesses) {
    const c = el('article', 'card');
    c.append(el('h3', '', b.name));
    c.append(el('div', 'balance', b.wallet ? usdc(b.wallet.balance) : 'unavailable'));
    c.append(
      el('div', 'small', 'Its own wallet: it can pay only the cars contract, within its limits'),
    );
    const a = el('div', 'small');
    a.append(link(`${SCAN}/address/${b.account}`, b.account));
    c.append(a);
    cards.append(c);
  }
  const deeds = el('article', 'card');
  deeds.append(el('h3', '', 'Cars owned on NEAR'));
  deeds.append(el('div', 'balance', String(e.deeds ?? 0)));
  deeds.append(el('div', 'small', 'Each one a title deed in its owner’s own wallet'));
  const d = el('div', 'small');
  d.append(link(`${SCAN}/address/${CARS}`, CARS));
  deeds.append(d);
  cards.append(deeds);

  const decisions = document.getElementById('decisions');
  if (e.decisions.length === 0) decisions.append(el('li', 'small', 'Nothing yet.'));
  for (const x of e.decisions)
    row(decisions, [
      el('span', `tag ${x.source === 'ai' ? 'ai' : ''}`, x.source === 'ai' ? 'AI' : 'Rule'),
      `${x.summary} `,
      el('span', 'small', when(x.at)),
    ]);

  const sales = document.getElementById('sales');
  if ((e.carSales ?? []).length === 0) sales.append(el('li', 'small', 'None yet.'));
  for (const s of e.carSales ?? [])
    row(
      sales,
      [
        `A ${s.car} for ${s.paidIn === 'usdc' ? usdc(s.amount) : dollars(s.amount)} `,
        el('span', 'small', when(s.at)),
      ],
      s.tx,
    );
}

load().catch((err) => {
  document.getElementById('state').textContent = err.message;
});
