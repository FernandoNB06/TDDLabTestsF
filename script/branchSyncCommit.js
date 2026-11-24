import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  getCurrentBranch, getHeadSha, getGithubRepository, sendWithRetry,
} from './branchSyncExecution.js';
import { loadSyncCredentials } from './tddSyncConfig.js';
import { runJest } from './tddScript.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function getCoverage(report) {
  if (!report.coverageMap) return null;
  let covered = 0;
  let total = 0;
  for (const file of Object.values(report.coverageMap)) {
    for (const count of Object.values(file.s ?? {})) {
      total += 1;
      if (count > 0) covered += 1;
    }
  }
  return total ? Math.round(covered / total * 10000) / 100 : null;
}

// Captura exclusivamente en memoria: no lee ni genera archivos de logs.
export function captureCurrentCommit(repoRoot = PROJECT_ROOT, report = null) {
  const branchName = getCurrentBranch(repoRoot);
  const sha = getHeadSha(repoRoot);
  const repository = getGithubRepository(repoRoot);
  if (!branchName) throw new Error('No se puede sincronizar un commit con HEAD separado.');
  if (!sha) throw new Error('No existe un commit HEAD para sincronizar.');
  if (!repository) throw new Error('No se pudo determinar el repositorio GitHub desde origin.');

  const parentShas = git(repoRoot, ['rev-list', '--parents', '-n', '1', sha])
    .split(/\s+/).slice(1);
  const statArgs = parentShas.length
    ? ['diff', '--numstat', parentShas[0], sha]
    : ['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', sha];
  let additions = 0;
  let deletions = 0;
  for (const line of git(repoRoot, statArgs).split(/\r?\n/).filter(Boolean)) {
    const [added, deleted] = line.split('\t');
    if (added !== '-') additions += Number(added);
    if (deleted !== '-') deletions += Number(deleted);
  }

  const executions = report ? [{
    eventId: randomUUID(),
    branchAtCapture: branchName,
    headShaAtExecution: sha,
    associatedCommitSha: sha,
    timestamp: report.startTime ?? Date.now(),
    numPassedTests: report.numPassedTests,
    failedTests: report.numFailedTests,
    numTotalTests: report.numTotalTests,
    coveragePercentage: getCoverage(report),
    success: report.success,
    testId: null,
  }] : [];
  const execution = executions[0];
  return {
    schemaVersion: 1,
    mode: 'incremental',
    repository: { provider: 'github', ...repository },
    branch: { name: branchName, headSha: sha, expectedHeadVersion: null },
    commits: [{
      sha,
      parentShas,
      message: git(repoRoot, ['show', '-s', '--format=%B', sha]),
      committedAt: new Date(git(repoRoot, ['show', '-s', '--format=%cI', sha])).toISOString(),
      stats: { additions, deletions, total: additions + deletions },
      metrics: execution ? {
        executionEventId: execution.eventId,
        numPassedTests: execution.numPassedTests,
        failedTests: execution.failedTests,
        numTotalTests: execution.numTotalTests,
        coveragePercentage: execution.coveragePercentage,
        conclusion: execution.failedTests > 0 ? 'failure'
          : execution.numTotalTests > 0 ? 'success' : 'neutral',
      } : null,
    }],
    branchCommitShas: [sha],
    executions,
  };
}

export async function syncCurrentCommit({
  repoRoot = PROJECT_ROOT, report = null, syncUrl, token,
} = {}) {
  const credentials = loadSyncCredentials({ repoRoot, syncUrl, token });
  const payload = captureCurrentCommit(repoRoot, report);
  const response = await sendWithRetry({
    syncUrl: credentials.syncUrl, token: credentials.token, payload,
  });
  return { response, payload };
}

export async function runCommitSync(repoRoot = PROJECT_ROOT) {
  try {
    // Verificar la vinculacion antes de ejecutar las pruebas.
    const credentials = loadSyncCredentials({ repoRoot });
    let report = null;
    try {
      ({ report } = await runJest(process.execPath, [
        path.join(repoRoot, 'node_modules', 'jest', 'bin', 'jest.js'),
        '--json', '--coverage', '--coverageReporters=none', '--runInBand',
      ]));
    } catch (error) {
      console.warn(`No se pudieron obtener metricas: ${error.message}`);
    }
    const { payload } = await syncCurrentCommit({ repoRoot, report, ...credentials });
    console.log(`TDDLab commit sincronizado: ${payload.commits[0].sha} | ${payload.branch.name}`);
  } catch (error) {
    console.warn(`TDDLab commit no sincronizado: ${error.message}`);
    console.warn('No se guardaron logs locales. Reintenta con npm run tdd:sync-commit.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCommitSync();
}
