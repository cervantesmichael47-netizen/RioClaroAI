import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('production anonymous CRUD stays on practice and persists changes without touching operational records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rioclaro-production-crud-'));
  const dataFile = path.join(directory, 'practice.json');
  const auditFile = path.join(directory, 'practice-audit.json');
  const conversationsFile = path.join(directory, 'practice-conversations.json');
  const originalData = {
    schemaVersion: 3,
    nextId: 100,
    products: [
      { id: 1, name: 'Producto practice existente', category: 'Prueba', branch: 'Guadalajara', stock: 2, origin: 'practice' },
      { id: 2, name: 'Producto operational privado', category: 'Privado', branch: 'Zapopan', stock: 90, origin: 'operational' },
    ],
    invoices: [
      { id: 3, supplier: 'Proveedor practice existente', reference: 'PRACTICE-001', date: '2026-10-28', amount: 10, origin: 'practice', status: 'pending_review', items: [], history: [] },
      { id: 4, supplier: 'Proveedor operational privado', reference: 'OPERATIONAL-001', date: '2026-10-28', amount: 900, origin: 'operational', status: 'pending_review', items: [], history: [] },
    ],
    complaints: [
      { id: 5, origin: 'operational', branch: 'Zapopan', customerName: 'Cliente operational privado', description: 'Caso privado.', category: 'Privado', status: 'pending', receivedAt: '2026-10-28T10:00:00.000Z', firstResponseAt: null, history: [] },
    ],
    inventoryMovements: [
      { id: 6, productId: 2, quantity: 90, branch: 'Zapopan', type: 'receipt', origin: 'operational', createdAt: '2026-10-28T10:00:00.000Z' },
    ],
    equivalenceGroups: [],
    canonicalProducts: [],
    normalizationReviews: [],
  };
  fs.writeFileSync(dataFile, JSON.stringify(originalData));

  const childScript = String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import request from 'supertest';

    const dataFile = process.env.RIOCLARO_DATA_FILE;
    const initialData = fs.readFileSync(dataFile, 'utf8');
    const originalDatabase = JSON.parse(initialData);
    const initialOperationalProduct = originalDatabase.products.find((item) => item.id === 2);
    const initialOperationalInvoice = originalDatabase.invoices.find((item) => item.id === 4);
    const initialOperationalComplaint = originalDatabase.complaints.find((item) => item.id === 5);
    const initialOperationalMovement = originalDatabase.inventoryMovements.find((item) => item.id === 6);
    const project = (item, fields) => Object.fromEntries(fields.map((field) => [field, item[field]]));
    const { createApp } = await import('./server/app.js');
    const app = createApp({ evaluationMode: true });
    assert.equal(fs.readFileSync(dataFile, 'utf8'), initialData, 'Production startup must not rewrite schemaVersion 3 data.');

    const headers = { 'X-Forwarded-Proto': 'https', 'X-Data-Origin': 'operational' };
    const send = (call) => call.set(headers);
    const createdProduct = await send(request(app).post('/api/products')).send({
      name: 'Producto público temporal',
      category: 'Prueba',
      branch: 'Guadalajara',
      stock: 2,
    }).expect(201);
    assert.equal(createdProduct.body.origin, 'practice');
    assert.equal(fs.readFileSync(dataFile + '.backup', 'utf8'), initialData);
    const productId = createdProduct.body.item.id;
    assert.ok((await send(request(app).get('/api/products?search=Producto%20p%C3%BAblico%20temporal')).expect(200))
      .body.items.some((item) => item.id === productId));
    await send(request(app).get('/api/products/' + productId)).expect(200);
    await send(request(app).patch('/api/products/' + productId)).send({
      name: 'Producto público actualizado',
      category: 'Prueba editada',
      branch: 'Guadalajara',
    }).expect(200);
    let persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(persisted.products.find((item) => item.id === productId).name, 'Producto público actualizado');
    const adjustedProduct = await send(request(app).post('/api/products')).send({
      name: 'Producto público con movimiento',
      category: 'Prueba',
      branch: 'Guadalajara',
      stock: 2,
    }).expect(201);
    const adjustedProductId = adjustedProduct.body.item.id;
    await send(request(app).patch('/api/products/' + adjustedProductId)).send({
      name: 'Producto público con movimiento',
      category: 'Prueba',
      branch: 'Guadalajara',
      stock: 7,
    }).expect(200);
    persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(persisted.products.find((item) => item.id === adjustedProductId).stock, 7);
    assert.ok(persisted.inventoryMovements.some((item) =>
      item.productId === adjustedProductId && item.origin === 'practice' && item.quantity === 5,
    ));
    assert.ok(fs.existsSync(dataFile + '.backup'));
    assert.equal(fs.existsSync(dataFile + '.' + process.pid + '.tmp'), false);
    const productDetails = await send(request(app).get('/api/products/' + adjustedProductId)).expect(200);
    assert.ok(productDetails.body.movements.some((item) => item.origin === 'practice' && item.quantity === 5));
    await send(request(app).delete('/api/products/' + productId)).expect(200);
    persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.ok(!persisted.products.some((item) => item.id === productId));
    assert.ok(persisted.products.some((item) => item.id === adjustedProductId));

    const createdInvoice = await send(request(app).post('/api/invoices')).send({
      supplier: 'Proveedor público temporal',
      reference: 'PUBLIC-CRUD-001',
      date: '2026-10-29',
      branch: 'Guadalajara',
      amount: 25,
      currency: 'MXN',
    }).expect(201);
    assert.equal(createdInvoice.body.origin, 'practice');
    const invoiceId = createdInvoice.body.item.id;
    assert.ok((await send(request(app).get('/api/invoices?search=PUBLIC-CRUD-001')).expect(200))
      .body.items.some((item) => item.id === invoiceId));
    await send(request(app).get('/api/invoices/' + invoiceId)).expect(200);
    await send(request(app).patch('/api/invoices/' + invoiceId)).send({
      supplier: 'Proveedor público actualizado',
      reference: 'PUBLIC-CRUD-002',
      date: '2026-10-30',
      branch: 'Zapopan',
      amount: 30,
      currency: 'USD',
    }).expect(200);
    persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(persisted.invoices.find((item) => item.id === invoiceId).supplier, 'Proveedor público actualizado');
    assert.equal(persisted.invoices.find((item) => item.id === invoiceId).currency, 'USD');
    await send(request(app).delete('/api/invoices/' + invoiceId)).expect(200);
    persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.ok(!persisted.invoices.some((item) => item.id === invoiceId));

    const createdComplaint = await send(request(app).post('/api/complaints')).send({
      branch: 'Guadalajara',
      customerName: 'Cliente practice temporal',
      description: 'Reclamación para prueba de persistencia.',
      category: 'Prueba',
    }).expect(201);
    assert.equal(createdComplaint.body.origin, 'practice');
    const complaintId = createdComplaint.body.item.id;
    assert.ok((await send(request(app).get('/api/complaints?branch=Guadalajara')).expect(200))
      .body.items.some((item) => item.id === complaintId));
    await send(request(app).get('/api/complaints/' + complaintId)).expect(200);
    await send(request(app).patch('/api/complaints/' + complaintId)).send({
      branch: 'Guadalajara',
      customerName: 'Cliente practice actualizado',
      description: 'Reclamación editada y persistida.',
      category: 'Seguimiento',
    }).expect(200);
    await send(request(app).post('/api/complaints/' + complaintId + '/status')).send({
      status: 'in_progress',
      note: 'Seguimiento de prueba.',
    }).expect(200);
    persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const persistedComplaint = persisted.complaints.find((item) => item.id === complaintId);
    assert.equal(persistedComplaint.origin, 'practice');
    assert.equal(persistedComplaint.customerName, 'Cliente practice actualizado');
    assert.equal(persistedComplaint.status, 'in_progress');
    assert.ok(persistedComplaint.history.some((item) => item.event === 'edited'));

    const dashboard = await send(request(app).get('/api/dashboard')).expect(200);
    assert.equal(dashboard.body.productCount, 2);
    assert.equal(dashboard.body.invoiceCount, 1);
    assert.equal(dashboard.body.origin, 'practice');
    const frontend = await send(request(app).get('/app.js')).expect(200);
    assert.doesNotMatch(frontend.text, /process\.env|FOUNDRY_PROJECT_ENDPOINT|ENTRA_CLIENT_SECRET|AZURE_WEBAPP_PUBLISH_PROFILE/);
    const practiceProducts = await send(request(app).get('/api/products')).expect(200);
    const practiceInvoices = await send(request(app).get('/api/invoices')).expect(200);
    const practiceComplaints = await send(request(app).get('/api/complaints')).expect(200);
    for (const response of [dashboard, practiceProducts, practiceInvoices, practiceComplaints]) {
      assert.equal(response.body.origin, 'practice');
      assert.ok(!JSON.stringify(response.body).includes('operational privado'));
    }

    await send(request(app).get('/api/products/2')).expect(404);
    await send(request(app).patch('/api/products/2')).send({
      name: 'Producto operational alterado',
      category: 'Privado',
      branch: 'Zapopan',
      stock: 1,
    }).expect(404);
    await send(request(app).delete('/api/products/2')).expect(404);
    await send(request(app).get('/api/invoices/4')).expect(404);
    await send(request(app).patch('/api/invoices/4')).send({
      supplier: 'Proveedor operational alterado',
      reference: 'OPERATIONAL-001',
      date: '2026-10-28',
      branch: 'Zapopan',
      amount: 1,
      currency: 'MXN',
    }).expect(404);
    await send(request(app).delete('/api/invoices/4')).expect(404);
    await send(request(app).get('/api/complaints/5')).expect(404);
    await send(request(app).patch('/api/complaints/5')).send({
      branch: 'Zapopan',
      customerName: 'Cliente operational alterado',
      description: 'Alteración no permitida.',
      category: 'Privado',
    }).expect(404);
    await send(request(app).post('/api/complaints/5/status')).send({ status: 'resolved' }).expect(404);
    await send(request(app).delete('/api/complaints/5')).expect(404);

    persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.deepEqual(project(persisted.products.find((item) => item.id === 2), ['id', 'name', 'category', 'branch', 'stock', 'origin']), project(initialOperationalProduct, ['id', 'name', 'category', 'branch', 'stock', 'origin']));
    assert.deepEqual(project(persisted.invoices.find((item) => item.id === 4), ['id', 'supplier', 'reference', 'date', 'amount', 'origin', 'status', 'items', 'history']), project(initialOperationalInvoice, ['id', 'supplier', 'reference', 'date', 'amount', 'origin', 'status', 'items', 'history']));
    assert.deepEqual(project(persisted.complaints.find((item) => item.id === 5), ['id', 'origin', 'branch', 'customerName', 'description', 'category', 'status', 'receivedAt', 'firstResponseAt', 'history']), project(initialOperationalComplaint, ['id', 'origin', 'branch', 'customerName', 'description', 'category', 'status', 'receivedAt', 'firstResponseAt', 'history']));
    assert.deepEqual(persisted.inventoryMovements.find((item) => item.id === 6), initialOperationalMovement);
    console.log(JSON.stringify({ origin: 'practice', productCrud: true, invoiceCrud: true, complaintUpdates: true, dashboard: true, movements: true, operationalUnchanged: true }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RIOCLARO_EVALUATION_MODE: 'true',
      RIOCLARO_DATA_FILE: dataFile,
      RIOCLARO_EVALUATION_DATA_FILE: dataFile,
      RIOCLARO_AUDIT_FILE: auditFile,
      RIOCLARO_EVALUATION_AUDIT_FILE: auditFile,
      FOUNDRY_CONVERSATIONS_FILE: conversationsFile,
      RIOCLARO_EVALUATION_CONVERSATIONS_FILE: conversationsFile,
    },
  });
  try {
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.deepEqual(JSON.parse(run.stdout), {
      origin: 'practice',
      productCrud: true,
      invoiceCrud: true,
      complaintUpdates: true,
      dashboard: true,
      movements: true,
      operationalUnchanged: true,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
