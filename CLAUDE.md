# usage-panel 开发规范

依据 Claude Code 自带的插件开发文档（`plugin-authoring` 技能的 `reference.md` 与 `claude-code.d.ts`）。API 处于早期阶段，以本机生成的 `claude-code.d.ts` 为准。

## 结构
- `.claude-plugin/plugin.json`：清单（name / version / description）
- `hooks/hooks.json`：`{ "modules": ["./register.js"] }`，只写一个模块路径
- `hooks/register.js`：导出 `register(on, options)`，所有逻辑都在这里

## API 约定
- hook 签名统一为 `($, e, next)`；不处理的事件必须 `return next(e)`
- 运行环境没有 DOM、没有 Node：访问外部一律通过 `$`（`$.fs` `$.env` `$.store` `$.clock`）
- `turn.step` 是流式事件，必须写成 `async function*`，每个 chunk 原样 `yield`
- 元素一律从 `$.ui.resolve(e)` 取，不要假设界面；terminal 与 desktop 支持的元素不同
- 宽度用格子数（Box `width`）控制；不要用 █ ░ 等宽度不固定的字符做布局
- 渲染树校验失败时，引擎会改画自己的默认内容（这块显示会消失）；改完要在 CLI 和 Desktop 两边都看
- 绘制时不能写状态；写操作放在按钮回调或其他事件里
- 模块变量在热重载后会重置；需要保留的界面状态应放 `$.state` / `$.store`

## 数据
- 持久数据放 `$.store`（`~/.claude/plugins/store/`），每个会话只写自己的 `s:<sessionId>` key
- 账户只存 uuid 的 SHA-256 前 8 位，不存 uuid 原文；邮箱只存打码形式（`cfg.hints`），用作默认显示名
- `$.state` 的键必须在 `types/index.d.ts` 声明，且调用处的 ref 必须是字面量常量（不能经由辅助函数传入变量）
- 账户来源优先级：环境变量 `CLAUDE_CODE_ACCOUNT_UUID`（桌面版按会话注入）> `~/.claude.json`（CLI 的 /login）
- 桌面版切换账户只影响之后新建的会话

## 发版
- 版本号有两处，必须同时改：`.claude-plugin/plugin.json` 的 `version` 和 `hooks/register.js` 的 `VERSION`
- 更新检查读取 GitHub 默认分支上的 `plugin.json`（`UPDATE_URL`），所以推送到 main 即等于发布；未完成的改动不要推到 main
- 发现新版本时只提示，不自动更新（桌面版无法执行命令）

## 验证
- 改完先运行 `claude plugin validate .`
- 调试：`claude --plugin-dir . --debug`，被引擎拒绝的原因写在 debug 日志里
- 版本更新后用 `/plugin-types` 重新生成类型文件，不要手改 `claude-code.d.ts`

## Git
- commit message 不加 AI 署名、Co-Authored-By 或会话链接
