import http from 'http';

const port = Number(process.env.MOCK_TDD_PORT || 4100);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/TDDCycles/history/sync') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
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
        res.end(JSON.stringify({ error: 'payload inválido' }));
        return;
      }

      console.log('\n--- BranchSyncData recibido ---');
      console.log(JSON.stringify(body, null, 2));
      console.log('--- fin ---\n');

      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          executionsAdded: 1,
          eventId: execution.eventId,
        }),
      );
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(
    `Mock TDD sync escuchando en http://127.0.0.1:${port}/api/TDDCycles/history/sync`,
  );
});
