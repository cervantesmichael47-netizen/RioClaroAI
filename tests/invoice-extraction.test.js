import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.RIOCLARO_DATA_FILE = ':memory:';

test('invoice extraction reports service unavailability without returning fabricated fields', async () => {
  const { createApp } = await import('../server/app.js');
  const unavailableExtractor = async () => {
    const error = new Error('Document Intelligence is not configured.');
    error.statusCode = 503;
    throw error;
  };
  const app = createApp({
    invoiceDocumentExtractor: unavailableExtractor,
    documentIntelligenceConfigured: false,
  });

  const result = await request(app).post('/api/invoices/extract')
    .set('Content-Type', 'application/pdf')
    .send(Buffer.from('%PDF-1.4 synthetic test'))
    .expect(503);
  assert.match(result.body.error, /no está configurado/);
  assert.equal(result.body.supplier, undefined);
  assert.equal(result.body.amount, undefined);
});

test('invoice extraction returns injected fields as unapproved and marks incomplete data', async () => {
  const { createApp } = await import('../server/app.js');
  let extractedDocument;
  const app = createApp({
    invoiceDocumentExtractor: async (document, mimeType) => {
      extractedDocument = { document, mimeType };
      return {
        supplier: 'Proveedor sintético OCR',
        reference: null,
        date: '2026-10-25',
        amount: 125.5,
        currency: 'MXN',
        items: [],
        confidence: 0.91,
        missingFields: ['reference'],
        status: 'incomplete',
      };
    },
    documentIntelligenceConfigured: true,
  });

  const result = await request(app).post('/api/invoices/extract')
    .set('Content-Type', 'application/pdf')
    .send(Buffer.from('%PDF-1.4 synthetic test'))
    .expect(200);
  assert.equal(extractedDocument.mimeType, 'application/pdf');
  assert.ok(Buffer.isBuffer(extractedDocument.document));
  assert.equal(result.body.supplier, 'Proveedor sintético OCR');
  assert.equal(result.body.reference, null);
  assert.equal(result.body.amount, 125.5);
  assert.equal(result.body.requiresHumanReview, true);
  assert.equal(result.body.documentStored, false);
  assert.deepEqual(result.body.missingFields, ['reference']);
  assert.equal(result.body.status, 'incomplete');
});

test('evaluation mode blocks external invoice documents before calling the extractor', async () => {
  const { createApp } = await import('../server/app.js');
  let called = false;
  const app = createApp({
    evaluationMode: true,
    invoiceDocumentExtractor: async () => {
      called = true;
      return {};
    },
    documentIntelligenceConfigured: true,
  });
  const result = await request(app).post('/api/invoices/extract')
    .set('Content-Type', 'application/pdf')
    .send(Buffer.from('%PDF-1.4 synthetic test'))
    .expect(403);
  assert.match(result.body.error, /deshabilitada en la evaluación pública/);
  assert.equal(called, false);
});

test('invoice UI connects extraction, currency, human review, and explicit submit controls', async () => {
  const { createApp } = await import('../server/app.js');
  const app = createApp();
  const page = await request(app).get('/').expect(200);
  assert.match(page.text, /id="invoice-document"/);
  assert.match(page.text, /name="amount"/);
  assert.match(page.text, /name="currency"/);
  assert.match(page.text, /id="invoice-review-form"/);
  assert.match(page.text, /id="invoice-review-evidence"/);

  const script = await request(app).get('/app.js').expect(200);
  assert.match(script.text, /addEventListener\('change', async \(event\) => \{\s*try \{\s*await extractInvoiceDocument/);
  assert.match(script.text, /addEventListener\('submit', submitInvoiceReview\)/);
  assert.match(script.text, /impuestos ni cargos/);
});
