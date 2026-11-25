import os from "node:os";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";

export interface RunProcessOptions {
  /** 显式指定是否经过 shell；省略时由 spawnProcess 根据 .cmd/.exe 判断 */
  shell?: boolean;
  cwd?: string;
  timeoutMs: number;
  maxStdoutBytes?: number;
}

/**
 * 运行一次 CLI 并收集 stdout。
 *
 * stdin 设为 ignore：pi 等 CLI 在非 TTY 下会等待 stdin EOF，
 * 而 execFile 留下的 stdin 管道永远不关闭，导致假死超时。
 */
export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      ...(options.shell === undefined ? {} : { shell: options.shell }),
      cwd: options.cwd ?? os.homedir(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const maxStdout = options.maxStdoutBytes ?? 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error: Error | null, output = ""): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };

    timer = setTimeout(() => {
      void terminateProcess(child, "SIGKILL");
      const error = new Error(`timeout ${options.timeoutMs}ms`);
      (error as { stderr?: string }).stderr = stderr;
      finish(error);
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxStdout) {
        void terminateProcess(child, "SIGKILL");
        finish(new Error(`stdout exceeded ${maxStdout} bytes`));
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) void terminateProcess(child, "SIGKILL");
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        finish(null, stdout);
        return;
      }
      const error = new Error(`exit code ${code ?? "null"}`);
      (error as { stderr?: string }).stderr = stderr;
      finish(error);
    });
  });
}

export function errorDetail(error: unknown): { message: string; stderr: string } {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const rawStderr = (error as { stderr?: unknown }).stderr;
  return {
    message: rawMessage.replace(/\s+/g, " ").slice(0, 200),
    stderr:
      typeof rawStderr === "string" ? rawStderr.replace(/\s+/g, " ").slice(0, 200) : "",
  };
}
