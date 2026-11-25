import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Default naming rules. The user may replace this whole block in
 * Settings -> Plugins -> Session Auto Title.
 *
 * `{MMDD}` is replaced at runtime with the session's creation month/day in
 * Asia/Shanghai when "include date" is enabled.
 */
export const DEFAULT_PROMPT = `你是会话标题提炼器。请根据下面的多轮对话，为这个编码会话生成一个适合左侧栏显示的简短标题。

严格规则：
1. 使用简体中文；专有名词、文件名、库名可以保留原文。
2. 标题长度 4~16 个汉字（英文按 8~28 个字符控制），不要超过一行。
3. 概括会话的目标或当前进展，要具体到对象；不要写"修复问题""处理代码"这类空泛描述。
4. 不要出现项目名、目录名、用户名等路径信息。
5. 不要使用引号、换行、Markdown、句号或感叹号。
6. 如果对话只是打招呼、简单确认，或信息不足以判断主题，返回 {"decided": false}，不要猜测。

只输出一行合法 JSON，不要输出 Markdown 代码块或任何解释：
{"decided": true, "title": "最终标题"} 或 {"decided": false}`;

export const autoTitleSettings = defineSettings({
  id: "auto-title",
  scope: "host",
  version: 1,
  schema: z.object({
    /** 总开关 */
    enabled: z.boolean().default(true),
    /** 连续空闲多少秒后定稿，避免在 agent 还在干活时改名 */
    idleSeconds: z.number().int().min(5).max(3600).default(30),
    /** first = 只命名一次；each = 每轮空闲后按最新对话刷新 */
    renameMode: z.enum(["first", "each"]).default("first"),
    /** 同步修改所属 workspace 的侧栏标题（手机/桌面侧栏通常显示 workspace 名） */
    syncWorkspaceTitle: z.boolean().default(true),
    /** pi = 本机 pi CLI；paseo = 用 Paseo 自己的模型开一个临时后台 agent */
    engine: z.enum(["pi", "paseo"]).default("pi"),
    /** 模型覆盖。pi 引擎传 --model；paseo 引擎传 provider/model。留空用各自默认 */
    model: z.string().trim().max(200).default(""),
    /** 标题前加 MMDD｜，例如 1125｜修复登录超时 */
    includeDate: z.boolean().default(false),
    customPrompt: z.string().max(8000).default(DEFAULT_PROMPT),
  }),
});

export type AutoTitleSettings = z.output<typeof autoTitleSettings.schema>;

/** 扫描已有会话并安排空闲改名 */
export const scanRpc = defineRpc({
  name: "session-auto-title.scan",
  input: z.object({
    /** 清除手改锁定并强制重命名 */
    force: z.boolean().optional(),
    /** 只处理这些 agent id；省略则处理当前主机全部会话 */
    agentIds: z.array(z.string()).optional(),
  }),
  output: z.object({
    scanned: z.number(),
    scheduled: z.number(),
  }),
});
