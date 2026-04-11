import {
  ActionPanel,
  Action,
  List,
  Color,
  Icon,
  Alert,
  closeMainWindow,
  confirmAlert,
  showToast,
  Toast,
} from "@raycast/api";
import { execSync } from "child_process";
import { useState, useEffect } from "react";
import { focusGhosttyTerminal } from "./utils";
import {
  type Worktree,
  WORKTREES_DIR,
  SCRIPT_LINK,
  loadStatus,
  refreshWorktree,
  removeWorktree,
  statusLabel,
  statusOrder,
  ciSummaryLabel,
  failingChecks,
} from "./worktree-utils";

function statusColor(status: string): Color {
  switch (status) {
    case "open":
      return Color.Green;
    case "draft":
      return Color.Orange;
    case "merged":
      return Color.Purple;
    case "closed":
      return Color.Red;
    case "remote_no_pr":
      return Color.Blue;
    default:
      return Color.SecondaryText;
  }
}

function ciSummaryColor(ci?: string): Color {
  switch (ci) {
    case "pass":
      return Color.Green;
    case "fail":
      return Color.Red;
    case "pending":
      return Color.Orange;
    default:
      return Color.SecondaryText;
  }
}

export default function Command() {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  function reloadData() {
    const data = loadStatus();
    const sorted = [...(data?.worktrees ?? [])].sort(
      (a, b) => statusOrder(a.status) - statusOrder(b.status),
    );
    setWorktrees(sorted);
    setIsLoaded(true);
  }

  useEffect(() => {
    reloadData();
  }, []);

  if (!isLoaded) {
    return <List isLoading />;
  }

  if (worktrees.length === 0) {
    return (
      <List>
        <List.EmptyView
          title="No worktree status data"
          description={`No status files found in ${WORKTREES_DIR}`}
          icon={Icon.Warning}
        />
      </List>
    );
  }

  function toggleSelected(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handleRefreshOne(wt: Worktree) {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Refreshing status…",
    });
    try {
      refreshWorktree(wt.path);
      reloadData();
      toast.style = Toast.Style.Success;
      toast.title = "Status refreshed";
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Refresh failed";
      toast.message = e instanceof Error ? e.message : String(e);
    }
  }

  async function handleRefreshAll() {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Refreshing all worktrees…",
    });
    try {
      execSync(`bash "${SCRIPT_LINK}"`, { timeout: 120000, stdio: "pipe" });
      reloadData();
      toast.style = Toast.Style.Success;
      toast.title = "All statuses refreshed";
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Refresh failed";
      toast.message = e instanceof Error ? e.message : String(e);
    }
  }

  async function cleanupOne(wt: Worktree) {
    const confirmed = await confirmAlert({
      title: `Remove worktree "${wt.branch || wt.worktree}"?`,
      message: `Deletes the local worktree at ${wt.path}${wt.branch ? ` and branch "${wt.branch}"` : ""}.`,
      primaryAction: { title: "Remove", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    try {
      removeWorktree(wt);
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        next.delete(wt.path);
        return next;
      });
      reloadData();
      await showToast({
        style: Toast.Style.Success,
        title: "Worktree removed",
        message: wt.branch || wt.worktree,
      });
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Cleanup failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function cleanupSelected() {
    const targets = worktrees.filter((wt) => selectedPaths.has(wt.path));
    const confirmed = await confirmAlert({
      title: `Remove ${targets.length} worktree${targets.length === 1 ? "" : "s"}?`,
      message: targets.map((wt) => wt.branch || wt.worktree).join(", "),
      primaryAction: {
        title: "Remove All",
        style: Alert.ActionStyle.Destructive,
      },
    });
    if (!confirmed) return;
    const failed: string[] = [];
    for (const wt of targets) {
      try {
        removeWorktree(wt);
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          next.delete(wt.path);
          return next;
        });
      } catch {
        failed.push(wt.branch || wt.worktree);
      }
    }
    reloadData();
    if (failed.length > 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Some removals failed",
        message: failed.join(", "),
      });
    } else {
      await showToast({
        style: Toast.Style.Success,
        title: `Removed ${targets.length} worktree${targets.length === 1 ? "" : "s"}`,
      });
    }
  }

  return (
    <List>
      {worktrees.map((wt) => {
        const prUrl =
          wt.repo && wt.pr_number
            ? `https://github.com/${wt.repo}/pull/${wt.pr_number}`
            : null;
        const isSelected = selectedPaths.has(wt.path);

        return (
          <List.Item
            key={wt.path}
            title={wt.root}
            subtitle={wt.branch || "(detached HEAD)"}
            accessories={[
              ...(isSelected
                ? [
                    {
                      icon: { source: Icon.Checkmark, tintColor: Color.Blue },
                      tooltip: "Selected",
                    },
                  ]
                : []),
              {
                tag: {
                  value: statusLabel(wt.status),
                  color: statusColor(wt.status),
                },
              },
              ...(wt.ci_summary && wt.ci_summary !== "none"
                ? [
                    {
                      tag: {
                        value: ciSummaryLabel(wt.ci_summary),
                        color: ciSummaryColor(wt.ci_summary),
                      },
                      tooltip:
                        wt.ci_summary === "fail"
                          ? `${failingChecks(wt).length} check(s) failing`
                          : undefined,
                    },
                  ]
                : []),
              { date: new Date(wt.updated_at), tooltip: "Last checked" },
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="Open in Zed"
                  icon={Icon.Code}
                  onAction={() => {
                    closeMainWindow();
                    execSync(`zed -r "${wt.path}"`);
                  }}
                />
                <Action
                  title={isSelected ? "Deselect" : "Select"}
                  icon={isSelected ? Icon.Circle : Icon.Checkmark}
                  shortcut={{ modifiers: [], key: "space" }}
                  onAction={() => toggleSelected(wt.path)}
                />
                <Action
                  title="Refresh Status"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={() => handleRefreshOne(wt)}
                />
                <Action
                  title="Focus in Ghostty"
                  icon={Icon.Terminal}
                  onAction={() => {
                    closeMainWindow();
                    focusGhosttyTerminal(wt.path);
                  }}
                />
                {prUrl && (
                  <Action.OpenInBrowser title="Open PR on GitHub" url={prUrl} />
                )}
                {failingChecks(wt).length > 0 && (
                  <ActionPanel.Section title="Failing CI Checks">
                    {failingChecks(wt)
                      .filter((check) => check.link)
                      .map((check) => (
                        <Action.OpenInBrowser
                          key={check.link}
                          title={check.name}
                          url={check.link}
                          icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }}
                        />
                      ))}
                  </ActionPanel.Section>
                )}
                {selectedPaths.size > 0 && (
                  <Action
                    title={`Clean Up Selected (${selectedPaths.size})`}
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "x" }}
                    onAction={cleanupSelected}
                  />
                )}
                <Action
                  title="Clean Up This Branch"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  {...(selectedPaths.size === 0
                    ? { shortcut: { modifiers: ["cmd", "shift"], key: "x" } }
                    : {})}
                  onAction={() => cleanupOne(wt)}
                />
                <ActionPanel.Section>
                  <Action
                    title="Refresh All Worktrees"
                    icon={Icon.ArrowClockwise}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
                    onAction={handleRefreshAll}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
