import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.RIOCLARO_DATA_FILE = ':memory:';

const identities = {
  admin: { userId: 'invoice-workflow-admin', roles: ['Administrator'], branch: null },
  accountsPayable: { userId: 'invoice-workflow-ap', roles: ['AccountsPayable'], branch: null },
};
const tokenVerifier = async (token) => {
  if (!identities[token]) throw new Error('Invalid test token.');
  return identities[token];
};
const auth = (token) => ({ Authorization: `Bearer ${token}` });

test('invoice review links products and posts inventory once only after confirmation', async () => {
  const { createApp } = await import('../server/app.js');
  const { listInventoryMovements, listProducts } = await import('../server/data/store.js');
  const app = createApp({ tokenVerifier });
  const invoice = {
    supplier: 'Proveedor de limpieza',
    reference: 'FLOW-2026-001',
    date: '2026-10-25',
    amount: 20,
    branch: 'Aguascalientes',
    items: [{ description: 'Cloro 1 L', quantity: 2, unitPrice: 10 }],
  };
  const before = listProducts({ origin: 'practice' })
    .find((product) => product.id === 1);
  const created = await request(app).post('/api/invoices').set(auth('accountsPayable'))
    .send(invoice).expect(201);
  assert.equal(created.body.item.status, 'pending_review');
  assert.equal(created.body.item.items[0].productId, null);
  assert.equal(created.body.item.items[0].requiresHumanReview, true);
  assert.equal(listInventoryMovements('practice').length, 0);

  const linked = await request(app).post(`/api/invoices/${created.body.item.id}/items/0/match`)
    .set(auth('accountsPayable'))
    .send({ productId: 1, evidence: 'Se compararon descripción y presentación del artículo.' })
    .expect(200);
  assert.equal(linked.body.item.items[0].productId, 1);
  assert.ok(linked.body.item.history.some((entry) => entry.status === 'product_match_confirmed'));

  const confirmed = await request(app).post(`/api/invoices/${created.body.item.id}/review`)
    .set(auth('accountsPayable'))
    .send({ decision: 'confirm', evidence: 'Factura original y recepción física revisadas.' })
    .expect(200);
  assert.equal(confirmed.body.item.status, 'confirmed');
  assert.equal(listInventoryMovements('practice').length, 1);
  const received = listProducts({ origin: 'practice' }).find((product) =>
    product.branches.some((branch) => branch.name === 'Aguascalientes' && branch.stock === 2),
  );
  assert.ok(received);
  assert.equal(received.stock, undefined);
  assert.equal(received.branches.find((branch) => branch.name === 'Aguascalientes').stock, 2);
  assert.equal(received.branches.find((branch) => branch.name === 'Guadalajara').stock, 48);

  await request(app).post(`/api/invoices/${created.body.item.id}/review`)
    .set(auth('accountsPayable'))
    .send({ decision: 'confirm', evidence: 'Intento de contabilización repetida.' })
    .expect(409);
  const duplicate = await request(app).post('/api/invoices').set(auth('accountsPayable'))
    .send(invoice).expect(200);
  assert.equal(duplicate.body.created, false);
  assert.equal(listInventoryMovements('practice').length, 1);

  const detail = await request(app).get(`/api/invoices/${created.body.item.id}`)
    .set(auth('accountsPayable')).expect(200);
  assert.equal(detail.body.item.status, 'confirmed');
  assert.equal(detail.body.item.history.at(-1).status, 'confirmed');
  assert.equal(before.stock, 48);
});

test('possible invoice folios require an explicit human distinction or rejection', async () => {
  const { createApp } = await import('../server/app.js');
  const app = createApp({ tokenVerifier });
  const invoice = {
    supplier: 'Proveedor con folio repetido',
    reference: 'DUP-2026-001',
    date: '2026-10-25',
    amount: 125,
  };
  const first = await request(app).post('/api/invoices').set(auth('accountsPayable'))
    .send(invoice).expect(201);
  const second = await request(app).post('/api/invoices').set(auth('accountsPayable'))
    .send({ ...invoice, date: '2026-10-26', amount: 126 }).expect(201);
  assert.equal(second.body.possibleDuplicate, true);
  await request(app).post(`/api/invoices/${second.body.item.id}/review`)
    .set(auth('accountsPayable'))
    .send({ decision: 'confirm', evidence: 'Se revisó el documento presentado.' })
    .expect(409);
  const confirmedDistinct = await request(app).post(`/api/invoices/${second.body.item.id}/review`)
    .set(auth('accountsPayable'))
    .send({ decision: 'confirm_distinct', evidence: 'Folio igual; documento y fecha diferentes.' })
    .expect(200);
  assert.equal(confirmedDistinct.body.item.status, 'confirmed');
  assert.equal(first.body.item.status, 'pending_review');
});

test('invoice currency is preserved and same-value invoices in different currencies are not exact duplicates', async () => {
  const { createApp } = await import('../server/app.js');
  const app = createApp({ tokenVerifier });
  const invoice = {
    supplier: 'Proveedor internacional',
    reference: 'FX-2026-001',
    date: '2026-10-25',
    amount: 25,
    currency: 'MXN',
  };
  const pesoInvoice = await request(app).post('/api/invoices').set(auth('accountsPayable'))
    .send(invoice).expect(201);
  const dollarInvoice = await request(app).post('/api/invoices').set(auth('accountsPayable'))
    .send({ ...invoice, currency: 'USD' }).expect(201);
  assert.notEqual(dollarInvoice.body.item.id, pesoInvoice.body.item.id);
  assert.equal(dollarInvoice.body.item.currency, 'USD');
  assert.equal(dollarInvoice.body.created, true);
  assert.equal(dollarInvoice.body.possibleDuplicate, true);

  await request(app).post('/api/invoices').set(auth('accountsPayable'))
    .send({ ...invoice, currency: 'CAD' }).expect(400);
});
