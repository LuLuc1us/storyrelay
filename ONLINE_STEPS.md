# 最快上线步骤

目标：先得到一个朋友能打开的公网 URL。AI 先用本地占位逻辑，等 Gemini 项目权限修好后再打开真实 AI。

## 1. 放到 GitHub

在 GitHub 新建一个仓库，例如：

```text
story-relay
```

然后在本地项目目录运行：

```bash
git init
git add .
git commit -m "Initial Story Relay alpha"
git branch -M main
git remote add origin 你的 GitHub 仓库地址
git push -u origin main
```

注意：`.env` 已经在 `.gitignore` 里，不会上传你的 key。

## 2. Render 创建服务

1. 打开 Render。
2. New，选择 Blueprint。
3. 连接刚才的 GitHub 仓库。
4. Render 会读取项目里的 `render.yaml`。
5. 创建服务。

默认环境变量是：

```text
NODE_ENV=production
AI_PROVIDER=local
```

## 3. 检查上线结果

部署完成后，Render 会给你一个 URL，例如：

```text
https://story-relay.onrender.com
```

打开：

```text
https://你的地址/api/health
```

看到：

```json
{
  "ok": true,
  "provider": "local"
}
```

就表示公网服务跑起来了。

## 4. 邀请朋友测试

你和朋友都打开 Render 给的公网 URL。

1. 你创建房间。
2. 把房间码发给朋友。
3. 朋友输入昵称和房间码加入。
4. 开始游戏。

不要把 `127.0.0.1` 发给朋友，那只是你自己电脑上的地址。
