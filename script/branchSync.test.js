import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getBranchSyncFilePath,
  getHeadSha,
  getLegacyCommitHistoryFilePath,
  getLegacyTddLogFilePath,
  recordExecution,
} from "./branchSyncExecution.js";
import { captureCurrentCommit } from "./branchSyncCommit.js";

function git(repositoryRoot, ...args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepository() {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tddlab-branch-sync-"),
  );
  git(repositoryRoot, "init", "-b", "main");
  git(repositoryRoot, "config", "user.name", "TDDLab Test");
  git(repositoryRoot, "config", "user.email", "tddlab-test@example.com");
  git(
    repositoryRoot,
    "remote",
    "add",
    "origin",
    "https://github.com/team/project.git",
  );
  fs.mkdirSync(path.join(repositoryRoot, "script"), { recursive: true });
  fs.writeFileSync(path.join(repositoryRoot, "source.txt"), "initial\n");
  git(repositoryRoot, "add", "source.txt");
  git(repositoryRoot, "commit", "-m", "initial commit");
  return repositoryRoot;
}

function removeRepository(repositoryRoot) {
  fs.rmSync(repositoryRoot, { recursive: true, force: true });
}

test("associates pending executions with one unique branch commit", () => {
  const repositoryRoot = createRepository();
  try {
    git(repositoryRoot, "checkout", "-b", "feature/branch-a");
    const executionInput = {
      numPassedTests: 2,
      failedTests: 1,
      numTotalTests: 3,
      timestamp: 100,
      success: false,
      testId: 0,
      coveragePercentage: 70,
    };
    const firstExecution = recordExecution(executionInput, repositoryRoot);
    const latestExecution = recordExecution(
      { ...executionInput, failedTests: 0, success: true, timestamp: 200 },
      repositoryRoot,
    );

    fs.writeFileSync(path.join(repositoryRoot, "source.txt"), "updated\n");
    git(repositoryRoot, "add", "source.txt");
    git(repositoryRoot, "commit", "-m", "feature commit");

    const commitSha = git(repositoryRoot, "rev-parse", "HEAD");
    const data = captureCurrentCommit(repositoryRoot);
    const branchSyncPath = getBranchSyncFilePath(
      "feature/branch-a",
      repositoryRoot,
    );
    const savedData = JSON.parse(fs.readFileSync(branchSyncPath, "utf8"));

    assert.equal(data.branch.headSha, commitSha);
    assert.equal(data.branch.expectedHeadVersion, null);
    assert.deepEqual(
      data.executions.map((execution) => execution.associatedCommitSha),
      [commitSha, commitSha],
    );
    assert.notEqual(firstExecution.eventId, latestExecution.eventId);
    assert.equal(data.executions[0].branchAtCapture, "feature/branch-a");
    assert.equal(data.executions[0].headShaAtExecution, firstExecution.headShaAtExecution);
    assert.deepEqual(data.commits[0].parentShas, [
      git(repositoryRoot, "rev-parse", "HEAD^"),
    ]);
    assert.equal(data.commits[0].message, "feature commit");
    assert.deepEqual(data.commits[0].stats, {
      additions: 1,
      deletions: 1,
      total: 2,
    });
    assert.equal(data.commits[0].metrics.executionEventId, latestExecution.eventId);
    assert.equal(data.commits[0].metrics.conclusion, "success");
    assert.deepEqual(data.branchCommitShas, [commitSha]);

    captureCurrentCommit(repositoryRoot);
    const repeatedData = JSON.parse(fs.readFileSync(branchSyncPath, "utf8"));
    assert.equal(repeatedData.commits.length, 1);
    assert.equal(repeatedData.branchCommitShas.length, 1);
    assert.deepEqual(savedData.commits, data.commits);

    assert.equal(
      getLegacyTddLogFilePath("main", repositoryRoot),
      path.join(repositoryRoot, "script", "tdd_log.json"),
    );
    assert.equal(
      getLegacyCommitHistoryFilePath("main", repositoryRoot),
      path.join(repositoryRoot, "script", "commit-history.json"),
    );
    assert.match(
      getLegacyTddLogFilePath("feature/branch-a", repositoryRoot),
      /tdd_log\.feature%2Fbranch-a\.json$/,
    );
    assert.match(
      getLegacyCommitHistoryFilePath("feature/branch-a", repositoryRoot),
      /commit-history\.feature%2Fbranch-a\.json$/,
    );
  } finally {
    removeRepository(repositoryRoot);
  }
});

