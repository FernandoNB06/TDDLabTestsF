import fs from 'fs';
import path from 'path';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

const validateSyncCredentials = ({ syncUrl, token }) => {
  if (!syncUrl || !token) {
    throw new Error('Repositorio TDDLab no vinculado.');
  }

  let url;
  try {
    url = new URL(syncUrl);
  } catch {
    throw new Error('La URL de sincronización TDDLab no es válida.');
  }

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('TDD_SYNC_URL debe usar HTTPS (HTTP solo en localhost).');
  }

  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('El token de sincronización TDDLab no es válido.');
  }

  return { syncUrl: url.href, token };
};

const getLocalSyncConfigPath = (repoRoot) =>
  process.env.TDD_SYNC_CONFIG_PATH?.trim() ||
  path.join(repoRoot, '.tddlab', 'sync-credentials.json');

const loadSyncCredentials = ({ repoRoot, syncUrl, token }) => {
  const envUrl = syncUrl ?? process.env.TDD_SYNC_URL;
  const envToken = token ?? process.env.TDD_SYNC_TOKEN;

  if (envUrl || envToken) {
    return {
      ...validateSyncCredentials({ syncUrl: envUrl, token: envToken }),
      source: 'environment',
    };
  }

  const configPath = getLocalSyncConfigPath(repoRoot);
  if (!fs.existsSync(configPath)) {
    throw new Error('Repositorio TDDLab no vinculado. Vincúlalo desde TDDLab.');
  }

  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error('No se pudo leer la configuración local de TDDLab.');
  }

  return {
    ...validateSyncCredentials({
      syncUrl: stored.TDD_SYNC_URL,
      token: stored.TDD_SYNC_TOKEN,
    }),
    source: 'local-config',
    configPath,
  };
};

const saveLocalSyncCredentials = ({ repoRoot, credentials }) => {
  const validated = validateSyncCredentials({
    syncUrl: credentials?.TDD_SYNC_URL,
    token: credentials?.TDD_SYNC_TOKEN,
  });

  const directory = path.join(repoRoot, '.tddlab');
  const configPath = path.join(directory, 'sync-credentials.json');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      TDD_SYNC_URL: validated.syncUrl,
      TDD_SYNC_TOKEN: validated.token,
    }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );

  try { fs.chmodSync(configPath, 0o600); } catch {}
  return configPath;
};

export {
  getLocalSyncConfigPath,
  loadSyncCredentials,
  saveLocalSyncCredentials,
  validateSyncCredentials,
};
