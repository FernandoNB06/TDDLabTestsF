import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureCurrentCommit, syncCurrentCommit } from './branchSyncCommit.js';
import { syncTestExecution } from './branchSyncExecution.js';
import { runJest } from './tddScript.js';

const TOKEN = 'test-token-'.padEnd(40, 'x');
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const report = {
  numPassedTests: 2, numFailedTests: 1, numTotalTests: 3,
  startTime: 1234, success: false,
  coverageMap: { file: { s: { 0: 1, 1: 0, 2: 1, 3: 0 } } },
};
function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tddlab-remote-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'TDDLab Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'remote', 'add', 'origin', 'https://github.com/team/project.git');
  fs.mkdirSync(path.join(root, 'script'));
  // Existing history must remain untouched, even when it is not valid JSON.
  fs.writeFileSync(path.join(root, 'script', 'tdd_log.json'), 'historical log');
  fs.writeFileSync(path.join(root, 'script', 'commit-history.json'), 'historical commits');
  fs.writeFileSync(path.join(root, 'source.txt'), 'initial\n');
  git(root, 'add', '.');
  git(root, '-c', 'core.hooksPath=unused-hooks', 'commit', '-m', 'initial');
  return root;
}
function snapshot(root) {
  return {
    head: git(root, 'rev-parse', 'HEAD'),
    status: git(root, 'status', '--porcelain', '--untracked-files=all'),
    files: fs.readdirSync(path.join(root, 'script')).sort(),
    log: fs.readFileSync(path.join(root, 'script', 'tdd_log.json'), 'utf8'),
    commits: fs.readFileSync(path.join(root, 'script', 'commit-history.json'), 'utf8'),
  };
}
async function backend(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ payload: JSON.parse(body), headers: req.headers, url: req.url });
      const status = handler?.(requests) ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { saved: true } : { code: 'test-error' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, syncUrl: `http://127.0.0.1:${server.address().port}/api/TDDCycles/sync` };
}

test('captures the actual SHA, root parents and metrics without reading or writing history', t => {
  const root = repository(t);
  const before = snapshot(root);
  const payload = captureCurrentCommit(root, report);
  assert.equal(payload.commits[0].sha, before.head);
  assert.deepEqual(payload.commits[0].parentShas, []);
  assert.equal(payload.commits[0].message, 'initial');
  assert.equal(payload.commits[0].metrics.coveragePercentage, 50);
  assert.equal(payload.commits[0].metrics.conclusion, 'failure');
  assert.equal(payload.executions[0].associatedCommitSha, before.head);
  assert.equal(payload.commits[0].metrics.executionEventId, payload.executions[0].eventId);
  assert.deepEqual(snapshot(root), before);
});

test('keeps all parents of a merge and does not invent metrics', t => {
  const root = repository(t);
  git(root, 'checkout', '-b', 'rama-a');
  fs.writeFileSync(path.join(root, 'a.txt'), 'A\n');
  git(root, 'add', 'a.txt');
  git(root, '-c', 'core.hooksPath=unused-hooks', 'commit', '-m', 'A');
  git(root, 'checkout', 'main');
  fs.writeFileSync(path.join(root, 'b.txt'), 'B\n');
  git(root, 'add', 'b.txt');
  git(root, '-c', 'core.hooksPath=unused-hooks', 'commit', '-m', 'B');
  git(root, '-c', 'core.hooksPath=unused-hooks', 'merge', '--no-ff', 'rama-a', '-m', 'merge A');
  const before = snapshot(root);
  const payload = captureCurrentCommit(root);
  assert.deepEqual(payload.commits[0].parentShas,
    git(root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/).slice(1));
  assert.equal(payload.commits[0].parentShas.length, 2);
  assert.equal(payload.commits[0].metrics, null);
  assert.deepEqual(payload.executions, []);
  assert.deepEqual(snapshot(root), before);
});

