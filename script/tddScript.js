import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'node:fs';
import { getLastTestId } from './id_execution_tests_commit.js';
import { spawn } from 'cross-spawn';
import { syncTestExecution, getLegacyTddLogFilePath, recordExecution } from './branchSyncExecution.js';

const COMMAND = 'jest';
const args = ['--json'];

function runJest(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ['inherit', 'pipe', 'inherit'] });
    let jsonOutput = '';
    child.stdout.on('data', (chunk) => { jsonOutput += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      try { resolve({ code: code ?? 1, report: JSON.parse(jsonOutput) }); }
      catch (error) { reject(new Error(`No se pudo interpretar la salida JSON de Jest: ${error.message}`)); }
    });
  });
}

const runTestsAndSync = async () => {
  const __filename = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(__filename), '..');

  let code;
  let report;
  try {
    ({ code, report } = await runJest(COMMAND, args));
  } catch (error) {
    console.error('Error al ejecutar Jest:', error.message);
    process.exitCode = 1;
    return;
  }

  const testEntry = {
    numPassedTests: report.numPassedTests,
    failedTests: report.numFailedTests,
    numTotalTests: report.numTotalTests,
    timestamp: report.startTime ?? Date.now(),
    success: report.success,
    testId: null,
  };

  let execution;
  try {
    const logPath = getLegacyTddLogFilePath(undefined, repoRoot);
    testEntry.testId = getLastTestId(logPath);
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    log.push(testEntry);
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
    execution = recordExecution(testEntry, repoRoot);
  } catch (error) {
    console.error(`Error al registrar la ejecucion local: ${error.message}`);
    process.exitCode = code || 1;
    return;
  }

  try {
    const result = await syncTestExecution({ repoRoot, testEntry, execution });
    console.log(`TDDLab synced: ${result.execution.eventId} | ${result.branchName} | ${result.headSha.slice(0, 7)}`);
  } catch (error) {
    console.warn(`TDDLab sync warning: ${error.message}`);
    console.warn('Las pruebas conservarán su resultado aunque la sincronización falle.');
  }

  process.exitCode = code;
};

runTestsAndSync();
export { runJest, runTestsAndSync };
