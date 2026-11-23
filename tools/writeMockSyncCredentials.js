import { fileURLToPath } from 'url';
import path from 'path';
import { saveLocalSyncCredentials } from '../script/tddSyncConfig.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.MOCK_TDD_TOKEN || 'a'.repeat(64);
const configPath = saveLocalSyncCredentials({
  repoRoot,
  credentials: {
    TDD_SYNC_URL: 'http://127.0.0.1:4100/api/TDDCycles/sync',
    TDD_SYNC_TOKEN: token,
  },
});
console.log(`Configuración mock guardada en ${configPath}`);
console.log('Ahora ejecuta solamente: npm test');
