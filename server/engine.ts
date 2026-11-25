import type {
  PluginHookAgent,
  PluginHookContext,
  PluginSettings,
  PluginTurnOutcome,
} from "@getpaseo/plugin/server";
import { autoTitleSettings, type AutoTitleSettings } from "../shared/settings";
import { PLUGIN_ID } from "./config";
import {
  applyDatePrefix,
  buildSystemPrompt,
  generateWithPaseo,
  generateWithPi,
  mmddOf,
} from "./generate";
import { renameAgent } from "./rename";
import { getAgentState, updateAgentState, type AgentTitleState } from "./state";
import {
  extractContext,
  fetchConversationEntries,
  forbiddenNames,
  type AgentSnapshotLike,
  type TimelineHandleLike,
} from "./timeline";

type PaseoLike = PluginHookContext["paseo"];
type SettingsStore = PluginSettings<typeof autoTitleSettings.schema>;

export interface ScanInput {
  force?: boolean;
  agentIds?: string[];
}

export interface ScanResult {
  scanned: number;
  scheduled: number;
}

interface CreateBeforeRequest {
  config: { title?: unknown };
}

const EMPTY_SETTINGS: AutoTitleSettings = autoTitleSettings.schema.parse({});

function isManuallyRenamed(state: AgentTitleState, currentTitle: string | null): boolean {
  if (!currentTitle) return false;
  if (state.lastPluginTitle) return currentTitle !== state.lastPluginTitle;
  if (state.provisionalTitle !== null) return currentTitle !== state.provisionalTitle;
  return false;
}

