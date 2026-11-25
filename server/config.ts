import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN_ID = "session-auto-title";
/** 生成标题用的临时后台 agent 的标题，便于在日志里辨认 */
export const GENERATOR_TITLE = "会话标题生成";
export const GENERATE_TIMEOUT_MS = 45_000;
export const PASEO_GENERATE_TIMEOUT_MS = 60_000;
export const RENAME_TIMEOUT_MS = 15_000;

export const PASEO_HOME =
  process.env.PASEO_HOME?.trim() || path.join(os.homedir(), ".paseo");
export const STATE_PATH = path.join(PASEO_HOME, "plugin-data", PLUGIN_ID, "state.json");

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function executableNames(name: string): string[] {
  // Windows 上 npm/安装器通常提供 .cmd 垫片；直接 spawn 无扩展名的 sh 脚本会失败。
  if (process.platform !== "win32") return [name];
  return [`${name}.cmd`, `${name}.exe`, name];
}

function pathDirectories(): string[] {
  const delimiter = process.platform === "win32" ? ";" : ":";
  return (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function fallbackDirectories(name: string): string[] {
  const home = os.homedir();
  const dirs: string[] = [];
  if (name === "paseo") {
    // Paseo 桌面版自带 CLI：<安装目录>/resources/bin/paseo.cmd
    try {
      dirs.push(path.join(path.dirname(process.execPath), "resources", "bin"));
    } catch {
      // ignore
    }
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) dirs.push(path.join(resourcesPath, "bin"));
    dirs.push(path.join(home, ".local", "bin"));
    if (process.platform === "win32") {
      dirs.push(
        path.join(home, "AppData", "Local", "Programs", "Paseo", "resources", "bin"),
      );
    }
  } else {
    dirs.push(
      path.join(home, ".local", "bin"),
      path.join(home, "bin"),
      path.join(home, ".pi", "agent", "bin"),
      path.join(home, ".pi", "bin"),
    );
    if (process.platform === "win32") {
      dirs.push(path.join(home, "AppData", "Roaming", "npm"));
    } else {
      dirs.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
    }
  }
  return dirs;
}

/**
 * 解析外部 CLI。顺序：显式环境变量覆盖 -> daemon 的 PATH -> 常见安装位置 ->
 * 裸命令名（让 spawn 报出可读的 ENOENT）。
 */
export function resolveExecutable(name: string, override?: string): string {
  const forced = override?.trim();
  if (forced) return forced;
  for (const directory of [...pathDirectories(), ...fallbackDirectories(name)]) {
    for (const file of executableNames(name)) {
      const candidate = path.join(directory, file);
      if (isFile(candidate)) return candidate;
    }
  }
  return name;
}

export const PASEO_BIN = resolveExecutable(
  "paseo",
  process.env.SESSION_AUTO_TITLE_PASEO_BIN,
);
export const PI_BIN = resolveExecutable("pi", process.env.SESSION_AUTO_TITLE_PI_BIN);
export const NODE_BIN = resolveExecutable("node", process.env.SESSION_AUTO_TITLE_NODE_BIN);

/**
 * `pi.cmd` 在 Windows 上必须经过 cmd.exe；cmd.exe 会把参数里的换行当成命令分隔，
 * 导致多行 system prompt 卡死。这里解析 pi 的 JS 入口，直接用 node 启动，
 * 参数原样传递，彻底绕开 shell 引号问题。
 */
export const PI_ENTRY: string | null = (() => {
  const home = os.homedir();
  const candidates = [
    process.env.SESSION_AUTO_TITLE_PI_ENTRY,
    path.join(
      path.dirname(PI_BIN),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    ),
    path.join(
      home,
      "AppData",
      "Roaming",
      "npm",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    ),
    path.join(
      home,
      ".npm-global",
      "lib",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
})();
