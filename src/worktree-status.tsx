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
import { useState } from "react";
import { focusGhosttyTerminal } from "./utils";
import {
  type Worktree,
  STATUS_FILE,
  loadStatus,
  removeWorktree,
  statusLabel,
  statusOrder,
} from "./worktree-utils";

function statusColor(status: string): Color {
  switch (status) {
    case "open":         return Color.Green;
    case "draft":        return Color.Orange;
    case "merged":       return Color.Purple;
    case "closed":       return Color.Red;
    case "remote_no_pr": return Color.Blue;
    default:             return Color.SecondaryText;
  }
}


export default function Command() {
  const data = loadStatus();
  const [removedPaths, setRemovedPaths] = useState<Set<string>>(new Set());
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  if (!data) {
    return (
      <List>
        <List.EmptyView
          title="Status file not found"
          description={`${STATUS_FILE} does not exist yet`}
          icon={Icon.Warning}
        />
      </List>
    );
  }

  if (data.error || !data.worktrees) {
    return (
      <List>
        <List.EmptyView
          title="Worktree status script errored"
          description={`Exit code: ${data.exit_code ?? "unknown"}. Check /tmp/gh-worktree-status/run.error.log`}
          icon={Icon.Warning}
        />
      </List>
    );
  }

  const visible = [...data.worktrees]
    .filter((wt) => !removedPaths.has(wt.path))
    .sort((a, b) => statusOrder(a.status) - statusOrder(b.status));

  function toggleSelected(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
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
      setRemovedPaths((prev) => new Set([...prev, wt.path]));
      setSelectedPaths((prev) => { const next = new Set(prev); next.delete(wt.path); return next; });
      await showToast({ style: Toast.Style.Success, title: "Worktree removed", message: wt.branch || wt.worktree });
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Cleanup failed", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function cleanupSelected() {
    const targets = visible.filter((wt) => selectedPaths.has(wt.path));
    const confirmed = await confirmAlert({
      title: `Remove ${targets.length} worktree${targets.length === 1 ? "" : "s"}?`,
      message: targets.map((wt) => wt.branch || wt.worktree).join(", "),
      primaryAction: { title: "Remove All", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    const failed: string[] = [];
    for (const wt of targets) {
      try {
        removeWorktree(wt);
        setRemovedPaths((prev) => new Set([...prev, wt.path]));
        setSelectedPaths((prev) => { const next = new Set(prev); next.delete(wt.path); return next; });
      } catch {
        failed.push(wt.branch || wt.worktree);
      }
    }
    if (failed.length > 0) {
      await showToast({ style: Toast.Style.Failure, title: "Some removals failed", message: failed.join(", ") });
    } else {
      await showToast({ style: Toast.Style.Success, title: `Removed ${targets.length} worktree${targets.length === 1 ? "" : "s"}` });
    }
  }

  return (
    <List>
      {visible.map((wt, i) => {
        const prUrl = wt.repo && wt.pr_number ? `https://github.com/${wt.repo}/pull/${wt.pr_number}` : null;
        const isSelected = selectedPaths.has(wt.path);

        return (
          <List.Item
            key={i}
            title={wt.root}
            subtitle={wt.branch || "(detached HEAD)"}
            accessories={[
              ...(isSelected ? [{ icon: { source: Icon.Checkmark, tintColor: Color.Blue }, tooltip: "Selected" }] : []),
              { tag: { value: statusLabel(wt.status), color: statusColor(wt.status) } },
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="Open in Zed"
                  icon={Icon.Code}
                  onAction={() => { closeMainWindow(); execSync(`zed -r "${wt.path}"`); }}
                />
                <Action
                  title={isSelected ? "Deselect" : "Select"}
                  icon={isSelected ? Icon.Circle : Icon.Checkmark}
                  shortcut={{ modifiers: [], key: "space" }}
                  onAction={() => toggleSelected(wt.path)}
                />
                <Action
                  title="Focus in Ghostty"
                  icon={Icon.Terminal}
                  onAction={() => { closeMainWindow(); focusGhosttyTerminal(wt.path); }}
                />
                {prUrl && <Action.OpenInBrowser title="Open PR on GitHub" url={prUrl} />}
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
                  {...(selectedPaths.size === 0 ? { shortcut: { modifiers: ["cmd", "shift"], key: "x" } } : {})}
                  onAction={() => cleanupOne(wt)}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