test('sends an authenticated commit batch to the configured backend without local logs', async t => {
  const root = repository(t);
  git(root, 'checkout', '-b', 'feature/commit-sync');
  const before = snapshot(root);
  const remote = await backend(t);
  const result = await syncCurrentCommit({ repoRoot: root, report, token: TOKEN, syncUrl: remote.syncUrl });
  assert.equal(result.response.saved, true);
  assert.equal(remote.requests.length, 1);
  const request = remote.requests[0];
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.url, '/api/TDDCycles/sync');
  assert.deepEqual(request.payload.repository, { provider: 'github', owner: 'team', name: 'project' });
  assert.equal(request.payload.branch.name, 'feature/commit-sync');
  assert.deepEqual(request.payload.branchCommitShas, [before.head]);
  assert.equal(request.payload.executions[0].associatedCommitSha, before.head);
  assert.deepEqual(snapshot(root), before);
});

test('retries temporary failures with the same event identity and payload', async t => {
  const root = repository(t);
  const before = snapshot(root);
  const remote = await backend(t, requests => requests.length === 1 ? 503 : 200);
  await syncCurrentCommit({ repoRoot: root, report, token: TOKEN, syncUrl: remote.syncUrl });
  assert.equal(remote.requests.length, 2);
  assert.deepEqual(remote.requests[0].payload, remote.requests[1].payload);
  assert.deepEqual(snapshot(root), before);
});

test('rejects authorization failures without retrying or creating a local fallback', async t => {
  const root = repository(t);
  const before = snapshot(root);
  const remote = await backend(t, () => 401);
  await assert.rejects(syncCurrentCommit({ repoRoot: root, report, token: TOKEN, syncUrl: remote.syncUrl }),
    error => error.status === 401);
  assert.equal(remote.requests.length, 1);
  assert.deepEqual(snapshot(root), before);
});

test('sends test executions using the integrated branch transport without local logs', async t => {
  const root = repository(t);
  const before = snapshot(root);
  const remote = await backend(t);
  const testEntry = { numPassedTests: 2, failedTests: 1, numTotalTests: 3, timestamp: 1234, success: false };
  const result = await syncTestExecution({ repoRoot: root, testEntry, token: TOKEN, syncUrl: remote.syncUrl });
  assert.equal(remote.requests[0].payload.executions[0].eventId, result.execution.eventId);
  assert.equal(result.execution.headShaAtExecution, before.head);
  assert.equal(result.execution.associatedCommitSha, null);
  assert.deepEqual(snapshot(root), before);
});

test('missing credentials fail explicitly without generating local history', async t => {
  const root = repository(t);
  const before = snapshot(root);
  await assert.rejects(syncCurrentCommit({ repoRoot: root, syncUrl: '', token: '' }), /no vinculado/);
  assert.deepEqual(snapshot(root), before);
});

test('Jest reports are parsed in memory and preserve a failing test exit code', async () => {
  const result = await runJest(process.execPath, ['-e',
    `console.log(JSON.stringify({numPassedTests:0,numFailedTests:1}));process.exitCode=1;`]);
  assert.equal(result.code, 1);
  assert.equal(result.report.numFailedTests, 1);
});

test('post-commit uses only remote sync and does not amend or stage logs', () => {
  const hook = fs.readFileSync(path.join(scriptRoot, '..', '.husky', 'post-commit'), 'utf8');
  assert.match(hook, /branchSyncCommit\.js/);
  assert.doesNotMatch(hook, /--amend|git add|stageLegacyLogs|commit-tracker|commitScript/);
});


test('commit CLI obtains Jest metrics and sends them without modifying local history or HEAD', async t => {
  const root = path.resolve(scriptRoot, '..');
  const before = snapshot(root);
  const remote = await backend(t);
  await new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(scriptRoot, 'branchSyncCommit.js')], {
      cwd: root,
      timeout: 30000,
      env: { ...process.env, TDD_SYNC_URL: remote.syncUrl, TDD_SYNC_TOKEN: TOKEN },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
      else resolve();
    });
  });
  assert.equal(remote.requests.length, 1);
  const payload = remote.requests[0].payload;
  assert.equal(payload.commits[0].sha, before.head);
  assert.equal(payload.commits[0].metrics.numTotalTests, 5);
  assert.equal(payload.commits[0].metrics.conclusion, 'success');
  assert.equal(payload.executions[0].associatedCommitSha, before.head);
  assert.deepEqual(snapshot(root), before);
});
