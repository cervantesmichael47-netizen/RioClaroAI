import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadKeyVaultSecrets } from './server/security/secrets.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const persistentProductionDataFile = '/home/rioclaro-data/rioclaro-data.json';

function pathsMatch(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function resolvePracticeDataFile(directory, environment = process.env) {
  const configuredDataFile = environment.RIOCLARO_DATA_FILE?.trim();
  const configuredEvaluationFile = environment.RIOCLARO_EVALUATION_DATA_FILE?.trim();
  if (environment.NODE_ENV === 'production') {
    const configuredPaths = [configuredDataFile, configuredEvaluationFile].filter(Boolean);
    if (configuredPaths.some((file) =>
      path.posix.normalize(file.replaceAll('\\', '/')) !== persistentProductionDataFile,
    )) {
      throw new Error('RIOCLARO_DATA_FILE y RIOCLARO_EVALUATION_DATA_FILE deben apuntar a /home/rioclaro-data/rioclaro-data.json.');
    }
    return persistentProductionDataFile;
  }
  return configuredDataFile
    || configuredEvaluationFile
    || path.join(directory, 'server', 'data', 'rioclaro-data.json');
}

async function start() {
  if (process.env.NODE_ENV === 'production') {
    process.env.RIOCLARO_EVALUATION_MODE = 'true';
  }
  const evaluationMode = process.env.RIOCLARO_EVALUATION_MODE === 'true';
  if (evaluationMode) {
    const defaultDataFile = path.join(currentDirectory, 'server', 'data', 'rioclaro-data.json');
    let configuredEvaluationFile;
    try {
      configuredEvaluationFile = resolvePracticeDataFile(currentDirectory);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    const existingDataFile = process.env.RIOCLARO_OPERATIONAL_DATA_FILE?.trim() || defaultDataFile;
    if (!path.isAbsolute(configuredEvaluationFile)) {
      console.error('El modo público requiere una ruta absoluta para el archivo persistente de datos.');
      process.exitCode = 1;
      return;
    }
    const evaluationAuditFile = process.env.RIOCLARO_EVALUATION_AUDIT_FILE?.trim()
      || `${configuredEvaluationFile}.audit.json`;
    const existingAuditFile = process.env.RIOCLARO_OPERATIONAL_AUDIT_FILE?.trim()
      || path.join(currentDirectory, 'server', 'data', 'audit-log.json');
    const defaultAuditFile = path.join(currentDirectory, 'server', 'data', 'audit-log.json');
    const evaluationConversationsFile = process.env.RIOCLARO_EVALUATION_CONVERSATIONS_FILE?.trim()
      || `${configuredEvaluationFile}.foundry-conversations.json`;
    const existingConversationsFile = process.env.RIOCLARO_OPERATIONAL_CONVERSATIONS_FILE?.trim()
      || path.join(currentDirectory, 'server', 'data', 'foundry-conversations.json');
    const defaultConversationsFile = path.join(currentDirectory, 'server', 'data', 'foundry-conversations.json');
    const evaluationFiles = [configuredEvaluationFile, evaluationAuditFile, evaluationConversationsFile];
    const operationalFiles = [
      existingDataFile,
      defaultDataFile,
      existingAuditFile,
      defaultAuditFile,
      existingConversationsFile,
      defaultConversationsFile,
      process.env.RIOCLARO_OPERATIONAL_DATA_FILE,
    ].filter(Boolean);
    const duplicateEvaluationFiles = evaluationFiles.some((file, index) =>
      evaluationFiles.some((otherFile, otherIndex) => index !== otherIndex && pathsMatch(file, otherFile)),
    );
    if (
      evaluationFiles.some((file) => !path.isAbsolute(file))
      || duplicateEvaluationFiles
      || evaluationFiles.some((file) => operationalFiles.some((operationalFile) =>
        pathsMatch(file, operationalFile),
      ))
    ) {
      console.error('Los datos, auditoría y conversaciones de práctica deben usar archivos absolutos dedicados.');
      process.exitCode = 1;
      return;
    }
    process.env.RIOCLARO_EVALUATION_DATA_FILE = configuredEvaluationFile;
    process.env.RIOCLARO_DATA_FILE = configuredEvaluationFile;
    process.env.RIOCLARO_AUDIT_FILE = evaluationAuditFile;
    process.env.FOUNDRY_CONVERSATIONS_FILE = evaluationConversationsFile;
  }
  try {
    await loadKeyVaultSecrets();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'key_vault_initialization_failed',
      message: error instanceof Error ? error.message : 'La inicialización de Key Vault falló.',
    }));
    process.exitCode = 1;
    return;
  }
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('La variable PORT debe ser un puerto válido.');
    process.exitCode = 1;
    return;
  }
  const [{ createApp }, { startFoundryAvailabilityMonitor }] = await Promise.all([
    import('./server/app.js'),
    import('./server/services/foundry.js'),
  ]);
  const app = createApp({ staticDirectory: path.join(currentDirectory, 'public') });
  startFoundryAvailabilityMonitor();
  const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
  app.listen(port, host, () => {
    console.log(`Río Claro AI disponible en el puerto ${port}.`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await start();
}

export { start };
export { resolvePracticeDataFile };
