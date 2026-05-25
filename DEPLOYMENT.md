# 线上部署说明

当前版本可以作为“线上 Alpha”部署到支持 Node.js 长连接的平台，例如 Render、Railway、Fly.io 或一台自己的 VPS。

推荐先用 Render 做第一个公网版本，因为这个项目不需要构建步骤，直接启动 Node 服务即可。

## 环境变量

必须：

```text
PORT=3000
NODE_ENV=production
```

第一版公网试玩建议先不用真实 AI，直接设置：

```text
AI_PROVIDER=local
```

这样所有 AI 主持人功能会使用本地占位逻辑，部署最稳。

之后如果要启用 Gemini，再添加：

```text
AI_PROVIDER=gemini
GEMINI_API_KEY=你的 Gemini API key
GEMINI_MODEL=gemini-2.5-flash
```

如果要尝试 OpenRouter 免费模型：

```text
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=你的 OpenRouter API key
OPENROUTER_MODEL=openrouter/free
APP_PUBLIC_URL=https://你的 Render 地址
```

`openrouter/free` 会自动选择当前可用的免费模型。免费模型可能遇到上游限流；本项目会自动尝试备用免费模型，仍失败时回退到本地占位逻辑。

没有 `GEMINI_API_KEY`、`OPENROUTER_API_KEY` 或 `OPENAI_API_KEY` 时，游戏仍可运行，但 AI 主持人会使用本地占位逻辑。

如果要使用 OpenAI：

```text
AI_PROVIDER=openai
OPENAI_API_KEY=你的 OpenAI API key
OPENAI_MODEL=gpt-5.2
```

## Render 部署

### 方式 A：用 `render.yaml`

项目里已经包含 `render.yaml`。把代码推到 GitHub 后，在 Render 里选择 Blueprint，连接仓库即可。

Render 会读取：

```text
startCommand: node src/server.js
healthCheckPath: /api/health
```

默认会启用 OpenRouter 免费模型路由器，但需要你在 Render 的 Environment 里填写 `OPENROUTER_API_KEY`：

```text
AI_PROVIDER=openrouter
OPENROUTER_MODEL=openrouter/free
```

### 方式 B：手动创建 Web Service

1. 新建 Web Service。
2. 连接这个代码仓库。
3. Runtime 选择 Node。
4. Build Command 留空。
5. Start Command 设置为：

```bash
node src/server.js
```

6. 添加环境变量：

```text
NODE_ENV=production
AI_PROVIDER=local
```

Render 会自动提供 `PORT`，不需要手动写死。

## Railway 部署

1. New Project，选择从仓库部署。
2. Start Command 使用：

```bash
node src/server.js
```

3. Variables 中添加：

```text
NODE_ENV=production
AI_PROVIDER=local
```

## Docker 部署

```bash
docker build -t story-relay .
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e AI_PROVIDER=gemini \
  -e GEMINI_API_KEY=你的 Gemini API key \
  story-relay
```

## 健康检查

部署后访问：

```text
/api/health
```

返回里的 `ai: true` 表示已经识别到真实 AI key；`provider` 会显示当前使用 `gemini`、`openrouter`、`openai` 或 `local`。

线上可玩时应类似：

```json
{
  "ok": true,
  "ai": true,
  "provider": "gemini",
  "model": "gemini-2.5-flash"
}
```

如果要确认 API key 真的可以调用模型，访问：

```text
/api/ai-check
```

`ok: true` 表示模型返回成功。`ok: false` 且 `lastError` 有内容时，说明 key 被读取到了，但供应商拒绝了请求，例如项目权限、API 未启用或 key 限制问题。

## 分享给朋友

部署完成后，Render 或 Railway 会给你一个公网 URL，例如：

```text
https://story-relay.onrender.com
```

朋友打开这个地址，输入昵称和房间码，就能和你一起玩。不要分享本地地址 `127.0.0.1`，那个只在你自己的电脑上有效。

## 当前线上 Alpha 的限制

房间和故事仍然存在服务进程内存里：

- 服务重启后房间会消失
- 多实例部署时，不同实例之间房间不同步
- 适合小范围试玩，不适合正式大规模运营

下一阶段建议接 Supabase Postgres 或 Redis，把房间、玩家、故事段落持久化。
