import http from 'node:http';
import https from 'node:https';
import { loadSyncCredentials } from './tddSyncConfig.js';
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

function runGit(args, repositoryRoot) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getBranchFileName(branch) {
  if (!branch || typeof branch !== "string") {
    throw new Error("Se requiere una rama Git con nombre.");
  }

  return encodeURIComponent(branch);
}

export function getCurrentBranch(repositoryRoot = PROJECT_ROOT) {
  const branch = runGit(["branch", "--show-current"], repositoryRoot);
  if (!branch) {
    throw new Error("No se puede registrar branch-sync con HEAD separado.");
  }

  return branch;
}

export function getHeadSha(repositoryRoot = PROJECT_ROOT) {
  runGit(["rev-parse", "--show-toplevel"], repositoryRoot);
  try {
    return runGit(["rev-parse", "--verify", "--quiet", "HEAD"], repositoryRoot);
  } catch (error) {
    if (error.status !== 1) throw error;

    try {
      const headRef = runGit(["symbolic-ref", "--quiet", "HEAD"], repositoryRoot);
      if (headRef.startsWith("refs/heads/")) {
        return null;
      }
    } catch {
      throw error;
    }

    throw error;
  }
}

export function getGithubRepository(repositoryRoot = PROJECT_ROOT) {
  let remote;
  try {
    remote = runGit(["remote", "get-url", "origin"], repositoryRoot);
  } catch (error) {
    throw new Error("No se pudo obtener la URL GitHub del remoto origin.", {
      cause: error,
    });
  }

  const githubUrl = remote.match(
    /^(?:https?:\/\/|ssh:\/\/(?:[^@/]+@)?|(?:[^@/]+@))?(?:www\.)?github\.com[:/](.+)$/i,
  );
  const parts = githubUrl?.[1].replace(/\.git$/i, "").split("/");
  if (!parts || parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error(`El remoto origin no es un repositorio GitHub válido: ${remote}`);
  }

  return { provider: "github", owner: parts[0], name: parts[1] };
}

export function getBranchSyncFilePath(
  branch = getCurrentBranch(),
  repositoryRoot = PROJECT_ROOT,
) {
  return path.join(
    repositoryRoot,
    "script",
    "branch-sync",
    `${getBranchFileName(branch)}.json`,
  );
}

export function getLegacyTddLogFilePath(
  branch = getCurrentBranch(),
  repositoryRoot = PROJECT_ROOT,
) {
  const fileName =
    branch === "main" ? "tdd_log.json" : `tdd_log.${getBranchFileName(branch)}.json`;
  return path.join(repositoryRoot, "script", fileName);
}

export function getLegacyCommitHistoryFilePath(
  branch = getCurrentBranch(),
  repositoryRoot = PROJECT_ROOT,
) {
  const fileName =
    branch === "main"
      ? "commit-history.json"
      : `commit-history.${getBranchFileName(branch)}.json`;
  return path.join(repositoryRoot, "script", fileName);
}

export function readBranchSyncData(
  branch,
  repositoryRoot = PROJECT_ROOT,
  headSha = getHeadSha(repositoryRoot),
) {
  const filePath = getBranchSyncFilePath(branch, repositoryRoot);
  if (fs.existsSync(filePath)) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`No se pudo leer el archivo branch-sync ${filePath}.`, {
        cause: error,
      });
    }

    if (
      data.schemaVersion !== 1 ||
      data.mode !== "incremental" ||
      data.branch?.name !== branch ||
      !Array.isArray(data.commits) ||
      !Array.isArray(data.branchCommitShas) ||
      !Array.isArray(data.executions)
    ) {
      throw new Error(`El archivo branch-sync ${filePath} no cumple el contrato esperado.`);
    }

    return { filePath, data };
  }

  return {
    filePath,
    data: {
      schemaVersion: 1,
      mode: "incremental",
      repository: getGithubRepository(repositoryRoot),
      branch: {
        name: branch,
        headSha,
        expectedHeadVersion: null,
      },
      commits: [],
      branchCommitShas: [],
      executions: [],
    },
  };
}

export function writeBranchSyncData(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        console.error("No se pudo limpiar el archivo temporal branch-sync:", cleanupError);
      }
    }
    throw new Error(`No se pudo guardar el archivo branch-sync ${filePath}.`, {
      cause: error,
    });
  }
}

export function recordExecution(
  result,
  repositoryRoot = PROJECT_ROOT,
) {
  const branch = getCurrentBranch(repositoryRoot);
  const headSha = getHeadSha(repositoryRoot);
  const { filePath, data } = readBranchSyncData(branch, repositoryRoot, headSha);
  const execution = {
    eventId: crypto.randomUUID(),
    branchAtCapture: branch,
    headShaAtExecution: headSha,
    associatedCommitSha: null,
    timestamp: result.timestamp,
    numPassedTests: result.numPassedTests,
    failedTests: result.failedTests,
    numTotalTests: result.numTotalTests,
    coveragePercentage: result.coveragePercentage ?? null,
    success: result.success,
    testId: result.testId,
  };

  data.branch = { name: branch, headSha, expectedHeadVersion: null };
  data.executions.push(execution);
  writeBranchSyncData(filePath, data);
  return execution;
}

const BRANCH_SYNC_SCHEMA_VERSION = 1;
const BRANCH_SYNC_MODE = "incremental";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_ATTEMPTS = 3;

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

const createBranchSyncPayload = ({ repository, branchName, headSha, testEntry, existingExecution }) => {
  const execution = existingExecution ?? {
    eventId: crypto.randomUUID(),
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

const syncTestExecution = async ({ repoRoot, testEntry, syncUrl, token, execution: existingExecution }) => {
  const branchName = getCurrentBranch(repoRoot);
  if (!branchName) throw new Error('No se pudo determinar la rama actual.');

  const repository = getGithubRepository(repoRoot);
  if (!repository) throw new Error('No se pudo determinar owner/repository desde Git.');

  const headSha = getHeadSha(repoRoot);
  if (!headSha) throw new Error('No se pudo obtener el SHA actual de Git.');

  const credentials = loadSyncCredentials({ repoRoot, syncUrl, token });
  const { payload, execution } = createBranchSyncPayload({ repository, branchName, headSha, testEntry, existingExecution });
  const response = await sendWithRetry({
    syncUrl: credentials.syncUrl,
    token: credentials.token,
    payload,
  });

  return { response, execution, branchName, headSha, credentialsSource: credentials.source };
};

export {
  createBranchSyncPayload,
  parseGithubRemote,
  postJson,
  sendWithRetry,
  syncTestExecution,
};
