# muxue-meter

[日本語](README.md) | **简体中文** | [English](README.en.md)

Claude Code mod：在提示框上方显示一行用量状态条，并提供详情面板。

```
⚡ opus-5-5 97.7 tok/s · 当前会话 $2.29 · 今日 $2.10 · 缓存命中 97.65%   收起  简略  详细
```

- 右上角「收起 / 简略 / 详细」切换显示：收起 只留这三个按钮，简略 显示一行状态条，详细 在状态条下展开详情卡
- 详情小窗口（点“详细”展开，或输入 `/meter`；在提示框上方，不占侧边栏）：1 天 / 7 天 / 30 天，按账户筛选，各模型占比、平均 TPS、每日价值，token 用 K / M / B 或精确值显示
- 额度估算（详情卡内）：用 5 小时 / 每周限额的已用百分比反推额度大小，`额度 ≈ 窗口第一次读数之后记录到的 API 等价价值 ÷ 之后已用百分比的增量`（增量满 5 个百分点才给出），显示为「预测5小时额度」「预测每周额度」；按账户分别计算，多账户各列一组。增量不足时显示上次的估算。CLI 会话的 `~/.claude.json` 与实际使用的账户不一致时，按每周重置时间识别，记到正确的账户下
- 状态条和详情卡按可用宽度自适应：宽度够时完整显示，窄时自动收缩
- 界面支持 10 种语言，默认跟随系统，也可以在详情卡右上角手动切换
- 价值按 API 单价换算，价格表在 `hooks/register.js` 顶部的 `PRICES`（已对照 2026-09 官方价格），新模型发布后手动更新；Opus 5 系列的 fast 模式按 2 倍计价
- 数据保存在 `~/.claude/plugins/store/`，不在本仓库里；每个会话只写自己的 key，多会话并行不会互相覆盖
- 账户：用账户 uuid 的 SHA-256 前 8 位区分（桌面版取环境变量 `CLAUDE_CODE_ACCOUNT_UUID`，CLI 取 `~/.claude.json`），不保存 uuid 原文；为了能认出账户，会保存打码后的邮箱（如 `al…@example.com`），可改名覆盖
- 桌面版切换账户只对之后新建的会话生效

## 需求

Claude Code 的 mods（function hooks）功能，在 v2.1.286 上开发和测试。Desktop 应用的 Code 标签页和 CLI 都能显示；WSL 会话不支持。

平台：Windows 实机测试；macOS / Linux 由自动测试覆盖（模拟 `$HOME` 路径，CI 在三个平台上跑），**尚未在 Mac 实机上测试**，遇到问题欢迎提 issue 并附截图。

## 试用

```bash
git clone https://github.com/muxueliunian/muxue-meter.git
cd muxue-meter
claude --plugin-dir .
```

## 开发

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

测试在 `tests/`，每个用例同时跑 terminal 和 desktop 两种界面。

## 更新

插件每 6 小时最多联网检查一次 GitHub 上的 `plugin.json`（所有会话共享结果），有新版本时状态条显示 `⬆ 新版本 vX.Y.Z`。只提示不自动更新，在插件目录执行：

```bash
git pull
```

然后运行 `/reload-plugins`。不想联网检查时，把 `hooks/register.js` 顶部的 `UPDATE_URL` 设为空字符串。

## 口径

- 实际输入 = 缓存读 + 缓存写 + 未缓存输入，即模型实际读入的量
- 未缓存输入是 API 的 `input_tokens`：最后一个缓存断点之后的部分，Claude Code 下通常每次只有几个 token
- 输出包含思考（thinking）token

## 已知限制

- 只统计安装之后的用量
- 额度估算只统计本插件记录的 CLI / App 用量（claude.ai 网页等不计入）；额度按 API 价格换算，模型比例变化时估算会漂移
- TPS 是 `output_tokens ÷（首个内容分片到响应结束的时间）`，生成不足 0.2 秒或不足 20 token 的请求不计入
- 0.4.0 之前插件名为 `usage-panel`，首次启动时会自动迁移旧数据
