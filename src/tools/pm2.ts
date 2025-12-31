/**
 * PM2 进程管理工具集
 *
 * 提供 PM2 进程的管理能力：
 * - pm2_list: 列出所有进程
 * - pm2_start: 创建并启动任务
 * - pm2_stop: 停止进程
 * - pm2_restart: 重启进程
 * - pm2_delete: 删除进程
 * - pm2_logs: 获取日志
 *
 * 注意：认证已在 HTTP 中间件层完成，工具层不再需要验证 token
 */

import pm2 from "pm2";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAllowedPaths } from "../auth.js";
import { validatePathSandbox } from "../utils/validator.js";
import {
  formatProcessTable,
  successResponse,
  errorResponse,
  type ProcessInfo,
} from "../utils/formatter.js";

const execAsync = promisify(exec);

// PM2 连接状态
let pm2Connected = false;

/**
 * 连接到 PM2（单例模式）
 */
async function connectPm2(): Promise<void> {
  if (pm2Connected) {
    return;
  }

  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) {
        reject(err);
      } else {
        pm2Connected = true;
        resolve();
      }
    });
  });
}

/**
 * 断开 PM2 连接
 */
export function disconnectPm2(): void {
  if (pm2Connected) {
    pm2.disconnect();
    pm2Connected = false;
  }
}

// 使用从 formatter.js 导入的 ProcessInfo 类型

/**
 * 获取进程的日志文件路径
 */
async function getLogPaths(
  name: string
): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    pm2.describe(name, (err, list) => {
      if (err) {
        reject(err);
      } else if (list.length === 0) {
        reject(new Error(`进程 '${name}' 不存在`));
      } else {
        const proc = list[0];
        resolve({
          out: proc.pm2_env?.pm_out_log_path || "",
          err: proc.pm2_env?.pm_err_log_path || "",
        });
      }
    });
  });
}

/**
 * 验证正则表达式是否安全（防止 ReDoS）
 */
function validateRegexSafety(pattern: string): { valid: boolean; error?: string } {
  // 限制长度
  if (pattern.length > 200) {
    return { valid: false, error: "正则表达式过长（最大 200 字符）" };
  }

  // 禁止嵌套量词等危险模式
  const dangerousPatterns = [
    /\([^)]*[+*][^)]*\)[+*]/, // 嵌套量词 (a+)+
    /(\.\*){3,}/, // 多个 .*
    /\([^)]*\|[^)]*\)[+*]/, // 分支量词 (a|b)+
  ];

  for (const danger of dangerousPatterns) {
    if (danger.test(pattern)) {
      return { valid: false, error: "正则表达式包含潜在危险模式" };
    }
  }

  // 尝试编译
  try {
    new RegExp(pattern);
  } catch {
    return { valid: false, error: "无效的正则表达式" };
  }

  return { valid: true };
}

interface MatchResult {
  lineNumber: number;
  line: string;
  context: { before: string[]; after: string[] };
}

/**
 * 在日志文件中搜索匹配的行
 */
async function grepLogs(
  logPath: string,
  pattern: RegExp,
  contextLines: number,
  maxMatches: number
): Promise<MatchResult[]> {
  const content = await readFile(logPath, "utf-8");
  const lines = content.split("\n");
  const results: MatchResult[] = [];
  const maxLineLength = 10000; // 防止 ReDoS

  for (let i = 0; i < lines.length && results.length < maxMatches; i++) {
    const line = lines[i].slice(0, maxLineLength);
    if (pattern.test(line)) {
      results.push({
        lineNumber: i + 1,
        line: lines[i],
        context: {
          before: lines.slice(Math.max(0, i - contextLines), i),
          after: lines.slice(i + 1, i + 1 + contextLines),
        },
      });
    }
  }

  return results;
}

/**
 * 格式化时间间隔为人类可读格式
 */
