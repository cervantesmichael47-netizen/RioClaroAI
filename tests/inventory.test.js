import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import {
  canonicalProductDisplayName,
  conflictingProductAttributes,
  equivalenceDefinitionForName,
  normalizeProductName,
} from '../server/data/product-normalization.js';

process.env.RIOCLARO_DATA_FILE = ':memory:';

const identities = {
  admin: { userId: 'inventory-test-admin', roles: ['Administrator'], branch: null },
  branchManager: { userId: 'inventory-test-manager', roles: ['BranchManager'], branch: 'Zapopan' },
  warehouse: { userId: 'inventory-test-warehouse', roles: ['Warehouse'], branch: 'Zapopan' },
  accountsPayable: { userId: 'inventory-test-ap', roles: ['AccountsPayable'], branch: null },
};

const tokenVerifier = async (token) => {
  if (!identities[token]) throw new Error('Invalid test token.');
  return identities[token];
};
const auth = (token) => ({ Authorization: `Bearer ${token}` });

test('normalizes units, keeps capacities distinct, and requires review before merging or invoice matching', async () => {
  assert.equal(normalizeProductName('  CLORO  '), normalizeProductName('Cloro'));
  assert.equal(normalizeProductName('  Clóro   1L '), normalizeProductName('Cloro 1 litro'));
  assert.equal(normalizeProductName('Cloro 1L'), normalizeProductName('Cloro 1000 ml'));
  assert.equal(normalizeProductName('Detergénte---LÍQUIDO  2 L'), 'detergente liquido 2 l');
  assert.equal(canonicalProductDisplayName('  CLORO  1000ml '), 'Cloro 1 L');
  assert.equal(normalizeProductName('Cloro 1,5 litros'), 'cloro 1p5 l');
  assert.equal(canonicalProductDisplayName('Jabon antibacterial 500ml'), 'Jabon Antibacterial 0.5 L');
  assert.equal(canonicalProductDisplayName('Limpiavidrios 750ml'), 'Limpiavidrios 0.75 L');
  assert.notEqual(normalizeProductName('Cloro 500 ml'), normalizeProductName('Cloro 1 L'));
  assert.notEqual(normalizeProductName('Cloro 5 L'), normalizeProductName('Cloro 1 L'));
  assert.notEqual(normalizeProductName('CLORO LITRO'), normalizeProductName('Cloro 1 L'));
  assert.equal(conflictingProductAttributes(
    { manufacturer: 'Marca A', composition: 'Hipoclorito' },
    { manufacturer: 'Marca B', composition: 'Amonio cuaternario' },
  ), true);
  assert.equal(
    equivalenceDefinitionForName('Blanqueador 1000ml')?.id,
    equivalenceDefinitionForName('CLORO LITRO')?.id,
  );
  assert.equal(equivalenceDefinitionForName('Blanqueador 500ml'), null);

  const { createApp } = await import('../server/app.js');
  const app = createApp({ tokenVerifier });
  const initialProducts = await request(app).get('/api/products').expect(200);
  assert.equal(initialProducts.body.origin, 'practice');
  assert.equal(initialProducts.body.items.length, 10);
  await request(app).get('/api/products').set('X-Data-Origin', 'operational').expect(401);
  const operationalProducts = await request(app).get('/api/products')
    .set(auth('admin')).set('X-Data-Origin', 'operational').expect(200);
  assert.deepEqual(operationalProducts.body.items, []);
  await request(app).get('/api/dashboard').set('X-Data-Origin', 'operational').expect(401);
  const operationalDashboard = await request(app).get('/api/dashboard')
    .set(auth('admin')).set('X-Data-Origin', 'operational').expect(200);
  assert.equal(operationalDashboard.body.productCount, 0);
  assert.equal(operationalDashboard.body.invoiceCount, 0);
  const candidates = initialProducts.body.items.filter((product) => product.reviewRequired);
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((product) => product.stock).sort((a, b) => a - b), [26, 32, 48]);
  const capacityAlias = await request(app).get('/api/products?search=Cloro%201%20litro').expect(200);
  assert.equal(capacityAlias.body.items.length, 1);
  assert.equal(capacityAlias.body.items[0].id, 1);
  assert.equal(capacityAlias.body.items[0].reviewRequired, true);

  const initialInvoices = await request(app).get('/api/invoices').set(auth('accountsPayable')).expect(200);
  const invoiceCandidate = await request(app).post('/api/invoices/product-match')
    .set(auth('accountsPayable'))
    .send({ detectedName: 'CLORO LITRO' })
    .expect(200);
  assert.equal(invoiceCandidate.body.product, null);
  assert.equal(invoiceCandidate.body.requiresHumanReview, true);
  assert.equal(invoiceCandidate.body.suggestedCanonicalName, 'Cloro 1 L');

  await request(app).post('/api/products').set(auth('admin'))
    .send({ name: 'Blanqueador 1000ml', category: 'Desinfectantes', branch: 'Guadalajara', stock: 5 })
    .expect(409);
  await request(app).post('/api/products/equivalences/confirm').set(auth('warehouse'))
    .send({ productIds: [1, 2, 3], evidence: 'Composición y fabricante verificados' })
    .expect(403);

  const confirmed = await request(app).post('/api/products/equivalences/confirm').set(auth('admin'))
    .send({ productIds: [1, 2, 3], evidence: 'Composición y fabricante verificados en envases' })
    .expect(200);
  assert.equal(confirmed.body.item.name, 'Cloro 1 L');
  assert.deepEqual(confirmed.body.item.sourceIds.sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(confirmed.body.item.branches.length, 3);
  assert.equal(confirmed.body.item.stock, undefined);
  assert.deepEqual(confirmed.body.item.branches.map(({ name, stock }) => ({ name, stock })), [
    { name: 'Guadalajara', stock: 48 },
    { name: 'León', stock: 26 },
    { name: 'Zapopan', stock: 32 },
  ]);
  const confirmedAgain = await request(app).post('/api/products/equivalences/confirm').set(auth('admin'))
    .send({ productIds: [1, 2, 3], evidence: 'Composición y fabricante verificados en envases' })
    .expect(200);
  assert.equal(confirmedAgain.body.item.stock, undefined);
  assert.equal(confirmedAgain.body.item.branches.length, 3);
  const audit = await request(app).get('/api/admin/audit').set(auth('admin')).expect(200);
  assert.ok(audit.body.items.some((event) =>
    event.type === 'product_equivalence_confirmed' && event.reason === 'source_ids:1,2,3',
  ));

  const canonicalProducts = await request(app).get('/api/products').expect(200);
  assert.equal(canonicalProducts.body.items.length, 8);
  const canonical = canonicalProducts.body.items.find((product) => product.name === 'Cloro 1 L');
  assert.equal(canonical.stock, undefined);
  assert.equal(canonical.branches.reduce((count, item) => count + item.stock, 0), 106);
  assert.deepEqual(canonical.sourceIds.sort((a, b) => a - b), [1, 2, 3]);
  const managerProducts = await request(app).get('/api/products').set(auth('branchManager')).expect(200);
  const managerCloro = managerProducts.body.items.find((product) => product.name === 'Cloro 1 L');
  assert.equal(managerCloro.stock, 32);
  assert.deepEqual(managerCloro.branches.map((branch) => branch.name), ['Zapopan']);

  const invoiceMatch = await request(app).post('/api/invoices/product-match')
    .set(auth('accountsPayable'))
    .send({ detectedName: 'CLORO LITRO' })
    .expect(200);
  assert.deepEqual(invoiceMatch.body.product, { id: 1, name: 'Cloro 1 L' });
  assert.equal(invoiceMatch.body.requiresHumanReview, false);
  const differentCapacity = await request(app).post('/api/invoices/product-match')
    .set(auth('accountsPayable'))
    .send({ detectedName: 'Cloro 500ml' })
    .expect(200);
  assert.equal(differentCapacity.body.product, null);
  assert.equal(differentCapacity.body.requiresHumanReview, true);

  await request(app).post('/api/products').set(auth('admin'))
    .send({ name: 'CLORO LITRO', category: 'Desinfectantes', branch: 'Guadalajara', stock: 5 })
    .expect(409);
  const canonicalAliasSearch = await request(app).get('/api/products?search=CLORO%201000%20ml').expect(200);
  assert.equal(canonicalAliasSearch.body.items.length, 1);
  assert.equal(canonicalAliasSearch.body.items[0].id, 1);
  await request(app).post('/api/products').set(auth('admin'))
    .send({ name: 'cloro 1 litro', category: 'Desinfectantes', branch: 'Guadalajara', stock: 5 })
    .expect(409);
  const finalInvoices = await request(app).get('/api/invoices').set(auth('accountsPayable')).expect(200);
  assert.equal(finalInvoices.body.items.length, initialInvoices.body.items.length);

  await request(app).post('/api/products').set(auth('admin')).set('X-Data-Origin', 'operational')
    .send({ name: 'Detergente operativo', category: 'Detergentes', branch: 'Guadalajara', stock: 3 })
    .expect(201);
  await request(app).post('/api/admin/practice/reset').set(auth('admin'))
    .send({ confirm: 'RESET_PRACTICE' }).expect(200);
  const resetPractice = await request(app).get('/api/products').expect(200);
  assert.deepEqual(resetPractice.body.items, []);
  const preservedOperational = await request(app).get('/api/products')
    .set(auth('admin')).set('X-Data-Origin', 'operational').expect(200);
  assert.equal(preservedOperational.body.items.length, 1);
});

