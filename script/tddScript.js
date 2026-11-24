import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { spawn } from 'cross-spawn';
import { getLastTestId } from './id_execution_tests_commit.js';
import { getLegacyTddLogFilePath, recordExecution } from './branchSyncExecution.js';

const COMMAND = 'jest';
const args = ['--json', '--outputFile=./script/report.json'];

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code);
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

const extractAndAddObject = async (reportFile, tddLogFile) => {
  try {
    const exitCode = await runCommand(COMMAND, args);

    ensureFileExists(tddLogFile, []);

    const jsonData = readJSONFile(reportFile);
    const passedTests = jsonData.numPassedTests;
    const failedTests = jsonData.numFailedTests; 
    const totalTests = jsonData.numTotalTests;
    const startTime = jsonData.startTime;
    const success = jsonData.success;
    let testId = getLastTestId(tddLogFile);

    const newReport = {
      numPassedTests: passedTests,
      failedTests: failedTests,
      numTotalTests: totalTests,
      timestamp: startTime,
      success: success,
      testId: testId
    };

    const tddLog = readJSONFile(tddLogFile);
    tddLog.push(newReport);

    writeJSONFile(tddLogFile, tddLog);
    recordExecution({
      numPassedTests: passedTests,
      failedTests,
      numTotalTests: totalTests,
      timestamp: startTime,
      success,
      testId,
      coveragePercentage: null,
    });

    if (exitCode !== 0) {
      process.exitCode = exitCode ?? 1;
    }
  } catch (error) {
    console.error("Error en la ejecución:", error);
    process.exitCode = 1;
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const inputFilePath = path.join(__dirname, 'report.json');
const outputFilePath = getLegacyTddLogFilePath();

extractAndAddObject(inputFilePath, outputFilePath);

export { extractAndAddObject };