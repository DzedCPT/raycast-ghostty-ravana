import {
  ActionPanel,
  Action,
  List,
  Color,
  Icon,
  closeMainWindow,
} from "@raycast/api";
import { execSync } from "child_process";
import {
  type ClaudeInstance,
  focusGhosttyTerminal,
  loadInstances,
  loadRecentActivity,
  modeLabel,
  projectName,
  timeAgo,
} from "./utils";

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
