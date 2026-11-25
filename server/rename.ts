import { PASEO_BIN, PLUGIN_ID, RENAME_TIMEOUT_MS } from "./config";
import { errorDetail, runProcess } from "./run";

/**
 * 只改会话（agent）标题：paseo agent update <id> --name <title>。
 * 不改项目名、内容、归属、排序、置顶或归档状态。
 *
 * runProcess 在 Windows 上由 spawnProcess 处理 .cmd 垫片和参数引号，
 * 并把 stdin 设为 ignore，避免 CLI 等待 EOF。中文标题、空格、括号都能安全传入。
 */
export async function renameAgent(agentId: string, title: string): Promise<boolean> {
  try {
    await runProcess(PASEO_BIN, ["agent", "update", agentId, "--name", title], {
      timeoutMs: RENAME_TIMEOUT_MS,
    });
    console.log(`[${PLUGIN_ID}] 已改名 agent=${agentId} -> ${title}`);
    return true;
  } catch (error) {
    const { message, stderr } = errorDetail(error);
    console.error(`[${PLUGIN_ID}] 改名失败 agent=${agentId}: ${message}`);
    if (stderr) console.error(`[${PLUGIN_ID}] 改名 stderr: ${stderr}`);
    return false;
  }
}
