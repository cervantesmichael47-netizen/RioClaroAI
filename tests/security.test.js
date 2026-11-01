import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.RIOCLARO_DATA_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const identities = {
  admin: { userId: 'entra-oid-admin', roles: ['Administrator'], branch: null },
  branchManager: { userId: 'entra-oid-manager', roles: ['BranchManager'], branch: 'Zapopan' },
  branchManagerWithoutBranch: { userId: 'entra-oid-manager-no-branch', roles: ['BranchManager'], branch: null },
  warehouse: { userId: 'entra-oid-warehouse', roles: ['Warehouse'], branch: 'Zapopan' },
  accountsPayable: { userId: 'entra-oid-ap', roles: ['AccountsPayable'], branch: null },
};
const tokenVerifier = async (token) => {
  if (token === 'signed.jwt.token') return identities.branchManager;
  if (!identities[token]) throw new Error('Invalid test token.');
  return identities[token];
};
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const validInvoice = {
  supplier: 'Proveedor de prueba',
  reference: 'TEST-2026-001',
  date: '2026-07-12',
  amount: 125.5,
};

function configureFoundry() {
  process.env.FOUNDRY_ENABLED = 'true';
  process.env.FOUNDRY_PROJECT_ENDPOINT = 'https://rioclaro.services.ai.azure.com/api/projects/test-project';
  process.env.FOUNDRY_AGENT_NAME = 'RioClaroAssistant';
  delete process.env.FOUNDRY_SUSPENDED;
}

function clearFoundry() {
  delete process.env.FOUNDRY_ENABLED;
  delete process.env.FOUNDRY_PROJECT_ENDPOINT;
  delete process.env.FOUNDRY_AGENT_NAME;
  delete process.env.FOUNDRY_SUSPENDED;
}

async function createApp(options = {}) {
  const { createApp: factory } = await import('../server/app.js');
  return factory({ tokenVerifier, ...options });
}

test('public endpoints identify their data origin; local practice writes are validated and operations stay protected', async () => {
  const app = await createApp();
  const home = await request(app).get('/').expect(200);
  assert.match(home.text, /RÍO CLARO AI/);
  const health = await request(app).get('/health').expect(200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.server, 'operational');
  assert.equal(health.body.foundryConfigured, false);
  const products = await request(app).get('/api/products').expect(200);
  assert.equal(products.body.origin, 'practice');
  assert.equal(products.body.demo, undefined);
  assert.equal(products.body.classification, undefined);
  assert.equal(products.headers['cache-control'], 'no-store');
  assert.equal((await request(app).get('/api/security/status')).body.practiceWritesEnabled, true);
  await request(app).post('/api/products').send({}).expect(400);
  await request(app).post('/api/invoices').send({}).expect(400);
  await request(app).post('/api/products').set('X-Data-Origin', 'operational')
    .send({ name: 'Producto operativo', category: 'Prueba', branch: 'Guadalajara', stock: 1 }).expect(401);
  await request(app).post('/api/invoices').set('X-Data-Origin', 'operational')
    .send(validInvoice).expect(401);
  await request(app).post('/api/assistant').send({ message: 'Consulta' }).expect(401);
  await request(app).get('/api/admin/audit').expect(401);
  await request(app).post('/api/documents').send({}).expect(404);
});

test('production APIs require a verified identity outside the isolated evaluation mode', async () => {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const app = await createApp();
    for (const route of ['/api/dashboard', '/api/products', '/api/invoices', '/api/sales', '/api/complaints']) {
      await request(app).get(route).set('X-Forwarded-Proto', 'https').expect(401);
    }
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
});

test('chat validates empty and oversized messages with HTTP 422 before authorization', async () => {
  const app = await createApp();
  await request(app).post('/api/chat').send({ message: '   ' }).expect(422);
  await request(app).post('/api/chat').send({ message: 'x'.repeat(2001) }).expect(422);
  await request(app).post('/api/chat').send({ message: 'Pregunta válida' }).expect(401);
});

test('chat reports missing Foundry configuration without calling a simulated response', async () => {
  clearFoundry();
  const app = await createApp({
    foundryClient: async () => {
      throw new Error('This should not be called.');
    },
  });
  const status = await request(app).get('/api/security/status').expect(200);
  assert.equal(status.body.aiConfigured, false);
  await request(app).post('/api/chat').set(auth('accountsPayable'))
    .send({ message: 'Pregunta válida' }).expect(503);
});

