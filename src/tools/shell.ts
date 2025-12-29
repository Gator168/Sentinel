/**
 * Shell 命令执行工具
 *
 * 提供受限的 Shell 命令执行能力
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  validateShellCommand,
  getAllowedCommands,
} from "../utils/validator.js";
import { validateToken, createAuthError, getAllowedPaths } from "../auth.js";

const execAsync = promisify(exec);

// 输入参数 Schema
const ShellExecInputSchema = z.object({
  token: z.string().describe("认证令牌"),
  command: z.string().describe("要执行的命令"),
  cwd: z
    .string()
    .optional()
    .describe("工作目录（可选，必须在允许的路径内）"),
});

type ShellExecInput = z.infer<typeof ShellExecInputSchema>;

/**
 * shell_exec 工具处理函数
 */
async function shellExecHandler(args: ShellExecInput) {
  const { token, command, cwd } = args;

  // 1. Token 认证
  if (!validateToken(token)) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(createAuthError()) }],
      isError: true,
    };
  }

  // 2. 获取允许的路径
  const allowedPaths = getAllowedPaths();

  // 3. 验证命令
  const validation = validateShellCommand(command, allowedPaths, cwd);
  if (!validation.valid) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: validation.error, code: 400 }),
        },
      ],
      isError: true,
    };
  }

  // 4. 执行命令
  try {
    const options: { cwd?: string; timeout: number; maxBuffer: number } = {
      timeout: 30000, // 30 秒超时
      maxBuffer: 1024 * 1024, // 1MB 输出限制
    };

    if (cwd) {
      options.cwd = cwd;
    }

    const { stdout, stderr } = await execAsync(command, options);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            stdout: stdout.trim(),
            stderr: stderr.trim() || undefined,
          }),
        },
      ],
    };
  } catch (error) {
    const err = error as Error & {
      code?: string;
      stdout?: string;
      stderr?: string;
    };
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: err.message,
            code: err.code,
            stdout: err.stdout?.trim(),
            stderr: err.stderr?.trim(),
          }),
        },
      ],
      isError: true,
    };
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
      token: z.string().describe("认证令牌"),
      command: z.string().describe("要执行的命令"),
      cwd: z
        .string()
        .optional()
        .describe("工作目录（可选，必须在允许的路径内）"),
    },
    shellExecHandler
  );
}
