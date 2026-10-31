import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.RIOCLARO_DATA_FILE = ':memory:';

const identities = {
  admin: { userId: 'complaint-admin', roles: ['Administrator'], branch: null },
  manager: { userId: 'complaint-manager', roles: ['BranchManager'], branch: 'Zapopan' },
  otherManager: { userId: 'complaint-other-manager', roles: ['BranchManager'], branch: 'Guadalajara' },
  unassignedManager: { userId: 'complaint-unassigned-manager', roles: ['BranchManager'], branch: null },
};
const tokenVerifier = async (token) => {
  if (!identities[token]) throw new Error('Invalid test token.');
  return identities[token];
};
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function createApp(options = {}) {
  const { createApp } = await import('../server/app.js');
  return createApp({ tokenVerifier, ...options });
}

test('registers a complaint, returns its metadata and stores its history', async () => {
  const app = await createApp();
  const created = await request(app).post('/api/complaints').set(auth('manager'))
    .send({
      branch: 'Zapopan',
      customerName: 'Ana López',
      description: 'El producto llegó dañado y no me atendieron en la sucursal.',
      category: 'Entrega',
      contactChannel: 'telefono',
      contactValue: '5551234567',
    })
    .expect(201);

  assert.equal(created.body.item.status, 'pending');
  assert.ok(created.body.item.id);
  assert.equal(created.body.item.branch, 'Zapopan');
  assert.equal(created.body.item.history.length, 1);

  const detail = await request(app).get(`/api/complaints/${created.body.item.id}`).set(auth('manager')).expect(200);
  assert.equal(detail.body.item.customerName, 'Ana López');
  assert.equal(detail.body.item.status, 'pending');
  assert.ok(detail.body.item.receivedAt);

  const changed = await request(app).post(`/api/complaints/${created.body.item.id}/status`).set(auth('manager'))
    .send({ status: 'in_progress', note: 'Se asignó a atención al cliente.' })
    .expect(200);
  assert.equal(changed.body.item.status, 'in_progress');
  assert.ok(changed.body.item.history.some((entry) => entry.status === 'in_progress'));

  await request(app).post(`/api/complaints/${created.body.item.id}/response`).set(auth('manager'))
    .send({ message: 'Gracias por contactarnos, revisaremos su caso de inmediato.' }).expect(400);
  const answered = await request(app).post(`/api/complaints/${created.body.item.id}/response`).set(auth('manager'))
    .send({ message: 'Gracias por contactarnos, revisaremos su caso de inmediato.', humanApproved: true })
    .expect(200);
  assert.ok(answered.body.item.firstResponseAt);
  assert.ok(answered.body.item.history.some((entry) => entry.event === 'first_response'));
});

test('rejects invalid complaints and blocks unauthorized branch access', async () => {
  const app = await createApp();
  await request(app).post('/api/complaints').set(auth('manager')).send({ customerName: 'Test' }).expect(400);
  await request(app).get('/api/complaints').set('X-Data-Origin', 'operational').expect(401);
  await request(app).post('/api/complaints').set('X-Data-Origin', 'operational').send({
    branch: 'Zapopan',
    customerName: 'Cliente',
    description: 'Necesito ayuda',
    category: 'Entrega',
  }).expect(401);
  await request(app).post('/api/complaints').set(auth('otherManager')).send({
    branch: 'Zapopan',
    customerName: 'Cliente',
    description: 'Necesito ayuda',
    category: 'Entrega',
  }).expect(403);

  const created = await request(app).post('/api/complaints').set(auth('manager')).send({
    branch: 'Zapopan',
    customerName: 'Luis',
    description: 'Pedido incompleto',
    category: 'Pedido',
  }).expect(201);

  await request(app).get(`/api/complaints/${created.body.item.id}`)
    .set('X-Data-Origin', 'operational').expect(401);
  await request(app).post(`/api/complaints/${created.body.item.id}/status`)
    .set('X-Data-Origin', 'operational').send({ status: 'resolved' }).expect(401);
  await request(app).post(`/api/complaints/${created.body.item.id}/response`)
    .set('X-Data-Origin', 'operational')
    .send({ message: 'Respuesta operativa no autorizada.', humanApproved: true }).expect(401);
  await request(app).get(`/api/complaints/${created.body.item.id}`)
    .set(auth('unassignedManager')).set('X-Data-Origin', 'operational').expect(403);
  await request(app).post(`/api/complaints/${created.body.item.id}/status`)
    .set(auth('unassignedManager')).set('X-Data-Origin', 'operational')
    .send({ status: 'resolved' }).expect(403);
  await request(app).post(`/api/complaints/${created.body.item.id}/response`)
    .set(auth('unassignedManager')).set('X-Data-Origin', 'operational')
    .send({ message: 'Respuesta no autorizada.', humanApproved: true }).expect(403);

  await request(app).get(`/api/complaints/${created.body.item.id}`).set(auth('otherManager')).expect(403);
  await request(app).get('/api/complaints').set(auth('otherManager')).query({ branch: 'Zapopan' }).expect(403);
  await request(app).get('/api/complaints').set(auth('admin')).query({ branch: 'Zapopan' }).expect(200);
});

