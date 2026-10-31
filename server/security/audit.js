import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const auditFile = process.env.RIOCLARO_DATA_FILE === ':memory:'
  ? null
  : process.env.RIOCLARO_AUDIT_FILE?.trim()
    || path.join(dataDirectory, 'audit-log.json');

function readEvents() {
  if (!auditFile || !fs.existsSync(auditFile)) return [];
  const contents = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
  if (!Array.isArray(contents)) throw new Error('El archivo de auditoría no tiene un formato compatible; no se modificó.');
  return contents;
}

const events = readEvents();

function persistEvents() {
  if (!auditFile) return;
  fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 });
  const temporaryFile = `${auditFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(events), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temporaryFile, auditFile);
  } catch (error) {
    fs.rmSync(temporaryFile, { force: true });
    throw error;
  }
}

export function recordAudit(type, result, userId = null, reason = null) {
  events.push({
    timestamp: new Date().toISOString(),
    type,
    result,
    userId,
    ...(reason ? { reason } : {}),
  });
  persistEvents();
}

export function listAuditEvents() {
  return events.map((event) => ({ ...event }));
}
