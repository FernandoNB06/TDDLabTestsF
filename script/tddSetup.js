import { fileURLToPath } from 'url';
import path from 'path';
import readline from 'readline';
import http from 'http';
import https from 'https';

import { getGithubRepository } from './branchSyncExecution.js';
import { saveLocalSyncCredentials } from './tddSyncConfig.js';

const DEFAULT_PROVISIONING_URL =
  'http://localhost:3000/api/TDDCycles/sync/credentials/cli';

const PROVISIONING_URL =
  process.env.TDD_PROVISIONING_URL || DEFAULT_PROVISIONING_URL;

const ask = (question) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

const postJson = (urlString, setupCode, payload, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    const url = new URL(urlString);

    if (!['http:', 'https:'].includes(url.protocol)) {
      reject(new Error('URL de aprovisionamiento no soportada.'));
      return;
    }

    const client = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);

    const request = client.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-tdd-setup-code': setupCode,
        },
      },
      (response) => {
        let raw = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });

        response.on('end', () => {
          let result;

          try {
            result = JSON.parse(raw);
          } catch {
            reject(new Error('Respuesta inválida del servidor TDDLab.'));
            return;
          }

          const status = response.statusCode ?? 0;

          if (status < 200 || status >= 300) {
            reject(
              new Error(
                result.message ||
                  result.code ||
                  `TDDLab respondió ${status}`,
              ),
            );
            return;
          }

          resolve(result);
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Timeout al configurar TDDLab.'));
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });

async function setupTDDLab() {
  const __filename = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(__filename), '..');

  const repository = getGithubRepository(repoRoot);

  if (!repository) {
    throw new Error(
      'No se pudo determinar el repositorio desde remote.origin.url.',
    );
  }

  console.log(
    `Repositorio detectado: ${repository.owner}/${repository.name}`,
  );

  const setupCode = await ask('Código de configuración TDDLab: ');

  if (!setupCode) {
    throw new Error('Debes ingresar el código de configuración.');
  }

  const credentials = await postJson(
    PROVISIONING_URL,
    setupCode,
    {
      repository: {
        provider: 'github',
        owner: repository.owner,
        name: repository.name,
      },
    },
  );

  const configPath = saveLocalSyncCredentials({
    repoRoot,
    credentials,
  });

  console.log(`TDDLab configurado correctamente en ${configPath}`);
  console.log('Desde ahora solo ejecuta: npm test');
}

setupTDDLab().catch((error) => {
  console.error(`Error configurando TDDLab: ${error.message}`);
  process.exitCode = 1;
});
