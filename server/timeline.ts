/**
 * 只读取标题生成需要的结构字段。Paseo 的 timeline 类型会随版本演进，
 * 这里用结构化类型 + 窄化，避免 server 端 import @getpaseo/client（插件编译边界禁止）。
 */

export interface AgentSnapshotLike {
  id?: string;
  createdAt?: string;
  title?: string | null;
  cwd?: string | null;
  workspaceId?: string | null;
  archivedAt?: string | null;
  background?: boolean;
  activeTurn?: unknown;
  runtimeInfo?: {
    provider?: string | null;
    model?: string | null;
  } | null;
}

interface TimelineItemLike {
  type?: string;
  text?: string;
  name?: string;
  agentMessage?: { event?: string; text?: string };
  detail?: { type?: string; text?: string };
}

export interface TimelineEntryLike {
  item?: TimelineItemLike;
  turnId?: string;
  seqStart?: number;
}

interface TimelineCursorLike {
  epoch: string;
  seq: number;
}

interface TimelinePageLike {
  entries?: TimelineEntryLike[];
  agent?: AgentSnapshotLike | null;
  hasOlder?: boolean;
  hasNewer?: boolean;
  startCursor?: TimelineCursorLike | null;
  endCursor?: TimelineCursorLike | null;
  reset?: boolean;
  error?: string | null;
}

export interface TimelineHandleLike {
  refetch(options?: {
    direction?: "tail" | "before" | "after";
    cursor?: TimelineCursorLike;
    limit?: number;
    projection?: "projected" | "canonical";
    wholeTurns?: boolean;
  }): Promise<TimelinePageLike>;
}

interface Message {
  role: "用户" | "助手";
  text: string;
  index: number;
}

const MAX_MESSAGE_CHARS = 400;
const MAX_CONTEXT_CHARS = 3000;
const MAX_FIRST_USER_MESSAGES = 2;
const MAX_RECENT_MESSAGES = 8;
const MAX_PAGES = 5;
const PAGE_SIZE = 24;

function cleanText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, "[代码片段]")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

function collectMessages(entries: TimelineEntryLike[]): Message[] {
  const messages: Message[] = [];
  entries.forEach((entry, index) => {
    const item = entry.item;
    if (!item) return;
    if (item.type === "user_message" || item.type === "assistant_message") {
      if (typeof item.text === "string") {
        const cleaned = cleanText(item.text);
        if (cleaned) {
          messages.push({
            role: item.type === "user_message" ? "用户" : "助手",
            text: cleaned,
            index,
          });
        }
      }
      return;
    }
    // 通过 CLI / 其它 agent 发进来的消息在 timeline 里是 tool_call。
    if (item.type === "tool_call" && (item.name === "paseo-agent-message" || item.agentMessage)) {
      const raw =
        item.agentMessage?.event === "message"
          ? item.agentMessage.text
          : item.detail?.type === "plain_text"
            ? item.detail.text
            : undefined;
      if (typeof raw === "string" && raw.trim()) {
        const cleaned = cleanText(raw);
        if (cleaned) messages.push({ role: "用户", text: cleaned, index });
      }
    }
  });
  return messages;
}

export function extractFirstUserText(entries: TimelineEntryLike[]): string | null {
  return collectMessages(entries).find((message) => message.role === "用户")?.text ?? null;
}

/**
 * 分页读取对话：先从开头取真实的首条用户消息，再从末尾回溯最近若干条问答。
 * 这样长会话、单轮大量 tool_call 的情况下都不会抓错上下文。
 */