test('filters by branch and state and rejects cross-branch complaint actions', async () => {
  const app = await createApp();
  const zapopan = await request(app).post('/api/complaints').set(auth('manager')).send({
    branch: 'Zapopan',
    customerName: 'Cliente Zapopan',
    description: 'El pedido llegó incompleto.',
    category: 'Entrega',
  }).expect(201);
  const guadalajara = await request(app).post('/api/complaints').set(auth('admin')).send({
    branch: 'Guadalajara',
    customerName: 'Cliente Guadalajara',
    description: 'El producto estaba dañado.',
    category: 'Producto',
  }).expect(201);

  await request(app).post(`/api/complaints/${zapopan.body.item.id}/status`).set(auth('manager'))
    .send({ status: 'in_progress', note: 'Caso asignado.' }).expect(200);

  const filtered = await request(app).get('/api/complaints').set(auth('manager'))
    .query({ branch: 'Zapopan', status: 'in_progress' }).expect(200);
  assert.ok(filtered.body.items.some((item) => item.id === zapopan.body.item.id));
  assert.ok(filtered.body.items.every((item) => item.branch === 'Zapopan' && item.status === 'in_progress'));
  const pending = await request(app).get('/api/complaints').set(auth('manager'))
    .query({ branch: 'Zapopan', status: 'pending' }).expect(200);
  assert.ok(pending.body.items.every((item) => item.status === 'pending'));

  const scopedList = await request(app).get('/api/complaints').set(auth('manager')).expect(200);
  assert.ok(scopedList.body.items.every((item) => item.branch === 'Zapopan'));
  assert.deepEqual(scopedList.body.sla.byBranch.map((item) => item.branch), ['Zapopan']);
  await request(app).get('/api/complaints').set(auth('unassignedManager')).expect(403);
  await request(app).get(`/api/complaints/${guadalajara.body.item.id}`).set(auth('manager')).expect(403);
  await request(app).post(`/api/complaints/${guadalajara.body.item.id}/status`).set(auth('manager'))
    .send({ status: 'resolved' }).expect(403);
  await request(app).post(`/api/complaints/${guadalajara.body.item.id}/response`).set(auth('manager'))
    .send({ message: 'Hemos recibido su caso.', humanApproved: true }).expect(403);
});

test('computes SLA with controlled timestamps and keeps complaints separated by branch', async () => {
  const app = await createApp();
  const first = await request(app).post('/api/complaints').set(auth('manager')).send({
    branch: 'Zapopan',
    customerName: 'Cliente 1',
    description: 'Factura incorrecta',
    category: 'Factura',
  }).expect(201);
  const second = await request(app).post('/api/complaints').set(auth('admin')).send({
    branch: 'Guadalajara',
    customerName: 'Cliente 2',
    description: 'Producto faltante',
    category: 'Inventario',
  }).expect(201);

  const firstItem = first.body.item;
  const secondItem = second.body.item;

  const list = await request(app).get('/api/complaints').set(auth('admin')).expect(200);
  assert.ok(list.body.items.some((item) => item.id === first.body.item.id && item.branch === 'Zapopan'));
  assert.ok(list.body.items.some((item) => item.id === second.body.item.id && item.branch === 'Guadalajara'));

  const sla = await request(app).get('/api/complaints').set(auth('admin')).query({ branch: 'Zapopan' }).expect(200);
  assert.ok(sla.body.sla.byBranch.some((entry) => entry.branch === 'Zapopan'));

  await request(app).post(`/api/complaints/${firstItem.id}/response`).set(auth('manager'))
    .send({ message: 'Respuesta inicial enviada.', humanApproved: true }).expect(200);

  const detail = await request(app).get(`/api/complaints/${firstItem.id}`).set(auth('manager')).expect(200);
  assert.ok(detail.body.item.firstResponseAt);
  assert.ok(detail.body.item.slaMinutes !== null);

  const stale = await request(app).post('/api/complaints').set(auth('manager')).send({
    branch: 'Zapopan',
    customerName: 'Cliente 3',
    description: 'Retraso en entrega',
    category: 'Entrega',
  }).expect(201);
  const staleDetail = await request(app).get(`/api/complaints/${stale.body.item.id}`).set(auth('admin')).expect(200);
  assert.ok(staleDetail.body.item.slaBreached || staleDetail.body.item.slaMinutes === null);
});

test('complaint AI drafts receive minimal context and never register or send a response', async () => {
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
    const contexts = [];
    const app = await createApp({
      foundryClient: async (_message, options) => {
        contexts.push(options.applicationContext);
        return { answer: 'Lamentamos el inconveniente. Revisaremos la información disponible.' };
      },
    });
    const complaint = await request(app).post('/api/complaints').set(auth('manager')).send({
      branch: 'Zapopan',
      customerName: 'Cliente sintético privado',
      description: 'Descripción sintética que no debe llegar al agente.',
      category: 'Entrega',
    }).expect(201);
    const draft = await request(app).post(`/api/complaints/${complaint.body.item.id}/draft-response`)
      .set(auth('manager')).send({}).expect(200);
    assert.equal(draft.body.requiresHumanApproval, true);
    assert.equal(draft.body.sentToCustomer, false);
    assert.equal(draft.body.draft, 'Lamentamos el inconveniente. Revisaremos la información disponible.');
    assert.deepEqual(contexts[0], {
      task: 'draft_complaint_response',
      origin: 'practice',
      synthetic: true,
      complaintCategory: 'Entrega',
      status: 'pending',
      firstResponseDueMinutes: 15,
      responseAlreadyRecorded: false,
    });
    assert.doesNotMatch(JSON.stringify(contexts), /Cliente sintético privado|Descripción sintética/);

    await request(app).get(`/api/complaints/${complaint.body.item.id}`).set(auth('manager'))
      .expect(200).expect((response) => {
        assert.equal(response.body.item.firstResponseAt, null);
      });
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
