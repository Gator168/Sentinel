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
 */

import pm2 from "pm2";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateToken, createAuthError, getAllowedPaths } from "../auth.js";
import { validatePathSandbox } from "../utils/validator.js";

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

// 进程信息简化接口
interface ProcessInfo {
  name: string;
  pm_id: number;
  status: string;
  cpu: number;
  memory: number;
  uptime: number | null;
  restarts: number;
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
    {
      token: z.string().describe("认证令牌"),
    },
    async ({ token }) => {
      if (!validateToken(token)) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(createAuthError()) },
          ],
          isError: true,
        };
      }

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

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, processes }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 2. pm2_start - 创建并启动任务
  server.tool(
    "pm2_start",
    "创建并启动一个新的 PM2 进程",
    {
      token: z.string().describe("认证令牌"),
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
    },
    async ({ token, name, script, cwd, interpreter, args, env, autorestart }) => {
      if (!validateToken(token)) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(createAuthError()) },
          ],
          isError: true,
        };
      }

      // 验证 cwd 路径
      const allowedPaths = getAllowedPaths();
      const cwdValidation = validatePathSandbox(cwd, allowedPaths);
      if (!cwdValidation.valid) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: cwdValidation.error, code: 400 }),
            },
          ],
          isError: true,
        };
      }

      try {
        await connectPm2();

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

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: `Process '${name}' started`,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 3. pm2_stop - 停止进程
  server.tool(
    "pm2_stop",
    "停止一个 PM2 进程",
    {
      token: z.string().describe("认证令牌"),
      name: z.string().describe("进程名称或 ID"),
    },
    async ({ token, name }) => {
      if (!validateToken(token)) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(createAuthError()) },
          ],
          isError: true,
        };
      }

      try {
        await connectPm2();

        await new Promise<void>((resolve, reject) => {
          pm2.stop(name, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: `Process '${name}' stopped`,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 4. pm2_restart - 重启进程
  server.tool(
    "pm2_restart",
    "重启一个 PM2 进程",
    {
      token: z.string().describe("认证令牌"),
      name: z.string().describe("进程名称或 ID"),
    },
    async ({ token, name }) => {
      if (!validateToken(token)) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(createAuthError()) },
          ],
          isError: true,
        };
      }

      try {
        await connectPm2();

        await new Promise<void>((resolve, reject) => {
          pm2.restart(name, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: `Process '${name}' restarted`,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 5. pm2_delete - 删除进程
  server.tool(
    "pm2_delete",
    "删除一个 PM2 进程",
    {
      token: z.string().describe("认证令牌"),
      name: z.string().describe("进程名称或 ID"),
    },
    async ({ token, name }) => {
      if (!validateToken(token)) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(createAuthError()) },
          ],
          isError: true,
        };
      }

      try {
        await connectPm2();

        await new Promise<void>((resolve, reject) => {
          pm2.delete(name, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: `Process '${name}' deleted`,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 6. pm2_logs - 获取日志
  server.tool(
    "pm2_logs",
    "获取 PM2 进程日志（最近 N 行）",
    {
      token: z.string().describe("认证令牌"),
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
    async ({ token, name, lines = 50, type = "all" }) => {
      if (!validateToken(token)) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(createAuthError()) },
          ],
          isError: true,
        };
      }

      try {
        // 使用 pm2 logs 命令获取日志（--nostream 模式）
        // PM2 API 不直接支持获取历史日志，需要通过命令行
        const logType = type === "all" ? "" : type === "out" ? "--out" : "--err";
        const cmd = `pm2 logs ${name} --nostream --lines ${lines} ${logType}`.trim();

        const { stdout, stderr } = await execAsync(cmd, {
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                logs: stdout.trim(),
                stderr: stderr.trim() || undefined,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