export async function fetchConversationEntries(
  timeline: TimelineHandleLike,
  options?: {
    firstUserLimit?: number;
    recentMessagesLimit?: number;
    maxPages?: number;
    pageSize?: number;
  },
): Promise<{
  entries: TimelineEntryLike[];
  firstUserText: string | null;
  agent: AgentSnapshotLike | null;
}> {
  const firstUserLimit = options?.firstUserLimit ?? MAX_FIRST_USER_MESSAGES;
  const recentMessagesLimit = options?.recentMessagesLimit ?? MAX_RECENT_MESSAGES;
  const maxPages = options?.maxPages ?? MAX_PAGES;
  const pageSize = options?.pageSize ?? PAGE_SIZE;

  let agent: AgentSnapshotLike | null = null;
  const headEntries: TimelineEntryLike[] = [];
  let firstUserText: string | null = null;
  let headUserCount = 0;
  let afterCursor: TimelineCursorLike | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await timeline.refetch({
      direction: "after",
      limit: pageSize,
      ...(afterCursor ? { cursor: afterCursor } : {}),
    });
    if (response.agent && !agent) agent = response.agent;
    if (response.error || (response.reset && afterCursor)) break;
    const entries = response.entries ?? [];
    if (!afterCursor && entries.length === 0 && !response.startCursor && !response.endCursor) {
      break;
    }

    for (const entry of entries) {
      const messages = collectMessages([entry]);
      if (messages.length === 0) continue;
      headEntries.push(entry);
      for (const message of messages) {
        if (message.role !== "用户") continue;
        if (firstUserText === null) firstUserText = message.text;
        headUserCount += 1;
      }
      if (headUserCount >= firstUserLimit) break;
    }

    if (headUserCount >= firstUserLimit || !response.hasNewer || !response.endCursor) break;
    if (
      afterCursor &&
      (response.endCursor.epoch !== afterCursor.epoch ||
        response.endCursor.seq <= afterCursor.seq)
    ) {
      break;
    }
    afterCursor = response.endCursor;
  }

  const tailPages: TimelineEntryLike[][] = [];
  let tailMessageCount = 0;
  let beforeCursor: TimelineCursorLike | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await timeline.refetch({
      direction: beforeCursor ? "before" : "tail",
      limit: pageSize,
      wholeTurns: true,
      ...(beforeCursor ? { cursor: beforeCursor } : {}),
    });
    if (response.agent) agent = response.agent;
    if (response.error || (response.reset && beforeCursor)) break;
    const entries = response.entries ?? [];
    if (!beforeCursor && entries.length === 0 && !response.startCursor && !response.endCursor) {
      break;
    }

    const messageEntries = entries.filter((entry) => collectMessages([entry]).length > 0);
    tailPages.push(messageEntries);
    tailMessageCount += messageEntries.length;

    if (tailMessageCount >= recentMessagesLimit || !response.hasOlder || !response.startCursor) {
      break;
    }
    if (
      beforeCursor &&
      (response.startCursor.epoch !== beforeCursor.epoch ||
        response.startCursor.seq >= beforeCursor.seq)
    ) {
      break;
    }
    beforeCursor = response.startCursor;
  }

  const tailEntries = tailPages.reverse().flat();
  if (firstUserText === null) firstUserText = extractFirstUserText(tailEntries);

  const merged: TimelineEntryLike[] = [];
  const seenSeq = new Set<number>();
  for (const entry of [...headEntries, ...tailEntries]) {
    if (typeof entry.seqStart === "number") {
      if (seenSeq.has(entry.seqStart)) continue;
      seenSeq.add(entry.seqStart);
    }
    merged.push(entry);
  }

  return { entries: merged, firstUserText, agent };
}

export function extractContext(
  entries: TimelineEntryLike[],
  originalTitle: string | null | undefined,
  datePrefix: string | null,
): string {
  const messages = collectMessages(entries);
  const firstUsers = messages.filter((message) => message.role === "用户").slice(0, MAX_FIRST_USER_MESSAGES);
  const recent = messages.slice(-MAX_RECENT_MESSAGES);

  const seen = new Set<number>();
  const selected: Message[] = [];
  for (const message of [...firstUsers, ...recent]) {
    if (seen.has(message.index)) continue;
    seen.add(message.index);
    selected.push(message);
  }

  const header = [
    `原始标题：${originalTitle || "(无)"}`,
    datePrefix ? `会话创建日期（MMDD，Asia/Shanghai）：${datePrefix}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = selected.map((message) => `${message.role}：${message.text}`).join("\n");
  const combined = `${header}\n\n${body}`;
  return combined.length > MAX_CONTEXT_CHARS ? combined.slice(0, MAX_CONTEXT_CHARS) : combined;
}

/** 从 cwd 提取不应出现在标题里的项目/目录名 */
export function forbiddenNames(cwd: string | null | undefined): string[] {
  if (typeof cwd !== "string" || !cwd.trim()) return [];
  return cwd
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !part.startsWith("."))
    .slice(-2);
}
