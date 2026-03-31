import { showHUD, showToast, Toast } from "@raycast/api";
import { execSync } from "child_process";

export default async function Command() {
  try {
    const script = `
tell application "Ghostty"
  set activeTab to selected tab of front window
  set activePane to focused terminal of activeTab
  get working directory of activePane
end tell`;
    const cwd = execSync(`osascript -e '${script}'`, { encoding: "utf-8" }).trim();

    if (!cwd) {
      await showToast({ style: Toast.Style.Failure, title: "Could not get working directory from Ghostty" });
      return;
    }

    execSync(`zed -r "${cwd}"`);
    await showHUD(`Opened Zed in ${cwd}`);
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
