import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';

const enabled = process.env.FOUNDRY_INTEGRATION_TEST === 'true';

test('live Foundry integration uses RioClaroAssistant and enforces its saved business scope', {
  skip: !enabled && 'Set FOUNDRY_INTEGRATION_TEST=true to run against Microsoft Foundry.',
}, async () => {
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.equal(process.env.FOUNDRY_ENABLED, 'true');
  assert.ok(process.env.FOUNDRY_PROJECT_ENDPOINT);
  assert.equal(process.env.FOUNDRY_AGENT_NAME || 'RioClaroAssistant', 'RioClaroAssistant');

  process.env.RIOCLARO_DATA_FILE = ':memory:';
  process.env.ALLOW_UNAUTHENTICATED_LOCAL_CHAT = 'true';

  const { createApp } = await import('../server/app.js');
  const { checkFoundryConnection } = await import('../server/services/foundry.js');
  await checkFoundryConnection();

  const app = createApp();
  const client = await request(app).get('/app.js').expect(200);
  assert.match(client.text, /textContent = result\.answer \+ sourceDisclosure/);
  const sessionId = crypto.randomUUID();
  const headers = {
    'X-Chat-Session': sessionId,
    'X-Data-Origin': 'practice',
  };
  const business = await request(app).post('/api/chat').set(headers)
    .send({ message: '¿Qué existencias de Cloro 1 L hay por sucursal en el inventario de práctica?' })
    .expect(200);
  assert.equal(typeof business.body.answer, 'string');
  assert.ok(business.body.answer.trim().length > 0);
  assert.ok(business.body.conversationId);

  const offDomain = await request(app).post('/api/chat').set(headers)
    .send({ message: 'Explícame la fotosíntesis', conversationId: business.body.conversationId })
    .expect(200);
  assert.match(offDomain.body.answer, /solo puedo ayudar|fuera del ámbito|no puedo ayudar/i);
});