test('local chat is opt-in and keeps the conversation bound to its session', async () => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousLocalChat = process.env.ALLOW_UNAUTHENTICATED_LOCAL_CHAT;
  const conversationId = 'c5a73e9c-1d3c-4c8f-a12a-1bc0c6a73892';
  const sessionId = '825cb746-6e65-4e31-b9f3-52f5aac1d762';
  const received = [];
  process.env.NODE_ENV = 'development';
  process.env.ALLOW_UNAUTHENTICATED_LOCAL_CHAT = 'true';
  configureFoundry();
  const app = await createApp({
    foundryClient: async (message, options) => {
      received.push({ message, ...options });
      return { answer: 'Respuesta real simulada por prueba.', sources: [], conversationId };
    },
  });
  try {
    const first = await request(app).post('/api/chat').set('X-Chat-Session', sessionId)
      .send({ message: 'Primera pregunta' }).expect(200);
    await request(app).post('/api/chat').set('X-Chat-Session', sessionId)
      .send({ message: 'Seguimiento', conversationId: first.body.conversationId }).expect(200);
    assert.equal(first.body.conversationId, conversationId);
    assert.equal(received[1].conversationId, conversationId);
    assert.equal(received[0].ownerId, `local:${sessionId}`);
    assert.equal(received[1].ownerId, `local:${sessionId}`);
  } finally {
    clearFoundry();
    delete process.env.ALLOW_UNAUTHENTICATED_LOCAL_CHAT;
    if (previousLocalChat !== undefined) process.env.ALLOW_UNAUTHENTICATED_LOCAL_CHAT = previousLocalChat;
    if (previousEnvironment !== undefined) process.env.NODE_ENV = previousEnvironment;
    else delete process.env.NODE_ENV;
  }
});

test('Foundry connection check returns a safe status', async () => {
  configureFoundry();
  const app = await createApp({ foundryConnectionCheck: async () => true });
  try {
    const response = await request(app).post('/api/foundry/check').expect(200);
    assert.equal(response.body.configured, true);
    assert.equal(response.body.connected, true);
  } finally {
    clearFoundry();
  }
});

test('invalid invoices, product values, and oversized JSON are rejected', async () => {
  const app = await createApp();
  await request(app).post('/api/invoices').set(auth('accountsPayable'))
    .send({ ...validInvoice, date: '2026-02-31' }).expect(400);
  await request(app).post('/api/invoices').set(auth('accountsPayable'))
    .send({ ...validInvoice, amount: -1 }).expect(400);
  await request(app).post('/api/products').set(auth('warehouse'))
    .send({ name: 'x', category: 'demo', branch: 'otra', stock: 1 }).expect(400);
  await request(app).post('/api/products').set(auth('warehouse'))
    .send({ name: 'x', category: 'demo', branch: 'Zapopan', stock: null }).expect(400);
  await request(app).post('/api/products').set(auth('warehouse'))
    .set('Content-Type', 'application/json')
    .send(`{"name":"${'x'.repeat(20_000)}"}`).expect(413);
  await request(app).post('/api/products').type('form')
    .send({ name: 'x'.repeat(9000) }).expect(413);
});

test('role policies enforce invoice and inventory access on the server', async () => {
  const app = await createApp();
  await request(app).get('/api/products')
    .set('Authorization', 'Bearer signed.jwt.token').expect(200);
  const managerProducts = await request(app).get('/api/products').set(auth('branchManager')).expect(200);
  assert.ok(managerProducts.body.items.length > 0);
  assert.ok(managerProducts.body.items.every((item) => item.branch === 'Zapopan'));
  await request(app).post('/api/products').set(auth('branchManager'))
    .send({ name: 'No autorizado', category: 'demo', branch: 'León', stock: 1 }).expect(403);
  await request(app).post('/api/invoices').set(auth('branchManager')).send(validInvoice).expect(403);
  await request(app).get('/api/invoices').set(auth('warehouse')).expect(403);
  await request(app).get('/api/products').set(auth('accountsPayable')).expect(403);
  await request(app).post('/api/products').set(auth('warehouse'))
    .send({ name: 'Producto Zapopan de prueba', category: 'demo', branch: 'Zapopan', stock: 2 }).expect(201);
  await request(app).post('/api/invoices').set(auth('accountsPayable'))
    .send(validInvoice).expect(201);
  await request(app).get('/api/admin/audit').set(auth('accountsPayable')).expect(403);
});

