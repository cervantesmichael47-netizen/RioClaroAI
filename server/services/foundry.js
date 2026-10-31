import { DefaultAzureCredential } from '@azure/identity';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const conversationFile = process.env.RIOCLARO_DATA_FILE === ':memory:'
  ? null
  : process.env.FOUNDRY_CONVERSATIONS_FILE?.trim()
    || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'foundry-conversations.json');
const conversations = new Map();
if (conversationFile && fs.existsSync(conversationFile)) {
  const savedConversations = JSON.parse(fs.readFileSync(conversationFile, 'utf8'));
  if (!Array.isArray(savedConversations) || savedConversations.some((conversation) =>
    typeof conversation?.conversationId !== 'string'
    || typeof conversation.ownerId !== 'string'
    || typeof conversation.foundryConversationId !== 'string',
  )) {
    throw new Error('El archivo de conversaciones de Foundry no tiene un formato compatible; no se modificó.');
  }
  for (const conversation of savedConversations) {
    conversations.set(conversation.conversationId, {
      ownerId: conversation.ownerId,
      foundryConversationId: conversation.foundryConversationId,
    });
  }
}
let cachedClient;
let availability = {
  state: 'pending',
  connected: false,
  message: 'La disponibilidad del agente aún no se ha verificado.',
  checkedAt: null,
};

function configurationError() {
  const error = new Error('La configuración de Microsoft Foundry no está completa.');
  error.statusCode = 503;
  return error;
}

function getConfiguration() {
  const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT?.trim();
  const agentName = process.env.FOUNDRY_AGENT_NAME?.trim() || 'RioClaroAssistant';
  if (!endpoint) throw configurationError();

  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw configurationError();
  }
  if (
    parsedEndpoint.protocol !== 'https:'
    || !parsedEndpoint.hostname.endsWith('.services.ai.azure.com')
    || !/^\/api\/projects\/[^/]+\/?$/.test(parsedEndpoint.pathname)
    || parsedEndpoint.search
    || parsedEndpoint.hash
  ) {
    throw configurationError();
  }
  return { endpoint: parsedEndpoint.href.replace(/\/$/, ''), agentName };
}

async function getClient() {
  const configuration = getConfiguration();
  const managedIdentityClientId = process.env.AZURE_CLIENT_ID?.trim() || undefined;
  if (
    cachedClient?.endpoint === configuration.endpoint
    && cachedClient.managedIdentityClientId === managedIdentityClientId
  ) return cachedClient;
  let AIProjectClient;
  try {
    ({ AIProjectClient } = await import('@azure/ai-projects'));
  } catch {
    throw configurationError();
  }
  const credential = new DefaultAzureCredential({
    ...(managedIdentityClientId ? { managedIdentityClientId } : {}),
  });
  const project = new AIProjectClient(configuration.endpoint, credential);
  cachedClient = {
    endpoint: configuration.endpoint,
    managedIdentityClientId,
    project,
    openAI: project.getOpenAIClient(),
  };
  return cachedClient;
}

function timeoutMs() {
  const value = Number.parseInt(process.env.FOUNDRY_TIMEOUT_MS ?? '20000', 10);
  if (!Number.isInteger(value) || value < 1000 || value > 120_000) {
    throw new Error('FOUNDRY_TIMEOUT_MS debe ser un entero entre 1000 y 120000.');
  }
  return value;
}

async function withTimeout(operation) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error('El agente de Foundry tardó demasiado en responder.');
          error.statusCode = 502;
          error.failureType = 'timeout';
          reject(error);
        }, timeoutMs());
      }),
    ]);
  } catch (error) {
    const statusCode = error.statusCode ?? error.status;
    if (statusCode === 429) {
      const serviceError = new Error('Microsoft Foundry alcanzó temporalmente su cuota de solicitudes.');
      serviceError.statusCode = 429;
      serviceError.retryAfter = error.retryAfter ?? error.headers?.['retry-after'];
      serviceError.failureType = 'quota';
      throw serviceError;
    }
    if ([404, 422, 503].includes(statusCode)) throw error;
    if (error.statusCode === 502 && error.failureType === 'timeout') throw error;
    const serviceError = new Error('El servicio de Microsoft Foundry no está disponible.');
    serviceError.statusCode = 502;
    serviceError.failureType = 'service';
    throw serviceError;
  } finally {
    clearTimeout(timer);
  }
}

function findConversation(conversationId, ownerId) {
  const conversation = conversations.get(conversationId);
  if (!conversation) {
    const error = new Error('No se encontró la conversación para esta sesión.');
    error.statusCode = 404;
    throw error;
  }
  if (conversation.ownerId !== ownerId) {
    const error = new Error('No se encontró la conversación para esta sesión.');
    error.statusCode = 404;
    throw error;
  }
  return conversation;
}

