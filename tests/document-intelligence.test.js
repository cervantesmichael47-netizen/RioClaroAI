import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoiceResult } from '../server/services/document-intelligence.js';

test('parses supported invoice currency and leaves human verification required', () => {
  const result = parseInvoiceResult({
    analyzeResult: {
      documents: [{
        fields: {
          VendorName: { valueString: 'Proveedor sintético', confidence: 0.99 },
          InvoiceId: { valueString: 'OCR-001', confidence: 0.98 },
          InvoiceDate: { valueDate: '2026-10-25', confidence: 0.97 },
          InvoiceTotal: {
            valueCurrency: { amount: 125.5, currencyCode: 'USD' },
            confidence: 0.96,
          },
          Items: {
            valueArray: [{
              valueObject: {
                Description: { valueString: 'Artículo sintético' },
                Quantity: { valueNumber: 1 },
                UnitPrice: { valueCurrency: { amount: 125.5, currencyCode: 'USD' } },
              },
            }],
          },
        },
      }],
    },
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.amount, 125.5);
  assert.equal(result.currency, 'USD');
  assert.equal(result.items[0].quantity, 1);
  assert.equal(result.items[0].unitPrice, 125.5);
  assert.equal(result.requiresHumanReview, true);
});

test('does not assign an amount when the OCR currency is unsupported or missing', () => {
  const result = parseInvoiceResult({
    analyzeResult: {
      documents: [{
        fields: {
          InvoiceTotal: {
            valueCurrency: { amount: 125.5, currencyCode: 'CAD' },
            confidence: 0.9,
          },
        },
      }],
    },
  });

  assert.equal(result.amount, null);
  assert.equal(result.currency, null);
  assert.deepEqual(result.missingFields, ['supplier', 'reference', 'date', 'amount', 'currency']);
  assert.equal(result.status, 'incomplete');
});
