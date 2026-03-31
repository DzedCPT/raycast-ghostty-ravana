import {
  ActionPanel,
  Action,
  List,
  Color,
  Icon,
  closeMainWindow,
} from "@raycast/api";
import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const STATE_DIR = "/tmp/claude-instances";

interface ClaudeInstance {
  session_id: string;
  status?: string;
  cwd?: string;
  model?: string;
  lines_added?: number;
  lines_removed?: number;
  context_percent?: number;
  pid?: number;
  permission_mode?: string;
  prompt?: string;
  custom_name?: string;
  terminal?: string;
  updated_at?: string;
}

function statusIcon(status?: string): { source: Icon; tintColor: Color } {
  switch (status) {
    case "working":
      return { source: Icon.CircleFilled, tintColor: Color.Green };
    case "permission":
      return { source: Icon.CircleFilled, tintColor: Color.Orange };
    case "stopped":
      return { source: Icon.CircleFilled, tintColor: Color.SecondaryText };
    default:
      return { source: Icon.QuestionMarkCircle, tintColor: Color.SecondaryText };
  }
}

function modeIcon(mode?: string): { source: Icon; tintColor: Color } {
  switch (mode) {
    case "acceptEdits":
      return { source: Icon.CircleFilled, tintColor: Color.Purple };
    case "plan":
      return { source: Icon.CircleFilled, tintColor: { light: "#0d9488", dark: "#2dd4bf" } };
    case "dontAsk":
    case "bypassPermissions":
      return { source: Icon.CircleFilled, tintColor: Color.Red };
    default:
      return { source: Icon.CircleFilled, tintColor: Color.SecondaryText };
  }
}

function projectName(cwd?: string): string {
  if (!cwd) return "unknown";
  return cwd.split("/").pop() || cwd;
}

function timeAgo(dateStr?: string): string {
  if (!dateStr) return "";
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function isProcessAlive(pid?: number): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function focusGhosttyTerminal(cwd: string) {
  const script = `
tell application "Ghostty"
  set matches to every terminal whose working directory is "${cwd}"
  if (count of matches) > 0 then
    focus (item 1 of matches)
  end if
end tell`;
  execSync(`osascript -e '${script}'`);
}

function loadInstances(): ClaudeInstance[] {
  try {
    const files = readdirSync(STATE_DIR).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".metrics.json"),
    );
    const instances = files
      .map((file) => {
        try {
          const content = readFileSync(join(STATE_DIR, file), "utf-8");
          if (!content.trim()) return null;
          const hook = JSON.parse(content) as ClaudeInstance;

          const metricsFile = file.replace(".json", ".metrics.json");
          try {
            const metricsContent = readFileSync(join(STATE_DIR, metricsFile), "utf-8");
            if (metricsContent.trim()) {
              const metrics = JSON.parse(metricsContent) as Partial<ClaudeInstance>;
              // Hook-owned fields win
              const merged = { ...hook, ...metrics };
              merged.status = hook.status;
              merged.permission_mode = hook.permission_mode;
              merged.prompt = hook.prompt;
              merged.custom_name = hook.custom_name;
              Object.assign(hook, merged);
            }
          } catch {
            /* no metrics yet */
          }

          if (!isProcessAlive(hook.pid)) {
            try {
              unlinkSync(join(STATE_DIR, file));
              unlinkSync(join(STATE_DIR, metricsFile));
            } catch {
              /* ignore */
            }
            return null;
          }
          return hook;
        } catch {
          return null;
        }
      })
      .filter((instance): instance is ClaudeInstance => instance !== null)
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));

    // Deduplicate by PID
    const seenPids = new Set<number>();
    return instances.filter((i) => {
      if (!i.pid) return true;
      if (seenPids.has(i.pid)) return false;
      seenPids.add(i.pid);
      return true;
    });
  } catch {
    return [];
  }
}

interface RecentActivity {
  recentTools: string[];
  lastResponse: string;
}

function jsonlPath(cwd?: string, sessionId?: string): string | null {
  if (!cwd || !sessionId) return null;
  const projectDir = cwd.replace(/\//g, "-");
  const path = join(homedir(), ".claude", "projects", projectDir, `${sessionId}.jsonl`);
  return existsSync(path) ? path : null;
}

function loadRecentActivity(cwd?: string, sessionId?: string): RecentActivity | null {
  const path = jsonlPath(cwd, sessionId);
  if (!path) return null;

  try {
    // Read last ~50KB to get recent entries
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const tail = lines.slice(-40);

    const recentTools: string[] = [];
    let lastResponse = "";

    for (const line of tail) {
      try {
        const obj = JSON.parse(line);
        const msg = obj.message;
        if (!msg) continue;

        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_use") {
              const name = block.name as string;
              const input = block.input as Record<string, unknown>;
              let detail = name;
              if (name === "Edit" || name === "Read" || name === "Write") {
                const fp = input.file_path as string | undefined;
                if (fp) detail = `${name}: ${fp.split("/").pop()}`;
              } else if (name === "Bash") {
                const cmd = input.command as string | undefined;
                if (cmd) detail = `Bash: ${cmd.slice(0, 40)}`;
              }
              recentTools.push(detail);
            } else if (block.type === "text" && block.text) {
              lastResponse = (block.text as string).slice(0, 200);
            }
          }
        }
      } catch {
        /* skip malformed lines */
      }
    }

    return {
      recentTools: recentTools.slice(-5),
      lastResponse,
    };
  } catch {
    return null;
  }
}