export function createTitleEngine(store: SettingsStore) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingTurns = new Map<string, string>();
  const running = new Set<string>();
  const explicitTitles = new Set<string>();

  async function readSettings(): Promise<AutoTitleSettings> {
    try {
      const state = await store.read();
      return state.status === "ready" ? state.values : EMPTY_SETTINGS;
    } catch {
      return EMPTY_SETTINGS;
    }
  }

  function cancel(agentId: string): void {
    const timer = timers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(agentId);
    }
    pendingTurns.delete(agentId);
  }

  function cancelAll(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pendingTurns.clear();
  }

  function lock(agentId: string, reason: string): void {
    updateAgentState(agentId, { locked: true, lockReason: reason });
    console.log(`[${PLUGIN_ID}] 永久停止自动改名 agent=${agentId} reason=${reason}`);
  }

  function schedule(
    agentId: string,
    paseo: PaseoLike,
    delayMs: number,
    force: boolean,
    turnId: string | null,
  ): void {
    cancel(agentId);
    if (turnId) pendingTurns.set(agentId, turnId);
    const timer = setTimeout(() => {
      timers.delete(agentId);
      void run(agentId, paseo, force);
    }, delayMs);
    timers.set(agentId, timer);
  }

  async function syncWorkspaceTitle(
    paseo: PaseoLike,
    workspaceId: string | null | undefined,
    title: string,
  ): Promise<void> {
    if (!workspaceId) return;
    try {
      const handle = paseo.workspaces.ref(workspaceId);
      const snapshot = await handle.refresh();
      if (snapshot?.name === title) return;
      await handle.setTitle(title);
      console.log(`[${PLUGIN_ID}] 已同步 workspace 标题 workspace=${workspaceId} -> ${title}`);
    } catch (error) {
      console.error(`[${PLUGIN_ID}] 同步 workspace 标题失败`, error);
    }
  }

  async function run(agentId: string, paseo: PaseoLike, force: boolean): Promise<void> {
    if (running.has(agentId)) return;
    running.add(agentId);
    const turnId = pendingTurns.get(agentId) ?? null;
    pendingTurns.delete(agentId);

    try {
      let state = getAgentState(agentId);
      const values = await readSettings();
      if (!values.enabled && !force) return;
      if (state.locked && !force) return;
      if (!force && values.renameMode === "first" && state.done) return;

      const handle = paseo.agents.ref(agentId);
      const page = await fetchConversationEntries(
        handle.timeline as unknown as TimelineHandleLike,
      );

      let snapshot: AgentSnapshotLike | null = page.agent;
      if (!snapshot) {
        snapshot = ((await handle.refresh())?.agent ?? null) as unknown as AgentSnapshotLike | null;
      }
      if (!snapshot) return;
      if (snapshot.archivedAt || snapshot.background) return;
      if (snapshot.activeTurn) {
        // 还在跑，等下一轮结束再排期。
        return;
      }

      const currentTitle = snapshot.title ?? null;
      if (!force && isManuallyRenamed(state, currentTitle)) {
        lock(agentId, "user_renamed");
        return;
      }
      if (!state.provisionalTitle && currentTitle) {
        state = updateAgentState(agentId, { provisionalTitle: currentTitle });
      }
      if (!force && turnId && state.lastSummarizedTurnId === turnId) {
        if (state.lastPluginTitle && values.syncWorkspaceTitle) {
          await syncWorkspaceTitle(paseo, snapshot.workspaceId, state.lastPluginTitle);
        }
        return;
      }

      const mmdd = mmddOf(snapshot.createdAt);
      const forbidden = forbiddenNames(snapshot.cwd);
      const context = extractContext(page.entries, currentTitle, mmdd);
      if (!context.trim()) return;

      const systemPrompt = buildSystemPrompt(values.customPrompt, mmdd, forbidden);
      const model = values.model.trim() || null;
      const request = { context, systemPrompt, model };

      let generated = await (values.engine === "paseo"
        ? generateWithPaseo(paseo, agentId, snapshot, request)
        : generateWithPi(request));

      // 选了 Paseo 引擎但模型不可用时，退回本机 pi，避免功能静默失效。
      if (!generated && values.engine === "paseo") {
        generated = await generateWithPi({ context, systemPrompt, model: null });
      }

      if (!generated) {
        updateAgentState(agentId, { lastSummarizedTurnId: turnId });
        return;
      }

      const title = applyDatePrefix(generated, mmdd, values.includeDate);
      if (!title) return;

      if (title === currentTitle) {
        updateAgentState(agentId, {
          lastSummarizedTurnId: turnId,
          ...(values.renameMode === "first" ? { done: true } : {}),
        });
        if (values.syncWorkspaceTitle) {
          await syncWorkspaceTitle(paseo, snapshot.workspaceId, title);
        }
        return;
      }

      // 生成期间用户可能手改标题；写入前再核对一次。
      const latest = ((await handle.refresh())?.agent ?? null) as unknown as AgentSnapshotLike | null;
      const latestTitle = latest?.title ?? currentTitle;
      if (!force && isManuallyRenamed(state, latestTitle)) {
        lock(agentId, "user_renamed");
        return;
      }

      const renamed = await renameAgent(agentId, title);
      if (!renamed) return;

      updateAgentState(agentId, {
        lastPluginTitle: title,
        lastSummarizedTurnId: turnId,
        ...(values.renameMode === "first" ? { done: true } : {}),
      });
      if (values.syncWorkspaceTitle) {
        await syncWorkspaceTitle(paseo, snapshot.workspaceId, title);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Agent not found/i.test(message)) {
        console.log(`[${PLUGIN_ID}] 会话已删除，跳过 agent=${agentId}`);
      } else {
        console.error(`[${PLUGIN_ID}] 自动命名失败 agent=${agentId}: ${message.slice(0, 500)}`);
      }
    } finally {
      running.delete(agentId);
    }
  }

  function onCreateBefore(request: CreateBeforeRequest): void {
    const title = typeof request.config.title === "string" ? request.config.title.trim() : "";
    if (title) explicitTitles.add(title);
  }

  function onCreateAfter(agent: PluginHookAgent): void {
    const title = typeof agent.title === "string" ? agent.title.trim() : "";
    const explicit = title !== "" && explicitTitles.has(title);
    if (explicit) explicitTitles.delete(title);
    if (agent.background || !explicit) return;
    updateAgentState(agent.id, {
      locked: true,
      lockReason: "explicit_create_title",
      provisionalTitle: title,
    });
    console.log(`[${PLUGIN_ID}] 创建时显式指定了标题，跳过 agent=${agent.id}`);
  }

  function onTurnBefore(agent: PluginHookAgent): void {
    if (agent.background) return;
    cancel(agent.id);
    const state = getAgentState(agent.id);
    if (state.locked) return;
    const currentTitle = agent.title ?? null;
    if (isManuallyRenamed(state, currentTitle)) {
      lock(agent.id, "user_renamed");
      return;
    }
    if (state.provisionalTitle === null && currentTitle) {
      updateAgentState(agent.id, { provisionalTitle: currentTitle });
    }
  }

  async function onTurnAfter(
    agent: PluginHookAgent,
    turnId: string | null,
    outcome: PluginTurnOutcome,
    paseo: PaseoLike,
  ): Promise<void> {
    if (outcome.kind !== "completed" || agent.background) return;
    cancel(agent.id);
    const values = await readSettings();
    if (!values.enabled) return;
    const delayMs = Math.max(5, values.idleSeconds) * 1000;
    schedule(agent.id, paseo, delayMs, false, turnId ?? `turn:${Date.now()}`);
  }

  function onArchive(agent: PluginHookAgent): void {
    cancel(agent.id);
  }

  async function scan(paseo: PaseoLike, input: ScanInput): Promise<ScanResult> {
    const listed = await paseo.agents.list();
    const allEntries = listed.entries ?? [];
    const ids = input.agentIds?.length ? new Set(input.agentIds) : null;
    const selected = ids
      ? allEntries.filter((entry) => ids.has(entry.agent.id))
      : allEntries;
    const force = input.force === true || ids !== null;
    let scheduled = 0;

    for (const entry of selected) {
      const agent = entry.agent;
      if (agent.archivedAt || agent.background) continue;
      const state = getAgentState(agent.id);
      if (state.locked && !force) continue;
      if (force) {
        updateAgentState(agent.id, {
          locked: false,
          lockReason: null,
          provisionalTitle: null,
          lastPluginTitle: null,
          lastSummarizedTurnId: null,
          done: false,
        });
      }
      schedule(agent.id, paseo, 800 + scheduled * 300, force, `scan:${agent.id}`);
      scheduled += 1;
    }

    console.log(
      `[${PLUGIN_ID}] 扫描会话：共 ${allEntries.length}，选中 ${selected.length}，安排 ${scheduled}`,
    );
    return { scanned: allEntries.length, scheduled };
  }

  return {
    onCreateBefore,
    onCreateAfter,
    onTurnBefore,
    onTurnAfter,
    onArchive,
    scan,
    dispose: cancelAll,
  };
}
