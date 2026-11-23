import http from 'http';

const port = Number(process.env.MOCK_TDD_PORT || 4100);
const token = process.env.MOCK_TDD_TOKEN || 'a'.repeat(64);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/TDDCycles/sync') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'NOT_FOUND' }));
    return;
  }

  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer',
    });
    res.end(JSON.stringify({ code: 'UNAUTHORIZED' }));
    return;
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
  });

  req.on('end', () => {
    try {
      const body = JSON.parse(raw);
      const execution = body.executions?.[0];

      const valid =
        body.schemaVersion === 1 &&
        body.mode === 'incremental' &&
        body.repository?.provider === 'github' &&
        typeof body.repository?.owner === 'string' &&
        typeof body.repository?.name === 'string' &&
        typeof body.branch?.name === 'string' &&
        typeof body.branch?.headSha === 'string' &&
        Array.isArray(body.commits) &&
        Array.isArray(body.branchCommitShas) &&
        Array.isArray(body.executions) &&
        body.executions.length === 1 &&
        typeof execution?.eventId === 'string' &&
        execution?.branchAtCapture === body.branch.name &&
        execution?.headShaAtExecution === body.branch.headSha &&
        execution?.associatedCommitSha === null;

      if (!valid) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'INVALID_SYNC_BATCH' }));
        return;
      }

      console.log('\n--- BranchSyncData recibido ---');
      console.log(JSON.stringify(body, null, 2));
      console.log('--- fin ---\n');

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        schemaVersion: 1,
        mode: 'incremental',
        repository: body.repository,
        branch: body.branch.name,
        summary: {
          repositoryCreated: false,
          branchesAdded: 0,
          commitsAdded: 0,
          commitsUpdated: 0,
          relationsAdded: 0,
          executionsAdded: 1,
          executionsUpdated: 0,
        },
        headUpdate: {
          status: 'not_applied',
          reason: 'HEAD_UPDATES_NOT_SUPPORTED',
        },
      }));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'INVALID_JSON' }));
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock TDD sync: http://127.0.0.1:${port}/api/TDDCycles/sync`);
  console.log(`Mock token: ${token}`);
});
