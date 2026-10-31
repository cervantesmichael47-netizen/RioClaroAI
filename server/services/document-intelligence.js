import { DefaultAzureCredential } from '@azure/identity';

const apiVersion = '2024-11-30';
const modelId = 'prebuilt-invoice';
const credential = new DefaultAzureCredential();

function getEndpoint() {
  const value = process.env.DOCUMENT_INTELLIGENCE_ENDPOINT?.trim();
  if (!value) return null;
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'https:'
    || !/^[a-z0-9-]+\.cognitiveservices\.azure\.com$/i.test(endpoint.hostname)
    || endpoint.pathname !== '/'
    || endpoint.search
    || endpoint.hash
  ) {
    throw new Error('Invalid Document Intelligence endpoint.');
  }
  return endpoint;
}

export function isDocumentIntelligenceConfigured() {
  try {
    return Boolean(getEndpoint());
  } catch {
    return false;
  }
}

function fieldValue(fields, name) {
  const field = fields?.[name];
  if (!field || typeof field !== 'object') return { value: null, confidence: null };
  const value = field.valueString
    ?? field.valueDate
    ?? field.valueNumber
    ?? field.valueCurrency?.amount
    ?? field.content
    ?? null;
  return {
    value: typeof value === 'string' || typeof value === 'number' ? value : null,
    confidence: Number.isFinite(field.confidence) ? field.confidence : null,
  };
}

export function parseInvoiceResult(payload) {
  const fields = payload?.analyzeResult?.documents?.[0]?.fields ?? {};
  const supplier = fieldValue(fields, 'VendorName');
  const reference = fieldValue(fields, 'InvoiceId');
  const date = fieldValue(fields, 'InvoiceDate');
  const total = fieldValue(fields, 'InvoiceTotal');
  const currencyCode = fields.InvoiceTotal?.valueCurrency?.currencyCode;
  const currencySupported = ['MXN', 'USD', 'EUR'].includes(currencyCode);
  const amount = currencySupported ? total.value : null;
  const itemsField = fields.Items;
  const items = Array.isArray(itemsField?.valueArray)
    ? itemsField.valueArray.map(({ valueObject = {} }) => {
      const description = fieldValue(valueObject, 'Description').value;
      const quantity = fieldValue(valueObject, 'Quantity').value;
      const unitPrice = fieldValue(valueObject, 'UnitPrice').value;
      return {
        description: typeof description === 'string' ? description : '',
        quantity: Number.isInteger(Number(quantity)) ? Number(quantity) : null,
        unitPrice: Number.isFinite(Number(unitPrice)) ? Number(unitPrice) : null,
      };
    })
    : [];
  const values = [supplier, reference, date, total];
  const confidences = values.map(({ confidence }) => confidence).filter(Number.isFinite);
  const missingFields = [
    ...(typeof supplier.value === 'string' && supplier.value.trim() ? [] : ['supplier']),
    ...(typeof reference.value === 'string' && reference.value.trim() ? [] : ['reference']),
    ...(typeof date.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.value) ? [] : ['date']),
    ...(typeof amount === 'number' && amount > 0 ? [] : ['amount']),
    ...(currencySupported ? [] : ['currency']),
  ];

  return {
    supplier: typeof supplier.value === 'string' ? supplier.value : null,
    reference: typeof reference.value === 'string' ? reference.value : null,
    date: typeof date.value === 'string' ? date.value : null,
    amount: typeof amount === 'number' ? amount : null,
    currency: currencySupported ? currencyCode : null,
    items,
    confidence: confidences.length
      ? confidences.reduce((sum, confidence) => sum + confidence, 0) / confidences.length
      : null,
    missingFields,
    status: missingFields.length ? 'incomplete' : 'complete',
    requiresHumanReview: true,
  };
}

export async function extractInvoiceDocument(document, mimeType) {
  const endpoint = getEndpoint();
  if (!endpoint) {
    const error = new Error('Document Intelligence is not configured.');
    error.statusCode = 503;
    throw error;
  }
  if (!Buffer.isBuffer(document) || document.length === 0 || document.length > 5 * 1024 * 1024) {
    const error = new Error('The invoice document size is invalid.');
    error.statusCode = 400;
    throw error;
  }
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mimeType)) {
    const error = new Error('The invoice document type is not supported.');
    error.statusCode = 415;
    throw error;
  }

  const token = await credential.getToken('https://cognitiveservices.azure.com/.default');
  if (!token?.token) {
    const error = new Error('Managed identity did not return a Document Intelligence token.');
    error.statusCode = 503;
    throw error;
  }
  const analyzeUrl = new URL(
    `documentintelligence/documentModels/${modelId}:analyze?api-version=${apiVersion}`,
    endpoint,
  );
  const analyzeResponse = await fetch(analyzeUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': mimeType,
    },
    body: document,
    signal: AbortSignal.timeout(10_000),
  });
  if (analyzeResponse.status !== 202) {
    const error = new Error('Document Intelligence did not accept the invoice document.');
    error.statusCode = analyzeResponse.status === 401 || analyzeResponse.status === 403 ? 503 : 502;
    throw error;
  }

  const operationLocation = analyzeResponse.headers.get('operation-location');
  if (!operationLocation) {
    const error = new Error('Document Intelligence omitted the operation URL.');
    error.statusCode = 502;
    throw error;
  }
  const operationUrl = new URL(operationLocation);
  if (operationUrl.origin !== endpoint.origin) {
    const error = new Error('Document Intelligence returned an invalid operation URL.');
    error.statusCode = 502;
    throw error;
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const resultResponse = await fetch(operationUrl, {
      headers: { Authorization: `Bearer ${token.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resultResponse.ok) {
      const error = new Error('Document Intelligence analysis could not be retrieved.');
      error.statusCode = 502;
      throw error;
    }
    const result = await resultResponse.json();
    if (result.status === 'succeeded') return parseInvoiceResult(result);
    if (result.status === 'failed') {
      const error = new Error('Document Intelligence could not read the invoice.');
      error.statusCode = 422;
      throw error;
    }
  }
  const error = new Error('Document Intelligence analysis timed out.');
  error.statusCode = 504;
  throw error;
}
