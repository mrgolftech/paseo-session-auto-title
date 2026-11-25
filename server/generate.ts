import path from "node:path";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import {
  GENERATE_TIMEOUT_MS,
  GENERATOR_TITLE,
  NODE_BIN,
  PASEO_BIN,
  PASEO_GENERATE_TIMEOUT_MS,
  PI_BIN,
  PI_ENTRY,
  PLUGIN_ID,
} from "./config";
import { errorDetail, runProcess } from "./run";
import type { AgentSnapshotLike } from "./timeline";

type PaseoLike = PluginHookContext["paseo"];

export interface GenerationRequest {
  /** 多轮对话摘录 */
  context: string;
  /** 命名规则（已替换 {MMDD}） */
  systemPrompt: string;
  /** pi: --model 值；paseo: provider/model */
  model: string | null;
}

const REFUSAL_PATTERN = /无法|不足|抱歉|不能确定|不确定|not enough|cannot|can't|unable|sorry/i;

function cleanTitle(raw: string): string | null {
  const title = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/^["'`“”‘’\s]+|["'`“”‘’\s]+$/g, "")
    .replace(/^(标题|title)\s*[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[。！!]+$/g, "")
    .trim()
    .slice(0, 48)
    .trim();
  return title || null;
}

/**
 * 解析模型输出。优先取 JSON 契约；部分模型会漏掉 JSON，因此对单行纯文本
 * 做有限兜底，并过滤明显的"信息不足"回复。
 */
export function parseTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        decided?: unknown;
        title?: unknown;
      };
      if (parsed.decided === false) return null;
      if (typeof parsed.title === "string") return cleanTitle(parsed.title);
    } catch {
      // 不是合法 JSON，走单行兜底。
    }
  }
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line || line.startsWith("{") || REFUSAL_PATTERN.test(line)) return null;
  return cleanTitle(line);
}

/** 会话创建日期 MMDD（Asia/Shanghai） */
export function mmddOf(createdAt: string | null | undefined): string | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    return month && day ? `${month}${day}` : null;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(
  template: string,
  mmdd: string | null,
  forbidden: string[],
): string {
  const rules = template.trim() || "";
  const replaced = mmdd ? rules.replaceAll("{MMDD}", mmdd) : rules.replaceAll("{MMDD}", "MMDD");
  const forbiddenLine =
    forbidden.length > 0
      ? `禁止在标题中出现这些项目/目录名：${forbidden.join("、")}。`
      : "";
  return [
    replaced,
    forbiddenLine,
    "只输出一行 JSON，不要调用任何工具，不要读取文件，不要输出 Markdown 代码块或解释。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function applyDatePrefix(
  title: string,
  mmdd: string | null,
  includeDate: boolean,
): string {
  if (!includeDate || !mmdd) return title;
  if (title.startsWith(`${mmdd}｜`) || title.startsWith(`${mmdd}|`)) return title;
  return `${mmdd}｜${title}`;
}

/** 本机 pi CLI，一次性、无工具、无会话 */
export async function generateWithPi(request: GenerationRequest): Promise<string | null> {
  const args = [
    "-p",
    "--no-tools",
    "--no-extensions",
    "--no-session",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--thinking",
    "off",
  ];
  if (request.model) args.push("--model", request.model);
  args.push("--system-prompt", request.systemPrompt, "--", request.context);

  const direct = PI_ENTRY !== null && path.isAbsolute(NODE_BIN);
  try {
    const stdout = direct
      ? await runProcess(NODE_BIN, [PI_ENTRY as string, ...args], {
          shell: false,
          timeoutMs: GENERATE_TIMEOUT_MS,
        })
      : await runProcess(PI_BIN, args, { timeoutMs: GENERATE_TIMEOUT_MS });
    const title = parseTitle(stdout);
    if (!title) console.log(`[${PLUGIN_ID}] pi 未返回可用标题: ${stdout.slice(0, 200)}`);
    return title;
  } catch (error) {
    const { message, stderr } = errorDetail(error);
    console.error(`[${PLUGIN_ID}] pi 失败: ${message}`);
    if (stderr) console.error(`[${PLUGIN_ID}] pi stderr: ${stderr}`);
    return null;
  }
}

interface MetadataGenerationConfig {
  metadataGeneration?: {
    providers?: Array<{ provider?: string; model?: string }>;
  };
}

async function resolvePaseoProvider(
  paseo: PaseoLike,
  override: string | null,
  snapshot: AgentSnapshotLike,
): Promise<string | null> {
  if (override) return override;
  try {
    const { config } = await paseo.config.get();
    const metadata = (config as unknown as MetadataGenerationConfig).metadataGeneration;
    const entry = metadata?.providers?.find((candidate) => candidate.provider);
    if (entry?.provider) {
      return entry.model ? `${entry.provider}/${entry.model}` : entry.provider;
    }
  } catch {
    // 配置不可读时继续用会话模型兜底。
  }
  const provider = snapshot.runtimeInfo?.provider;
  const model = snapshot.runtimeInfo?.model;
  if (provider && model) return `${provider}/${model}`;
  return provider ?? null;
}

/**
 * 用 Paseo 自己的模型：在会话所属 workspace 里开一个隐藏的后台 agent，
 * 跑完一轮后立刻归档，不进入会话列表、不触发通知。
 */
export async function generateWithPaseo(
  paseo: PaseoLike,
  agentId: string,
  snapshot: AgentSnapshotLike,
  request: GenerationRequest,
): Promise<string | null> {
  const workspaceId = snapshot.workspaceId;
  if (!workspaceId) return null;
  const provider = await resolvePaseoProvider(paseo, request.model, snapshot);
  if (!provider) {
    console.log(`[${PLUGIN_ID}] 没有可用的 Paseo 模型，请设置模型或在 config.json 配置 metadataGeneration`);
    return null;
  }

  type WorkspaceHandle = ReturnType<PaseoLike["workspaces"]["ref"]>;
  type CreatedAgentHandle = Awaited<ReturnType<WorkspaceHandle["agents"]["create"]>>;
  let handle: CreatedAgentHandle | null = null;
  try {
    handle = await paseo.workspaces.ref(workspaceId).agents.create({
      config: { provider },
      title: GENERATOR_TITLE,
      prompt: `${request.systemPrompt}\n\n对话内容：\n${request.context}`,
      background: true,
      labels: {
        "paseo.parent-agent-id": agentId,
        [`${PLUGIN_ID}.generator`]: "1",
      },
    });
    const result = await handle.waitForFinish(PASEO_GENERATE_TIMEOUT_MS);
    if (result.status !== "idle") {
      console.log(
        `[${PLUGIN_ID}] 标题生成 agent 结束状态 ${result.status}${result.error ? `: ${result.error}` : ""}`,
      );
    }
    return parseTitle(result.lastMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${PLUGIN_ID}] Paseo 生成标题失败: ${message.slice(0, 400)}`);
    return null;
  } finally {
    if (handle) {
      await handle.archive().catch((error: unknown) => {
        console.log(`[${PLUGIN_ID}] 归档标题生成 agent 失败: ${String(error)}`);
      });
    }
  }
}

/** 确保 paseo CLI 可用；用于日志提示 */
export function describeBinaries(): string {
  return `paseo=${PASEO_BIN} pi=${PI_BIN}`;
}