function saveConversation(conversationId, ownerId, foundryConversationId) {
  conversations.set(conversationId, {
    ownerId,
    foundryConversationId,
  });
  if (!conversationFile) return;
  fs.mkdirSync(path.dirname(conversationFile), { recursive: true, mode: 0o700 });
  const temporaryFile = `${conversationFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify([...conversations.entries()].map(([id, conversation]) => ({
    conversationId: id,
    ...conversation,
  }))), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temporaryFile, conversationFile);
  } catch (error) {
    fs.rmSync(temporaryFile, { force: true });
    throw error;
  }
}

export function isFoundryConfigured() {
  return Boolean(process.env.FOUNDRY_PROJECT_ENDPOINT?.trim());
}

export function getFoundryAvailability() {
  const configured = isFoundryConfigured();
  const enabled = process.env.FOUNDRY_ENABLED === 'true' && configured;
  const suspended = process.env.FOUNDRY_SUSPENDED === 'true';
  return {
    ...availability,
    configured,
    enabled: enabled && !suspended,
    suspended,
    state: !configured ? 'unconfigured' : suspended ? 'suspended' : !enabled ? 'disabled' : availability.state,
  };
}

export function setFoundryAvailability(state, message, connected = false) {
  availability = {
    state,
    connected,
    message,
    checkedAt: new Date().toISOString(),
  };
  return getFoundryAvailability();
}

export function startFoundryAvailabilityMonitor({
  connectionCheck = checkFoundryConnection,
  initialDelayMs = 2_000,
  maximumDelayMs = 60_000,
} = {}) {
  let stopped = false;
  let failureCount = 0;
  let timer;

  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeout(check, delay);
    timer.unref?.();
  };

  async function check() {
    if (stopped) return;
    const status = getFoundryAvailability();
    if (!status.enabled) {
      setFoundryAvailability(status.state, status.message);
      schedule(maximumDelayMs);
      return;
    }

    setFoundryAvailability('connecting', 'Comprobando disponibilidad del agente.');
    try {
      await connectionCheck();
      failureCount = 0;
      setFoundryAvailability('connected', 'El agente RioClaroAssistant está disponible.', true);
      schedule(maximumDelayMs);
    } catch (error) {
      failureCount += 1;
      const rateLimited = (error.statusCode ?? error.status) === 429;
      setFoundryAvailability(
        rateLimited ? 'rate_limited' : 'unavailable',
        rateLimited
          ? 'Foundry está limitando temporalmente las solicitudes.'
          : 'El agente no está disponible en este momento.',
      );
      const delay = Math.min(initialDelayMs * (2 ** Math.min(failureCount - 1, 10)), maximumDelayMs);
      schedule(delay);
    }
  }

  void check();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export async function checkFoundryConnection() {
  const { project } = await getClient();
  const { agentName } = getConfiguration();
  return withTimeout(async (signal) => {
    const agent = await project.agents.get(agentName, { abortSignal: signal });
    if (!agent || typeof agent.name !== 'string' || agent.name !== agentName) {
      throw new Error('The configured Foundry agent was not found.');
    }
    return true;
  });
}

export async function askFoundry(message, { applicationContext, conversationId, ownerId }) {
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) {
    const error = new Error('La sesión de conversación no es válida.');
    error.statusCode = 422;
    throw error;
  }
  if (conversationId !== undefined && !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(conversationId)) {
    const error = new Error('El identificador de conversación no es válido.');
    error.statusCode = 422;
    throw error;
  }

  const { project, openAI } = await getClient();
  const { agentName } = getConfiguration();
  const content = applicationContext === undefined
    ? message
    : JSON.stringify({
      userMessage: message,
      applicationContext,
    });
  return withTimeout(async (signal) => {
    const agent = await project.agents.get(agentName, { abortSignal: signal });
    if (!agent || typeof agent.name !== 'string' || agent.name !== agentName) {
      throw new Error('The configured Foundry agent was not found.');
    }

    let handle = conversationId;
    let foundryConversationId;
    if (handle) {
      foundryConversationId = findConversation(handle, ownerId).foundryConversationId;
      await openAI.conversations.items.create(foundryConversationId, {
        items: [{ type: 'message', role: 'user', content }],
      }, { signal });
    } else {
      handle = crypto.randomUUID();
      const conversation = await openAI.conversations.create({
        items: [{ type: 'message', role: 'user', content }],
      }, { signal });
      foundryConversationId = conversation.id;
    }

    const response = await openAI.responses.create(
      { conversation: foundryConversationId },
      { body: { agent_reference: { name: agent.name, type: 'agent_reference' } }, signal },
    );
    if (typeof response.output_text !== 'string' || !response.output_text.trim()) {
      throw new Error('The Foundry agent returned an empty response.');
    }
    saveConversation(handle, ownerId, foundryConversationId);
    return { answer: response.output_text.trim(), sources: [], conversationId: handle };
  });
}
