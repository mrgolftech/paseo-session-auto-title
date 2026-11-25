import fs from "node:fs";
import path from "node:path";
import { STATE_PATH } from "./config";

export interface AgentTitleState {
  /** 插件第一次看到该会话时的标题，用来识别"用户是否在首次定稿前手改过" */
  provisionalTitle: string | null;
  /** 插件最近一次成功写入的标题 */
  lastPluginTitle: string | null;
  /** 最近一次已经总结过的 turnId，避免同一轮重复调用模型 */
  lastSummarizedTurnId: string | null;
  /** first 模式下已经改过一次名 */
  done: boolean;
  /** 用户手改 / 创建时显式指定标题 -> 永久停止自动改名 */
  locked: boolean;
  lockReason: string | null;
}

interface StateFile {
  agents: Record<string, AgentTitleState>;
}

const EMPTY: AgentTitleState = {
  provisionalTitle: null,
  lastPluginTitle: null,
  lastSummarizedTurnId: null,
  done: false,
  locked: false,
  lockReason: null,
};

let cached: StateFile | null = null;

function emptyState(): StateFile {
  return { agents: {} };
}

function load(): StateFile {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as StateFile;
    cached =
      parsed && typeof parsed === "object" && parsed.agents && typeof parsed.agents === "object"
        ? parsed
        : emptyState();
  } catch {
    cached = emptyState();
  }
  return cached;
}

function persist(): void {
  if (!cached) return;
  const directory = path.dirname(STATE_PATH);
  try {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${STATE_PATH}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(cached, null, 2), "utf8");
    fs.renameSync(temporary, STATE_PATH);
  } catch (error) {
    console.error("[session-auto-title] 写入状态失败", error);
  }
}

export function getAgentState(agentId: string): AgentTitleState {
  const state = load();
  return state.agents[agentId]
    ? { ...EMPTY, ...state.agents[agentId] }
    : { ...EMPTY };
}

export function updateAgentState(
  agentId: string,
  patch: Partial<AgentTitleState>,
): AgentTitleState {
  const state = load();
  const next: AgentTitleState = { ...getAgentState(agentId), ...patch };
  state.agents[agentId] = next;
  persist();
  return next;
}
