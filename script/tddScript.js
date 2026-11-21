import { fileURLToPath } from 'url';
import path from 'path';
import { spawn } from 'cross-spawn';
import { syncTestExecution } from './branchSyncExecution.js';

const COMMAND = 'jest';
const args = ['--json'];

function runJest(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ['inherit', 'pipe', 'inherit'],
    });

    let jsonOutput = '';

    child.stdout.on('data', (chunk) => {
      jsonOutput += chunk.toString();
    });

    child.on('error', reject);

    child.on('close', (code) => {
      try {
        const report = JSON.parse(jsonOutput);
        resolve({
          code: code ?? 1,
          report,
        });
      } catch (error) {
        reject(
          new Error(
            `No se pudo interpretar la salida JSON de Jest: ${error.message}`,
          ),
        );
      }
    });
  });
}

const runTestsAndSync = async () => {
  const __filename = fileURLToPath(import.meta.url);
  const scriptDirectory = path.dirname(__filename);
  const repoRoot = path.resolve(scriptDirectory, '..');

  try {
    const { code, report } = await runJest(COMMAND, args);

    const testEntry = {
      numPassedTests: report.numPassedTests,
      failedTests: report.numFailedTests,
      numTotalTests: report.numTotalTests,
      timestamp: report.startTime ?? Date.now(),
      success: report.success,
      testId: null,
    };

    const result = await syncTestExecution({
      repoRoot,
      testEntry,
    });

    console.log(
      `TDD execution synced: ${result.execution.eventId} | ${result.branchName} | ${result.headSha.slice(0, 7)}`,
    );

    if (code !== 0) {
      process.exitCode = code;
    }
  } catch (error) {
    console.error('Error en la ejecución o sincronización TDD:', error.message);
    process.exitCode = 1;
  }
};

runTestsAndSync();

export { runJest, runTestsAndSync };