test('stores operational records persistently and keeps them separate from practice records', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rioclaro-store-'));
  const previousDataFile = process.env.RIOCLARO_DATA_FILE;
  const dataFile = path.join(directory, 'records.json');
  process.env.RIOCLARO_DATA_FILE = dataFile;
  try {
    const firstStore = await import(`../server/data/store.js?persist=${Date.now()}`);
    firstStore.addProduct({
      name: 'Detergente especial 750 ml',
      category: 'Detergentes',
      branch: 'Guadalajara',
      stock: 7,
      origin: 'operational',
    });
    const reloadedStore = await import(`../server/data/store.js?persist=${Date.now() + 1}`);
    const operational = reloadedStore.listProducts({ origin: 'operational' });
    assert.equal(operational.length, 1);
    assert.equal(operational[0].stock, 7);
    assert.equal(reloadedStore.listProducts({ origin: 'practice' }).length, 10);
  } finally {
    if (previousDataFile === undefined) delete process.env.RIOCLARO_DATA_FILE;
    else process.env.RIOCLARO_DATA_FILE = previousDataFile;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema migration preserves records and references while building canonical identities without merging stock', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rioclaro-normalization-migration-'));
  const previousDataFile = process.env.RIOCLARO_DATA_FILE;
  const dataFile = path.join(directory, 'records.json');
  const data = {
    schemaVersion: 2,
    nextId: 10,
    products: [
      { id: 1, name: 'Cloro 1L', category: 'Desinfectantes', branch: 'Guadalajara', stock: 15, origin: 'practice' },
      { id: 2, name: 'CLORO 1000 ml', category: 'Desinfectantes', branch: 'Zapopan', stock: 10, origin: 'practice' },
      { id: 3, name: 'Cloro 5L', category: 'Desinfectantes', branch: 'León', stock: 4, origin: 'practice' },
      { id: 6, name: 'Desinfectante 1 L', category: 'Desinfectantes', branch: 'Querétaro', stock: 3, brand: 'Marca A', origin: 'practice' },
      { id: 7, name: 'Desinfectante 1 L', category: 'Desinfectantes', branch: 'Aguascalientes', stock: 5, brand: 'Marca B', origin: 'practice' },
      { id: 8, name: 'Desinfectante 1 L', category: 'Desinfectantes', branch: 'Guadalajara', stock: 7, brand: 'Marca C', composition: 'Hipoclorito', origin: 'practice' },
      { id: 9, name: 'Desinfectante 1 L', category: 'Desinfectantes', branch: 'León', stock: 9, brand: 'Marca C', composition: 'Amonio cuaternario', origin: 'practice' },
    ],
    invoices: [{
      id: 4,
      supplier: 'Proveedor de limpieza',
      reference: 'MIG-001',
      date: '2026-10-28',
      amount: 20,
      origin: 'practice',
      status: 'pending_review',
      items: [{ description: 'CLORO 1000 ml', quantity: 2, unitPrice: 10, productId: 2 }],
      history: [],
    }],
    inventoryMovements: [{
      id: 5,
      invoiceId: 4,
      invoiceItemIndex: 0,
      productId: 2,
      quantity: 2,
      branch: 'Zapopan',
      type: 'invoice_receipt',
      origin: 'practice',
      createdAt: '2026-10-28T12:00:00.000Z',
    }],
    equivalenceGroups: [
      ['practice:chlorine-1l', { confirmedProductIds: [], confirmedAt: null, reviewEvidenceProvided: false }],
      ['operational:chlorine-1l', { confirmedProductIds: [], confirmedAt: null, reviewEvidenceProvided: false }],
    ],
  };
  fs.writeFileSync(dataFile, JSON.stringify(data));
  process.env.RIOCLARO_DATA_FILE = dataFile;
  try {
    const migratedStore = await import(`../server/data/store.js?migration=${Date.now()}`);
    const normalized = migratedStore.listProducts({ origin: 'practice', search: 'cloro 1 litro' });
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].id, 1);
    assert.equal(normalized[0].reviewRequired, true);
    assert.equal(normalized[0].stock, undefined);
    assert.deepEqual(normalized[0].branches.map(({ name, stock }) => ({ name, stock })), [
      { name: 'Guadalajara', stock: 15 },
      { name: 'Zapopan', stock: 10 },
    ]);
    const conflictingProducts = migratedStore.listProducts({
      origin: 'practice',
      search: 'desinfectante 1 litro',
    });
    assert.equal(conflictingProducts.length, 4);
    assert.equal(new Set(conflictingProducts.map((product) => product.id)).size, 4);
    assert.ok(conflictingProducts.every((product) => product.reviewRequired));

    const detail = migratedStore.getProductDetails({
      productId: 1,
      origin: 'practice',
      includeInvoiceReferences: true,
    });
    assert.equal(detail.movements.length, 1);
    assert.equal(detail.movements[0].productId, 2);
    assert.equal(detail.invoiceReferences[0].reference, 'MIG-001');
    const migratedFile = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(migratedFile.schemaVersion, 3);
    assert.equal(migratedFile.products.find((product) => product.id === 1).stock, 15);
    assert.equal(migratedFile.products.find((product) => product.id === 2).stock, 10);
    assert.equal(migratedFile.products.find((product) => product.id === 2).canonicalProductId, 1);
    assert.equal(migratedFile.invoices[0].items[0].description, 'CLORO 1000 ml');
    assert.equal(migratedFile.invoices[0].items[0].productId, 2);
    assert.equal(migratedFile.inventoryMovements.length, 1);
    assert.equal(migratedFile.inventoryMovements[0].quantity, 2);
    assert.equal(migratedFile.normalizationMigrationReport.inventoryStocksConsolidated, false);
    assert.ok(fs.readdirSync(directory).some((file) => file.startsWith('records.json.backup-')));
  } finally {
    if (previousDataFile === undefined) delete process.env.RIOCLARO_DATA_FILE;
    else process.env.RIOCLARO_DATA_FILE = previousDataFile;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
