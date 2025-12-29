/**
 * Token 认证模块
 *
 * 职责：
 * 1. 从环境变量加载配置
 * 2. 验证 Token
 * 3. 获取配置信息
 */

import "dotenv/config";

export interface AuthConfig {
  token: string;
  allowedPaths: string[];
  port: number;
}

let config: AuthConfig | null = null;

/**
 * 加载配置（延迟初始化，单例模式）
 */
export function loadConfig(): AuthConfig {
  if (config) {
    return config;
  }

  const token = process.env.SENTINEL_TOKEN;
  const allowedPathsStr = process.env.SENTINEL_ALLOWED_PATHS;
  const port = parseInt(process.env.SENTINEL_PORT || "9001", 10);

  if (!token) {
    throw new Error("SENTINEL_TOKEN environment variable is required");
  }

  if (!allowedPathsStr) {
    throw new Error("SENTINEL_ALLOWED_PATHS environment variable is required");
  }

  const allowedPaths = allowedPathsStr
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (allowedPaths.length === 0) {
    throw new Error("SENTINEL_ALLOWED_PATHS must contain at least one path");
  }

  config = { token, allowedPaths, port };
  return config;
}

/**
 * 验证 Token（使用时间安全的比较，防止时序攻击）
 */
export function validateToken(providedToken: string): boolean {
  const { token } = loadConfig();

  // 长度不同则失败
  if (providedToken.length !== token.length) {
    return false;
  }

  // 时间安全的字符串比较
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= providedToken.charCodeAt(i) ^ token.charCodeAt(i);
  }

  return result === 0;
}

/**
 * 创建认证错误响应
 */
export function createAuthError(): { error: string; code: number } {
  return { error: "Unauthorized", code: 401 };
}

/**
 * 获取允许的路径列表
 */
export function getAllowedPaths(): string[] {
  return loadConfig().allowedPaths;
}

/**
 * 获取服务端口
 */
export function getPort(): number {
  return loadConfig().port;
}
