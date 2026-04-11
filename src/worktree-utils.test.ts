import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as child_process from "child_process";
import {
  getMainWorktreePath,
  loadStatus,
  refreshWorktree,
  removeWorktree,
  WORKTREES_DIR,
  statusFileName,
  statusLabel,
  statusOrder,
  ciSummaryLabel,
  failingChecks,
  type CICheck,
  type Worktree,
} from "./worktree-utils";

vi.mock("fs");
vi.mock("child_process");

// ---------------------------------------------------------------------------
// statusLabel
// ---------------------------------------------------------------------------

describe("statusLabel", () => {
  it.each([
    ["open", "Open"],
    ["draft", "Draft"],
    ["merged", "Merged"],
    ["closed", "Closed"],
    ["remote_no_pr", "No PR"],
    ["no_remote_branch", "Not Pushed"],
    ["no_remote", "No Remote"],
    ["detached_head", "Detached HEAD"],
  ])("maps %s → %s", (status, label) => {
    expect(statusLabel(status)).toBe(label);
  });

  it("returns the raw value for unknown statuses", () => {
    expect(statusLabel("some_future_status")).toBe("some_future_status");
  });
});

// ---------------------------------------------------------------------------
// statusOrder
// ---------------------------------------------------------------------------

describe("statusOrder", () => {
  it.each([
    ["merged", 0],
    ["open", 1],
    ["draft", 2],
    ["remote_no_pr", 3],
    ["no_remote", 4],
    ["no_remote_branch", 5],
  ])("assigns order %i to %s", (status, order) => {
    expect(statusOrder(status)).toBe(order);
  });

  it("returns 6 for unknown statuses", () => {
    expect(statusOrder("detached_head")).toBe(6);
    expect(statusOrder("anything_else")).toBe(6);
  });

  it("sorts worktrees correctly by status", () => {
    const statuses = [
      "no_remote",
      "open",
      "merged",
      "draft",
      "remote_no_pr",
      "no_remote_branch",
    ];
    const sorted = [...statuses].sort(
      (a, b) => statusOrder(a) - statusOrder(b),
    );
    expect(sorted).toEqual([
      "merged",
      "open",
      "draft",
      "remote_no_pr",
      "no_remote",
      "no_remote_branch",
    ]);
  });
});

// ---------------------------------------------------------------------------
// statusFileName
// ---------------------------------------------------------------------------

describe("statusFileName", () => {
  it("combines root and worktree with double underscore", () => {
    expect(
      statusFileName({ root: "my-repo", worktree: "feature-branch" }),
    ).toBe("my-repo__feature-branch.json");
  });

  it("handles names with hyphens and numbers", () => {
    expect(
      statusFileName({
        root: "customs-filing-service",
        worktree: "psc-edit-1234",
      }),
    ).toBe("customs-filing-service__psc-edit-1234.json");
  });
});

// ---------------------------------------------------------------------------
// ciSummaryLabel
// ---------------------------------------------------------------------------

describe("ciSummaryLabel", () => {
  it.each([
    ["pass", "CI Passing"],
    ["fail", "CI Failing"],
    ["pending", "CI Pending"],
    [undefined, ""],
    ["none", ""],
  ])("maps %s → %s", (ci, label) => {
    expect(ciSummaryLabel(ci)).toBe(label);
  });
});

// ---------------------------------------------------------------------------
// failingChecks
// ---------------------------------------------------------------------------

