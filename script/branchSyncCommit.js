import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  getCurrentBranch,
  getHeadSha,
  readBranchSyncData,
  writeBranchSyncData,
} from "./branchSyncExecution.js";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

function runGit(args, repositoryRoot) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getCommitStats(sha, parentShas, repositoryRoot) {
  const args =
    parentShas.length > 0
      ? ["diff", "--numstat", parentShas[0], sha]
      : ["diff-tree", "--root", "--no-commit-id", "--numstat", "-r", sha];
  const output = runGit(args, repositoryRoot);
  let additions = 0;
  let deletions = 0;

  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [added, deleted] = line.split("\t");
    if (added !== "-") additions += Number(added);
    if (deleted !== "-") deletions += Number(deleted);
  }

  return { additions, deletions, total: additions + deletions };
}

function getMetrics(execution) {
  if (!execution) return null;

  let conclusion = "neutral";
  if (execution.failedTests > 0) {
    conclusion = "failure";
  } else if (execution.numTotalTests > 0) {
    conclusion = "success";
  }

  return {
    executionEventId: execution.eventId,
    numPassedTests: execution.numPassedTests,
    failedTests: execution.failedTests,
    numTotalTests: execution.numTotalTests,
    coveragePercentage: execution.coveragePercentage,
    conclusion,
  };
}

export function captureCurrentCommit(repositoryRoot = PROJECT_ROOT) {
  const branch = getCurrentBranch(repositoryRoot);
  const sha = getHeadSha(repositoryRoot);
  if (!sha) {
    throw new Error("No existe un commit HEAD que se pueda registrar.");
  }

  const commitRecord = runGit(
    ["rev-list", "--parents", "-n", "1", sha],
    repositoryRoot,
  )
    .split(/\s+/)
    .filter(Boolean);
  if (commitRecord[0] !== sha) {
    throw new Error(`Git devolvió un SHA inesperado para HEAD: ${commitRecord[0]}`);
  }

  const parentShas = commitRecord.slice(1);
  const message = execFileSync("git", ["show", "-s", "--format=%B", sha], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
  const committedAt = new Date(
    runGit(["show", "-s", "--format=%cI", sha], repositoryRoot),
  ).toISOString();
  const stats = getCommitStats(sha, parentShas, repositoryRoot);
  const { filePath, data } = readBranchSyncData(branch, repositoryRoot, sha);
  const pendingExecutions = data.executions.filter(
    (execution) =>
      execution.branchAtCapture === branch &&
      execution.associatedCommitSha === null,
  );
  const latestExecution = pendingExecutions.reduce(
    (latest, execution) =>
      latest === null || execution.timestamp >= latest.timestamp
        ? execution
        : latest,
    null,
  );

  data.executions = data.executions.map((execution) =>
    pendingExecutions.includes(execution)
      ? { ...execution, associatedCommitSha: sha }
      : execution,
  );

  if (!data.commits.some((commit) => commit.sha === sha)) {
    data.commits.push({
      sha,
      parentShas,
      message,
      committedAt,
      stats,
      metrics: getMetrics(latestExecution),
    });
  }

  if (!data.branchCommitShas.includes(sha)) {
    data.branchCommitShas.push(sha);
  }
  data.branch = {
    name: branch,
    headSha: sha,
    expectedHeadVersion: null,
  };

  writeBranchSyncData(filePath, data);
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    captureCurrentCommit();
  } catch (error) {
    console.error("Error al registrar el commit en branch-sync:", error);
    process.exitCode = 1;
  }
}