test('invoice duplicate detection flags possible matches for human review', async () => {
  const app = await createApp();
  const duplicate = await request(app).post('/api/invoices').set(auth('accountsPayable'))
    .send({
      supplier: 'Suministros del Centro',
      reference: 'RC-1051',
      date: '2026-03-18',
      amount: 2150.75,
    }).expect(200);
  assert.equal(duplicate.body.possibleDuplicate, true);
  assert.equal(duplicate.body.created, false);
  assert.equal(duplicate.body.requiresHumanReview, true);
  const audit = await request(app).get('/api/admin/audit').set(auth('admin')).expect(200);
  assert.ok(audit.body.items.some((event) => event.type === 'invoice_duplicate_detected'));
  assert.equal(JSON.stringify(audit.body).includes('Suministros del Centro'), false);
});

test('assistant blocks sensitive input and does not reveal Foundry errors', async () => {
  configureFoundry();
  let calls = 0;
  const app = await createApp({
    foundryClient: async () => {
      calls += 1;
      const error = new Error('secret-value-should-not-leak');
      error.safeMessage = 'another-secret-should-not-leak';
      throw error;
    },
  });
  const privateQuery = await request(app).post('/api/assistant').set(auth('accountsPayable'))
    .send({ message: 'Mi correo es employee@example.test' }).expect(422);
  assert.equal(privateQuery.text.includes('employee@example.test'), false);
  await request(app).post('/api/assistant').set(auth('accountsPayable'))
    .send({ message: 'El teléfono es 555-123-4567' }).expect(422);
  assert.equal(calls, 0);
  const audit = await request(app).get('/api/admin/audit').set(auth('admin')).expect(200);
  assert.equal(JSON.stringify(audit.body).includes('employee@example.test'), false);

  const originalError = console.error;
  const logOutput = [];
  console.error = (...parts) => logOutput.push(parts.join(' '));
  try {
    const failed = await request(app).post('/api/assistant').set(auth('accountsPayable'))
      .send({ message: '¿Qué política pública debo seguir?' }).expect(502);
    assert.equal(failed.text.includes('secret-value-should-not-leak'), false);
    assert.equal(failed.text.includes('another-secret-should-not-leak'), false);
  } finally {
    console.error = originalError;
    clearFoundry();
  }
  assert.equal(logOutput.join(' ').includes('secret-value-should-not-leak'), false);
  assert.equal(logOutput.join(' ').includes('another-secret-should-not-leak'), false);
});

test('chat does not override saved Foundry agent instructions and returns provenance metadata', async () => {
  let received;
  configureFoundry();
  const app = await createApp({
    foundryClient: async (message, options) => {
      received = {
        message,
        options,
        applicationContext: options.applicationContext,
      };
      return { answer: 'No hay evidencia suficiente.', sources: ['catalog/demo-item-1'] };
    },
  });
  try {
    const response = await request(app).post('/api/assistant').set(auth('admin'))
      .send({ message: '¿Qué datos están disponibles?' }).expect(200);
    assert.equal(received.message, '¿Qué datos están disponibles?');
    assert.equal(Object.hasOwn(received.options, 'instructions'), false);
    assert.equal(received.applicationContext.origin, 'practice');
    assert.equal(received.applicationContext.originDescription.startsWith('Datos de práctica'), true);
    assert.equal(received.applicationContext.inventory.available, true);
    assert.equal(received.applicationContext.invoices.available, true);
    assert.ok(Array.isArray(received.applicationContext.inventory.records));
    assert.ok(Array.isArray(received.applicationContext.invoices.records));
    assert.equal(response.body.sourceStatus, 'agent-reported-unverified');
    assert.equal(response.body.requiresHumanReview, true);
  } finally {
    clearFoundry();
  }
});

