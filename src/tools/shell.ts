/**
 * Shell 命令执行工具
 *
 * 提供受限的 Shell 命令执行能力
 *
 * 注意：认证已在 HTTP 中间件层完成，工具层不再需要验证 token
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  validateShellCommand,
  getAllowedCommands,
} from "../utils/validator.js";
import { getAllowedPaths } from "../auth.js";
import { successResponse, errorResponse } from "../utils/formatter.js";

const execAsync = promisify(exec);

/**
 * shell_exec 工具处理函数
 */
async function shellExecHandler({ command, cwd }: { command: string; cwd?: string }) {
  // 获取允许的路径
  const allowedPaths = getAllowedPaths();

  // 验证命令
  const validation = validateShellCommand(command, allowedPaths, cwd);
  if (!validation.valid) {
    const allowedCmds = getAllowedCommands().join(", ");
    return errorResponse(`${validation.error}\n\n允许的命令: ${allowedCmds}`);
  }

  // 执行命令
  try {
    const options: { cwd?: string; timeout: number; maxBuffer: number } = {
      timeout: 30000, // 30 秒超时
      maxBuffer: 1024 * 1024, // 1MB 输出限制
    };

    if (cwd) {
      options.cwd = cwd;
    }

    const { stdout, stderr } = await execAsync(command, options);

    // 构建输出
    const parts: string[] = [`$ ${command}`, ""];

    if (stdout.trim()) {
      parts.push(stdout.trim());
    }

    if (stderr.trim()) {
      parts.push("", "[stderr]", stderr.trim());
    }

    if (!stdout.trim() && !stderr.trim()) {
      parts.push("(命令执行成功，无输出)");
    }

    return successResponse(parts.join("\n"));
  } catch (error) {
    const err = error as Error & {
      code?: string;
      stdout?: string;
      stderr?: string;
    };

    const parts: string[] = [`$ ${command}`, "", `命令执行失败: ${err.message}`];

    if (err.stdout?.trim()) {
      parts.push("", "[stdout]", err.stdout.trim());
    }

    if (err.stderr?.trim()) {
      parts.push("", "[stderr]", err.stderr.trim());
    }

    return errorResponse(parts.join("\n"));
  }
}

/**
 * 注册 Shell 工具到 MCP Server
 */
export function registerShellTools(server: McpServer): void {
  const allowedCmds = getAllowedCommands().join(", ");

  server.tool(
    "shell_exec",
    `执行受限的 Shell 命令。

允许的命令：${allowedCmds}

安全限制：
- 禁止管道 |、重定向 > <、命令连接 && || ;
- 禁止命令替换 $() 或反引号
- 路径必须在 SENTINEL_ALLOWED_PATHS 范围内`,
    {
      command: z.string().describe("要执行的命令"),
      cwd: z
        .string()
        .optional()
        .describe("工作目录（可选，必须在允许的路径内）"),
    },
    shellExecHandler
  );
}