describe("failingChecks", () => {
  it("returns empty array when ci_checks is null", () => {
    expect(failingChecks({ ...BASE_WF, ci_checks: null })).toEqual([]);
  });

  it("returns empty array when ci_checks is undefined", () => {
    expect(failingChecks({ ...BASE_WF, ci_checks: undefined })).toEqual([]);
  });

  it("returns only checks with bucket 'fail'", () => {
    const checks: CICheck[] = [
      { name: "build", state: "SUCCESS", bucket: "pass", link: "https://example.com/1", workflow: "CI" },
      { name: "test", state: "FAILURE", bucket: "fail", link: "https://example.com/2", workflow: "CI" },
      { name: "lint", state: "PENDING", bucket: "pending", link: "https://example.com/3", workflow: "CI" },
    ];
    const result = failingChecks({ ...BASE_WF, ci_checks: checks });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("test");
  });

  it("includes cancelled checks", () => {
    const checks: CICheck[] = [
      { name: "deploy", state: "CANCELLED", bucket: "cancel", link: "https://example.com/1", workflow: "CI" },
    ];
    const result = failingChecks({ ...BASE_WF, ci_checks: checks });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("deploy");
  });

  it("returns empty array when all checks pass", () => {
    const checks: CICheck[] = [
      { name: "build", state: "SUCCESS", bucket: "pass", link: "https://example.com/1", workflow: "CI" },
    ];
    expect(failingChecks({ ...BASE_WF, ci_checks: checks })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadStatus
// ---------------------------------------------------------------------------

const BASE_WF: Worktree = {
  root: "my-repo",
  worktree: "feature-branch",
  path: "/Users/jboyle/Developer/worktrees/my-repo/feature-branch",
  branch: "feature-branch",
  repo: "org/my-repo",
  status: "open",
  pr_number: 42,
  updated_at: "2026-04-10T14:00:00Z",
  ci_summary: "pass",
  ci_checks: [
    {
      name: "build",
      state: "SUCCESS",
      bucket: "pass",
      link: "https://example.com/1",
      workflow: "CI",
    },
  ],
};

describe("loadStatus", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns null when the worktrees directory does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadStatus()).toBeNull();
  });

  it("returns null when the directory is empty", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(
      [] as unknown as ReturnType<typeof fs.readdirSync>,
    );
    expect(loadStatus()).toBeNull();
  });

  it("assembles worktrees from multiple per-worktree files", () => {
    const wt2: Worktree = {
      ...BASE_WF,
      root: "other-repo",
      worktree: "main",
      path: "/wt/other-repo/main",
      updated_at: "2026-04-11T10:00:00Z",
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([
      "my-repo__feature-branch.json",
      "other-repo__main.json",
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(JSON.stringify(BASE_WF))
      .mockReturnValueOnce(JSON.stringify(wt2));

    const result = loadStatus();
    expect(result?.worktrees).toHaveLength(2);
    expect(result?.updated_at).toBe("2026-04-11T10:00:00Z"); // max of the two timestamps
  });

  it("skips malformed JSON files without crashing", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([
      "bad.json",
      "my-repo__feature.json",
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce("not valid json {{")
      .mockReturnValueOnce(JSON.stringify(BASE_WF));

    const result = loadStatus();
    expect(result?.worktrees).toHaveLength(1);
  });

  it("skips worktrees whose path no longer exists on disk (option A)", () => {
    vi.mocked(fs.existsSync)
      .mockReturnValueOnce(true) // WORKTREES_DIR exists
      .mockReturnValueOnce(false); // wt.path does not exist

    vi.mocked(fs.readdirSync).mockReturnValue([
      "my-repo__feature.json",
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify(BASE_WF));

    expect(loadStatus()).toBeNull();
  });

  it("returns null when all files are skipped", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([
      "not-a-json.txt",
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    expect(loadStatus()).toBeNull();
  });

  it("reads from the correct directory", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    loadStatus();
    expect(fs.existsSync).toHaveBeenCalledWith(WORKTREES_DIR);
  });

  it("preserves ci_summary and ci_checks through JSON round-trip", () => {
    const wtWithCI: Worktree = {
      ...BASE_WF,
      ci_summary: "fail",
      ci_checks: [
        { name: "test", state: "FAILURE", bucket: "fail", link: "https://example.com/job/1", workflow: "CI" },
      ],
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([
      "my-repo__feature.json",
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify(wtWithCI));

    const result = loadStatus();
    expect(result?.worktrees?.[0].ci_summary).toBe("fail");
    expect(result?.worktrees?.[0].ci_checks).toHaveLength(1);
    expect(result?.worktrees?.[0].ci_checks?.[0].name).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// refreshWorktree
// ---------------------------------------------------------------------------

describe("refreshWorktree", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls execSync with the script link and the given worktree path", () => {
    vi.mocked(child_process.execSync).mockReturnValue(Buffer.from(""));
    refreshWorktree("/wt/my-repo/feature");
    expect(child_process.execSync).toHaveBeenCalledWith(
      expect.stringMatching(/bash.*script\.sh.*\/wt\/my-repo\/feature/),
      expect.objectContaining({ timeout: 45000 }),
    );
  });
});

// ---------------------------------------------------------------------------
// getMainWorktreePath
// ---------------------------------------------------------------------------

describe("getMainWorktreePath", () => {
  afterEach(() => vi.restoreAllMocks());

  it("extracts the path from the first line of porcelain output", () => {
    vi.mocked(child_process.execSync).mockReturnValue(
      "worktree /Users/jboyle/Developer/worktrees/frontends/.bare\nbare\n\nworktree /other\nHEAD abc\n" as unknown as Buffer,
    );
    expect(getMainWorktreePath("/some/worktree")).toBe(
      "/Users/jboyle/Developer/worktrees/frontends/.bare",
    );
  });

  it("runs git with -C set to the given worktree path", () => {
    vi.mocked(child_process.execSync).mockReturnValue(
      "worktree /main\nbare\n" as unknown as Buffer,
    );
    getMainWorktreePath("/my/worktree");
    expect(child_process.execSync).toHaveBeenCalledWith(
      expect.stringContaining('-C "/my/worktree"'),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe("removeWorktree", () => {
  beforeEach(() => {
    vi.mocked(child_process.execSync)
      .mockReset()
      .mockReturnValueOnce(
        "worktree /worktrees/my-repo/.bare\nbare\n" as unknown as Buffer,
      )
      .mockReturnValue(Buffer.from(""));
    vi.mocked(fs.existsSync).mockReset().mockReturnValue(true);
    vi.mocked(fs.unlinkSync).mockReset().mockReturnValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("removes the worktree using the main worktree path", () => {
    removeWorktree(BASE_WF);
    const calls = vi
      .mocked(child_process.execSync)
      .mock.calls.map((c) => c[0] as string);
    expect(
      calls.some(
        (c) =>
          c.includes("worktree remove --force") &&
          c.includes(
            "/Users/jboyle/Developer/worktrees/my-repo/feature-branch",
          ),
      ),
    ).toBe(true);
  });

  it("deletes the branch when branch is non-empty", () => {
    removeWorktree(BASE_WF);
    const calls = vi
      .mocked(child_process.execSync)
      .mock.calls.map((c) => c[0] as string);
    expect(
      calls.some(
        (c) => c.includes("branch -D") && c.includes("feature-branch"),
      ),
    ).toBe(true);
  });

  it("does not delete a branch when branch is empty", () => {
    removeWorktree({ ...BASE_WF, branch: "" });
    const calls = vi
      .mocked(child_process.execSync)
      .mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("branch -D"))).toBe(false);
  });

  it("uses the bare repo path for all git commands", () => {
    removeWorktree(BASE_WF);
    const calls = vi
      .mocked(child_process.execSync)
      .mock.calls.slice(1)
      .map((c) => c[0] as string);
    expect(
      calls.every((c) => c.includes('-C "/worktrees/my-repo/.bare"')),
    ).toBe(true);
  });

  it("deletes the status file after removing the worktree", () => {
    removeWorktree(BASE_WF);
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("my-repo__feature-branch.json"),
    );
  });

  it("skips unlinkSync when the status file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    removeWorktree(BASE_WF);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});
