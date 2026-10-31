import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.RIOCLARO_DATA_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const identities = {
  admin: { userId: 'sales-admin', roles: ['Administrator'], branch: null },
  manager: { userId: 'sales-manager', roles: ['BranchManager'], branch: 'Zapopan' },
  noBranch: { userId: 'sales-no-branch', roles: ['BranchManager'], branch: null },
  accountsPayable: { userId: 'sales-ap', roles: ['AccountsPayable'], branch: null },
};
const tokenVerifier = async (token) => {
  if (!identities[token]) throw new Error('Invalid test token.');
  return identities[token];
};
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function createApp(options = {}) {
  const { createApp: factory } = await import('../server/app.js');
  return factory({ tokenVerifier, ...options });
}

test('computes synthetic sales by branch and period, including comparisons and products', async () => {
  const { createApp } = await import('../server/app.js');
  const { getSalesReport, syntheticSalesRecords } = await import('../server/data/sales.js');
  const app = createApp({ tokenVerifier });
  const from = syntheticSalesRecords.at(-1).date;
  const to = from;
  const response = await request(app).get('/api/sales').query({ from, to }).expect(200);
  const expectedRecords = syntheticSalesRecords.filter((sale) => sale.date === from);
  const expectedRevenueCents = expectedRecords.reduce(
    (sum, sale) => sum + sale.quantity * sale.unitPriceCents,
    0,
  );
  assert.equal(response.body.synthetic, true);
  assert.equal(response.body.source, 'synthetic');
  assert.equal(response.body.totalOrders, expectedRecords.length);
  assert.equal(response.body.totalRevenue, expectedRevenueCents / 100);
  assert.equal(response.body.branches.length, 5);
  assert.equal(response.body.topProducts[0].name, getSalesReport({ from, to }).topProducts[0].name);

  const branch = await request(app).get('/api/sales').query({ from, to, branch: 'Zapopan' }).expect(200);
  assert.equal(branch.body.branches.length, 1);
  assert.equal(branch.body.branches[0].branch, 'Zapopan');
  assert.equal(branch.body.totalOrders, 2);

  const empty = await request(app).get('/api/sales')
    .query({ from: '2000-01-01', to: '2000-01-02' }).expect(200);
  assert.equal(empty.body.dataAvailable, false);
  assert.equal(empty.body.totalOrders, 0);
  assert.match(empty.body.message, /No hay registros sintéticos/);
});

test('limits synthetic sales reports to the verified role and branch and never exposes operational sales', async () => {
  const app = await createApp();
  const from = '2026-10-25';
  const to = '2026-10-31';
  const managerReport = await request(app).get('/api/sales').set(auth('manager'))
    .query({ from, to, branch: 'León' }).expect(403);
  assert.match(managerReport.body.error, /otra sucursal/);

  const managerScope = await request(app).get('/api/sales').set(auth('manager'))
    .query({ from, to }).expect(200);
  assert.deepEqual(managerScope.body.branches.map(({ branch }) => branch), ['Zapopan']);
  await request(app).get('/api/sales').set(auth('noBranch'))
    .query({ from, to }).expect(403);
  await request(app).get('/api/sales').set(auth('accountsPayable'))
    .query({ from, to }).expect(403);

  await request(app).get('/api/sales').set('X-Data-Origin', 'operational')
    .query({ from, to }).expect(401);
  await request(app).get('/api/sales').set(auth('admin')).set('X-Data-Origin', 'operational')
    .query({ from, to }).expect(503);
  await request(app).get('/api/sales').query({ from: '2026-02-31', to }).expect(400);
});

