/**
 * Sentinel MCP Server 入口
 *
 * 使用 HTTP + SSE 传输协议，提供远程 PM2 和 Shell 管理能力
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { loadConfig, getAllowedPaths } from "./auth.js";
import { registerPm2Tools, disconnectPm2 } from "./tools/pm2.js";
import { registerShellTools } from "./tools/shell.js";

// 加载配置（会验证环境变量）
const config = loadConfig();

/**
 * 创建新的 MCP Server 实例
 * 每个 SSE 连接需要独立的 server 实例
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "sentinel",
    version: "1.0.0",
  });

  // 注册所有工具
  registerPm2Tools(server);
  registerShellTools(server);

  return server;
}

// 创建 Express 应用
const app = express();
app.use(express.json());

/**
 * OAuth Protected Resource Metadata
 * 告诉客户端此资源不需要认证
 * RFC 9728: https://datatracker.ietf.org/doc/html/rfc9728
 */
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  // 动态获取请求的 host，确保与客户端连接的 URL 匹配
  const host = req.get("host") || `localhost:${config.port}`;
  const protocol = req.protocol || "http";
  res.json({
    resource: `${protocol}://${host}`,
    // 空的 authorization_servers 表示不需要认证
    authorization_servers: [],
  });
});

/**
 * OAuth 客户端注册端点
 * 返回一个假的成功注册响应，让客户端认为注册成功
 */
app.post("/register", (req, res) => {
  // 返回假的 client credentials，绕过 OAuth 流程
  const body = req.body || {};
  res.status(201).json({
    client_id: "sentinel-no-auth-client",
    client_secret: "not-required",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0, // 永不过期
    redirect_uris: body.redirect_uris || [],
    token_endpoint_auth_method: body.token_endpoint_auth_method || "client_secret_post",
    grant_types: body.grant_types || ["authorization_code", "refresh_token"],
    response_types: body.response_types || ["code"],
    scope: body.scope || "",
  });
});

/**
 * OAuth 授权服务器元数据
 */
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const host = req.get("host") || `localhost:${config.port}`;
  const baseUrl = `http://${host}`;
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  });
});

/**
 * OAuth 授权端点
 * 直接重定向回客户端，附带假的授权码
 */
app.get("/authorize", (req, res) => {
  const redirectUri = req.query.redirect_uri as string;
  const state = req.query.state as string;

  if (!redirectUri) {
    res.status(400).json({ error: "missing redirect_uri" });
    return;
  }

  // 生成假的授权码
  const code = "sentinel-auth-code-" + Date.now();
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (state) {
    redirectUrl.searchParams.set("state", state);
  }

  res.redirect(redirectUrl.toString());
});

/**
 * OAuth Token 端点
 * 返回假的 access token
 */
app.post("/token", (req, res) => {
  res.json({
    access_token: "sentinel-access-token-" + Date.now(),
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "sentinel-refresh-token",
    scope: "",
  });
});

// 存储活跃的 SSE 连接
const transports = new Map<string, SSEServerTransport>();

/**
 * SSE 连接端点
 * 客户端通过 GET /sse 建立 SSE 连接
 */
app.get("/sse", async (req, res) => {
  console.log("[SSE] New connection request");

  // 创建 SSE Transport（transport.start() 会自动设置正确的 SSE headers）
  const transport = new SSEServerTransport("/message", res);
  const sessionId = transport.sessionId;

  console.log(`[SSE] Session created: ${sessionId}`);

  // 存储 transport
  transports.set(sessionId, transport);

  // 连接关闭时清理
  res.on("close", () => {
    console.log(`[SSE] Session closed: ${sessionId}`);
    transports.delete(sessionId);
  });

  // 为每个连接创建独立的 MCP Server 实例
  const mcpServer = createMcpServer();

  // 添加错误处理
  transport.onerror = (error) => {
    console.error(`[SSE] Transport error for ${sessionId}:`, error);
  };

  transport.onmessage = (message) => {
    console.log(`[SSE] Message received for ${sessionId}:`, JSON.stringify(message).slice(0, 200));
  };

  // 连接 MCP Server
  try {
    await mcpServer.connect(transport);
    console.log(`[SSE] MCP connected for session: ${sessionId}`);
  } catch (error) {
    console.error(`[SSE] Connection error:`, error);
    transports.delete(sessionId);
  }
});

/**
 * 消息接收端点
 * 客户端通过 POST /message 发送 MCP 消息
 */
app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  console.log(`[Message] POST received for session: ${sessionId}`);
  console.log(`[Message] Body:`, JSON.stringify(req.body).slice(0, 300));

  if (!sessionId) {
    res.status(400).json({ error: "Missing sessionId" });
    return;
  }

  const transport = transports.get(sessionId);

  if (!transport) {
    console.log(`[Message] Session not found: ${sessionId}`);
    res.status(404).json({ error: "Session not found" });
    return;
  }

  try {
    // 传递已解析的 body，避免重复读取流
    await transport.handlePostMessage(req, res, req.body);
    console.log(`[Message] Handled successfully for: ${sessionId}`);
  } catch (error) {
    console.error(`[Message] Error handling message:`, error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * 健康检查端点
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "sentinel",
    version: "1.0.0",
    activeSessions: transports.size,
  });
});

/**
 * 启动服务器
 */
const server = app.listen(config.port, () => {
  const allowedPaths = getAllowedPaths();

  console.log(`
╔═══════════════════════════════════════════════════╗
║              Sentinel MCP Server                  ║
╠═══════════════════════════════════════════════════╣
║  Status:  Running                                 ║
║  Port:    ${config.port.toString().padEnd(41)}║
║  SSE:     http://localhost:${config.port}/sse${" ".repeat(Math.max(0, 23 - config.port.toString().length))}║
╚═══════════════════════════════════════════════════╝

Allowed paths:
${allowedPaths.map((p) => `  - ${p}`).join("\n")}

Available tools:
  - pm2_list      列出所有进程
  - pm2_start     创建并启动任务
  - pm2_stop      停止进程
  - pm2_restart   重启进程
  - pm2_delete    删除进程
  - pm2_logs      获取日志
  - shell_exec    执行受限命令
`);
});

/**
 * 优雅关闭
 */
function gracefulShutdown() {
  console.log("\n[Server] Shutting down...");

  // 关闭所有 SSE 连接
  for (const [sessionId] of transports) {
    console.log(`[Server] Closing session: ${sessionId}`);
  }
  transports.clear();

  // 断开 PM2
  disconnectPm2();

  // 关闭 HTTP 服务器
  server.close(() => {
    console.log("[Server] Goodbye!");
    process.exit(0);
  });

  // 强制退出超时
  setTimeout(() => {
    console.log("[Server] Force exit");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
