import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import request from 'supertest';

test('serves the complaint workflow and connects its controls to the existing API contracts', async () => {
  const { createApp } = await import('../server/app.js');
  const app = createApp({ staticDirectory: path.resolve('public') });

  const page = await request(app).get('/').expect(200);
  assert.match(page.text, /Atención de reclamaciones/);
  assert.match(page.text, /id="complaint-form"/);
  assert.match(page.text, /id="complaint-branch-filter"/);
  assert.match(page.text, /id="complaint-status-filter"/);
  assert.match(page.text, /id="complaint-detail-dialog"/);
  assert.match(page.text, /aria-live="polite"/);

  const script = await request(app).get('/app.js').expect(200);
  assert.match(script.text, /api\('\/api\/complaints'/);
  assert.match(script.text, /\/api\/complaints\/\$\{complaintId\}\/status/);
  assert.match(script.text, /\/api\/complaints\/\$\{complaintId\}\/response/);
  assert.match(script.text, /data-draft-response/);
  assert.match(script.text, /name="humanApproved"/);
  assert.match(script.text, /humanApproved: form\.elements\.namedItem\('humanApproved'\)\.checked/);
  assert.match(script.text, /item\.branch !== branch/);
  assert.match(script.text, /item\.branch !== selectedBranch/);
});
