import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import http from 'http';
import https from 'https';

const BRANCH_SYNC_SCHEMA_VERSION = 1;
const BRANCH_SYNC_MODE = 'incremental';
const DEFAULT_SYNC_URL = 'http://localhost:3000/api/TDDCycles/history/sync';

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
  if (!remoteUrl) {
    return null;
  }

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

    if (url.hostname !== 'github.com') {
      return null;
    }

    const [owner, ...repoParts] = url.pathname.replace(/^\//, '').split('/');
    const name = repoParts.join('/');

    if (!owner || !name) {
      return null;
    }

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

const postJson = (urlString, payload, timeoutMs = 8000) =>
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

          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new Error(
                `Backend TDD respondió ${statusCode}: ${responseBody || 'sin cuerpo'}`,
              ),
            );
            return;
          }

          if (!responseBody) {
            resolve(null);
            return;
          }

          try {
            resolve(JSON.parse(responseBody));
          } catch {
            resolve(responseBody);
          }
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new Error(`Timeout al sincronizar TDD después de ${timeoutMs} ms`),
      );
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });

const syncTestExecution = async ({
  repoRoot,
  testEntry,
  syncUrl = process.env.TDD_SYNC_URL || DEFAULT_SYNC_URL,
}) => {
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

  const response = await postJson(syncUrl, payload);

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
  syncTestExecution,
};
