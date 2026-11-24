import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import http from 'http';
import https from 'https';
import { loadSyncCredentials } from './tddSyncConfig.js';

const BRANCH_SYNC_SCHEMA_VERSION = 1;
const BRANCH_SYNC_MODE = 'incremental';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_ATTEMPTS = 3;

const runGit = (repoRoot, args) => {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
};

const getCurrentBranch = (repoRoot) => runGit(repoRoot, ['branch', '--show-current']) || null;
const getHeadSha = (repoRoot) => runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']);

const parseGithubRemote = (remoteUrl) => {
  if (!remoteUrl) return null;
  const normalized = remoteUrl.trim().replace(/\.git$/, '');
  const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/(.+)$/);
  if (sshMatch) return { owner: sshMatch[1], name: sshMatch[2] };
  const sshUrlMatch = normalized.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/);
  if (sshUrlMatch) return { owner: sshUrlMatch[1], name: sshUrlMatch[2] };

  try {
    const url = new URL(normalized);
    if (url.hostname !== 'github.com') return null;
    const [owner, ...repoParts] = url.pathname.replace(/^\//, '').split('/');
    const name = repoParts.join('/');
    return owner && name ? { owner, name } : null;
  } catch { return null; }
};

const getGithubRepository = (repoRoot) =>
  parseGithubRemote(runGit(repoRoot, ['config', '--get', 'remote.origin.url']));

const createBranchSyncPayload = ({ repository, branchName, headSha, testEntry }) => {
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
      repository: { provider: 'github', owner: repository.owner, name: repository.name },
      branch: { name: branchName, headSha, expectedHeadVersion: null },
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
    const body = JSON.stringify(payload);
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => {
        const statusCode = response.statusCode ?? 0;
        let parsedBody = responseBody;
        if (responseBody) {
          try { parsedBody = JSON.parse(responseBody); } catch {}
        }
        if (statusCode < 200 || statusCode >= 300) {
          const error = new Error(`Backend TDD respondió ${statusCode}: ${
            typeof parsedBody === 'object'
              ? parsedBody.code ?? parsedBody.message ?? responseBody
              : parsedBody || 'sin cuerpo'
          }`);
          error.status = statusCode;
          reject(error);
          return;
        }
        resolve(parsedBody || null);
      });
    });

    request.setTimeout(timeoutMs, () => request.destroy(new Error('Timeout al sincronizar TDD.')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shouldRetry = (error) => !error?.status || [500, 502, 503, 504].includes(error.status);

const sendWithRetry = async ({ syncUrl, token, payload, maxAttempts = DEFAULT_MAX_ATTEMPTS }) => {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try { return await postJson(syncUrl, token, payload); }
    catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === maxAttempts) throw error;
      await sleep(500 * attempt);
    }
  }
  throw lastError;
};

const syncTestExecution = async ({ repoRoot, testEntry, syncUrl, token }) => {
  const branchName = getCurrentBranch(repoRoot);
  if (!branchName) throw new Error('No se pudo determinar la rama actual.');

  const repository = getGithubRepository(repoRoot);
  if (!repository) throw new Error('No se pudo determinar owner/repository desde Git.');

  const headSha = getHeadSha(repoRoot);
  if (!headSha) throw new Error('No se pudo obtener el SHA actual de Git.');

  const credentials = loadSyncCredentials({ repoRoot, syncUrl, token });
  const { payload, execution } = createBranchSyncPayload({ repository, branchName, headSha, testEntry });
  const response = await sendWithRetry({
    syncUrl: credentials.syncUrl,
    token: credentials.token,
    payload,
  });

  return { response, execution, branchName, headSha, credentialsSource: credentials.source };
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
