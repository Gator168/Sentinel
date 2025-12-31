/**
 * GPU 状态监控工具
 *
 * 使用 nvidia-smi 获取 GPU 状态和进程信息
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/formatter.js";

const execAsync = promisify(exec);

interface GpuInfo {
  index: number;
  name: string;
  memoryUsed: number; // MB
  memoryTotal: number; // MB
  utilization: number; // %
}

interface GpuProcess {
  gpuIndex: number;
  pid: number;
  processName: string;
  memoryUsed: number; // MB
}

/**
 * 获取 GPU 状态和进程信息
 */
async function getGpuStatus(): Promise<{
  gpus: GpuInfo[];
  processes: GpuProcess[];
}> {
  const gpuCmd =
    "nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits";
  const procCmd =
    "nvidia-smi --query-compute-apps=gpu_bus_id,pid,process_name,used_memory --format=csv,noheader,nounits";
  const busCmd = "nvidia-smi --query-gpu=index,gpu_bus_id --format=csv,noheader";

  // 并行执行所有查询
  const [gpuResult, procResult, busResult] = await Promise.allSettled([
    execAsync(gpuCmd, { timeout: 10000 }),
    execAsync(procCmd, { timeout: 10000 }),
    execAsync(busCmd, { timeout: 10000 }),
  ]);

  // 解析 GPU 信息
  const gpus: GpuInfo[] = [];
  if (gpuResult.status === "fulfilled") {
    gpuResult.value.stdout
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .forEach((line) => {
        const parts = line.split(",").map((p) => p.trim());
        gpus.push({
          index: parseInt(parts[0], 10),
          name: parts[1],
          memoryUsed: parseInt(parts[2], 10),
          memoryTotal: parseInt(parts[3], 10),
          utilization: parseInt(parts[4], 10),
        });
      });
  }

  // 构建 bus_id -> index 映射
  const busToIndex = new Map<string, number>();
  if (busResult.status === "fulfilled") {
    busResult.value.stdout
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .forEach((line) => {
        const [index, busId] = line.split(",").map((p) => p.trim());
        busToIndex.set(busId, parseInt(index, 10));
      });
  }

  // 解析进程信息
  const processes: GpuProcess[] = [];
  if (procResult.status === "fulfilled" && procResult.value.stdout.trim()) {
    procResult.value.stdout
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .forEach((line) => {
        const parts = line.split(",").map((p) => p.trim());
        const busId = parts[0];
        processes.push({
          gpuIndex: busToIndex.get(busId) ?? -1,
          pid: parseInt(parts[1], 10),
          processName: parts[2],
          memoryUsed: parseInt(parts[3], 10),
        });
      });
  }

  return { gpus, processes };
}

/**
 * 格式化 GPU 状态为人类可读文本
 */
function formatGpuStatus(gpus: GpuInfo[], processes: GpuProcess[]): string {
  const lines: string[] = [];

  lines.push("GPU 状态：");
  lines.push("");

  for (const gpu of gpus) {
    const memPercent = ((gpu.memoryUsed / gpu.memoryTotal) * 100).toFixed(1);
    const memBar = createProgressBar(gpu.memoryUsed, gpu.memoryTotal, 20);
    const utilBar = createProgressBar(gpu.utilization, 100, 20);

    lines.push(`[GPU ${gpu.index}] ${gpu.name}`);
    lines.push(`  显存: ${memBar} ${gpu.memoryUsed} MB / ${gpu.memoryTotal} MB (${memPercent}%)`);
    lines.push(`  利用率: ${utilBar} ${gpu.utilization}%`);

    // 显示该 GPU 上的进程
    const gpuProcesses = processes.filter((p) => p.gpuIndex === gpu.index);
    if (gpuProcesses.length > 0) {
      lines.push(`  进程:`);
      for (const proc of gpuProcesses) {
        lines.push(`    - PID ${proc.pid}: ${proc.processName} (${proc.memoryUsed} MB)`);
      }
    }
    lines.push("");
  }

  // 汇总信息
  const totalMemUsed = gpus.reduce((sum, g) => sum + g.memoryUsed, 0);
  const totalMemTotal = gpus.reduce((sum, g) => sum + g.memoryTotal, 0);
  const avgUtil = gpus.length > 0
    ? (gpus.reduce((sum, g) => sum + g.utilization, 0) / gpus.length).toFixed(1)
    : "0";

  lines.push("---");
  lines.push(`总计: ${gpus.length} 个 GPU`);
  lines.push(`总显存: ${totalMemUsed} MB / ${totalMemTotal} MB`);
  lines.push(`平均利用率: ${avgUtil}%`);
  lines.push(`运行进程: ${processes.length} 个`);

  return lines.join("\n");
}

/**
 * 创建进度条
 */
function createProgressBar(current: number, total: number, width: number): string {
  const ratio = Math.min(current / total, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return "[" + "█".repeat(filled) + "░".repeat(empty) + "]";
}

/**
 * 注册 GPU 工具到 MCP Server
 */
export function registerGpuTools(server: McpServer): void {
  server.tool(
    "gpu_status",
    "获取 GPU 状态和进程信息（使用 nvidia-smi）",
    {},
    async () => {
      try {
        const { gpus, processes } = await getGpuStatus();

        if (gpus.length === 0) {
          return errorResponse("未检测到 NVIDIA GPU 或 nvidia-smi 不可用");
        }

        return successResponse(formatGpuStatus(gpus, processes));
      } catch (error) {
        const err = error as Error;
        if (
          err.message.includes("command not found") ||
          err.message.includes("not recognized") ||
          err.message.includes("ENOENT")
        ) {
          return errorResponse("nvidia-smi 命令不可用，请确认已安装 NVIDIA 驱动");
        }
        return errorResponse(err.message);
      }
    }
  );
}
