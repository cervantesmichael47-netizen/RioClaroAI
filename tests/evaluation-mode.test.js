import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

process.env.RIOCLARO_DATA_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const adminToken = 'evaluation-test-admin';
const tokenVerifier = async (token) => {
  if (token !== adminToken) throw new Error('Invalid test token.');
  return { userId: 'evaluation-test-admin', roles: ['Administrator'], branch: null };
};
const auth = { Authorization: `Bearer ${adminToken}` };

async function createApp(options = {}) {
  const { createApp: factory } = await import('../server/app.js');
  return factory({ tokenVerifier, ...options });
}

test('production practice data path is canonical and conflicting environment variables are rejected', async () => {
  const { resolvePracticeDataFile } = await import('../server.js');
  const productionPath = '/home/rioclaro-data/rioclaro-data.json';
  assert.equal(resolvePracticeDataFile('C:\\app', {
    NODE_ENV: 'production',
    RIOCLARO_DATA_FILE: productionPath,
    RIOCLARO_EVALUATION_DATA_FILE: productionPath,
  }), productionPath);
  assert.equal(resolvePracticeDataFile('C:\\app', {
    NODE_ENV: 'production',
    RIOCLARO_DATA_FILE: productionPath,
  }), productionPath);
  assert.throws(() => resolvePracticeDataFile('C:\\app', {
    NODE_ENV: 'production',
    RIOCLARO_DATA_FILE: productionPath,
    RIOCLARO_EVALUATION_DATA_FILE: 'C:\\home\\other.json',
  }), /deben apuntar a \/home\/rioclaro-data\/rioclaro-data\.json/);
  assert.equal(resolvePracticeDataFile('C:\\app', {
    NODE_ENV: 'test',
    RIOCLARO_DATA_FILE: 'C:\\data\\primary.json',
    RIOCLARO_EVALUATION_DATA_FILE: 'C:\\data\\secondary.json',
  }), 'C:\\data\\primary.json');
});

test('root serves the dashboard without cookies, login, or a profile picker', async () => {
  const app = await createApp({ evaluationMode: true });
  const page = await request(app).get('/').expect(200);
  assert.match(page.text, /class="page-view active" id="page-inicio"/);
  assert.match(page.text, /class="origin-select-label" hidden/);
  for (const pageId of ['inventario', 'facturas', 'reclamaciones', 'asistente', 'documentacion', 'responsable', 'acerca']) {
    assert.match(page.text, new RegExp(`id="page-${pageId}"`));
  }
  assert.match(page.text, /Proveedores y clientes/);
  assert.match(page.text, /El dashboard incluye solo ventas sintéticas de demostración/);
  assert.match(page.text, /id="chat-mic-button"/);
  assert.match(page.text, /id="chat-input"[^]*id="chat-mic-button"/);
  assert.doesNotMatch(page.text, /inventory-mic-button|inventory-query-input/);
  assert.doesNotMatch(page.text, /Iniciar sesión|Entrar como evaluador|Selecciona un perfil|Crear cuenta/i);
  assert.equal(page.headers['set-cookie'], undefined);
});