test('chat context respects inventory branch scope and invoice role permissions', async () => {
  configureFoundry();
  const contexts = [];
  const app = await createApp({
    foundryClient: async (_message, { applicationContext }) => {
      contexts.push(applicationContext);
      return { answer: 'Contexto limitado a Zapopan.', sources: [] };
    },
  });
  try {
    await request(app).post('/api/chat').set(auth('branchManager'))
      .send({ message: '¿Qué hay en inventario?' }).expect(200);
    await request(app).post('/api/chat').set(auth('branchManagerWithoutBranch'))
      .send({ message: '¿Qué hay en inventario?' }).expect(200);
    assert.ok(contexts[0].inventory.records.length > 0);
    assert.ok(contexts[0].inventory.records.every((product) => product.branch === 'Zapopan'));
    assert.equal(contexts[0].invoices.available, false);
    assert.deepEqual(contexts[0].invoices.records, []);
    assert.equal(contexts[1].inventory.available, false);
    assert.deepEqual(contexts[1].inventory.records, []);
  } finally {
    clearFoundry();
  }
});

test('operational chat context requires a verified identity', async () => {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  process.env.ALLOW_UNAUTHENTICATED_LOCAL_CHAT = 'true';
  configureFoundry();
  const app = await createApp({ foundryClient: async () => ({ answer: 'No debe llamarse.', sources: [] }) });
  try {
    await request(app).post('/api/chat').set('X-Data-Origin', 'operational')
      .set('X-Chat-Session', '825cb746-6e65-4e31-b9f3-52f5aac1d762')
      .send({ message: 'Consulta operativa' }).expect(401);
  } finally {
    clearFoundry();
    delete process.env.ALLOW_UNAUTHENTICATED_LOCAL_CHAT;
    if (previousEnvironment !== undefined) process.env.NODE_ENV = previousEnvironment;
    else delete process.env.NODE_ENV;
  }
});

test('sensitive assistant output is blocked', async () => {
  configureFoundry();
  const app = await createApp({
    foundryClient: async () => ({
      answer: 'Respuesta normal con una access_token de ejemplo: should-not-be-returned',
      sources: ['catalog/demo-record', 'someone@example.test'],
    }),
  });
  try {
    const response = await request(app).post('/api/assistant').set(auth('accountsPayable'))
      .send({ message: '¿Qué fuente hay disponible?' }).expect(502);
    assert.equal(response.text.includes('should-not-be-returned'), false);
  } finally {
    clearFoundry();
  }
});

test('assistant source identifiers containing sensitive values are omitted', async () => {
  configureFoundry();
  const app = await createApp({
    foundryClient: async () => ({
      answer: 'Respuesta general de ejemplo.',
      sources: ['catalog/demo-record', 'someone@example.test'],
    }),
  });
  try {
    const response = await request(app).post('/api/assistant').set(auth('accountsPayable'))
      .send({ message: '¿Qué fuente hay disponible?' }).expect(200);
    assert.deepEqual(response.body.sources, ['catalog/demo-record']);
  } finally {
    clearFoundry();
  }
});

test('AI suspension blocks calls and can only be changed by an administrator', async () => {
  configureFoundry();
  let calls = 0;
  const app = await createApp({
    foundryClient: async () => {
      calls += 1;
      return { answer: 'Respuesta', sources: [] };
    },
  });
  try {
    await request(app).post('/api/admin/ai-control').set(auth('warehouse'))
      .send({ enabled: false }).expect(403);
    const suspended = await request(app).post('/api/admin/ai-control').set(auth('admin'))
      .send({ enabled: false }).expect(200);
    assert.equal(suspended.body.aiSuspended, true);
    await request(app).post('/api/assistant').set(auth('accountsPayable'))
      .send({ message: 'Pregunta no sensible' }).expect(503);
    assert.equal(calls, 0);
    const resumed = await request(app).post('/api/admin/ai-control').set(auth('admin'))
      .send({ enabled: true }).expect(200);
    assert.equal(resumed.body.aiSuspended, false);
    await request(app).post('/api/assistant').set(auth('accountsPayable'))
      .send({ message: 'Pregunta no sensible' }).expect(200);
    assert.equal(calls, 1);
  } finally {
    clearFoundry();
  }
});

