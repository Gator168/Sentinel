/**
 * 格式化工具函数
 *
 * 将数据转换为 LLM 友好的人类可读格式
 */

/**
 * 格式化字节数为人类可读格式
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(1)} ${units[i]}`;
}

/**
 * 格式化毫秒为人类可读的时间
 */
export function formatUptime(ms: number | null): string {
  if (ms === null || ms <= 0) return "-";

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * 格式化 CPU 使用率
 */
export function formatCpu(cpu: number): string {
  return `${cpu.toFixed(1)}%`;
}

/**
 * 状态映射为中文
 */
export function formatStatus(status: string): string {
  const statusMap: Record<string, string> = {
    online: "运行中",
    stopping: "停止中",
    stopped: "已停止",
    launching: "启动中",
    errored: "错误",
    "one-launch-status": "单次运行",
  };
  return statusMap[status] || status;
}

/**
 * 填充字符串到指定宽度（支持中文）
 */
export function padEnd(str: string, width: number): string {
  // 计算实际显示宽度（中文字符占2个宽度）
  let displayWidth = 0;
  for (const char of str) {
    displayWidth += char.charCodeAt(0) > 127 ? 2 : 1;
  }
  const padding = Math.max(0, width - displayWidth);
  return str + " ".repeat(padding);
}

export function padStart(str: string, width: number): string {
  let displayWidth = 0;
  for (const char of str) {
    displayWidth += char.charCodeAt(0) > 127 ? 2 : 1;
  }
  const padding = Math.max(0, width - displayWidth);
  return " ".repeat(padding) + str;
}

// 进程信息接口
export interface ProcessInfo {
  name: string;
  pm_id: number;
  status: string;
  cpu: number;
  memory: number;
  uptime: number | null;
  restarts: number;
}

/**
 * 格式化进程列表为表格
 */
export function formatProcessTable(processes: ProcessInfo[]): string {
  if (processes.length === 0) {
    return "当前没有运行的进程。";
  }

  const lines: string[] = [];

  // 表头
  lines.push("PM2 进程列表：");
  lines.push("");

  // 计算每列宽度
  const headers = ["ID", "名称", "状态", "CPU", "内存", "运行时间", "重启"];
  const widths = [4, 20, 8, 8, 10, 10, 6];

  // 表头行
  const headerRow = headers
    .map((h, i) => padEnd(h, widths[i]))
    .join(" │ ");
  const separator = widths.map((w) => "─".repeat(w)).join("─┼─");

  lines.push("┌─" + widths.map((w) => "─".repeat(w)).join("─┬─") + "─┐");
  lines.push("│ " + headerRow + " │");
  lines.push("├─" + separator + "─┤");

  // 数据行
  for (const proc of processes) {
    const row = [
      padEnd(String(proc.pm_id), widths[0]),
      padEnd(proc.name.slice(0, 18), widths[1]),
      padEnd(formatStatus(proc.status), widths[2]),
      padEnd(formatCpu(proc.cpu), widths[3]),
      padEnd(proc.memory > 0 ? formatBytes(proc.memory) : "-", widths[4]),
      padEnd(formatUptime(proc.uptime), widths[5]),
      padEnd(String(proc.restarts), widths[6]),
    ].join(" │ ");
    lines.push("│ " + row + " │");
  }

  lines.push("└─" + widths.map((w) => "─".repeat(w)).join("─┴─") + "─┘");
  lines.push("");
  lines.push(`共 ${processes.length} 个进程`);

  return lines.join("\n");
}

/**
 * 创建成功响应
 */
export function successResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * 创建错误响应
 */
export function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: `错误：${message}` }],
    isError: true,
  };
}
