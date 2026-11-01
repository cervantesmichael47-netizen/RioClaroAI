import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import {
  addProduct,
  addInvoice,
  assignInvoiceProduct,
  confirmProductEquivalence,
  deleteComplaint,
  deleteInvoice,
  deleteProduct,
  getComplaint,
  getComplaintSlaSummary,
  getInvoice,
  getProductDetails,
  getDashboard,
  getNormalizationReport,
  inspectProductRegistration,
  listComplaints,
  listInvoices,
  listInventoryMovements,
  listProducts,
  matchInvoiceProduct,
  resetPracticeData,
  reviewInvoice,
  createComplaint,
  updateComplaintStatus,
  updateProduct,
  addComplaintResponse,
} from './data/store.js';
import { getSalesReport, salesBranches } from './data/sales.js';
import {
  askFoundry,
  checkFoundryConnection,
  getFoundryAvailability,
  isFoundryConfigured,
  setFoundryAvailability,
} from './services/foundry.js';
import { extractInvoiceDocument, isDocumentIntelligenceConfigured } from './services/document-intelligence.js';
import { recordAudit, listAuditEvents } from './security/audit.js';
import { branchIsAllowed, createAuthentication, entraIsConfigured } from './security/auth.js';

const branches = ['Guadalajara', 'Zapopan', 'León', 'Querétaro', 'Aguascalientes'];
const productRoles = ['Administrator', 'BranchManager', 'Warehouse'];
const invoiceRoles = ['Administrator', 'AccountsPayable'];
const complaintRoles = ['Administrator', 'BranchManager'];
const salesRoles = ['Administrator', 'BranchManager'];
const sensitiveInput = /(?:\bpassword\b|\bcontraseña\b|\b(?:api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret|secret key)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}\b|\b\d{10,18}\b|(?:\+?\d[\d ()-]{8,}\d))/i;
const sensitiveOutput = /(?:\b(?:api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret|password)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}\b|\b\d{10,18}\b|(?:\+?\d[\d ()-]{8,}\d))/i;

function isValidInvoiceDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function configuredOrigins() {
  return (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function pathsMatch(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function rateLimitHandler(_request, response) {
  response.status(429).json({ error: 'Se alcanzó el límite de solicitudes. Intenta de nuevo más tarde.' });
}

function getDataOrigin(request, response) {
  if (request.evaluationMode) return 'practice';
  const origin = request.get('x-data-origin') || 'practice';
  if (!['practice', 'operational'].includes(origin)) {
    response.status(400).json({ error: 'Selecciona un conjunto de datos válido.' });
    return null;
  }
  if (origin === 'operational' && !request.identity) {
    response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para consultar datos operativos.' });
    return null;
  }
  return origin;
}

function assistantDataContext({ origin, identity, branches: availableBranches }) {
  const isAdministrator = identity?.roles.includes('Administrator') ?? false;
  const canReadProducts = !identity
    ? origin === 'practice'
    : isAdministrator || (
      Boolean(identity.branch)
      && identity.roles.some((role) => productRoles.includes(role))
    );
  const canReadInvoices = !identity
    ? origin === 'practice'
    : isAdministrator || identity.roles.some((role) => invoiceRoles.includes(role));
  const allowedBranches = identity && !isAdministrator
    ? availableBranches.filter((branch) => branchIsAllowed(identity, branch))
    : undefined;
  const productRecords = canReadProducts
    ? listProducts({ allowedBranches, origin })
    : [];
  const invoiceRecords = canReadInvoices ? listInvoices(origin) : [];
  const limit = 25;

  return {
    origin,
    originDescription: origin === 'practice'
      ? 'Datos de práctica; no son registros verificados de la empresa.'
      : 'Registros operativos guardados en esta aplicación; no implican conexión a un ERP.',
    capturedAt: new Date().toISOString(),
    inventory: {
      available: canReadProducts,
      reason: canReadProducts ? undefined : 'El rol actual no permite consultar inventario.',
      totalRecords: productRecords.length,
      truncated: productRecords.length > limit,
      records: productRecords.slice(0, limit).map((product) => ({
        id: product.id,
        name: product.name,
        category: product.category,
        branch: product.branch,
        stock: product.stock,
        branches: product.branches,
        aliases: product.aliases,
        normalizationStatus: product.normalizationStatus,
        reviewRequired: product.reviewRequired,
        ...(product.suggestedCanonicalName
          ? { suggestedCanonicalName: product.suggestedCanonicalName }
          : {}),
      })),
      recentMovements: canReadProducts
        ? listInventoryMovements(origin, allowedBranches).slice(-limit).map((movement) => ({
          id: movement.id,
          invoiceId: movement.invoiceId,
          productId: movement.productId,
          quantity: movement.quantity,
          branch: movement.branch,
          type: movement.type,
          createdAt: movement.createdAt,
        }))
        : [],
    },
    invoices: {
      available: canReadInvoices,
      reason: canReadInvoices ? undefined : 'El rol actual no permite consultar facturas.',
      totalRecords: invoiceRecords.length,
      truncated: invoiceRecords.length > limit,
      records: invoiceRecords.slice(0, limit).map((invoice) => ({
        id: invoice.id,
        supplier: invoice.supplier,
        reference: invoice.reference,
        date: invoice.date,
        amount: invoice.amount,
        branch: invoice.branch,
        status: invoice.status,
        possibleDuplicate: invoice.possibleDuplicate,
        items: (Array.isArray(invoice.items) ? invoice.items : []).slice(0, 20).map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          tax: item.tax,
          amount: item.amount,
          productId: item.productId,
          matchedProductName: item.matchedProductName,
          requiresHumanReview: item.requiresHumanReview,
        })),
        itemsTruncated: (Array.isArray(invoice.items) ? invoice.items.length : 0) > 20,
      })),
    },
    unavailableCapabilities: [
      'No se dispone aquí de una conexión a la base de conocimiento documental ni al PDF empresarial.',
      'No hay herramientas de chat para escribir registros, consultar pagos ni ejecutar acciones financieras.',
      'No hay datos consultables de proveedores o clientes en este contexto.',
    ],
  };
}

