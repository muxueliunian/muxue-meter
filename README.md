# usage-panel

Claude Code mod：在提示框上方显示一行状态条，并提供详情面板。

```
⚡ 62.3 tok/s · 当前会话 $1.23 · 今日 $4.80 · 缓存命中 99.99%   详情
```

- 详情小窗口（点“详情”展开，或输入 `/usage-mod`；在提示框上方，不占侧边栏）：1 天 / 7 天 / 30 天，各模型占比，输入/输出/缓存读写 token（K / M / B 或精确值）
- 价值按 API 单价换算，价格表在 `hooks/register.js` 顶部的 `PRICES`，新模型发布后手动更新
- 数据保存在 `~/.claude/plugins/store/`，不在本仓库里；每个会话只写自己的 key，多会话并行不会互相覆盖
- 账户：用账户 uuid 的 SHA-256 前 8 位区分（桌面版取环境变量 `CLAUDE_CODE_ACCOUNT_UUID`，CLI 取 `~/.claude.json`），不保存 uuid 原文；为了能认出账户，会保存打码后的邮箱（如 `al…@example.com`），可改名覆盖
- 桌面版切换账户只对之后新建的会话生效

## 需求

Claude Code v2.1.287 或更高（mods 功能）。Desktop 应用的 Code 标签页和 CLI 都能显示；WSL 会话不支持。

## 试用

```bash
claude --plugin-dir .
```

校验：`claude plugin validate .`

## 更新

插件每 6 小时最多联网检查一次 GitHub 上的 `plugin.json`（所有会话共享结果），有新版本时状态条显示 `⬆ 新版本 vX.Y.Z`。只提示不自动更新，更新方法：

```bash
git pull
```

在插件目录执行后运行 `/reload-plugins`。不想联网检查时，把 `hooks/register.js` 顶部的 `UPDATE_URL` 设为空字符串。

## 口径

- 实际输入 = 缓存读 + 缓存写 + 未缓存输入，即模型实际读入的量
- 未缓存输入是 API 的 `input_tokens`：最后一个缓存断点之后的部分，Claude Code 下通常每次只有几个 token
- 输出包含思考（thinking）token

## 已知限制

- 只统计安装之后的用量
- TPS 是 `output_tokens ÷（首个内容分片到响应结束的时间）`，生成不足 0.2 秒或不足 20 token 的请求不计入
- 价格表里 Sonnet 5 的缓存读取价、Opus 4.x 旧版价格为推测值，请对照官方价格页核对
