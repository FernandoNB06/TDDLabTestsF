import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  getCurrentBranch,
  getLegacyCommitHistoryFilePath,
  getLegacyTddLogFilePath,
} from "./branchSyncExecution.js";

const branch = getCurrentBranch();
for (const filePath of [
  getLegacyTddLogFilePath(branch),
  getLegacyCommitHistoryFilePath(branch),
]) {
  const gitPath = path
    .relative(process.cwd(), filePath)
    .split(path.sep)
    .join("/");
  execFileSync("git", ["add", "--", gitPath], { stdio: "inherit" });
}