test('production evaluation mode refuses the default shared data file', async () => {
  const previous = {
    environment: process.env.NODE_ENV,
    dataFile: process.env.RIOCLARO_DATA_FILE,
    evaluationFile: process.env.RIOCLARO_EVALUATION_DATA_FILE,
  };
  process.env.NODE_ENV = 'production';
  const defaultDataFile = path.resolve('server', 'data', 'rioclaro-data.json');
  process.env.RIOCLARO_DATA_FILE = defaultDataFile;
  process.env.RIOCLARO_EVALUATION_DATA_FILE = defaultDataFile;
  try {
    await assert.rejects(createApp({ evaluationMode: true }), /archivo de persistencia dedicado/);
    process.env.RIOCLARO_DATA_FILE = ':memory:';
    process.env.RIOCLARO_EVALUATION_DATA_FILE = path.join(path.dirname(defaultDataFile), 'evaluation.json');
    await assert.rejects(createApp({ evaluationMode: true }), /archivo de persistencia dedicado/);
  } finally {
    for (const [key, value] of Object.entries({
      NODE_ENV: previous.environment,
      RIOCLARO_DATA_FILE: previous.dataFile,
      RIOCLARO_EVALUATION_DATA_FILE: previous.evaluationFile,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('evaluation requests are pinned to synthetic practice data and cannot grant admin roles', async () => {
  const normalApp = await createApp();
  const operationalProduct = await request(normalApp).post('/api/products')
    .set(auth)
    .set('X-Data-Origin', 'operational')
    .send({ name: 'Producto Operativo Privado', category: 'Evaluación', branch: 'Zapopan', stock: 7 })
    .expect(201);
  assert.equal(operationalProduct.body.origin, 'operational');

  const evaluationApp = await createApp({ evaluationMode: true });
  const status = await request(evaluationApp).get('/api/security/status').expect(200);
  assert.equal(status.body.evaluationMode, true);

  const products = await request(evaluationApp).get('/api/products')
    .set('X-Data-Origin', 'operational').expect(200);
  assert.equal(products.body.origin, 'practice');
  assert.ok(products.body.items.every((product) => product.origin === 'practice'));
  assert.ok(products.body.items.every((product) => product.name !== 'Producto Operativo Privado'));

  const created = await request(evaluationApp).post('/api/products')
    .set('X-Data-Origin', 'operational')
    .send({
      name: 'Producto Sintético del Evaluador',
      category: 'Prueba',
      branch: 'Zapopan',
      stock: 3,
      role: 'Administrator',
    })
    .expect(201);
  assert.equal(created.body.origin, 'practice');

  const confirmedOrigin = await request(evaluationApp).get('/api/products')
    .set('X-Data-Origin', 'nonsense').expect(200);
  assert.equal(confirmedOrigin.body.origin, 'practice');
  assert.ok(confirmedOrigin.body.items.some((product) => product.normalizedName === 'producto sintetico del evaluador'));

  await request(evaluationApp).post('/api/admin/ai-control').send({ enabled: false }).expect(401);
  await request(evaluationApp).get('/api/admin/audit').expect(401);
  await request(evaluationApp).post('/api/admin/practice/reset')
    .send({ confirm: 'RESET_PRACTICE', role: 'Administrator' }).expect(401);

  const operationalStillSeparate = await request(normalApp).get('/api/products')
    .set(auth)
    .set('X-Data-Origin', 'operational').expect(200);
  assert.ok(operationalStillSeparate.body.items.some((product) => product.name === 'Producto Operativo Privado'));
  assert.ok(operationalStillSeparate.body.items.every((product) => product.name !== 'Producto Sintético del Evaluador'));
});

test('evaluation complaints persist with their history and invoice writes stay in practice', async () => {
  const evaluationApp = await createApp({ evaluationMode: true });
  const created = await request(evaluationApp).post('/api/complaints')
    .set('X-Data-Origin', 'operational')
    .send({
      branch: 'Zapopan',
      customerName: 'Cliente sintético',
      description: 'Caso de evaluación independiente.',
      category: 'Prueba',
    })
    .expect(201);
  assert.equal(created.body.origin, 'practice');

  const updated = await request(evaluationApp).post(`/api/complaints/${created.body.item.id}/status`)
    .set('X-Data-Origin', 'operational')
    .send({ status: 'in_progress' }).expect(200);
  assert.equal(updated.body.item.history.length, 2);
  assert.equal(updated.body.item.history[1].actor, 'system');

  const detail = await request(evaluationApp).get(`/api/complaints/${created.body.item.id}`)
    .set('X-Data-Origin', 'operational').expect(200);
  assert.equal(detail.body.item.origin, 'practice');
  assert.equal(detail.body.item.history.length, 2);
  const editedComplaint = await request(evaluationApp).patch(`/api/complaints/${created.body.item.id}`)
    .set('X-Data-Origin', 'operational')
    .send({
      branch: 'Zapopan',
      customerName: 'Cliente sintético actualizado',
      description: 'Caso de evaluación independiente actualizado.',
      category: 'Seguimiento',
    }).expect(200);
  assert.equal(editedComplaint.body.item.customerName, 'Cliente sintético actualizado');
  assert.equal(editedComplaint.body.item.history.at(-1).event, 'edited');

  const invoice = await request(evaluationApp).post('/api/invoices')
    .set('X-Data-Origin', 'operational')
    .send({
      supplier: 'Proveedor sintético',
      reference: 'EVAL-2026-001',
      date: '2026-10-29',
      amount: 25,
    })
    .expect(201);
  assert.equal(invoice.body.origin, 'practice');
  assert.equal((await request(evaluationApp).get('/api/invoices').expect(200)).body.origin, 'practice');
  const editedInvoice = await request(evaluationApp).patch(`/api/invoices/${invoice.body.item.id}`)
    .set('X-Data-Origin', 'operational')
    .send({
      supplier: 'Proveedor sintético actualizado',
      reference: 'EVAL-2026-002',
      date: '2026-10-30',
      branch: 'Zapopan',
      amount: 25,
      currency: 'MXN',
    }).expect(200);
  assert.equal(editedInvoice.body.item.supplier, 'Proveedor sintético actualizado');
  assert.equal(editedInvoice.body.item.history.at(-1).event, 'edited');
});

test('evaluation complaint data survives a server restart in its dedicated files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rioclaro-evaluation-'));
  const dataFile = path.join(directory, 'evaluation-data.json');
  const auditFile = path.join(directory, 'evaluation-audit.json');
  const conversationsFile = path.join(directory, 'evaluation-conversations.json');
  const childScript = [
    "const { createApp } = await import('./server/app.js');",
    "const request = (await import('supertest')).default;",
    'const app = createApp();',
    "if (process.env.EVAL_TEST_ACTION === 'create') {",
    "  const response = await request(app).post('/api/complaints').set('X-Data-Origin', 'operational').send({",
    "    branch: 'Zapopan', customerName: 'Cliente de persistencia', description: 'Caso sintético persistente.', category: 'Prueba'",
    '  });',
    '  if (response.status !== 201) throw new Error(JSON.stringify(response.body));',
    '  console.log(JSON.stringify({ id: response.body.item.id, origin: response.body.origin }));',
    '} else {',
    "  const response = await request(app).get('/api/complaints?branch=Zapopan').set('X-Data-Origin', 'operational');",
    '  if (response.status !== 200) throw new Error(JSON.stringify(response.body));',
    "  const item = response.body.items.find((complaint) => complaint.customerName === 'Cliente de persistencia');",
    '  if (!item) throw new Error("Persisted evaluation complaint was not found.");',
    '  console.log(JSON.stringify({ origin: response.body.origin, status: item.status, history: item.history.length }));',
    '}',
  ].join('\n');
  const run = (action) => spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RIOCLARO_EVALUATION_MODE: 'true',
      RIOCLARO_DATA_FILE: dataFile,
      RIOCLARO_EVALUATION_DATA_FILE: dataFile,
      RIOCLARO_AUDIT_FILE: auditFile,
      RIOCLARO_EVALUATION_AUDIT_FILE: auditFile,
      FOUNDRY_CONVERSATIONS_FILE: conversationsFile,
      RIOCLARO_EVALUATION_CONVERSATIONS_FILE: conversationsFile,
      EVAL_TEST_ACTION: action,
    },
  });
  try {
    const created = run('create');
    assert.equal(created.status, 0, created.stderr || created.stdout);
    assert.equal(JSON.parse(created.stdout).origin, 'practice');

    const restored = run('read');
    assert.equal(restored.status, 0, restored.stderr || restored.stdout);
    assert.deepEqual(JSON.parse(restored.stdout), {
      origin: 'practice',
      status: 'pending',
      history: 1,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Foundry receives only practice inventory in evaluation mode', async () => {
  const previous = {
    enabled: process.env.FOUNDRY_ENABLED,
    endpoint: process.env.FOUNDRY_PROJECT_ENDPOINT,
    agent: process.env.FOUNDRY_AGENT_NAME,
    suspended: process.env.FOUNDRY_SUSPENDED,
  };
  process.env.FOUNDRY_ENABLED = 'true';
  process.env.FOUNDRY_PROJECT_ENDPOINT = 'https://rioclaro.services.ai.azure.com/api/projects/evaluation';
  process.env.FOUNDRY_AGENT_NAME = 'RioClaroAssistant';
  delete process.env.FOUNDRY_SUSPENDED;
  const received = [];
  try {
    const normalApp = await createApp();
    await request(normalApp).post('/api/products').set(auth).set('X-Data-Origin', 'operational')
      .send({ name: 'Producto Privado No Compartir', category: 'Privada', branch: 'Zapopan', stock: 1 })
      .expect(201);
    const evaluationApp = await createApp({
      evaluationMode: true,
      foundryClient: async (_message, options) => {
        received.push(options.applicationContext);
        return { answer: 'Respuesta de prueba.', sources: [] };
      },
    });
    await request(evaluationApp).post('/api/chat')
      .set('X-Data-Origin', 'operational')
      .set('X-Chat-Session', '825cb746-6e65-4e31-b9f3-52f5aac1d762')
      .send({ message: '¿Qué productos sintéticos hay?' })
      .expect(200);
    assert.equal(received[0].origin, 'practice');
    assert.ok(received[0].inventory.records.every((product) => product.origin === undefined || product.origin === 'practice'));
    assert.ok(!JSON.stringify(received[0]).includes('Producto Privado No Compartir'));
  } finally {
    for (const [key, value] of Object.entries({
      FOUNDRY_ENABLED: previous.enabled,
      FOUNDRY_PROJECT_ENDPOINT: previous.endpoint,
      FOUNDRY_AGENT_NAME: previous.agent,
      FOUNDRY_SUSPENDED: previous.suspended,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('public demo permanently deletes only synthetic records and protects inventory history', async () => {
  const app = await createApp({ evaluationMode: true });
  const originHeader = { 'X-Data-Origin': 'operational' };

  const product = await request(app).post('/api/products').set(originHeader).send({
    name: 'Producto sintético para eliminar',
    category: 'Prueba',
    branch: 'Guadalajara',
    stock: 5,
  }).expect(201);
  const productId = product.body.item.id;
  assert.equal(product.body.origin, 'practice');
  const updatedProduct = await request(app).patch(`/api/products/${productId}`)
    .set(originHeader)
    .send({
      name: 'Producto sintético actualizado',
      category: 'Prueba actualizada',
      branch: 'León',
    }).expect(200);
  assert.equal(updatedProduct.body.origin, 'practice');
  assert.equal(updatedProduct.body.item.name, 'Producto sintético actualizado');
  assert.equal(updatedProduct.body.item.category, 'Prueba actualizada');
  assert.equal(updatedProduct.body.item.branch, 'León');
  assert.equal(updatedProduct.body.item.stock, 5);
  const invalidStockEdit = await request(app).patch(`/api/products/${productId}`)
    .set(originHeader)
    .send({
      name: 'Producto sintético actualizado',
      category: 'Prueba actualizada',
      branch: 'León',
      stock: 1_000_001,
    }).expect(400);
  assert.match(invalidStockEdit.body.error, /existencia debe ser un entero/i);
  const deletedProduct = await request(app).delete(`/api/products/${productId}`)
    .set(originHeader).expect(200);
  assert.deepEqual(deletedProduct.body, { deleted: true, count: 1, origin: 'practice' });
  const productsAfterDelete = await request(app).get('/api/products').expect(200);
  assert.ok(productsAfterDelete.body.items.every((item) => item.id !== productId));

  const adjustedProduct = await request(app).post('/api/products').set(originHeader).send({
    name: 'Producto sintético con ajuste manual',
    category: 'Prueba',
    branch: 'Aguascalientes',
    stock: 2,
  }).expect(201);
  const adjustment = await request(app).patch(`/api/products/${adjustedProduct.body.item.id}`)
    .set(originHeader)
    .send({
      name: adjustedProduct.body.item.name,
      category: adjustedProduct.body.item.category,
      branch: adjustedProduct.body.item.branch,
      stock: 7,
    }).expect(200);
  assert.equal(adjustment.body.item.stock, 7);
  const productDetails = await request(app).get(`/api/products/${adjustedProduct.body.item.id}`)
    .set(originHeader).expect(200);
  assert.ok(productDetails.body.movements.some((movement) =>
    movement.type === 'manual_adjustment' && movement.quantity === 5,
  ));
  await request(app).delete(`/api/products/${adjustedProduct.body.item.id}`)
    .set(originHeader).expect(409);

  const invoice = await request(app).post('/api/invoices').set(originHeader).send({
    supplier: 'Proveedor sintético para eliminar',
    reference: 'DEMO-DELETE-001',
    date: '2026-10-31',
    amount: 25,
  }).expect(201);
  await request(app).delete(`/api/invoices/${invoice.body.item.id}`)
    .set(originHeader).expect(200, { deleted: true, origin: 'practice' });
  await request(app).get(`/api/invoices/${invoice.body.item.id}`).expect(404);

  const complaint = await request(app).post('/api/complaints').set(originHeader).send({
    branch: 'Zapopan',
    customerName: 'Cliente sintético',
    description: 'Caso de demostración para eliminar.',
    category: 'Prueba',
  }).expect(201);
  await request(app).delete(`/api/complaints/${complaint.body.item.id}`)
    .set(originHeader).expect(200, { deleted: true, origin: 'practice' });
  await request(app).get(`/api/complaints/${complaint.body.item.id}`).expect(404);

  const stockProduct = await request(app).post('/api/products').set(originHeader).send({
    name: 'Producto sintético con historial',
    category: 'Prueba',
    branch: 'Zapopan',
    stock: 0,
  }).expect(201);
  const postedInvoice = await request(app).post('/api/invoices').set(originHeader).send({
    supplier: 'Proveedor sintético con movimiento',
    reference: 'DEMO-DELETE-002',
    date: '2026-10-31',
    amount: 12.5,
    branch: 'Zapopan',
    items: [{
      description: 'Producto sintético con historial',
      quantity: 1,
      unitPrice: 12.5,
      productId: stockProduct.body.item.id,
    }],
  }).expect(201);
  await request(app).post(`/api/invoices/${postedInvoice.body.item.id}/review`)
    .set(originHeader)
    .send({ decision: 'confirm', evidence: 'Revisión sintética para probar el movimiento.' })
    .expect(200);
  await request(app).patch(`/api/products/${stockProduct.body.item.id}`)
    .set(originHeader)
    .send({
      name: 'Producto sintético actualizado con historial',
      category: 'Prueba actualizada',
      branch: 'Zapopan',
    }).expect(200);
  await request(app).patch(`/api/products/${stockProduct.body.item.id}`)
    .set(originHeader)
    .send({
      name: 'Producto sintético actualizado con historial',
      category: 'Prueba actualizada',
      branch: 'León',
    }).expect(409);
  await request(app).delete(`/api/invoices/${postedInvoice.body.item.id}`)
    .set(originHeader).expect(409);
  await request(app).delete(`/api/products/${stockProduct.body.item.id}`)
    .set(originHeader).expect(409);
});

test('public product updates and deletes stay disabled outside the evaluation mode', async () => {
  const app = await createApp({ evaluationMode: false });
  const productCount = (await request(app).get('/api/products').expect(200)).body.items.length;
  await request(app).patch('/api/products/1').send({
    name: 'Producto cambiado',
    category: 'Prueba',
    branch: 'Zapopan',
  }).expect(403);
  await request(app).delete('/api/products/1').expect(403);
  assert.equal((await request(app).get('/api/products').expect(200)).body.items.length, productCount);
});

test('production evaluation mode serves and writes only isolated practice data without Entra', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rioclaro-public-production-'));
  const environmentKeys = [
    'NODE_ENV',
    'RIOCLARO_DATA_FILE',
    'RIOCLARO_EVALUATION_DATA_FILE',
    'RIOCLARO_AUDIT_FILE',
    'RIOCLARO_EVALUATION_AUDIT_FILE',
    'FOUNDRY_CONVERSATIONS_FILE',
    'RIOCLARO_EVALUATION_CONVERSATIONS_FILE',
    'FOUNDRY_ENABLED',
    'FOUNDRY_PROJECT_ENDPOINT',
  ];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const dataFile = path.join(directory, 'evaluation-data.json');
  const auditFile = path.join(directory, 'evaluation-audit.json');
  const conversationsFile = path.join(directory, 'evaluation-conversations.json');
  Object.assign(process.env, {
    NODE_ENV: 'production',
    RIOCLARO_DATA_FILE: dataFile,
    RIOCLARO_EVALUATION_DATA_FILE: dataFile,
    RIOCLARO_AUDIT_FILE: auditFile,
    RIOCLARO_EVALUATION_AUDIT_FILE: auditFile,
    FOUNDRY_CONVERSATIONS_FILE: conversationsFile,
    RIOCLARO_EVALUATION_CONVERSATIONS_FILE: conversationsFile,
    FOUNDRY_ENABLED: 'false',
  });
  delete process.env.FOUNDRY_PROJECT_ENDPOINT;
  try {
    const app = await createApp({ evaluationMode: true });
    const headers = { 'X-Forwarded-Proto': 'https' };
    const status = await request(app).get('/api/security/status').set(headers).expect(200);
    assert.equal(status.body.evaluationMode, true);
    assert.equal(status.body.practiceWritesEnabled, false);
    await request(app).get('/api/products').set(headers)
      .set('Authorization', 'Bearer invalid-evaluation-token').expect(401);

    const products = await request(app).get('/api/products')
      .set(headers).set('X-Data-Origin', 'operational').expect(200);
    assert.equal(products.body.origin, 'practice');
    const created = await request(app).post('/api/products').set(headers)
      .set('X-Data-Origin', 'operational')
      .send({
        name: 'Producto demo público de producción',
        category: 'Prueba',
        branch: 'León',
        stock: 4,
      }).expect(201);
    assert.equal(created.body.origin, 'practice');
      const updated = await request(app).patch(`/api/products/${created.body.item.id}`)
        .set(headers)
        .send({
          name: 'Producto demo público actualizado en producción',
          category: 'Prueba actualizada',
          branch: 'León',
        }).expect(200);
      assert.equal(updated.body.origin, 'practice');
      assert.equal(updated.body.item.name, 'Producto demo público actualizado en producción');
      assert.equal(updated.body.item.stock, 4);
      await request(app).delete(`/api/products/${created.body.item.id}`)
        .set(headers).expect(200, { deleted: true, count: 1, origin: 'practice' });
      const productsAfterDelete = await request(app).get('/api/products')
        .set(headers).expect(200);
      assert.ok(productsAfterDelete.body.items.every((product) => product.id !== created.body.item.id));
      await request(app).post('/api/chat').set(headers)
        .send({ message: 'Consulta sintética' }).expect(503);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
