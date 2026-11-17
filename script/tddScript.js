import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { spawn } from 'cross-spawn';
import { getLastTestId } from './id_execution_tests_commit.js';
import {
  appendBranchSyncExecution,
  getCurrentBranch,
  getLegacyTddLogFilePath,
} from './branchSyncExecution.js';

const COMMAND = 'jest';
const args = ['--json', '--outputFile=./script/report.json'];

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: 'inherit' });
    process.on('close', () => {
      resolve();
    });
  });
}

const readJSONFile = (filePath) => {
  const rawData = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(rawData);
};

const writeJSONFile = (filePath, data) => {
  const jsonString = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, jsonString, 'utf-8');
};

const ensureFileExists = (filePath, initialData) => {
  if (!fs.existsSync(filePath)) {
    writeJSONFile(filePath, initialData);
  }
};

const extractAndAddObject = async (reportFile, tddLogFile = null) => {
  try {
    await runCommand(COMMAND, args);

    const __filename = fileURLToPath(import.meta.url);
    const scriptDirectory = path.dirname(__filename);
    const repoRoot = path.resolve(scriptDirectory, '..');
    const branchName = getCurrentBranch(repoRoot);
    const resolvedTddLogFile = tddLogFile ?? getLegacyTddLogFilePath(scriptDirectory, branchName);

    ensureFileExists(resolvedTddLogFile, []);

    const jsonData = readJSONFile(reportFile);
    const passedTests = jsonData.numPassedTests;
    const failedTests = jsonData.numFailedTests;
    const totalTests = jsonData.numTotalTests;
    const startTime = jsonData.startTime;
    const success = jsonData.success;
    const testId = getLastTestId(resolvedTddLogFile);

    // Keep the legacy entry shape compatible with the current TDDLab reader.
    const newReport = {
      numPassedTests: passedTests,
      failedTests: failedTests,
      numTotalTests: totalTests,
      timestamp: startTime,
      success: success,
      testId: testId
    };

    const tddLog = readJSONFile(resolvedTddLogFile);
    tddLog.push(newReport);
    writeJSONFile(resolvedTddLogFile, tddLog);

    // New branch-aware capture. Failure here must not break the legacy TDD log.
    try {
      const result = appendBranchSyncExecution({
        repoRoot,
        scriptDirectory,
        testEntry: newReport,
      });

      if (!result.written) {
        console.warn(`Branch-aware TDD execution was not recorded: ${result.reason}`);
      }
    } catch (branchSyncError) {
      console.warn('Could not record branch-aware TDD execution:', branchSyncError.message);
    }
  } catch (error) {
    console.error('Error en la ejecución:', error);
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const inputFilePath = path.join(__dirname, 'report.json');

extractAndAddObject(inputFilePath);

export { extractAndAddObject };
