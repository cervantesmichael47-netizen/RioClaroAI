import { createRemoteJWKSet, jwtVerify } from 'jose';

const knownRoles = new Set(['Administrator', 'BranchManager', 'AccountsPayable', 'Warehouse']);
let remoteKeys;
let cachedTenant;

export function entraIsConfigured() {
  return Boolean(process.env.ENTRA_TENANT_ID && process.env.ENTRA_API_CLIENT_ID);
}

export async function verifyEntraToken(token) {
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.ENTRA_API_CLIENT_ID;
  if (!tenantId || !clientId) {
    const error = new Error('Microsoft Entra ID aún no está configurado.');
    error.statusCode = 503;
    throw error;
  }
  if (!/^[\da-f-]{36}$/i.test(tenantId)) {
    throw new Error('La configuración de Entra ID no es válida.');
  }
  if (!remoteKeys || cachedTenant !== tenantId) {
    remoteKeys = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
    cachedTenant = tenantId;
  }
  const { payload } = await jwtVerify(token, remoteKeys, {
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    audience: [clientId, `api://${clientId}`],
    algorithms: ['RS256'],
    requiredClaims: ['oid', 'tid', 'exp', 'iat'],
  });
  if (payload.tid !== tenantId || typeof payload.oid !== 'string') {
    throw new Error('El token no pertenece al tenant configurado.');
  }
  const roles = Array.isArray(payload.roles)
    ? payload.roles.filter((role) => knownRoles.has(role))
    : [];
  const branchClaim = process.env.ENTRA_BRANCH_CLAIM?.trim() || 'extension_branch';
  const branch = typeof payload[branchClaim] === 'string' ? payload[branchClaim] : null;
  return { userId: payload.oid, roles, branch };
}

export function createAuthentication({ tokenVerifier = verifyEntraToken, recordAudit }) {
  async function optionalIdentity(request, response, next) {
    const header = request.get('authorization');
    if (!header) return next();
    const match = /^Bearer ([\w.~+/-]+={0,2})$/.exec(header);
    if (!match) {
      recordAudit('authentication', 'denied', null, 'invalid_bearer');
      return response.status(401).json({ error: 'Se requiere un token Bearer válido de Microsoft Entra ID.' });
    }
    try {
      request.identity = await tokenVerifier(match[1]);
      return next();
    } catch (error) {
      recordAudit('authentication', 'denied', null, error.statusCode === 503 ? 'entra_not_configured' : 'invalid_token');
      if (error.statusCode === 503) {
        return response.status(503).json({ error: 'La autenticación de Microsoft Entra ID está pendiente de configuración.' });
      }
      return response.status(401).json({ error: 'El token de Microsoft Entra ID no es válido o expiró.' });
    }
  }

  function requireIdentity(request, response, next) {
    if (!request.identity) {
      recordAudit('authorization', 'denied', null, 'identity_required');
      return response.status(401).json({ error: 'Inicia sesión con Microsoft Entra ID para realizar esta operación.' });
    }
    next();
  }

  function requireRoles(...roles) {
    return (request, response, next) => {
      if (!request.identity) return requireIdentity(request, response, next);
      if (!request.identity.roles.some((role) => roles.includes(role))) {
        recordAudit('authorization', 'denied', request.identity.userId, 'role_denied');
        return response.status(403).json({ error: 'Tu rol no tiene permiso para esta operación.' });
      }
      next();
    };
  }

  return { optionalIdentity, requireIdentity, requireRoles };
}

export function branchIsAllowed(identity, branch) {
  return identity.roles.includes('Administrator') || identity.branch === branch;
}
