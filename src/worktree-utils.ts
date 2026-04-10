import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";

export interface Worktree {
  root: string;
  worktree: string;
  path: string;
  branch: string;
  repo: string;
  status: string;
  pr_number: number | null;
}

export interface StatusFile {
  updated_at: string;
  error?: boolean;
  exit_code?: number;
  worktrees: Worktree[] | null;
}

export const STATUS_FILE = "/tmp/gh-worktree-status/status.json";

export function statusLabel(status: string): string {
  switch (status) {
    case "open":             return "Open";
    case "draft":            return "Draft";
    case "merged":           return "Merged";
    case "closed":           return "Closed";
    case "remote_no_pr":     return "No PR";
    case "no_remote_branch": return "Not Pushed";
    case "no_remote":        return "No Remote";
    case "detached_head":    return "Detached HEAD";
    default:                 return status;
  }
}

export function statusOrder(status: string): number {
  switch (status) {
    case "merged":           return 0;
    case "open":             return 1;
    case "draft":            return 2;
    case "remote_no_pr":     return 3;
    case "no_remote":        return 4;
    case "no_remote_branch": return 5;
    default:                 return 6;
  }
}

export function loadStatus(): StatusFile | null {
  if (!existsSync(STATUS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATUS_FILE, "utf-8")) as StatusFile;
  } catch {
    return null;
  }
}

export function getMainWorktreePath(worktreePath: string): string {
  const output = execSync(`git -C "${worktreePath}" worktree list --porcelain`, { encoding: "utf-8" });
  return output.split("\n")[0].replace(/^worktree /, "").trim();
}

export function removeWorktree(wt: Worktree): void {
  const mainPath = getMainWorktreePath(wt.path);
  execSync(`git -C "${mainPath}" worktree remove --force "${wt.path}"`);
  if (wt.branch) {
    execSync(`git -C "${mainPath}" branch -D "${wt.branch}"`);
  }
}