export function createApp({
  staticDirectory = path.resolve('public'),
  tokenVerifier,
  foundryClient = askFoundry,
  foundryConnectionCheck = checkFoundryConnection,
  invoiceDocumentExtractor = extractInvoiceDocument,
  documentIntelligenceConfigured = isDocumentIntelligenceConfigured(),
  keyVaultConfigured = Boolean(process.env.KEY_VAULT_URL && process.env.KEY_VAULT_SECRET_NAMES),
  evaluationMode = process.env.RIOCLARO_EVALUATION_MODE === 'true',
} = {}) {
  const app = express();
  const ephemeralTestStore = process.env.NODE_ENV !== 'production'
    && process.env.RIOCLARO_DATA_FILE === ':memory:';
  if (evaluationMode && !ephemeralTestStore) {
    const dedicatedFiles = [
      {
        evaluation: process.env.RIOCLARO_EVALUATION_DATA_FILE,
        active: process.env.RIOCLARO_DATA_FILE,
        default: path.resolve('server', 'data', 'rioclaro-data.json'),
      },
      {
        evaluation: process.env.RIOCLARO_EVALUATION_AUDIT_FILE,
        active: process.env.RIOCLARO_AUDIT_FILE,
        default: path.resolve('server', 'data', 'audit-log.json'),
      },
      {
        evaluation: process.env.RIOCLARO_EVALUATION_CONVERSATIONS_FILE,
        active: process.env.FOUNDRY_CONVERSATIONS_FILE,
        default: path.resolve('server', 'data', 'foundry-conversations.json'),
      },
    ];
    const evaluationFiles = dedicatedFiles.map(({ evaluation }) => evaluation);
    if (
      dedicatedFiles.some(({ evaluation, active, default: defaultFile }) =>
        !evaluation
        || !path.isAbsolute(evaluation)
        || !active
        || !pathsMatch(evaluation, active)
        || pathsMatch(evaluation, defaultFile),
      )
      || evaluationFiles.some((file, index) =>
        evaluationFiles.some((otherFile, otherIndex) =>
          index !== otherIndex && pathsMatch(file, otherFile),
        ),
      )
    ) {
      throw new Error('El modo de evaluación requiere un archivo de persistencia dedicado y configurado explícitamente.');
    }
  }
  const aiConfigured = isFoundryConfigured();
  const canEnableAI = process.env.FOUNDRY_ENABLED === 'true' && aiConfigured;
  const localChatEnabled = process.env.NODE_ENV !== 'production'
    && process.env.ALLOW_UNAUTHENTICATED_LOCAL_CHAT === 'true';
  const practiceWritesEnabled = process.env.NODE_ENV !== 'production';
  let aiSuspended = process.env.FOUNDRY_SUSPENDED === 'true';
  const evaluationOrRoles = (...roles) => {
    const requireRole = auth.requireRoles(...roles);
    return (request, response, next) => {
      if (evaluationMode && !request.identity) return next();
      return requireRole(request, response, next);
    };
  };
  function authorizeComplaintAccess(request, response, origin, branch = null, requireAuthenticatedWrite = false) {
    if (origin === 'operational' && !request.identity) {
      response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para consultar reclamaciones operativas.' });
      return false;
    }
    if (requireAuthenticatedWrite && !request.identity && !practiceWritesEnabled && !evaluationMode) {
      response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para modificar reclamaciones.' });
      return false;
    }
    if (request.identity && !request.identity.roles.some((role) => complaintRoles.includes(role))) {
      response.status(403).json({ error: 'Tu rol no tiene permiso para esta operación de reclamaciones.' });
      return false;
    }
    if (request.identity && !request.identity.roles.includes('Administrator')) {
      if (!request.identity.branch) {
        response.status(403).json({ error: 'Tu usuario no tiene una sucursal asignada para consultar reclamaciones.' });
        return false;
      }
      if (branch && !branchIsAllowed(request.identity, branch)) {
        response.status(403).json({ error: 'No tienes permiso para consultar reclamaciones de otra sucursal.' });
        return false;
      }
    }
    return true;
  }

  function requireEvaluationMode(request, response, next) {
    if (!evaluationMode) {
      recordAudit('demo_delete', 'denied', request.identity?.userId ?? null, 'evaluation_mode_disabled');
      return response.status(403).json({ error: 'Esta operación solo está disponible para datos sintéticos de demostración.' });
    }
    next();
  }

  app.disable('x-powered-by');
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use((request, response, next) => {
    request.requestId = crypto.randomUUID();
    response.setHeader('X-Request-Id', request.requestId);
    if (
      process.env.NODE_ENV === 'production'
      && !request.secure
      && request.get('x-forwarded-proto') !== 'https'
    ) {
      return response.status(400).json({ error: 'La conexión debe usar HTTPS.' });
    }
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: process.env.NODE_ENV === 'production' ? undefined : false,
  }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || configuredOrigins().includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Chat-Session', 'X-Data-Origin'],
    credentials: false,
    maxAge: 600,
  }));
  app.use(express.json({ limit: '16kb', strict: true, type: 'application/json' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 30 }));
  app.use('/api', rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rateLimitHandler,
  }));
  app.use('/api', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    next();
  });

  const authOptions = tokenVerifier ? { tokenVerifier, recordAudit } : { recordAudit };
  const auth = createAuthentication(authOptions);
  const requireWriteRoles = (...roles) => {
    const requireRole = auth.requireRoles(...roles);
    return (request, response, next) => {
      if (
        !request.identity
        && (evaluationMode || (
          practiceWritesEnabled
          && request.get('x-data-origin') !== 'operational'
        ))
      ) return next();
      return requireRole(request, response, next);
    };
  };
  app.use('/api', auth.optionalIdentity);
  app.use('/api', (request, _response, next) => {
    request.evaluationMode = evaluationMode;
    next();
  });
  app.use(express.static(staticDirectory, {
    dotfiles: 'ignore',
    index: 'index.html',
    fallthrough: true,
    setHeaders(response) {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'no-store');
    },
  }));

  app.get(['/health', '/api/health'], (_request, response) => {
    response.json({
      status: 'ok',
      server: 'operational',
      persistence: 'file',
      evaluationMode,
      foundryConfigured: aiConfigured,
      foundryEnabled: canEnableAI && !aiSuspended,
      foundryConnection: getFoundryAvailability(),
    });
  });

  app.get('/api/security/status', (_request, response) => {
    response.json({
      authenticationConfigured: entraIsConfigured(),
      authenticationPending: !entraIsConfigured(),
      evaluationMode,
      keyVaultConfigured,
      documentIntelligenceConfigured,
      aiConfigured,
      aiEnabled: canEnableAI && !aiSuspended,
      aiSuspended,
      localChatEnabled,
      practiceWritesEnabled,
      foundryConnection: {
        ...getFoundryAvailability(),
        suspended: aiSuspended,
      },
    });
  });

  app.post('/api/foundry/check', rateLimit({
    windowMs: 60_000,
    limit: 3,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rateLimitHandler,
  }), async (_request, response) => {
    if (!aiConfigured) {
      setFoundryAvailability('unconfigured', 'Foundry no está configurado.');
      return response.json({
        configured: false,
        connected: false,
        message: 'Configura FOUNDRY_PROJECT_ENDPOINT para verificar el agente.',
      });
    }
    if (!canEnableAI || aiSuspended) {
      setFoundryAvailability(aiSuspended ? 'suspended' : 'disabled', 'La integración no está habilitada.');
      return response.json({
        configured: true,
        connected: false,
        message: 'La integración está desactivada. Revisa FOUNDRY_ENABLED y FOUNDRY_SUSPENDED.',
      });
    }
    try {
      setFoundryAvailability('connecting', 'Comprobando disponibilidad del agente.');
      await foundryConnectionCheck();
      setFoundryAvailability('connected', 'El agente RioClaroAssistant está disponible.', true);
      response.json({ configured: true, connected: true, message: 'El agente RioClaroAssistant está accesible.' });
    } catch (error) {
      const rateLimited = (error.statusCode ?? error.status) === 429;
      setFoundryAvailability(rateLimited ? 'rate_limited' : 'unavailable', 'El agente no está disponible en este momento.');
      console.warn(JSON.stringify({
        event: 'foundry_connection_check_failed',
        category: rateLimited ? 'rate_limit' : error.statusCode === 503 ? 'configuration' : 'service',
      }));
      response.json({
        configured: true,
        connected: false,
        message: rateLimited
          ? 'Foundry está limitando temporalmente las solicitudes.'
          : error.statusCode === 503
          ? 'La configuración de Foundry no es válida.'
          : 'No fue posible verificar Foundry. Revisa autenticación, permisos y conectividad.',
      });
    }
  });

  app.get('/api/dashboard', (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    if (origin === 'operational' && !request.identity) {
      return response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para consultar datos operativos.' });
    }
    if (origin === 'operational' && !request.identity.roles.includes('Administrator')) {
      return response.status(403).json({ error: 'Solo un administrador puede consultar el resumen operativo.' });
    }
    response.json(getDashboard({ origin }));
  });

  function getAuthorizedSalesReport(request, response) {
    const origin = getDataOrigin(request, response);
    if (!origin) return null;
    if (origin === 'operational') {
      if (!request.identity) {
        response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para consultar datos operativos.' });
      } else {
        response.status(503).json({ error: 'No hay una fuente de ventas operativa configurada.' });
      }
      return null;
    }
    let branch = typeof request.query.branch === 'string' && request.query.branch.trim()
      ? request.query.branch.trim()
      : null;
    if (branch && !salesBranches.includes(branch)) {
      response.status(400).json({ error: 'La sucursal indicada no es válida.' });
      return null;
    }
    if (request.identity) {
      if (!request.identity.roles.some((role) => salesRoles.includes(role))) {
        response.status(403).json({ error: 'Tu rol no tiene permiso para consultar reportes de ventas.' });
        return null;
      }
      if (!request.identity.roles.includes('Administrator')) {
        if (!request.identity.branch) {
          response.status(403).json({ error: 'El token verificado no tiene una sucursal asignada.' });
          return null;
        }
        if (branch && !branchIsAllowed(request.identity, branch)) {
          response.status(403).json({ error: 'No tienes permiso para consultar ventas de otra sucursal.' });
          return null;
        }
        branch = request.identity.branch;
      }
    }
    const today = new Date();
    const defaultTo = today.toISOString().slice(0, 10);
    const defaultFromDate = new Date(today);
    defaultFromDate.setUTCDate(defaultFromDate.getUTCDate() - 6);
    const from = typeof request.query.from === 'string' ? request.query.from : defaultFromDate.toISOString().slice(0, 10);
    const to = typeof request.query.to === 'string' ? request.query.to : defaultTo;
    if (!isValidInvoiceDate(from) || !isValidInvoiceDate(to) || from > to) {
      response.status(400).json({ error: 'Indica un periodo válido con fechas AAAA-MM-DD.' });
      return null;
    }
    if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 > 365) {
      response.status(400).json({ error: 'El periodo no puede superar 366 días.' });
      return null;
    }
    return getSalesReport({ from, to, branch });
  }

  app.get('/api/sales', (request, response) => {
    const report = getAuthorizedSalesReport(request, response);
    if (!report) return;
    response.json(report);
  });

  app.post('/api/sales/summary', async (request, response) => {
    const report = getAuthorizedSalesReport(request, response);
    if (!report) return;
    if (process.env.FOUNDRY_SUSPENDED === 'true' || aiSuspended || !canEnableAI) {
      return response.status(503).json({ error: 'No hay una conexión disponible con Foundry. No se generó un resumen de IA.' });
    }
    const ownerId = request.identity?.userId;
    if (!ownerId && !evaluationMode && !localChatEnabled) {
      return response.status(401).json({ error: 'Inicia sesión para solicitar un resumen con IA.' });
    }
    const localSessionId = ownerId ? null : request.get('x-chat-session');
    if (!ownerId && (typeof localSessionId !== 'string'
      || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(localSessionId))) {
      return response.status(422).json({ error: 'La sesión local de conversación no es válida.' });
    }
    try {
      const result = await foundryClient(
        'Resume brevemente los indicadores numéricos proporcionados, destaca comparaciones observables y reconoce si no hay datos. No agregues cifras, causas ni recomendaciones no contenidas en el contexto. Este resumen es orientación y requiere revisión humana.',
        {
          applicationContext: { task: 'synthetic_sales_summary', salesReport: report },
          conversationId: request.body?.conversationId,
          ownerId: ownerId ?? `local:${localSessionId}`,
        },
      );
      if (!result || typeof result.answer !== 'string' || !result.answer.trim()
        || sensitiveOutput.test(result.answer)) {
        return response.status(502).json({ error: 'El resumen del asistente no pasó los controles y no está disponible.' });
      }
      response.json({
        summary: result.answer.trim(),
        conversationId: result.conversationId ?? null,
        requiresHumanReview: true,
        source: 'synthetic-sales-report',
      });
    } catch {
      response.status(502).json({ error: 'No fue posible obtener un resumen de Foundry. El reporte calculado sigue disponible.' });
    }
  });

  app.get('/api/products', (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    if (origin === 'operational' && !request.identity) {
      return response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para consultar datos operativos.' });
    }
    if (request.identity) {
      if (!request.identity.roles.some((role) => productRoles.includes(role))) {
        recordAudit('product_read', 'denied', request.identity.userId, 'role_denied');
        return response.status(403).json({ error: 'Tu rol no tiene permiso para consultar inventario.' });
      }
      if (!request.identity.roles.includes('Administrator') && !request.identity.branch) {
        recordAudit('product_read', 'denied', request.identity.userId, 'branch_missing');
        return response.status(403).json({ error: 'El token verificado no tiene una sucursal asignada.' });
      }
    }
    const allowedBranches = request.identity && !request.identity.roles.includes('Administrator')
      ? branches.filter((branch) => branchIsAllowed(request.identity, branch))
      : undefined;
    const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
    if (search.length > 100) {
      return response.status(400).json({ error: 'La búsqueda no puede superar 100 caracteres.' });
    }
    const items = listProducts({ allowedBranches, origin, search });
    response.json({ items, origin });
  });

  app.get('/api/products/normalization-report', (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    if (origin === 'operational' && !request.identity) {
      return response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para consultar datos operativos.' });
    }
    if (request.identity && !request.identity.roles.includes('Administrator')) {
      recordAudit('product_normalization_report', 'denied', request.identity.userId, 'role_denied');
      return response.status(403).json({ error: 'Solo un administrador puede consultar el informe de normalización.' });
    }
    response.json(getNormalizationReport(origin));
  });

  app.get('/api/products/:productId', (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    if (origin === 'operational' && !request.identity) {
      return response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para consultar datos operativos.' });
    }
    if (request.identity && !request.identity.roles.some((role) => productRoles.includes(role))) {
      recordAudit('product_read', 'denied', request.identity.userId, 'role_denied');
      return response.status(403).json({ error: 'Tu rol no tiene permiso para consultar inventario.' });
    }
    if (request.identity && !request.identity.roles.includes('Administrator') && !request.identity.branch) {
      return response.status(403).json({ error: 'El token verificado no tiene una sucursal asignada.' });
    }
    const productId = Number(request.params.productId);
    if (!Number.isSafeInteger(productId) || productId < 1) {
      return response.status(400).json({ error: 'El identificador del producto no es válido.' });
    }
    const allowedBranches = request.identity && !request.identity.roles.includes('Administrator')
      ? branches.filter((branch) => branchIsAllowed(request.identity, branch))
      : undefined;
    const result = getProductDetails({
      productId,
      allowedBranches,
      origin,
      includeInvoiceReferences: !request.identity
        || request.identity.roles.some((role) => invoiceRoles.includes(role)),
    });
    if (!result) return response.status(404).json({ error: 'No se encontró el producto.' });
    response.json(result);
  });

  app.post('/api/products', requireWriteRoles(...productRoles), (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const { name, category, branch, stock } = request.body ?? {};
    if (![name, category, branch].every((value) => typeof value === 'string' && value.trim())) {
      return response.status(400).json({ error: 'Nombre, categoría y sucursal son obligatorios.' });
    }
    if (!branches.includes(branch.trim())) {
      return response.status(400).json({ error: 'Selecciona una de las sucursales disponibles.' });
    }
    if (name.trim().length > 100 || category.trim().length > 80 || branch.trim().length > 80) {
      return response.status(400).json({ error: 'Revisa la longitud de los campos.' });
    }
    if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) {
      return response.status(400).json({ error: 'La existencia debe ser un entero entre 0 y 1,000,000.' });
    }
    if (request.identity && !branchIsAllowed(request.identity, branch.trim())) {
      recordAudit('product_write', 'denied', request.identity.userId, 'branch_scope_denied');
      return response.status(403).json({ error: 'Solo puedes registrar productos para tu sucursal asignada.' });
    }
    const registration = inspectProductRegistration({
      name: name.trim(),
      category: category.trim(),
      branch: branch.trim(),
      origin,
    });
    if (registration.reviewRequired) {
      return response.status(409).json({
        error: 'El nombre coincide con un candidato pendiente de revisión humana. No se creó otro registro.',
        requiresHumanReview: true,
        suggestedCanonicalName: registration.canonicalName,
      });
    }
    if (registration.duplicate) {
      return response.status(409).json({
        error: 'Ya existe un producto equivalente en esta sucursal.',
        existingProductId: registration.existingId,
        ...(registration.canonicalName ? { canonicalName: registration.canonicalName } : {}),
      });
    }
    const registrationResult = addProduct({
      name: registration.canonicalName ?? name.trim(),
      category: category.trim(),
      branch: branch.trim(),
      stock,
      origin,
      ...(registration.equivalenceGroupId ? { equivalenceGroupId: registration.equivalenceGroupId } : {}),
    });
    if (registrationResult.requiresHumanReview) {
      return response.status(409).json({
        error: 'El nombre requiere revisión humana; no se creó otro registro.',
        requiresHumanReview: true,
        suggestedCanonicalName: registrationResult.canonicalName,
      });
    }
    if (registrationResult.duplicate) {
      return response.status(409).json({
        error: 'Ya existe una ficha para este producto en la sucursal seleccionada.',
        existingProductId: registrationResult.id,
        canonicalProductId: registrationResult.canonicalProductId,
      });
    }
    const { duplicate: _duplicate, requiresHumanReview: _review, ...item } = registrationResult;
    recordAudit('product_write', 'success', request.identity?.userId ?? null);
    response.status(201).json({ item, origin });
  });

  app.patch('/api/products/:productId', requireEvaluationMode, (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const productId = Number(request.params.productId);
    if (!Number.isSafeInteger(productId) || productId < 1) {
      return response.status(400).json({ error: 'El identificador del producto no es válido.' });
    }

    const body = request.body ?? {};
    const allowedFields = ['name', 'category', 'branch'];
    if (
      !body
      || typeof body !== 'object'
      || Array.isArray(body)
      || Object.keys(body).some((field) => !allowedFields.includes(field))
      || !allowedFields.every((field) => typeof body[field] === 'string' && body[field].trim())
    ) {
      return response.status(400).json({ error: 'Nombre, categoría y sucursal son obligatorios; no se permiten otros campos.' });
    }
    const { name, category, branch } = body;
    if (!branches.includes(branch.trim())) {
      return response.status(400).json({ error: 'Selecciona una de las sucursales disponibles.' });
    }
    if (name.trim().length > 100 || category.trim().length > 80 || branch.trim().length > 80) {
      return response.status(400).json({ error: 'Revisa la longitud de los campos.' });
    }
    if (request.identity && !branchIsAllowed(request.identity, branch.trim())) {
      recordAudit('demo_product_update', 'denied', request.identity.userId, 'branch_scope_denied');
      return response.status(403).json({ error: 'Solo puedes asignar productos a tu sucursal.' });
    }

    const result = updateProduct({
      productId,
      name: name.trim(),
      category: category.trim(),
      branch: branch.trim(),
      origin,
    });
    if (result.error) {
      const status = result.error === 'No se encontró el producto.' ? 404 : 409;
      recordAudit('demo_product_update', 'denied', request.identity?.userId ?? null, `product:${productId}`);
      return response.status(status).json({ error: result.error });
    }
    recordAudit('demo_product_update', 'success', request.identity?.userId ?? null, `product:${productId}`);
    response.json({ item: result, origin });
  });

  app.delete('/api/products/:productId', requireEvaluationMode, (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const productId = Number(request.params.productId);
    if (!Number.isSafeInteger(productId) || productId < 1) {
      return response.status(400).json({ error: 'El identificador del producto no es válido.' });
    }
    const result = deleteProduct({ productId, origin });
    if (result.error) {
      const status = result.error === 'No se encontró el producto.' ? 404 : 409;
      recordAudit('demo_product_delete', 'denied', request.identity?.userId ?? null, `product:${productId}`);
      return response.status(status).json({ error: result.error });
    }
    recordAudit('demo_product_delete', 'success', request.identity?.userId ?? null, `product:${productId};records:${result.count}`);
    response.json({ ...result, origin });
  });

  app.post('/api/products/equivalences/confirm', evaluationOrRoles('Administrator'), (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const { productIds, evidence } = request.body ?? {};
    if (
      !Array.isArray(productIds)
      || productIds.length < 2
      || productIds.some((id) => !Number.isInteger(id))
      || new Set(productIds).size !== productIds.length
      || typeof evidence !== 'string'
      || evidence.trim().length < 20
      || evidence.trim().length > 500
      || Object.keys(request.body ?? {}).some((key) => !['productIds', 'evidence'].includes(key))
    ) {
      return response.status(400).json({
        error: 'Indica los IDs candidatos y una justificación de revisión humana (20 a 500 caracteres).',
      });
    }
    const result = confirmProductEquivalence({ productIds, evidence: evidence.trim(), origin });
    if (result.error) {
      return response.status(409).json({ error: result.error, requiresHumanReview: true });
    }
    recordAudit(
      'product_equivalence_confirmed',
      'success',
      request.identity?.userId ?? null,
      `source_ids:${[...result.item.sourceIds].sort((left, right) => left - right).join(',')}`,
    );
    response.json({ item: result.item, confirmedAt: result.confirmedAt, origin });
  });

  app.get('/api/invoices', (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    if (origin === 'operational' && !request.identity) {
      return response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para consultar datos operativos.' });
    }
    if (request.identity && !request.identity.roles.some((role) => invoiceRoles.includes(role))) {
      recordAudit('invoice_read', 'denied', request.identity.userId, 'role_denied');
      return response.status(403).json({ error: 'Tu rol no tiene permiso para consultar facturas.' });
    }
    response.json({ items: listInvoices(origin), origin });
  });

  app.post('/api/invoices/extract', rateLimit({
    windowMs: 60_000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rateLimitHandler,
  }), express.raw({
    type: ['application/pdf', 'image/jpeg', 'image/png'],
    limit: '5mb',
  }), async (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    if (evaluationMode) {
      return response.status(403).json({ error: 'La extracción de documentos externos está deshabilitada en la evaluación pública.' });
    }
    if (origin === 'operational' && !request.identity) {
      return response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para analizar documentos operativos.' });
    }
    if (request.identity && !request.identity.roles.some((role) => invoiceRoles.includes(role))) {
      return response.status(403).json({ error: 'Tu rol no tiene permiso para analizar facturas.' });
    }
    const mimeType = request.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mimeType)) {
      return response.status(415).json({ error: 'Usa un archivo PDF, JPG o PNG.' });
    }
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      return response.status(400).json({ error: 'El documento está vacío o no es válido.' });
    }
    try {
      const extraction = await invoiceDocumentExtractor(request.body, mimeType);
      if (!extraction || !['complete', 'incomplete'].includes(extraction.status)
        || !Array.isArray(extraction.missingFields)
        || !(extraction.confidence === null || (
          Number.isFinite(extraction.confidence)
          && extraction.confidence >= 0
          && extraction.confidence <= 1
        ))) {
        return response.status(502).json({ error: 'La extracción no produjo un resultado verificable.' });
      }
      recordAudit('invoice_document_extraction', 'success', request.identity?.userId ?? null);
      response.json({ ...extraction, requiresHumanReview: true, documentStored: false });
    } catch (error) {
      recordAudit('invoice_document_extraction', 'failed', request.identity?.userId ?? null, 'service_unavailable');
      const status = [400, 415, 422, 503, 504].includes(error.statusCode) ? error.statusCode : 502;
      response.status(status).json({
        error: status === 503
          ? 'Azure Document Intelligence no está configurado o no tiene permisos. No se inventaron datos.'
          : status === 422
            ? 'El documento no pudo leerse. Completa los campos manualmente; no se inventaron datos.'
            : status === 504
              ? 'La extracción excedió el tiempo de espera. Intenta de nuevo o captura los datos manualmente.'
              : 'No fue posible extraer los datos del documento. Completa la captura manualmente.',
      });
    }
  });

  app.post('/api/invoices/product-match', evaluationOrRoles(...invoiceRoles), (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const { detectedName, manufacturer, composition, presentation, description } = request.body ?? {};
    if (
      typeof detectedName !== 'string'
      || !detectedName.trim()
      || detectedName.trim().length > 100
      || [manufacturer, composition, presentation, description].some((value) =>
        value !== undefined && (typeof value !== 'string' || value.length > 200))
      || Object.keys(request.body ?? {}).some((key) =>
        !['detectedName', 'manufacturer', 'composition', 'presentation', 'description'].includes(key))
    ) {
      return response.status(400).json({ error: 'Indica un nombre de artículo válido y atributos opcionales verificables.' });
    }
    const result = matchInvoiceProduct(detectedName.trim(), {
      manufacturer,
      composition,
      presentation,
      description,
    }, origin);
    recordAudit(
      result.requiresHumanReview ? 'invoice_product_match_review' : 'invoice_product_match',
      'success',
      request.identity?.userId ?? null,
    );
    response.json(result);
  });

  app.post('/api/invoices', requireWriteRoles(...invoiceRoles), (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const { supplier, reference, date, amount, branch, items, currency } = request.body ?? {};
    const allowedKeys = ['supplier', 'reference', 'date', 'amount', 'branch', 'items', 'currency'];
    if (Object.keys(request.body ?? {}).some((key) => !allowedKeys.includes(key))) {
      return response.status(400).json({ error: 'La factura contiene campos no admitidos.' });
    }
    if (![supplier, reference, date].every((value) => typeof value === 'string' && value.trim())) {
      return response.status(400).json({ error: 'Proveedor, folio y fecha son obligatorios.' });
    }
    if (supplier.trim().length > 120 || reference.trim().length > 80) {
      return response.status(400).json({ error: 'Revisa la longitud de proveedor y folio.' });
    }
    if (!isValidInvoiceDate(date)) {
      return response.status(400).json({ error: 'La fecha debe ser válida y usar el formato AAAA-MM-DD.' });
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) {
      return response.status(400).json({ error: 'El importe debe ser mayor que cero y no superar 100,000,000.' });
    }
    if (currency !== undefined && !['MXN', 'USD', 'EUR'].includes(currency)) {
      return response.status(400).json({ error: 'Selecciona MXN, USD o EUR como moneda de la factura.' });
    }
    if (
      items !== undefined
      && (!Array.isArray(items) || items.length > 100 || items.some((item) =>
        !item
        || typeof item.description !== 'string'
        || !item.description.trim()
        || item.description.trim().length > 160
        || !Number.isInteger(item.quantity)
        || item.quantity < 1
        || item.quantity > 1_000_000
        || typeof item.unitPrice !== 'number'
        || !Number.isFinite(item.unitPrice)
        || item.unitPrice <= 0
        || item.unitPrice > 100_000_000
        || (item.productId !== undefined && !Number.isInteger(item.productId))
        || ['manufacturer', 'composition', 'presentation'].some((field) =>
          item[field] !== undefined && (typeof item[field] !== 'string' || item[field].length > 200))
        || Object.keys(item).some((key) =>
          !['description', 'quantity', 'unitPrice', 'productId', 'manufacturer', 'composition', 'presentation'].includes(key))
      ))
    ) {
      return response.status(400).json({ error: 'Revisa los artículos, cantidades y precios de la factura.' });
    }
    if (Array.isArray(items) && items.length) {
      if (!branches.includes(branch)) {
        return response.status(400).json({ error: 'Selecciona la sucursal que recibirá los artículos.' });
      }
      const lineTotal = items.reduce((total, item) => total + Math.round(item.quantity * item.unitPrice * 100) / 100, 0);
      if (!Number.isFinite(lineTotal) || Math.round(lineTotal * 100) !== Math.round(amount * 100)) {
        return response.status(400).json({ error: 'El importe total debe coincidir con la suma de las líneas.' });
      }
    } else if (branch !== undefined && !branches.includes(branch)) {
      return response.status(400).json({ error: 'Selecciona una sucursal válida.' });
    }
    const availableProducts = listProducts({ origin });
    if (items?.some((item) =>
      item.productId !== undefined && !availableProducts.some((product) => product.id === item.productId),
    )) {
      return response.status(400).json({ error: 'Una línea de factura apunta a un producto no disponible en este conjunto de datos.' });
    }
    const validatedItems = (items ?? []).map((item) => {
      const match = item.productId === undefined
        ? matchInvoiceProduct(item.description.trim(), {
          manufacturer: item.manufacturer,
          composition: item.composition,
          presentation: item.presentation,
        }, origin)
        : { product: availableProducts.find((product) => product.id === item.productId), requiresHumanReview: false };
      return {
        description: item.description.trim(),
        quantity: item.quantity,
        unitPrice: Math.round(item.unitPrice * 100) / 100,
        amount: Math.round(item.quantity * item.unitPrice * 100) / 100,
        productId: match.product?.id ?? null,
        matchedProductName: match.product?.name ?? null,
        requiresHumanReview: Boolean(match.requiresHumanReview || !match.product),
      };
    });
    const result = addInvoice({
      supplier: supplier.trim(),
      reference: reference.trim(),
      date,
      amount: Math.round(amount * 100) / 100,
      currency: currency ?? 'MXN',
      origin,
      branch,
      items: validatedItems,
    });
    recordAudit(
      result.possibleDuplicate ? 'invoice_duplicate_detected' : 'invoice_write',
      'success',
      request.identity?.userId ?? null,
    );
    response.status(result.created ? 201 : 200).json({ ...result, origin });
  });

  app.delete('/api/invoices/:invoiceId', requireEvaluationMode, (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const invoiceId = Number(request.params.invoiceId);
    if (!Number.isSafeInteger(invoiceId) || invoiceId < 1) {
      return response.status(400).json({ error: 'El identificador de factura no es válido.' });
    }
    const result = deleteInvoice({ invoiceId, origin });
    if (result.error) {
      const status = result.error === 'No se encontró la factura.' ? 404 : 409;
      recordAudit('demo_invoice_delete', 'denied', request.identity?.userId ?? null, `invoice:${invoiceId}`);
      return response.status(status).json({ error: result.error });
    }
    recordAudit('demo_invoice_delete', 'success', request.identity?.userId ?? null, `invoice:${invoiceId}`);
    response.json({ ...result, origin });
  });

  app.get('/api/complaints', (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    let branch = typeof request.query.branch === 'string' ? request.query.branch.trim() : null;
    const status = typeof request.query.status === 'string' ? request.query.status.trim() : null;
    if (branch && !branches.includes(branch)) {
      return response.status(400).json({ error: 'La sucursal indicada no es válida.' });
    }
    if (status && !['pending', 'in_progress', 'resolved', 'closed'].includes(status)) {
      return response.status(400).json({ error: 'El estado indicado no es válido.' });
    }
    if (!authorizeComplaintAccess(request, response, origin, branch)) return;
    if (request.identity && !request.identity.roles.includes('Administrator')) {
      branch = request.identity.branch;
    }
    const sla = getComplaintSlaSummary(origin);
    if (request.identity && !request.identity.roles.includes('Administrator')) {
      const branchSla = sla.byBranch.find((item) => item.branch === branch);
      sla.total = branchSla?.total ?? 0;
      sla.unresolved = branchSla?.unresolved ?? 0;
      sla.onTime = branchSla?.onTime ?? 0;
      sla.breached = branchSla?.breached ?? 0;
      sla.byBranch = branchSla ? [branchSla] : [];
    }
    response.json({ items: listComplaints({ origin, branch, status }), origin, sla });
  });

  app.post('/api/complaints', (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const { branch, customerName, description, category, contactChannel, contactValue } = request.body ?? {};
    if (!authorizeComplaintAccess(request, response, origin, branch, true)) return;
    const payload = {
      origin,
      branch,
      customerName,
      description,
      category,
      contactChannel,
      contactValue,
      actor: request.identity?.userId ?? 'system',
    };
    const result = createComplaint(payload);
    if (result.error) return response.status(400).json({ error: result.error });
    response.status(201).json({ item: result.item, origin });
  });

  app.delete('/api/complaints/:complaintId', requireEvaluationMode, (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const complaintId = Number(request.params.complaintId);
    if (!Number.isSafeInteger(complaintId) || complaintId < 1) {
      return response.status(400).json({ error: 'El identificador de reclamación no es válido.' });
    }
    const result = deleteComplaint({ complaintId, origin });
    if (result.error) {
      recordAudit('demo_complaint_delete', 'denied', request.identity?.userId ?? null, `complaint:${complaintId}`);
      return response.status(404).json({ error: result.error });
    }
    recordAudit('demo_complaint_delete', 'success', request.identity?.userId ?? null, `complaint:${complaintId}`);
    response.json({ ...result, origin });
  });

  app.get('/api/complaints/:complaintId', (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const complaintId = Number(request.params.complaintId);
    if (!Number.isSafeInteger(complaintId) || complaintId < 1) {
      return response.status(400).json({ error: 'El identificador de reclamación no es válido.' });
    }
    if (!authorizeComplaintAccess(request, response, origin)) return;
    const item = getComplaint(complaintId, origin);
    if (!item) return response.status(404).json({ error: 'No se encontró la reclamación.' });
    if (!authorizeComplaintAccess(request, response, origin, item.branch)) return;
    if (request.identity && !request.identity.roles.includes('Administrator') && request.identity.branch !== item.branch) {
      return response.status(403).json({ error: 'No tienes permiso para consultar esta sucursal.' });
    }
    response.json({ item, origin });
  });

  app.post('/api/complaints/:complaintId/status', (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const complaintId = Number(request.params.complaintId);
    const { status, note } = request.body ?? {};
    if (!Number.isSafeInteger(complaintId) || complaintId < 1) return response.status(400).json({ error: 'El identificador de reclamación no es válido.' });
    if (!status || !['pending', 'in_progress', 'resolved', 'closed'].includes(status)) return response.status(400).json({ error: 'El estado indicado no es válido.' });
    if ((note !== undefined && (typeof note !== 'string' || note.length > 500))
      || Object.keys(request.body ?? {}).some((key) => !['status', 'note'].includes(key))) {
      return response.status(400).json({ error: 'La nota de seguimiento debe ser texto de hasta 500 caracteres.' });
    }
    if (!authorizeComplaintAccess(request, response, origin, null, true)) return;
    const existing = getComplaint(complaintId, origin);
    if (!existing) return response.status(404).json({ error: 'No se encontró la reclamación.' });
    if (!authorizeComplaintAccess(request, response, origin, existing.branch, true)) return;
    const result = updateComplaintStatus({ complaintId, status, note, actor: request.identity?.userId ?? 'system', origin });
    if (result.error) return response.status(409).json({ error: result.error });
    response.json({ item: result.item, origin });
  });

  app.post('/api/complaints/:complaintId/response', (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const complaintId = Number(request.params.complaintId);
    const { message, humanApproved } = request.body ?? {};
    if (!Number.isSafeInteger(complaintId) || complaintId < 1) return response.status(400).json({ error: 'El identificador de reclamación no es válido.' });
    if (typeof message !== 'string' || !message.trim() || message.trim().length > 2000
      || humanApproved !== true
      || Object.keys(request.body ?? {}).some((key) => !['message', 'humanApproved'].includes(key))) {
      return response.status(400).json({ error: 'Revisa la respuesta y confirma explícitamente su revisión humana.' });
    }
    if (!authorizeComplaintAccess(request, response, origin, null, true)) return;
    const existing = getComplaint(complaintId, origin);
    if (!existing) return response.status(404).json({ error: 'No se encontró la reclamación.' });
    if (!authorizeComplaintAccess(request, response, origin, existing.branch, true)) return;
    const result = addComplaintResponse({ complaintId, responder: request.identity?.userId ?? 'system', message: message.trim(), origin });
    if (result.error) return response.status(409).json({ error: result.error });
    response.json({ item: result.item, origin });
  });

  app.post('/api/complaints/:complaintId/draft-response', async (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const complaintId = Number(request.params.complaintId);
    const { conversationId } = request.body ?? {};
    if (!Number.isSafeInteger(complaintId) || complaintId < 1) {
      return response.status(400).json({ error: 'El identificador de reclamación no es válido.' });
    }
    if (conversationId !== undefined && (
      typeof conversationId !== 'string'
      || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(conversationId)
    )) {
      return response.status(422).json({ error: 'El identificador de conversación no es válido.' });
    }
    if (!authorizeComplaintAccess(request, response, origin)) return;
    if (request.identity && !request.identity.roles.length) {
      return response.status(403).json({ error: 'Se requiere un rol de la aplicación asignado en Microsoft Entra ID.' });
    }
    if (!request.identity && !localChatEnabled && !evaluationMode) {
      return response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para solicitar un borrador de respuesta.' });
    }
    if (process.env.FOUNDRY_SUSPENDED === 'true' || aiSuspended || !canEnableAI) {
      return response.status(503).json({ error: 'Foundry no está disponible. No se generó un borrador.' });
    }
    const item = getComplaint(complaintId, origin);
    if (!item) return response.status(404).json({ error: 'No se encontró la reclamación.' });
    if (!authorizeComplaintAccess(request, response, origin, item.branch)) return;
    const sessionId = request.get('x-chat-session');
    if (!request.identity && (typeof sessionId !== 'string'
      || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(sessionId))) {
      return response.status(422).json({ error: 'La sesión local de conversación no es válida.' });
    }
    try {
      const result = await foundryClient(
        'Redacta un borrador breve, empático y profesional para reconocer una reclamación. No afirmes que se resolvió ni prometas compensaciones, plazos o acciones no confirmados. No contactes al cliente. La persona responsable revisará y aprobará el texto antes de registrarlo.',
        {
          applicationContext: {
            task: 'draft_complaint_response',
            origin,
            synthetic: origin === 'practice',
            complaintCategory: item.category,
            status: item.status,
            firstResponseDueMinutes: 15,
            responseAlreadyRecorded: Boolean(item.firstResponseAt),
          },
          conversationId,
          ownerId: request.identity?.userId ?? `local:${sessionId}`,
        },
      );
      if (!result || typeof result.answer !== 'string' || !result.answer.trim()
        || result.answer.length > 2000 || sensitiveOutput.test(result.answer)) {
        return response.status(502).json({ error: 'El borrador no pasó los controles y no está disponible.' });
      }
      response.json({
        draft: result.answer.trim(),
        conversationId: result.conversationId ?? null,
        requiresHumanApproval: true,
        sentToCustomer: false,
      });
    } catch {
      response.status(502).json({ error: 'No fue posible obtener un borrador de Foundry. No se envió ningún mensaje.' });
    }
  });

  app.get('/api/invoices/:invoiceId', evaluationOrRoles(...invoiceRoles), (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const invoiceId = Number(request.params.invoiceId);
    if (!Number.isSafeInteger(invoiceId) || invoiceId < 1) {
      return response.status(400).json({ error: 'El identificador de factura no es válido.' });
    }
    const item = getInvoice(invoiceId, origin);
    if (!item) return response.status(404).json({ error: 'No se encontró la factura.' });
    response.json({ item, origin });
  });

  app.post('/api/invoices/:invoiceId/items/:itemIndex/match', evaluationOrRoles(...invoiceRoles), (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const invoiceId = Number(request.params.invoiceId);
    const itemIndex = Number(request.params.itemIndex);
    const { productId, evidence } = request.body ?? {};
    if (
      !Number.isSafeInteger(invoiceId)
      || invoiceId < 1
      || !Number.isSafeInteger(itemIndex)
      || itemIndex < 0
      || !Number.isSafeInteger(productId)
      || typeof evidence !== 'string'
      || evidence.trim().length < 20
      || evidence.trim().length > 500
      || Object.keys(request.body ?? {}).some((key) => !['productId', 'evidence'].includes(key))
    ) {
      return response.status(400).json({ error: 'Selecciona un producto y documenta la revisión (20 a 500 caracteres).' });
    }
    const result = assignInvoiceProduct({
      invoiceId,
      itemIndex,
      productId,
      evidence: evidence.trim(),
      origin,
    });
    if (result.error) return response.status(409).json({ error: result.error });
    recordAudit('invoice_product_linked', 'success', request.identity?.userId ?? null);
    response.json({ item: result.item, origin });
  });

  app.post('/api/invoices/:invoiceId/review', evaluationOrRoles(...invoiceRoles), (request, response) => {
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    const invoiceId = Number(request.params.invoiceId);
    const { decision, evidence } = request.body ?? {};
    if (
      !Number.isSafeInteger(invoiceId)
      || invoiceId < 1
      || !['confirm', 'confirm_distinct', 'reject'].includes(decision)
      || typeof evidence !== 'string'
      || evidence.trim().length < 20
      || evidence.trim().length > 500
      || Object.keys(request.body ?? {}).some((key) => !['decision', 'evidence'].includes(key))
    ) {
      return response.status(400).json({ error: 'Indica la decisión y su justificación (20 a 500 caracteres).' });
    }
    const result = reviewInvoice({
      invoiceId,
      decision,
      evidence: evidence.trim(),
      userId: request.identity?.userId ?? 'evaluation',
      origin,
    });
    if (result.error) return response.status(409).json({ error: result.error, requiresHumanReview: true });
    recordAudit(`invoice_${decision}`, 'success', request.identity?.userId ?? null);
    response.json({ item: result.item, origin });
  });

  app.post(['/api/chat', '/api/assistant'], async (request, response) => {
    const { message, conversationId } = request.body ?? {};
    if (typeof message !== 'string' || !message.trim()) {
      return response.status(422).json({ error: 'Escribe una pregunta para el asistente.' });
    }
    if (Array.from(message).length > 2000) {
      return response.status(422).json({ error: 'La pregunta no puede superar 2,000 caracteres.' });
    }
    if (conversationId !== undefined && (
      typeof conversationId !== 'string'
      || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(conversationId)
    )) {
      return response.status(422).json({ error: 'El identificador de conversación no es válido.' });
    }
    if (sensitiveInput.test(message)) {
      recordAudit('ai_request', 'blocked', request.identity?.userId ?? null, 'sensitive_input_blocked');
      return response.status(422).json({ error: 'No envíes credenciales, datos personales o información financiera sensible al asistente.' });
    }
    if (request.identity && !request.identity.roles.length) {
      recordAudit('ai_request', 'denied', request.identity.userId, 'role_missing');
      return response.status(403).json({ error: 'Se requiere un rol de la aplicación asignado en Microsoft Entra ID.' });
    }
    if (!request.identity && !localChatEnabled && !evaluationMode) {
      recordAudit('ai_request', 'denied', null, 'identity_required');
      return response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID o habilita el chat local de desarrollo.' });
    }
    const origin = getDataOrigin(request, response);
    if (!origin) return;
    if (origin === 'operational' && !request.identity) {
      return response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para consultar datos operativos.' });
    }
    if (process.env.FOUNDRY_SUSPENDED === 'true' || aiSuspended) {
      recordAudit('ai_request', 'blocked', request.identity?.userId ?? null, 'ai_suspended');
      return response.status(503).json({ error: 'El asistente de IA está temporalmente desactivado por seguridad.' });
    }
    if (!canEnableAI) {
      return response.status(503).json({ error: 'Microsoft Foundry está pendiente de configuración. No se generó respuesta.' });
    }
    let ownerId = request.identity?.userId;
    if (!ownerId) {
      const localSessionId = request.get('x-chat-session');
      if (typeof localSessionId !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(localSessionId)) {
        return response.status(422).json({ error: 'La sesión local de conversación no es válida.' });
      }
      ownerId = `local:${localSessionId}`;
    }
    try {
      const applicationContext = assistantDataContext({
        origin,
        identity: request.identity,
        branches,
      });
      const result = await foundryClient(message.trim(), {
        applicationContext,
        conversationId,
        ownerId,
      });
      if (!result || typeof result.answer !== 'string' || !result.answer.trim()) {
        throw new Error('Unexpected agent response.');
      }
      if (sensitiveOutput.test(result.answer)) {
        recordAudit('ai_request', 'blocked', request.identity?.userId ?? null, 'sensitive_output_blocked');
        return response.status(502).json({ error: 'La respuesta del asistente no pasó los controles de seguridad y no está disponible.' });
      }
      const sources = Array.isArray(result.sources)
        ? result.sources.filter((source) => typeof source === 'string' && source.length <= 160 && !sensitiveOutput.test(source)).slice(0, 5)
        : [];
      recordAudit('ai_request', 'success', request.identity?.userId ?? null);
      setFoundryAvailability('connected', 'El agente RioClaroAssistant está disponible.', true);
      response.json({
        answer: result.answer.trim(),
        sources,
        sourceStatus: sources.length ? 'agent-reported-unverified' : 'not-available',
        conversationId: result.conversationId ?? null,
        requiresHumanReview: true,
      });
    } catch (error) {
      const rateLimited = (error.statusCode ?? error.status) === 429;
      setFoundryAvailability(
        rateLimited ? 'rate_limited' : 'unavailable',
        rateLimited ? 'Foundry está limitando temporalmente las solicitudes.' : 'El agente no está disponible en este momento.',
      );
      recordAudit('ai_connection', 'failed', request.identity?.userId ?? null, error.failureType === 'timeout' ? 'timeout' : 'service_unavailable');
      console.warn(JSON.stringify({
        event: 'foundry_request_failed',
        category: error.failureType === 'timeout' ? 'timeout' : rateLimited ? 'rate_limit' : error.statusCode === 503 ? 'configuration' : 'service',
      }));
      if (error.statusCode === 503) {
        return response.status(503).json({ error: 'La configuración del asistente no está disponible. No se generó respuesta.' });
      }
      if (error.statusCode === 404) {
        return response.status(404).json({ error: 'No se encontró la conversación para esta sesión.' });
      }
      if (error.statusCode === 422) {
        return response.status(422).json({ error: 'La sesión de conversación no es válida.' });
      }
      if (error.statusCode === 429) {
        if (typeof error.retryAfter === 'string' && /^\d+$/.test(error.retryAfter)) {
          response.setHeader('Retry-After', error.retryAfter);
        }
        return response.status(429).json({
          error: 'Foundry alcanzó temporalmente su cuota. Espera un momento y vuelve a intentarlo.',
        });
      }
      response.status(502).json({ error: 'No fue posible obtener una respuesta del asistente. La respuesta no está disponible.' });
    }
  });

  app.post('/api/admin/ai-control', auth.requireRoles('Administrator'), (request, response) => {
    const body = request.body;
    if (!body || typeof body.enabled !== 'boolean' || Object.keys(body).some((key) => key !== 'enabled')) {
      return response.status(400).json({ error: 'El cuerpo debe contener únicamente enabled como valor booleano.' });
    }
    if (body.enabled && (!canEnableAI || process.env.FOUNDRY_SUSPENDED === 'true')) {
      return response.status(409).json({ error: 'No se puede activar la IA: la configuración del servidor no lo permite.' });
    }
    aiSuspended = !body.enabled;
    recordAudit(body.enabled ? 'ai_emergency_resume' : 'ai_emergency_suspend', 'success', request.identity.userId);
    response.json({ aiSuspended, message: body.enabled ? 'La IA fue habilitada por un administrador.' : 'La IA fue suspendida por un administrador.' });
  });

  app.get('/api/admin/audit', auth.requireRoles('Administrator'), (_request, response) => {
    response.json({
      items: listAuditEvents(),
      persistence: process.env.RIOCLARO_DATA_FILE === ':memory:' ? 'memory' : 'file',
    });
  });

  app.post('/api/admin/practice/reset', auth.requireRoles('Administrator'), (request, response) => {
    if (
      request.body?.confirm !== 'RESET_PRACTICE'
      || Object.keys(request.body ?? {}).length !== 1
    ) {
      return response.status(400).json({ error: 'Confirma la limpieza escribiendo RESET_PRACTICE.' });
    }
    resetPracticeData();
    recordAudit('practice_data_reset', 'success', request.identity.userId);
    response.json({ reset: true, origin: 'practice' });
  });

  app.use('/api', (request, response) => {
    recordAudit('api_access', 'denied', request.identity?.userId ?? null, 'route_not_found');
    response.status(404).json({ error: 'Ruta de API no encontrada.' });
  });

  app.use((_request, response) => {
    response.status(404).type('text/plain').send('Recurso no encontrado.');
  });

  app.use((error, request, response, _next) => {
    if (response.headersSent) return;
    if (error instanceof SyntaxError && 'body' in error) {
      return response.status(400).json({ error: 'El cuerpo de la solicitud no contiene JSON válido.' });
    }
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ error: 'La solicitud supera el límite permitido.' });
    }
    if (error.type === 'entity.parse.failed') {
      return response.status(400).json({ error: 'El cuerpo de la solicitud no contiene JSON válido.' });
    }
    console.error(JSON.stringify({ event: 'request_failed', requestId: request.requestId }));
    response.status(500).json({ error: 'Ocurrió un error interno. Intenta de nuevo más tarde.' });
  });

  return app;
}

export { branches };
