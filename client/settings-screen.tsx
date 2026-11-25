import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import {
  autoTitleSettings,
  scanRpc,
  type AutoTitleSettings,
} from "../shared/settings";

function SettingsBody({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const settings = useSettings(autoTitleSettings);
  const toast = useToast();
  const scan = useRpc(scanRpc);
  const [draft, setDraft] = useState<AutoTitleSettings | null>(null);
  const readyValues = settings.status === "ready" ? settings.values : null;

  useEffect(() => {
    if (readyValues) setDraft((current) => current ?? { ...readyValues });
  }, [readyValues]);

  const promptStyle = useMemo(
    () => ({
      minHeight: 240,
      padding: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      color: theme.colors.foreground,
      textAlignVertical: "top" as const,
    }),
    [theme],
  );

  if (settings.status !== "ready" || !draft) {
    const info =
      settings.status === "error" || settings.status === "invalid"
        ? settings.error
        : settings.status === "loading"
          ? "读取中…"
          : "设置不可用";
    return (
      <SettingsSection title="会话自动标题" info={info}>
        <SettingsAction
          label="设置"
          actionLabel="重新读取"
          onPress={() => void settings.reload()}
        />
      </SettingsSection>
    );
  }

  const patch = (next: Partial<AutoTitleSettings>): void => {
    setDraft({ ...draft, ...next });
  };

  const save = async (): Promise<void> => {
    const idleSeconds = Math.max(5, Math.min(3600, Math.round(Number(draft.idleSeconds) || 30)));
    const ok = await settings.save({ ...draft, idleSeconds }, settings.revision);
    toast.show(ok ? "设置已保存" : "保存失败，请重试", {
      variant: ok ? "success" : "error",
    });
  };

  return (
    <>
      <SettingsSection
        title="总开关"
        info="关闭后不再自动改名，也不会扫描历史会话。"
      >
        <SettingsSwitch
          label="启用自动命名"
          value={draft.enabled}
          onValueChange={(enabled) => patch({ enabled })}
        />
      </SettingsSection>

      <SettingsSection
        title="触发时机"
        info="一轮对话结束并连续空闲达到设定秒数后，再读取对话并定稿；期间又开始新一轮会自动取消。"
      >
        <SettingsInput
          label="空闲等待（秒）"
          hint="范围 5–3600，默认 30"
          initialValue={String(draft.idleSeconds)}
          onChangeText={(text) => patch({ idleSeconds: Number(text) || 30 })}
          placeholder="30"
        />
        <SettingsSelect
          label="命名策略"
          hint="只命名一次：首轮有内容后定稿；每轮刷新：每次空闲都按最新对话更新"
          value={draft.renameMode}
          options={[
            { label: "只命名一次（推荐）", value: "first" },
            { label: "每轮空闲后刷新", value: "each" },
          ]}
          onValueChange={(renameMode) => patch({ renameMode })}
        />
      </SettingsSection>

      <SettingsSection
        title="侧栏显示"
        info="Paseo 侧栏通常显示 workspace 名称。开启后会同步修改所属 workspace 的显示标题，手机上也能看到。"
      >
        <SettingsSwitch
          label="同步 workspace 标题"
          hint="关闭则只改会话（agent）标题"
          value={draft.syncWorkspaceTitle}
          onValueChange={(syncWorkspaceTitle) => patch({ syncWorkspaceTitle })}
        />
        <SettingsSwitch
          label="标题前加日期"
          hint="格式：MMDD｜标题，日期按会话创建时间（Asia/Shanghai）"
          value={draft.includeDate}
          onValueChange={(includeDate) => patch({ includeDate })}
        />
      </SettingsSection>

      <SettingsSection
        title="命名模型"
        info="pi：调用本机 pi CLI，一次请求、无工具，速度快；Paseo：在当前 workspace 里开一个隐藏后台 agent 生成，使用 Paseo 已配置的模型。"
      >
        <SettingsSelect
          label="生成引擎"
          value={draft.engine}
          options={[
            { label: "本机 pi CLI（推荐）", value: "pi" },
            { label: "Paseo 后台 agent", value: "paseo" },
          ]}
          onValueChange={(engine) => patch({ engine })}
        />
        <SettingsInput
          label="模型覆盖（可选）"
          hint="pi 引擎填 pi 模型 ID，例如 deepseek/deepseek-flash；Paseo 引擎填 provider/model。留空用默认"
          initialValue={draft.model}
          onChangeText={(model) => patch({ model })}
          placeholder="留空使用默认模型"
        />
      </SettingsSection>

      <SettingsSection
        title="命名提示词"
        info="可整段改写命名风格、语言和长度限制。{MMDD} 会替换为会话创建日期。"
      >
        <TextInput
          multiline
          numberOfLines={12}
          value={draft.customPrompt}
          onChangeText={(customPrompt) => patch({ customPrompt })}
          placeholder="输入自定义提示词"
          style={promptStyle}
        />
      </SettingsSection>

      <SettingsSection
        title="已有会话"
        info="扫描当前主机上尚未锁定的历史会话并安排改名。用户手改过或创建时显式指定标题的会话不会被动。"
      >
        <SettingsAction
          label="历史会话批量命名"
          actionLabel="立即扫描"
          onPress={() =>
            void scan({}).then((result) => {
              toast.show(`已扫描 ${result.scanned} 个会话，安排 ${result.scheduled} 个`);
            })
          }
        />
        <SettingsAction
          label="解锁并重新命名全部"
          hint="清除所有手改锁定标记，按最新对话重新总结一次"
          actionLabel="强制重命名"
          onPress={() =>
            void scan({ force: true }).then((result) => {
              toast.show(`已解锁并安排 ${result.scheduled}/${result.scanned} 个会话`);
            })
          }
        />
      </SettingsSection>

      <SettingsSection title="保存">
        <SettingsAction
          label="应用设置"
          actionLabel="保存"
          onPress={() => void save()}
          disabled={settings.saving}
        />
        <SettingsAction
          label="恢复默认"
          actionLabel="重置"
          onPress={() => void settings.reset()}
          disabled={settings.saving}
        />
        {settings.saveError ? (
          <SettingsAction
            label="错误"
            actionLabel={settings.saveError}
            onPress={() => undefined}
          />
        ) : null}
      </SettingsSection>
    </>
  );
}

export function AutoTitleSettingsScreen(props: PluginSurfaceProps) {
  return <SettingsBody theme={props.theme} />;
}