test('assistant accepts successive conversations without an application question quota', async () => {
  configureFoundry();
  const app = await createApp({
    foundryClient: async () => ({ answer: 'Respuesta', sources: [] }),
  });
  try {
    for (let count = 0; count < 8; count += 1) {
      await request(app).post('/api/assistant').set(auth('accountsPayable'))
        .send({ message: `Pregunta pública ${count}` }).expect(200);
    }
  } finally {
    clearFoundry();
  }
});

test('automatic Foundry availability checks retry temporary failures with backoff', async () => {
  const {
    getFoundryAvailability,
    startFoundryAvailabilityMonitor,
  } = await import('../server/services/foundry.js');
  configureFoundry();
  let attempts = 0;
  const stop = startFoundryAvailabilityMonitor({
    initialDelayMs: 5,
    maximumDelayMs: 10,
    connectionCheck: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('Temporary service failure.');
      return true;
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(attempts >= 2);
    assert.equal(getFoundryAvailability().connected, true);
    assert.equal(getFoundryAvailability().state, 'connected');
  } finally {
    stop();
    clearFoundry();
  }
});

test('Foundry quota errors stay safe and include retry guidance', async () => {
  configureFoundry();
  const app = await createApp({
    foundryClient: async () => {
      const error = new Error('provider response with private details');
      error.statusCode = 429;
      error.retryAfter = '12';
      throw error;
    },
  });
  try {
    const response = await request(app).post('/api/assistant').set(auth('accountsPayable'))
      .send({ message: 'Pregunta no sensible' }).expect(429);
    assert.equal(response.headers['retry-after'], '12');
    assert.match(response.body.error, /cuota/);
    assert.equal(response.text.includes('private details'), false);
  } finally {
    clearFoundry();
  }
});

test('security headers are set, and browser-origin CORS is not universal', async () => {
  const previous = process.env.CORS_ALLOWED_ORIGINS;
  process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.test';
  try {
    const app = await createApp();
    const response = await request(app).get('/api/health').set('Origin', 'https://attacker.example');
    assert.equal(response.headers['x-powered-by'], undefined);
    assert.match(response.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    const preflight = await request(app).options('/api/products/1')
      .set('Origin', 'https://app.example.test')
      .set('Access-Control-Request-Method', 'PATCH')
      .set('Access-Control-Request-Headers', 'content-type,x-data-origin')
      .expect(204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://app.example.test');
    assert.match(preflight.headers['access-control-allow-methods'], /\bPATCH\b/);
  } finally {
    if (previous === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previous;
  }
});

test('HTML escaping encodes user-controlled text before template insertion', async () => {
  const { escapeHTML } = await import('../public/escape.js');
  assert.equal(escapeHTML('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});

test('unauthenticated local practice can add products and invoices; operational and production writes stay protected', async () => {
  const app = await createApp();
  const product = await request(app).post('/api/products')
    .send({
      name: 'Producto local flujo completo',
      category: 'Pruebas locales',
      branch: 'Guadalajara',
      stock: 5,
    }).expect(201);
  assert.equal(product.body.origin, 'practice');
  assert.equal(product.body.item.name, 'Producto local flujo completo');

  const invoice = await request(app).post('/api/invoices')
    .send({
      supplier: 'Proveedor local de prueba',
      reference: 'LOCAL-PRACTICE-2026-001',
      date: '2026-10-29',
      branch: 'Guadalajara',
      amount: 25,
      items: [{ description: 'Producto local flujo completo', quantity: 2, unitPrice: 12.5 }],
    }).expect(201);
  assert.equal(invoice.body.item.status, 'pending_review');
  assert.equal(invoice.body.item.amount, 25);
  assert.equal(invoice.body.item.items[0].productId, product.body.item.id);

  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const productionApp = await createApp();
    assert.equal((await request(productionApp).get('/api/security/status')
      .set('X-Forwarded-Proto', 'https')).body.practiceWritesEnabled, false);
    await request(productionApp).post('/api/products').set('X-Forwarded-Proto', 'https')
      .send({
        name: 'Producto sin autorización',
        category: 'Pruebas',
        branch: 'Guadalajara',
        stock: 1,
      }).expect(401);
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
});