function modeLabel(mode?: string): string {
  switch (mode) {
    case "acceptEdits":
      return "Accept Edits";
    case "plan":
      return "Plan";
    case "dontAsk":
      return "Don't Ask";
    case "bypassPermissions":
      return "Bypass Permissions";
    default:
      return mode ?? "Unknown";
  }
}

export default function Command() {
  const instances = loadInstances();

  return (
    <List isShowingDetail>
      {instances.length === 0 ? (
        <List.EmptyView
          title="No Claude instances running"
          description="Start a Claude Code session to see it here"
        />
      ) : (
        instances.map((instance) => {
          const added = instance.lines_added ?? 0;
          const removed = instance.lines_removed ?? 0;
          const contextPct = instance.context_percent ?? 0;
          const activity = loadRecentActivity(instance.cwd, instance.session_id);

          return (
            <List.Item
              key={instance.session_id}
              title={instance.custom_name || projectName(instance.cwd)}
              subtitle={instance.custom_name ? projectName(instance.cwd) : undefined}
              icon={statusIcon(instance.status)}
              accessories={[
                { text: timeAgo(instance.updated_at) },
              ]}
              detail={
                <List.Item.Detail
                  metadata={
                    <List.Item.Detail.Metadata>
                      {instance.custom_name && (
                        <List.Item.Detail.Metadata.Label
                          title="Name"
                          text={instance.custom_name}
                        />
                      )}
                      {instance.prompt && (
                        <List.Item.Detail.Metadata.Label
                          title="Prompt"
                          text={instance.prompt}
                        />
                      )}
                      <List.Item.Detail.Metadata.Label
                        title="Status"
                        text={instance.status ? instance.status.charAt(0).toUpperCase() + instance.status.slice(1) : "Unknown"}
                        icon={statusIcon(instance.status)}
                      />
                      <List.Item.Detail.Metadata.Label
                        title="Model"
                        text={instance.model ?? "unknown"}
                      />
                      <List.Item.Detail.Metadata.Label
                        title="Mode"
                        text={modeLabel(instance.permission_mode)}
                        icon={modeIcon(instance.permission_mode)}
                      />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.TagList title="Edits">
                        <List.Item.Detail.Metadata.TagList.Item text={`+${added}`} color={Color.Green} />
                        <List.Item.Detail.Metadata.TagList.Item text={`-${removed}`} color={Color.Red} />
                      </List.Item.Detail.Metadata.TagList>
                      <List.Item.Detail.Metadata.TagList title="Context">
                        <List.Item.Detail.Metadata.TagList.Item
                          text={`${contextPct}%`}
                          color={contextPct >= 80 ? Color.Red : contextPct >= 60 ? Color.Orange : Color.SecondaryText}
                        />
                      </List.Item.Detail.Metadata.TagList>
                      {activity?.lastResponse && (
                        <>
                          <List.Item.Detail.Metadata.Separator />
                          <List.Item.Detail.Metadata.Label
                            title="Last Response"
                            text={activity.lastResponse}
                          />
                        </>
                      )}
                      {activity && activity.recentTools.length > 0 && (
                        <>
                          {activity.recentTools.map((tool, i) => (
                            <List.Item.Detail.Metadata.Label
                              key={i}
                              title={i === 0 ? "Recent Tools" : ""}
                              text={tool}
                            />
                          ))}
                        </>
                      )}
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label
                        title="Working Directory"
                        text={instance.cwd ?? "unknown"}
                      />
                      <List.Item.Detail.Metadata.Label
                        title="Last Active"
                        text={instance.updated_at ? new Date(instance.updated_at).toLocaleString() : "unknown"}
                      />
                      <List.Item.Detail.Metadata.Label
                        title="Session"
                        text={instance.session_id}
                      />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  <Action
                    title="Focus in Ghostty"
                    icon={Icon.Terminal}
                    onAction={() => {
                      closeMainWindow();
                      if (instance.cwd) {
                        focusGhosttyTerminal(instance.cwd);
                      }
                    }}
                  />
                  <Action
                    title="Open in Zed"
                    icon={Icon.Code}
                    onAction={() => {
                      closeMainWindow();
                      execSync(`zed -r "${instance.cwd}"`);
                    }}
                  />
                  <Action.CopyToClipboard title="Copy Working Directory" content={instance.cwd ?? ""} />
                  <Action.CopyToClipboard title="Copy Session ID" content={instance.session_id} />
                </ActionPanel>
              }
            />
          );
        })
      )}
    </List>
  );
}
