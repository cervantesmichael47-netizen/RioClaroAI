import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.RIOCLARO_DATA_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const adminToken = 'chat-voice-test-admin';
const sessionId = '825cb746-6e65-4e31-b9f3-52f5aac1d762';
const foundryConversationId = 'c5a73e9c-1d3c-4c8f-a12a-1bc0c6a73892';
const tokenVerifier = async (token) => {
  if (token !== adminToken) throw new Error('Invalid test token.');
  return { userId: 'chat-voice-test-admin', roles: ['Administrator'], branch: null };
};
const auth = { Authorization: `Bearer ${adminToken}` };

process.env.FOUNDRY_ENABLED = 'true';
process.env.FOUNDRY_PROJECT_ENDPOINT = 'https://rioclaro.services.ai.azure.com/api/projects/test-project';
process.env.FOUNDRY_AGENT_NAME = 'RioClaroAssistant';

const { createApp } = await import('../server/app.js');

test('places voice controls in the main assistant composer and removes the separate inventory voice module', async () => {
  const app = createApp({ tokenVerifier });
  const page = await request(app).get('/').expect(200);
  assert.match(page.text, /id="chat-form"[^]*id="chat-input"[^]*id="chat-mic-button"[^]*id="chat-voice-cancel"/);
  assert.match(page.text, /id="chat-voice-status"[^]*aria-live="polite"/);
  assert.doesNotMatch(page.text, /inventory-mic-button|inventory-query-input|inventory-query-result/);
  await request(app).post('/api/inventory/query')
    .set(auth).send({ query: 'Cloro en Guadalajara' }).expect(404);
});

test('written and transcribed follow-ups use the same RioClaroAssistant conversation and authorized inventory context', async () => {
  const received = [];
  const app = createApp({
    tokenVerifier,
    foundryClient: async (message, options) => {
      received.push({ message, ...options });
      return {
        answer: 'Respuesta del adaptador de prueba.',
        sources: [],
        conversationId: foundryConversationId,
      };
    },
  });
  const headers = { 'X-Chat-Session': sessionId, ...auth };
  const firstMessage = '¿Cuánto cloro de un litro tenemos en Guadalajara?';
  const spokenFollowUp = '¿Y en León?';
  const spokenComparison = '¿Cuál tiene más?';

  const first = await request(app).post('/api/chat').set(headers)
    .send({ message: firstMessage }).expect(200);
  const second = await request(app).post('/api/chat').set(headers)
    .send({ message: spokenFollowUp, conversationId: first.body.conversationId }).expect(200);
  await request(app).post('/api/chat').set(headers)
    .send({ message: spokenComparison, conversationId: second.body.conversationId }).expect(200);

  assert.deepEqual(received.map(({ message }) => message), [
    firstMessage,
    spokenFollowUp,
    spokenComparison,
  ]);
  assert.equal(received[0].conversationId, undefined);
  assert.equal(received[1].conversationId, foundryConversationId);
  assert.equal(received[2].conversationId, foundryConversationId);
  assert.ok(received.every(({ ownerId }) => ownerId === 'chat-voice-test-admin'));

  const inventory = received[0].applicationContext.inventory;
  assert.equal(inventory.available, true);
  const branchStocks = inventory.records.flatMap((product) =>
    product.branches.map(({ name, stock }) => ({ product: product.name, branch: name, stock })),
  );
  assert.ok(branchStocks.some(({ branch, stock }) => branch === 'Guadalajara' && stock === 48));
  assert.ok(branchStocks.some(({ branch, stock }) => branch === 'León' && stock === 26));
  assert.deepEqual(received[1].applicationContext.inventory, inventory);
  assert.deepEqual(received[2].applicationContext.inventory, inventory);
});
