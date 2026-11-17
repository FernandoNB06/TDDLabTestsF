import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

const BRANCH_SYNC_SCHEMA_VERSION = 1;
const BRANCH_SYNC_MODE = 'incremental';

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

  const sshUrlMatch = normalized.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/);
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
  const remoteUrl = runGit(repoRoot, ['config', '--get', 'remote.origin.url']);
  return parseGithubRemote(remoteUrl);
};

const getSafeBranchName = (branchName) => encodeURIComponent(branchName);

const getBranchSyncFilePath = (scriptDirectory, branchName) => {
  return path.join(scriptDirectory, 'branch-sync', `${getSafeBranchName(branchName)}.json`);
};

/**
 * Preserve the exact legacy filename on main so current TDDLab keeps working.
 * Other branches get isolated legacy logs, avoiding test executions from
 * parallel branches writing to the same tdd_log.json.
 */
const getLegacyTddLogFilePath = (scriptDirectory, branchName) => {
  if (!branchName || branchName === 'main') {
    return path.join(scriptDirectory, 'tdd_log.json');
  }

  return path.join(scriptDirectory, `tdd_log.${getSafeBranchName(branchName)}.json`);
};

const createBranchSyncData = ({ repository, branchName, headSha }) => ({
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
    // Scripts work offline and do not know the backend HEAD version.
    expectedHeadVersion: null,
  },
  commits: [],
  branchCommitShas: [],
  executions: [],
});

const readBranchSyncData = (filePath, initialData) => {
  if (!fs.existsSync(filePath)) {
    return initialData;
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (data.schemaVersion !== BRANCH_SYNC_SCHEMA_VERSION || data.mode !== BRANCH_SYNC_MODE) {
    throw new Error(`Unsupported branch sync format in ${filePath}`);
  }

  if (!Array.isArray(data.commits) || !Array.isArray(data.branchCommitShas) || !Array.isArray(data.executions)) {
    throw new Error(`Invalid branch sync structure in ${filePath}`);
  }

  return data;
};

const writeJsonAtomically = (filePath, data) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
};

/**
 * Captures a test execution in the BranchSyncData v1 shape agreed with Backend.
 *
 * The legacy tdd_log.json remains untouched by this helper. A separate file is
 * maintained per Git branch so parallel branches do not write to the same new
 * synchronization file.
 */
const appendBranchSyncExecution = ({ repoRoot, scriptDirectory, testEntry }) => {
  const branchName = getCurrentBranch(repoRoot);
  if (!branchName) {
    return {
      written: false,
      reason: 'detached-head-or-branch-unavailable',
    };
  }

  const repository = getGithubRepository(repoRoot);
  if (!repository) {
    return {
      written: false,
      reason: 'github-origin-unavailable',
    };
  }

  const headSha = getHeadSha(repoRoot);
  const filePath = getBranchSyncFilePath(scriptDirectory, branchName);
  const initialData = createBranchSyncData({ repository, branchName, headSha });
  const data = readBranchSyncData(filePath, initialData);

  if (
    data.repository?.provider !== 'github' ||
    data.repository?.owner !== repository.owner ||
    data.repository?.name !== repository.name
  ) {
    throw new Error(`Branch sync repository mismatch in ${filePath}`);
  }

  // Refresh only the information that Scripts can know locally.
  data.branch = {
    name: branchName,
    headSha,
    expectedHeadVersion: null,
  };

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
    // Kept only for compatibility. BranchSyncData explicitly states that
    // testId is not a globally unique identity.
    testId: testEntry.testId ?? null,
  };

  data.executions.push(execution);
  writeJsonAtomically(filePath, data);

  return {
    written: true,
    filePath,
    execution,
  };
};

export {
  appendBranchSyncExecution,
  getBranchSyncFilePath,
  getCurrentBranch,
  getGithubRepository,
  getHeadSha,
  getLegacyTddLogFilePath,
  parseGithubRemote,
};
