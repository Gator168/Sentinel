/**
 * Shell 命令安全校验模块
 *
 * 职责：
 * 1. 命令白名单验证
 * 2. 危险字符检测（管道、重定向、命令连接、命令替换）
 * 3. 路径沙箱验证
 */

import path from "node:path";

// 允许的命令白名单
const ALLOWED_COMMANDS = new Set([
  "ls",
  "pwd",
  "tree",
  "cat",
  "head",
  "tail",
  "df",
  "free",
  "nvidia-smi",
  "ps",
]);

// 危险字符/模式正则
const DANGEROUS_PATTERNS: RegExp[] = [
  /\|/, // 管道
  />/, // 输出重定向
  /</, // 输入重定向
  /&&/, // AND 连接
  /\|\|/, // OR 连接
  /;/, // 命令分隔
  /\$\(/, // 命令替换 $()
  /`/, // 命令替换 反引号
  /\$\{/, // 变量展开
];

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * 验证命令是否在白名单内
 */
export function validateCommand(command: string): ValidationResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { valid: false, error: "Empty command" };
  }

  // 提取命令名（第一个空格之前的部分）
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];

  // 提取基本命令名（处理路径情况如 /usr/bin/ls）
  const baseName = path.basename(cmd);

  if (!ALLOWED_COMMANDS.has(baseName)) {
    return {
      valid: false,
      error: `Command '${baseName}' is not in whitelist. Allowed: ${[...ALLOWED_COMMANDS].join(", ")}`,
    };
  }

  return { valid: true };
}

/**
 * 检测危险字符
 */
export function detectDangerousPatterns(input: string): ValidationResult {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(input)) {
      return {
        valid: false,
        error: `Dangerous pattern detected: ${pattern.source}`,
      };
    }
  }
  return { valid: true };
}

/**
 * 验证路径是否在允许的沙箱内
 * @param targetPath 目标路径
 * @param allowedPaths 允许的路径列表
 * @param basePath 基础路径（用于解析相对路径）
 */
export function validatePathSandbox(
  targetPath: string,
  allowedPaths: string[],
  basePath?: string
): ValidationResult {
  // 解析为绝对路径
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(basePath || process.cwd(), targetPath);

  // 规范化路径（处理 .. 等）
  const normalizedPath = path.normalize(resolvedPath);

  // 检查是否在允许的路径内
  const isAllowed = allowedPaths.some((allowed) => {
    const resolvedAllowed = path.resolve(allowed);
    const normalizedAllowed = path.normalize(resolvedAllowed);

    // 路径完全匹配或者是其子目录
    return (
      normalizedPath === normalizedAllowed ||
      normalizedPath.startsWith(normalizedAllowed + path.sep)
    );
  });

  if (!isAllowed) {
    return {
      valid: false,
      error: `Path '${normalizedPath}' is not within allowed paths: ${allowedPaths.join(", ")}`,
    };
  }

  return { valid: true };
}

/**
 * 从命令参数中提取可能的路径
 * 跳过以 - 开头的选项参数
 */
export function extractPathsFromArgs(args: string[]): string[] {
  const paths: string[] = [];

  for (const arg of args) {
    // 跳过选项参数
    if (arg.startsWith("-")) {
      continue;
    }
    // 可能是路径（包含 / 或 . 开头）
    if (arg.startsWith("/") || arg.startsWith(".") || arg.includes("/")) {
      paths.push(arg);
    }
  }

  return paths;
}

/**
 * 完整的 Shell 命令验证
 * @param command 完整命令字符串
 * @param allowedPaths 允许的路径列表
 * @param cwd 工作目录（可选）
 */
export function validateShellCommand(
  command: string,
  allowedPaths: string[],
  cwd?: string
): ValidationResult {
  // 1. 验证命令白名单
  const cmdResult = validateCommand(command);
  if (!cmdResult.valid) {
    return cmdResult;
  }

  // 2. 检测危险字符
  const dangerResult = detectDangerousPatterns(command);
  if (!dangerResult.valid) {
    return dangerResult;
  }

  // 3. 如果有 cwd，验证 cwd 是否在沙箱内
  if (cwd) {
    const cwdResult = validatePathSandbox(cwd, allowedPaths);
    if (!cwdResult.valid) {
      return cwdResult;
    }
  }

  // 4. 提取并验证命令中的路径参数
  const parts = command.trim().split(/\s+/);
  const args = parts.slice(1);
  const paths = extractPathsFromArgs(args);

  for (const p of paths) {
    // 使用 cwd 作为基础路径解析相对路径
    const pathResult = validatePathSandbox(p, allowedPaths, cwd);
    if (!pathResult.valid) {
      return pathResult;
    }
  }

  return { valid: true };
}

/**
 * 获取允许的命令列表
 */
export function getAllowedCommands(): string[] {
  return [...ALLOWED_COMMANDS];
}
