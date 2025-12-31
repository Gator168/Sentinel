# Sentinel

Remote server guardian - 通过 MCP 协议远程管理 PM2 进程和执行 Shell 命令。

## 简介

Sentinel 是一个轻量级 MCP Server，部署在远程服务器上，让 AI 编程助手（如 Claude Code）能够：

- 🚀 远程管理 PM2 进程（机器学习训练任务）
- 💻 执行受限的 Shell 命令查看服务器状态
- 🔐 通过 Token 认证防止未授权访问

## 架构

```
┌─────────────────────┐                              ┌─────────────────────┐
│      本地环境        │          HTTP + SSE          │   远程服务器 (内网)   │
│  ┌───────────────┐  │                              │  ┌───────────────┐  │
│  │  Claude Code  │  │ ─────── POST /message ──────▶│  │   Sentinel    │  │
│  │               │◀─┼─────── SSE /sse ────────────│  │   :9001       │  │
│  └───────────────┘  │                              │  └───────┬───────┘  │
└─────────────────────┘                              │          │          │
                                                     │    ┌─────┴─────┐    │
                                                     │    ▼           ▼    │
                                                     │  ┌───┐       ┌───┐  │
                                                     │  │PM2│       │SH │  │
                                                     │  └───┘       └───┘  │
                                                     └─────────────────────┘
```

## 安装

```bash
# 克隆项目
git clone https://github.com/your-repo/sentinel.git
cd sentinel

# 安装依赖
npm install

# 构建
npm run build
```

## 配置

创建 `.env` 文件或设置环境变量：

```bash
# 认证令牌（必填）
SENTINEL_TOKEN="your-secret-token"

# 允许访问的目录，逗号分隔（必填）
SENTINEL_ALLOWED_PATHS="/home/user/projects,/data/datasets"

# 服务端口（可选，默认 9001）
SENTINEL_PORT=9001
```

## 使用

### 启动服务

```bash
npm start
```

### 在 Claude Code 中配置

在 `~/.claude.json` 中添加：

```json
{
  "mcpServers": {
    "sentinel": {
      "type": "sse",
      "url": "http://your-server-ip:9001/sse"
    }
  }
}
```

## MCP Tools

### PM2 进程管理

| Tool | 描述 |
|------|------|
| `pm2_list` | 列出所有 PM2 进程 |
| `pm2_start` | 创建并启动任务（支持 `clear_logs` 参数清理旧日志） |
| `pm2_stop` | 停止进程 |
| `pm2_restart` | 重启进程 |
| `pm2_delete` | 删除进程 |
| `pm2_logs` | 获取进程日志 |
| `pm2_grep` | 在日志中搜索匹配内容（支持正则和上下文） |
| `pm2_health` | 检查进程健康状态 |
| `pm2_metrics` | 从日志中提取训练指标 |

### GPU 监控

| Tool | 描述 |
|------|------|
| `gpu_status` | 获取 GPU 状态（显存、利用率、进程信息） |

### Shell 命令

| Tool | 描述 |
|------|------|
| `shell_exec` | 执行受限 Shell 命令 |

支持的命令白名单：
```
ls, pwd, tree, cat, head, tail, df, free, nvidia-smi, ps, du, wc, top
```

> 注：`top` 命令仅允许非交互模式 `top -bn1`

## 安全特性

- **Token 认证**：每次调用需验证 Token
- **命令白名单**：仅允许预定义的安全命令
- **路径沙箱**：限制文件访问在指定目录内
- **注入防护**：禁止管道、重定向、命令替换等

## 开发

```bash
# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 运行
npm start
```

## License

Apache License 2.0
