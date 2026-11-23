import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import http from 'http';
import https from 'https';

const BRANCH_SYNC_SCHEMA_VERSION = 1;
const BRANCH_SYNC_MODE = 'incremental';
const DEFAULT_SYNC_URL = 'http://localhost:3000/api/TDDCycles/sync';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_ATTEMPTS = 3;

const runGit = (repoRoot, args) => {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

const getCurrentBranch = (repoRoot) => {
  const branch = runGit(repoRoot, ['branch', '--show-current']);
  return branch || null;
};

const getHeadSha = (repoRoot) => {
  return runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']);
};

const parseGithubRemote = (remoteUrl) => {
  if (!remoteUrl) return null;

  const normalized = remoteUrl.trim().replace(/\.git$/, '');

  const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/(.+)$/);
  if (sshMatch) {
    return { owner: sshMatch[1], name: sshMatch[2] };
  }

  const sshUrlMatch = normalized.match(
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/,
  );
  if (sshUrlMatch) {
    return { owner: sshUrlMatch[1], name: sshUrlMatch[2] };
  }

  try {
    const url = new URL(normalized);
    if (url.hostname !== 'github.com') return null;

    const [owner, ...repoParts] = url.pathname.replace(/^\//, '').split('/');
    const name = repoParts.join('/');

    if (!owner || !name) return null;
    return { owner, name };
  } catch {
    return null;
  }
};

const getGithubRepository = (repoRoot) => {
  const remoteUrl = runGit(repoRoot, [
    'config',
    '--get',
    'remote.origin.url',
  ]);
  return parseGithubRemote(remoteUrl);
};

const createBranchSyncPayload = ({
  repository,
  branchName,
  headSha,
  testEntry,
}) => {
  const execution = {
    eventId: randomUUID(),
    branchAtCapture: branchName,
    headShaAtExecution: headSha,
    associatedCommitSha: null,
    timestamp: testEntry.timestamp,
    numPassedTests: testEntry.numPassedTests,
    failedTests: testEntry.failedTests,
    numTotalTests: testEntry.numTotalTests,
    coveragePercentage: null,
    success: testEntry.success,
    testId: null,
  };

  return {
    payload: {
      schemaVersion: BRANCH_SYNC_SCHEMA_VERSION,
      mode: BRANCH_SYNC_MODE,
      repository: {
        provider: 'github',
        owner: repository.owner,
        name: repository.name,
      },
      branch: {
        name: branchName,
        headSha,
        expectedHeadVersion: null,
      },
      commits: [],
      branchCommitShas: [],
      executions: [execution],
    },
    execution,
  };
};

const postJson = (urlString, token, payload, timeoutMs = DEFAULT_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const url = new URL(urlString);

    if (!['http:', 'https:'].includes(url.protocol)) {
      reject(new Error(`Protocolo no soportado en TDD_SYNC_URL: ${url.protocol}`));
      return;
    }

    const body = JSON.stringify(payload);
    const client = url.protocol === 'https:' ? https : http;

    const request = client.request(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let responseBody = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });

        response.on('end', () => {
          const statusCode = response.statusCode ?? 0;
          let parsedBody = responseBody;

          if (responseBody) {
            try {
              parsedBody = JSON.parse(responseBody);
            } catch {
              // Keep plain text when an intermediary responds.
            }
          }

          if (statusCode < 200 || statusCode >= 300) {
            const error = new Error(
              `Backend TDD respondió ${statusCode}: ${
                typeof parsedBody === 'object'
                  ? parsedBody.code ?? parsedBody.message ?? responseBody
                  : parsedBody || 'sin cuerpo'
              }`,
            );
            error.status = statusCode;
            error.response = parsedBody;
            reject(error);
            return;
          }

          resolve(parsedBody || null);
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      const error = new Error(
        `Timeout al sincronizar TDD después de ${timeoutMs} ms`,
      );
      error.code = 'SYNC_TIMEOUT';
      request.destroy(error);
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shouldRetry = (error) => {
  if (!error?.status) return true;
  return [500, 502, 503, 504].includes(error.status);
};

const sendWithRetry = async ({
  syncUrl,
  token,
  payload,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) => {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await postJson(syncUrl, token, payload);
    } catch (error) {
      lastError = error;

      if (!shouldRetry(error) || attempt === maxAttempts) {
        throw error;
      }

      await sleep(500 * attempt);
    }
  }

  throw lastError;
};

const syncTestExecution = async ({
  repoRoot,
  testEntry,
  syncUrl = process.env.TDD_SYNC_URL || DEFAULT_SYNC_URL,
  token = process.env.TDD_SYNC_TOKEN,
}) => {
  if (!token) {
    throw new Error('Configurar TDD_SYNC_TOKEN antes de ejecutar npm test.');
  }

  const branchName = getCurrentBranch(repoRoot);
  if (!branchName) {
    throw new Error(
      'No se pudo determinar la rama actual. Detached HEAD no es válido para esta captura.',
    );
  }

  const repository = getGithubRepository(repoRoot);
  if (!repository) {
    throw new Error(
      'No se pudo determinar owner/repository desde remote.origin.url.',
    );
  }

  const headSha = getHeadSha(repoRoot);
  if (!headSha) {
    throw new Error('No se pudo obtener el SHA actual de Git.');
  }

  const { payload, execution } = createBranchSyncPayload({
    repository,
    branchName,
    headSha,
    testEntry,
  });

  const response = await sendWithRetry({
    syncUrl,
    token,
    payload,
  });

  return {
    response,
    payload,
    execution,
    branchName,
    headSha,
    syncUrl,
  };
};

export {
  createBranchSyncPayload,
  getCurrentBranch,
  getGithubRepository,
  getHeadSha,
  parseGithubRemote,
  postJson,
  sendWithRetry,
  syncTestExecution,
};