test('filters inventory movements by the same verified branch before sending Foundry context', async () => {
  const old = {
    enabled: process.env.FOUNDRY_ENABLED,
    endpoint: process.env.FOUNDRY_PROJECT_ENDPOINT,
    agent: process.env.FOUNDRY_AGENT_NAME,
  };
  process.env.FOUNDRY_ENABLED = 'true';
  process.env.FOUNDRY_PROJECT_ENDPOINT = 'https://rioclaro.services.ai.azure.com/api/projects/test-project';
  process.env.FOUNDRY_AGENT_NAME = 'RioClaroAssistant';
  try {
    const received = [];
    const app = await createApp({
      foundryClient: async (_message, options) => {
        received.push(options.applicationContext);
        return { answer: 'Respuesta de prueba sin cifras.', sources: [], conversationId: null };
      },
    });
    const admin = auth('admin');
    const zapopanProduct = await request(app).post('/api/products').set(admin)
      .set('X-Data-Origin', 'operational')
      .send({ name: 'Producto operativo Zapopan', category: 'Prueba', branch: 'Zapopan', stock: 0 })
      .expect(201);
    const guadalajaraProduct = await request(app).post('/api/products').set(admin)
      .set('X-Data-Origin', 'operational')
      .send({ name: 'Producto operativo Guadalajara', category: 'Prueba', branch: 'Guadalajara', stock: 0 })
      .expect(201);

    for (const [product, branch, reference] of [
      [zapopanProduct.body.item, 'Zapopan', 'MOV-ZAP'],
      [guadalajaraProduct.body.item, 'Guadalajara', 'MOV-GDL'],
    ]) {
      const invoice = await request(app).post('/api/invoices').set(auth('accountsPayable'))
        .set('X-Data-Origin', 'operational')
        .send({
          supplier: 'Proveedor sintético de prueba',
          reference,
          date: '2026-10-31',
          amount: 10,
          branch,
          items: [{
            description: product.name,
            quantity: 1,
            unitPrice: 10,
            productId: product.id,
          }],
        }).expect(201);
      await request(app).post(`/api/invoices/${invoice.body.item.id}/review`)
        .set(auth('accountsPayable')).set('X-Data-Origin', 'operational')
        .send({ decision: 'confirm', evidence: 'Se revisó el registro sintético de prueba.' })
        .expect(200);
    }

    await request(app).post('/api/chat').set(auth('manager'))
      .set('X-Data-Origin', 'operational').set('X-Chat-Session', '825cb746-6e65-4e31-b9f3-52f5aac1d762')
      .send({ message: 'Resume mis movimientos autorizados.' }).expect(200);
    const context = received[0];
    assert.ok(context.inventory.recentMovements.length > 0);
    assert.ok(context.inventory.recentMovements.every(({ branch }) => branch === 'Zapopan'));
    assert.ok(context.inventory.records.every(({ branches: branchStocks }) =>
      branchStocks.every(({ name }) => name === 'Zapopan')));
    assert.equal(context.invoices.available, false);
    assert.doesNotMatch(JSON.stringify(context), /MOV-GDL|Producto operativo Guadalajara/);
  } finally {
    for (const [key, value] of Object.entries({
      FOUNDRY_ENABLED: old.enabled,
      FOUNDRY_PROJECT_ENDPOINT: old.endpoint,
      FOUNDRY_AGENT_NAME: old.agent,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('integrates calculated sales into the existing evaluation dashboard', async () => {
  const app = await createApp({ evaluationMode: true });
  const page = await request(app).get('/').expect(200);
  assert.match(page.text, /id="sales-report"/);
  assert.match(page.text, /id="sales-filters"/);
  assert.match(page.text, /Reporte de ventas sintéticas/);
  const report = await request(app).get('/api/sales').set('X-Data-Origin', 'operational').expect(200);
  assert.equal(report.body.source, 'synthetic');
});

test('Foundry sales summaries receive only the calculated synthetic report', async () => {
  const { syntheticSalesRecords } = await import('../server/data/sales.js');
  const previousEnvironment = {
    enabled: process.env.FOUNDRY_ENABLED,
    endpoint: process.env.FOUNDRY_PROJECT_ENDPOINT,
    agent: process.env.FOUNDRY_AGENT_NAME,
    suspended: process.env.FOUNDRY_SUSPENDED,
  };
  process.env.FOUNDRY_ENABLED = 'true';
  process.env.FOUNDRY_PROJECT_ENDPOINT = 'https://rioclaro.services.ai.azure.com/api/projects/test-project';
  process.env.FOUNDRY_AGENT_NAME = 'RioClaroAssistant';
  process.env.FOUNDRY_SUSPENDED = 'false';
  try {
    const received = [];
    const app = await createApp({
      foundryClient: async (_message, options) => {
        received.push(options);
        return { answer: 'El resumen corresponde al periodo sintético solicitado.' };
      },
    });
    const date = syntheticSalesRecords.at(-1).date;
    const result = await request(app).post('/api/sales/summary')
      .set(auth('admin'))
      .query({ from: date, to: date })
      .send({})
      .expect(200);
    assert.equal(result.body.source, 'synthetic-sales-report');
    assert.equal(result.body.requiresHumanReview, true);
    assert.equal(result.body.summary, 'El resumen corresponde al periodo sintético solicitado.');
    assert.equal(received[0].applicationContext.task, 'synthetic_sales_summary');
    assert.equal(received[0].applicationContext.salesReport.source, 'synthetic');
    assert.equal(received[0].applicationContext.salesReport.from, date);
    assert.equal(received[0].ownerId, identities.admin.userId);
  } finally {
    for (const [key, value] of Object.entries({
      FOUNDRY_ENABLED: previousEnvironment.enabled,
      FOUNDRY_PROJECT_ENDPOINT: previousEnvironment.endpoint,
      FOUNDRY_AGENT_NAME: previousEnvironment.agent,
      FOUNDRY_SUSPENDED: previousEnvironment.suspended,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