function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} 天前`;
  if (hours > 0) return `${hours} 小时前`;
  if (minutes > 0) return `${minutes} 分钟前`;
  return "刚刚";
}

interface HealthStatus {
  name: string;
  pmId: number;
  status: string;
  healthy: boolean;
  lastLogTime: Date | null;
  logAge: string;
  cpu: number;
  memory: number;
  restarts: number;
  issues: string[];
}

/**
 * 检查单个进程的健康状态
 */
async function checkProcessHealth(
  proc: pm2.ProcessDescription
): Promise<HealthStatus> {
  const name = proc.name || "unknown";
  const pmId = proc.pm_id ?? -1;
  const status = proc.pm2_env?.status || "unknown";
  const issues: string[] = [];
  let lastLogTime: Date | null = null;

  // 检查状态
  if (status === "errored") {
    issues.push("进程处于错误状态");
  } else if (status === "stopped") {
    issues.push("进程已停止");
  }

  // 检查重启次数
  const restarts = proc.pm2_env?.restart_time || 0;
  if (restarts > 10) {
    issues.push(`频繁重启（${restarts} 次）`);
  }

  // 检查日志文件更新时间
  const outLogPath = proc.pm2_env?.pm_out_log_path;
  if (outLogPath && status === "online") {
    try {
      const stats = await stat(outLogPath);
      lastLogTime = stats.mtime;

      const ageMs = Date.now() - stats.mtime.getTime();
      const ageMinutes = ageMs / 60000;

      if (ageMinutes > 30) {
        issues.push(`日志长时间无更新（${formatTimeAgo(ageMs)}）`);
      }
    } catch {
      // 日志文件不存在
    }
  }

  return {
    name,
    pmId,
    status,
    healthy: issues.length === 0 && status === "online",
    lastLogTime,
    logAge: lastLogTime ? formatTimeAgo(Date.now() - lastLogTime.getTime()) : "-",
    cpu: proc.monit?.cpu || 0,
    memory: proc.monit?.memory || 0,
    restarts,
    issues,
  };
}

/**
 * 格式化进程信息
 */
function formatProcessInfo(proc: pm2.ProcessDescription): ProcessInfo {
  return {
    name: proc.name || "unknown",
    pm_id: proc.pm_id ?? -1,
    status: proc.pm2_env?.status || "unknown",
    cpu: proc.monit?.cpu || 0,
    memory: proc.monit?.memory || 0,
    uptime: proc.pm2_env?.pm_uptime
      ? Date.now() - proc.pm2_env.pm_uptime
      : null,
    restarts: proc.pm2_env?.restart_time || 0,
  };
}

/**
 * 注册所有 PM2 工具到 MCP Server
 */
export function registerPm2Tools(server: McpServer): void {
  // 1. pm2_list - 列出所有进程
  server.tool(
    "pm2_list",
    "列出所有 PM2 进程",
    {},
    async () => {
      try {
        await connectPm2();

        const list = await new Promise<pm2.ProcessDescription[]>(
          (resolve, reject) => {
            pm2.list((err, list) => {
              if (err) reject(err);
              else resolve(list);
            });
          }
        );

        const processes = list.map(formatProcessInfo);
        return successResponse(formatProcessTable(processes));
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
  );

  // 2. pm2_start - 创建并启动任务
  server.tool(
    "pm2_start",
    "创建并启动一个新的 PM2 进程",
    {
      name: z.string().describe("任务名称"),
      script: z.string().describe("脚本路径"),
      cwd: z.string().describe("工作目录"),
      interpreter: z
        .string()
        .optional()
        .describe("解释器路径（如 Python 环境路径）"),
      args: z.array(z.string()).optional().describe("脚本参数"),
      env: z.record(z.string()).optional().describe("环境变量"),
      autorestart: z
        .boolean()
        .optional()
        .default(false)
        .describe("是否自动重启，默认 false"),
      clear_logs: z
        .boolean()
        .optional()
        .default(false)
        .describe("启动前是否清理旧日志，默认 false"),
    },
    async ({ name, script, cwd, interpreter, args, env, autorestart, clear_logs }) => {
      // 验证 cwd 路径
      const allowedPaths = getAllowedPaths();
      const cwdValidation = validatePathSandbox(cwd, allowedPaths);
      if (!cwdValidation.valid) {
        return errorResponse(cwdValidation.error || "路径验证失败");
      }

      try {
        await connectPm2();

        // 如果设置了 clear_logs，先清理旧日志
        let logsCleared = false;
        if (clear_logs) {
          try {
            await execAsync(`pm2 flush ${name}`, { timeout: 10000 });
            logsCleared = true;
          } catch {
            // 如果进程不存在（首次启动），flush 会失败，忽略错误
          }
        }

        const options: pm2.StartOptions = {
          name,
          script,
          cwd,
          autorestart: autorestart ?? false,
          interpreter: interpreter || "node",
          args: args,
          env: env,
        };

        await new Promise<pm2.Proc>((resolve, reject) => {
          pm2.start(options, (err, proc) => {
            if (err) reject(err);
            else resolve(proc as pm2.Proc);
          });
        });

        const details = [
          `进程 '${name}' 已启动`,
          "",
          `脚本: ${script}`,
          `工作目录: ${cwd}`,
          interpreter ? `解释器: ${interpreter}` : null,
          args?.length ? `参数: ${args.join(" ")}` : null,
          `自动重启: ${autorestart ? "是" : "否"}`,
          logsCleared ? `日志已清理: 是` : null,
        ]
          .filter(Boolean)
          .join("\n");

        return successResponse(details);
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
  );

  // 3. pm2_stop - 停止进程
  server.tool(
    "pm2_stop",
    "停止一个 PM2 进程",
    {
      name: z.string().describe("进程名称或 ID"),
    },
    async ({ name }) => {
      try {
        await connectPm2();

        await new Promise<void>((resolve, reject) => {
          pm2.stop(name, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        return successResponse(`进程 '${name}' 已停止`);
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
  );

  // 4. pm2_restart - 重启进程
  server.tool(
    "pm2_restart",
    "重启一个 PM2 进程",
    {
      name: z.string().describe("进程名称或 ID"),
    },
    async ({ name }) => {
      try {
        await connectPm2();

        await new Promise<void>((resolve, reject) => {
          pm2.restart(name, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        return successResponse(`进程 '${name}' 已重启`);
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
  );

  // 5. pm2_delete - 删除进程
  server.tool(
    "pm2_delete",
    "删除一个 PM2 进程",
    {
      name: z.string().describe("进程名称或 ID"),
    },
    async ({ name }) => {
      try {
        await connectPm2();

        await new Promise<void>((resolve, reject) => {
          pm2.delete(name, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        return successResponse(`进程 '${name}' 已删除`);
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
  );

  // 6. pm2_logs - 获取日志
  server.tool(
    "pm2_logs",
    "获取 PM2 进程日志（最近 N 行）",
    {
      name: z.string().describe("进程名称或 ID"),
      lines: z
        .number()
        .optional()
        .default(50)
        .describe("获取的日志行数，默认 50"),
      type: z
        .enum(["out", "err", "all"])
        .optional()
        .default("all")
        .describe("日志类型：out（标准输出）、err（错误输出）、all（全部）"),
    },
    async ({ name, lines = 50, type = "all" }) => {
      try {
        // 使用 pm2 logs 命令获取日志（--nostream 模式）
        // PM2 API 不直接支持获取历史日志，需要通过命令行
        const logType = type === "all" ? "" : type === "out" ? "--out" : "--err";
        const cmd = `pm2 logs ${name} --nostream --lines ${lines} ${logType}`.trim();

        const { stdout } = await execAsync(cmd, {
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        });

        const logContent = stdout.trim();
        if (!logContent) {
          return successResponse(`进程 '${name}' 暂无日志`);
        }

        const header = `进程 '${name}' 的最近 ${lines} 行日志：\n\n`;
        return successResponse(header + logContent);
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
  );

  // 7. pm2_grep - 日志搜索
  server.tool(
    "pm2_grep",
    "在 PM2 进程日志中搜索匹配的行",
    {
      name: z.string().describe("进程名称或 ID"),
      pattern: z.string().describe("搜索正则表达式"),
      context_lines: z
        .number()
        .optional()
        .default(0)
        .describe("上下文行数（匹配行前后各显示多少行）"),
      type: z
        .enum(["out", "err", "all"])
        .optional()
        .default("all")
        .describe("日志类型"),
      max_matches: z
        .number()
        .optional()
        .default(50)
        .describe("最大匹配数，防止输出过大"),
    },
    async ({ name, pattern, context_lines = 0, type = "all", max_matches = 50 }) => {
      // 验证正则安全性
      const regexValidation = validateRegexSafety(pattern);
      if (!regexValidation.valid) {
        return errorResponse(regexValidation.error!);
      }

      try {
        await connectPm2();
        const logPaths = await getLogPaths(name);
        const regex = new RegExp(pattern);

        const allResults: { source: string; matches: MatchResult[] }[] = [];
        let remaining = max_matches;

        if ((type === "out" || type === "all") && logPaths.out) {
          try {
            const matches = await grepLogs(logPaths.out, regex, context_lines, remaining);
            if (matches.length > 0) {
              allResults.push({ source: "stdout", matches });
              remaining -= matches.length;
            }
          } catch {
            // 日志文件不存在或无法读取
          }
        }

        if ((type === "err" || type === "all") && logPaths.err && remaining > 0) {
          try {
            const matches = await grepLogs(logPaths.err, regex, context_lines, remaining);
            if (matches.length > 0) {
              allResults.push({ source: "stderr", matches });
            }
          } catch {
            // 日志文件不存在或无法读取
          }
        }

        if (allResults.length === 0) {
          return successResponse(`进程 '${name}' 日志中未找到匹配 '${pattern}' 的内容`);
        }

        // 格式化输出
        const lines: string[] = [`进程 '${name}' 日志搜索结果（匹配: ${pattern}）：`, ""];

        for (const { source, matches } of allResults) {
          lines.push(`[${source}] ${matches.length} 处匹配：`);
          lines.push("");

          for (const match of matches) {
            if (match.context.before.length > 0) {
              match.context.before.forEach((l) => lines.push(`  ${l}`));
            }
            lines.push(`> ${match.lineNumber}: ${match.line}`);
            if (match.context.after.length > 0) {
              match.context.after.forEach((l) => lines.push(`  ${l}`));
            }
            lines.push("---");
          }
        }

        const totalMatches = allResults.reduce((sum, r) => sum + r.matches.length, 0);
        lines.push(`\n共 ${totalMatches} 处匹配`);

        return successResponse(lines.join("\n"));
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
  );

  // 8. pm2_health - 健康检查
  server.tool(
    "pm2_health",
    "检查 PM2 进程的健康状态",
    {
      name: z
        .string()
        .optional()
        .describe("进程名称或 ID（不提供则检查所有）"),
    },
    async ({ name }) => {
      try {
        await connectPm2();

        let processes: pm2.ProcessDescription[];

        if (name) {
          processes = await new Promise((resolve, reject) => {
            pm2.describe(name, (err, list) => {
              if (err) reject(err);
              else resolve(list);
            });
          });
          if (processes.length === 0) {
            return errorResponse(`进程 '${name}' 不存在`);
          }
        } else {
          processes = await new Promise((resolve, reject) => {
            pm2.list((err, list) => {
              if (err) reject(err);
              else resolve(list);
            });
          });
        }

        if (processes.length === 0) {
          return successResponse("当前没有 PM2 进程");
        }

        const healthResults = await Promise.all(
          processes.map(checkProcessHealth)
        );

        const lines: string[] = ["进程健康检查结果：", ""];

        for (const health of healthResults) {
          const icon = health.healthy ? "[OK]" : "[!!]";
          const statusText =
            health.status === "online"
              ? "运行中"
              : health.status === "stopped"
                ? "已停止"
                : health.status === "errored"
                  ? "错误"
                  : health.status;

          lines.push(`${icon} ${health.name} (ID: ${health.pmId})`);
          lines.push(`    状态: ${statusText}`);
          lines.push(`    CPU: ${health.cpu.toFixed(1)}%`);
          lines.push(
            `    内存: ${(health.memory / 1024 / 1024).toFixed(1)} MB`
          );
          lines.push(`    重启次数: ${health.restarts}`);
          lines.push(`    最后日志: ${health.logAge}`);

          if (health.issues.length > 0) {
            lines.push(`    问题:`);
            health.issues.forEach((issue) => lines.push(`      - ${issue}`));
          }
          lines.push("");
        }

        const healthyCount = healthResults.filter((h) => h.healthy).length;
        lines.push("---");
        lines.push(`总计: ${healthyCount}/${healthResults.length} 个进程健康`);

        return successResponse(lines.join("\n"));
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
  );

  // 9. pm2_metrics - 指标提取
  server.tool(
    "pm2_metrics",
    "从 PM2 进程日志中提取指标值",
    {
      name: z.string().describe("进程名称或 ID"),
      patterns: z
        .record(z.string())
        .describe("指标名称到正则表达式的映射，正则需有一个捕获组"),
      lines: z
        .number()
        .optional()
        .default(1000)
        .describe("分析的日志行数，默认 1000"),
    },
    async ({ name, patterns, lines = 1000 }) => {
      // 验证 patterns 数量
      const patternEntries = Object.entries(patterns);
      if (patternEntries.length > 10) {
        return errorResponse("最多支持 10 个指标模式");
      }

      if (patternEntries.length === 0) {
        return errorResponse("至少需要一个指标模式");
      }

      // 验证所有正则的安全性
      for (const [metricName, pattern] of patternEntries) {
        const validation = validateRegexSafety(pattern);
        if (!validation.valid) {
          return errorResponse(`指标 '${metricName}' 的正则无效: ${validation.error}`);
        }
      }

      try {
        await connectPm2();
        const logPaths = await getLogPaths(name);

        if (!logPaths.out) {
          return errorResponse(`进程 '${name}' 没有日志文件`);
        }

        // 读取日志文件
        let logContent: string;
        try {
          logContent = await readFile(logPaths.out, "utf-8");
        } catch {
          return errorResponse(`无法读取日志文件: ${logPaths.out}`);
        }

        const logLines = logContent.split("\n").slice(-lines);
        const maxLineLength = 10000;

        // 提取指标
        interface MetricValue {
          value: string;
          lineNumber: number;
        }

        const results: Record<
          string,
          { values: MetricValue[]; latest: string | null }
        > = {};

        for (const [metricName, patternStr] of patternEntries) {
          const regex = new RegExp(patternStr);
          const values: MetricValue[] = [];

          for (let i = 0; i < logLines.length; i++) {
            const line = logLines[i].slice(0, maxLineLength);
            const match = line.match(regex);
            if (match && match[1]) {
              values.push({
                value: match[1],
                lineNumber: logLines.length - lines + i + 1,
              });
            }
          }

          results[metricName] = {
            values,
            latest: values.length > 0 ? values[values.length - 1].value : null,
          };
        }

        // 格式化输出
        const output: string[] = [`进程 '${name}' 指标提取结果：`, ""];

        for (const [metricName, result] of Object.entries(results)) {
          output.push(`[${metricName}]`);
          if (result.values.length === 0) {
            output.push("  未找到匹配");
          } else {
            output.push(`  最新值: ${result.latest}`);
            output.push(`  匹配数: ${result.values.length}`);

            // 显示最后 5 个值的趋势
            const recent = result.values.slice(-5);
            if (recent.length > 1) {
              output.push(`  趋势: ${recent.map((v) => v.value).join(" -> ")}`);
            }
          }
          output.push("");
        }

        return successResponse(output.join("\n"));
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
  );
}
