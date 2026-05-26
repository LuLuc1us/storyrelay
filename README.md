# 故事接龙工坊 / Story Relay

一个简单的在线多人故事接龙 MVP。玩家创建房间、通过房间码加入、投票选择故事开头，然后按顺序轮流写段落。系统会给每轮写作要求，并每 2 轮插入一段系统中间段，最后可生成结尾并导出 Markdown。

## 启动

```bash
node src/server.js
```

如果系统终端提示 `node: command not found`，运行：

```bash
./scripts/start-local.sh
```

打开：

```text
http://127.0.0.1:3000
```

如果本机有 npm，也可以运行：

```bash
npm start
```

## 启用真实 AI 主持人

复制 `.env.example` 里的变量到部署平台环境变量，或在本地 shell 中设置：

```bash
export AI_PROVIDER="gemini"
export GEMINI_API_KEY="你的 Gemini API key"
export GEMINI_MODEL="gemini-2.5-flash"
node src/server.js
```

设置 `GEMINI_API_KEY` 后，以下功能会优先调用 Gemini API：

- 生成 3 个故事开头
- 生成每轮写作要求
- AI 润色玩家段落
- 生成系统中间段
- 生成最终结尾

没有 key 时会自动回退到本地占位逻辑，游戏仍然可玩。

如果想切换到 OpenRouter，也可以设置：

```bash
export AI_PROVIDER="openrouter"
export OPENROUTER_API_KEY="你的 OpenRouter API key"
export OPENROUTER_MODEL="openrouter/free"
```

`openrouter/free` 会让 OpenRouter 自动选择当前可用的免费模型。免费模型偶尔会被上游限流；服务端会自动尝试备用免费模型，并在失败时回退到本地占位逻辑，保证游戏流程不中断。

或者切换到 OpenAI：

```bash
export AI_PROVIDER="openai"
export OPENAI_API_KEY="你的 OpenAI API key"
export OPENAI_MODEL="gpt-5.2"
```

## 已实现

- 创建房间和房间码
- 2–6 人加入房间
- 房主设置字数、轮数、时间限制占位、系统中间段、系统结尾
- 玩家在房间等待页投票选择故事风格，开局时采用票数最高的风格
- 生成 3 个随机开头
- 玩家投票，房主确定开头
- 玩家可在开头选择阶段投票重抽一批开头
- 按玩家顺序轮流写作
- 每轮生成关键词、情绪、转折要求
- 玩家可在写作阶段投票重抽本轮写作要求
- 当前玩家可在提交前使用 AI 润色建议，并自主选择是否采用
- 提交时校验字数、关键词，并拦截链接、代码块、明显说明文字和异常重复字符
- 每 2 个玩家段落自动插入系统中间段
- 游戏中可投票进入结尾，超过半数同意后收束故事
- 房间内显示事件日志，记录加入、设置、重抽、提交、结尾等关键动作
- 达到最大轮数后进入结尾阶段
- 生成系统结尾
- 刷新或重新打开网页后，首页会提示继续本机上次进入的房间，也可以忘记旧房间重新开始
- 完成页提供可分享阅读链接 `/story/房间码`
- 导出完整故事为 Markdown
- `/api/health` 健康检查接口，方便线上部署平台检测服务状态
- `/api/ai-check` AI 连接检查接口，用来确认 Gemini/OpenRouter/OpenAI key 真的可调用

## 文件结构

```text
src/server.js      房间、玩家、回合、同步和导出接口
src/aiHost.js      AI 主持人占位模块，可替换为真实模型调用
src/content.js     开头、关键词、情绪、转折、系统段落内容池
public/app.js      前端状态和页面渲染
public/styles.css  页面样式
public/index.html  网页入口
```

## 后续接入真实 AI

当前 AI 主持人是本地占位逻辑。后续可以替换 `src/aiHost.js` 里的这些位置：

- `createRequirement`：生成写作要求
- `polishSegment`：润色玩家提交前的段落
- `createBridgeSegment`：生成中间段
- `createEndingSegment`：生成结尾
- `createOpeningOptions`：生成 3 个开头

保留当前函数签名，前端和房间状态机无需改动。

## 线上部署

见 [DEPLOYMENT.md](/Users/lucius/Documents/Codex/2026-05-25/story-relay-1-2-3-ai/DEPLOYMENT.md)。

当前版本已经可以部署成单实例线上 Alpha。配置 Supabase 后，房间和故事会保存到数据库；如果没有配置 Supabase，则会临时保存在服务内存中，服务重启会丢失。

## Supabase 持久化

如果设置了 Supabase 环境变量，房间状态会自动保存到 `story_rooms` 表，服务重启后会恢复已有房间：

```bash
export SUPABASE_URL="你的 Supabase Project URL"
export SUPABASE_SERVICE_ROLE_KEY="你的 service_role key"
export SUPABASE_ROOMS_TABLE="story_rooms"
```

旧房间会自动整理：未开始的房间默认保留 12 小时，进行中的房间保留 72 小时，已完成故事保留 14 天。可以用这些环境变量调整：

```bash
ROOM_ABANDONED_LOBBY_HOURS=12
ROOM_ACTIVE_RETENTION_HOURS=72
ROOM_FINISHED_RETENTION_DAYS=14
```

先在 Supabase SQL Editor 运行 [supabase/schema.sql](/Users/lucius/Documents/Codex/2026-05-25/story-relay-1-2-3-ai/supabase/schema.sql)。不要把 `service_role key` 放到前端或 GitHub，它只应该放在 Render 的 Environment 里。
