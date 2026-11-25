import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AutoTitleSettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  const remove = client.addSettingsScreen({
    id: "auto-title",
    title: "会话自动标题",
    icon: "Sparkles",
    Component: AutoTitleSettingsScreen,
  });
  return remove;
}