test("records every parent of a merge commit", () => {
  const repositoryRoot = createRepository();
  try {
    git(repositoryRoot, "checkout", "-b", "rama-a");
    fs.writeFileSync(path.join(repositoryRoot, "rama-a.txt"), "A\n");
    git(repositoryRoot, "add", "rama-a.txt");
    git(repositoryRoot, "commit", "-m", "commit on A");

    git(repositoryRoot, "checkout", "main");
    git(repositoryRoot, "checkout", "-b", "rama-b");
    fs.writeFileSync(path.join(repositoryRoot, "rama-b.txt"), "B\n");
    git(repositoryRoot, "add", "rama-b.txt");
    git(repositoryRoot, "commit", "-m", "commit on B");

    git(repositoryRoot, "checkout", "main");
    git(repositoryRoot, "merge", "--no-ff", "rama-a", "-m", "merge A");
    git(repositoryRoot, "merge", "--no-ff", "rama-b", "-m", "merge B");

    const expectedParents = git(
      repositoryRoot,
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD",
    )
      .split(/\s+/)
      .slice(1);
    const data = captureCurrentCommit(repositoryRoot);

    assert.equal(expectedParents.length, 2);
    assert.deepEqual(data.commits[0].parentShas, expectedParents);
    assert.equal(data.commits[0].metrics, null);
    assert.equal(
      data.branch.headSha,
      git(repositoryRoot, "rev-parse", "HEAD"),
    );
  } finally {
    removeRepository(repositoryRoot);
  }
});

test("keeps executions and legacy paths isolated between branches", () => {
  const repositoryRoot = createRepository();
  try {
    const executionInput = {
      numPassedTests: 1,
      failedTests: 0,
      numTotalTests: 1,
      timestamp: Date.now(),
      success: true,
      testId: 0,
      coveragePercentage: null,
    };
    const mainExecution = recordExecution(executionInput, repositoryRoot);

    git(repositoryRoot, "checkout", "-b", "rama-a");
    const branchExecution = recordExecution(
      { ...executionInput, timestamp: Date.now() + 1 },
      repositoryRoot,
    );
    fs.writeFileSync(path.join(repositoryRoot, "rama-a.txt"), "A\n");
    git(repositoryRoot, "add", "rama-a.txt");
    git(repositoryRoot, "commit", "-m", "commit on A");
    const branchSha = git(repositoryRoot, "rev-parse", "HEAD");
    captureCurrentCommit(repositoryRoot);

    git(repositoryRoot, "checkout", "main");
    fs.writeFileSync(path.join(repositoryRoot, "source.txt"), "main update\n");
    git(repositoryRoot, "add", "source.txt");
    git(repositoryRoot, "commit", "-m", "commit on main");
    const mainSha = git(repositoryRoot, "rev-parse", "HEAD");
    captureCurrentCommit(repositoryRoot);

    const mainData = JSON.parse(
      fs.readFileSync(getBranchSyncFilePath("main", repositoryRoot), "utf8"),
    );
    const branchData = JSON.parse(
      fs.readFileSync(getBranchSyncFilePath("rama-a", repositoryRoot), "utf8"),
    );

    assert.deepEqual(
      mainData.executions.map((execution) => execution.eventId),
      [mainExecution.eventId],
    );
    assert.equal(mainData.executions[0].associatedCommitSha, mainSha);
    assert.deepEqual(
      branchData.executions.map((execution) => execution.eventId),
      [branchExecution.eventId],
    );
    assert.equal(branchData.executions[0].branchAtCapture, "rama-a");
    assert.equal(branchData.executions[0].associatedCommitSha, branchSha);
  } finally {
    removeRepository(repositoryRoot);
  }
});

test("allows execution capture before the first commit", () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tddlab-unborn-branch-"),
  );
  try {
    git(repositoryRoot, "init", "-b", "main");
    git(repositoryRoot, "remote", "add", "origin", "https://github.com/team/project.git");

    assert.equal(getHeadSha(repositoryRoot), null);
    const execution = recordExecution(
      {
        numPassedTests: 1,
        failedTests: 0,
        numTotalTests: 1,
        timestamp: 100,
        success: true,
        testId: 0,
        coveragePercentage: null,
      },
      repositoryRoot,
    );
    const data = JSON.parse(
      fs.readFileSync(getBranchSyncFilePath("main", repositoryRoot), "utf8"),
    );

    assert.equal(execution.headShaAtExecution, null);
    assert.equal(data.executions[0].eventId, execution.eventId);
  } finally {
    removeRepository(repositoryRoot);
  }
});
