# muxue-meter

[日本語](README.md) | [简体中文](README.zh-CN.md) | **English**

A Claude Code mod: one line of usage stats above the prompt, plus a details panel.

```
⚡ opus-5-5 97.7 tok/s · Session $2.29 · Today $2.10 · Cache hit 97.65%   Details
```

- Details panel (click "Details" or type `/meter`; it opens above the prompt, not in the sidebar): 1 / 7 / 30 days, filter by account, share by model, average TPS, daily value; tokens shown as K / M / B or exact values
- Quota estimate (in the details card): works back from how full the 5-hour and weekly limits are to how big they are, `quota ≈ API-equivalent value recorded ÷ the percent it used` (when recording started after the window opened, only the usage after the first reading and the points gained since count, and a figure appears once that is 5 points), shown as "Predicted 5h quota" and "Predicted Week quota"; worked out per account, one group per account. Below 5% used the figure is too coarse, so the last estimate is shown
- The status line and the details card adapt to the available width: everything when there is room, shorter forms when it gets narrow
- The UI comes in 10 languages; it follows the system language by default and can be switched from the top right of the details card
- Values are API-equivalent cost at API prices. The price table is `PRICES` at the top of `hooks/register.js` (checked against the official prices as of 2026-09) and is updated by hand when new models ship; Opus 5 fast mode is billed at 2×
- Data is stored in `~/.claude/plugins/store/`, not in this repository. Each session writes only its own key, so parallel sessions never overwrite each other
- Accounts are told apart by the first 8 characters of the SHA-256 of the account uuid (Desktop reads the `CLAUDE_CODE_ACCOUNT_UUID` environment variable, the CLI reads `~/.claude.json`); the uuid itself is never stored. So you can recognise an account, a masked email (e.g. `al…@example.com`) is stored; you can rename it
- On Desktop, switching accounts only affects sessions created afterwards

## Requirements

Claude Code's mods (function hooks) feature; developed and tested on v2.1.286. Works in the Desktop app's Code tab and in the CLI. WSL sessions are not supported.

Platforms: tested on real Windows hardware. macOS / Linux are covered by automated tests (with a simulated `$HOME`; CI runs on all three platforms) but **not yet tested on a real Mac**. If something breaks, please open an issue with a screenshot.

## Try it

```bash
git clone https://github.com/muxueliunian/muxue-meter.git
cd muxue-meter
claude --plugin-dir .
```

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

Tests live in `tests/`; every case runs in both the terminal and the desktop UI.

## Updates

The plugin checks `plugin.json` on GitHub at most once every 6 hours (the result is shared by all sessions). When a new version is out, the status line shows `⬆ New version vX.Y.Z`. It only notifies and never updates itself; run this in the plugin folder:

```bash
git pull
```

Then run `/reload-plugins`. To turn the check off, set `UPDATE_URL` at the top of `hooks/register.js` to an empty string.

## Definitions

- Actual input = cache read + cache write + uncached input, i.e. what the model actually read
- Uncached input is the API's `input_tokens`: the part after the last cache breakpoint, usually only a few tokens per request in Claude Code
- Output includes thinking tokens

## Known limitations

- Only usage after installation is counted
- The quota estimate counts only the CLI / app usage this plugin recorded (claude.ai on the web and the like are not counted); quotas are measured at API prices, so the estimate drifts when the model mix changes
- TPS is `output_tokens ÷ (time from the first content chunk to the end of the response)`; requests that generate for under 0.2 s or under 20 tokens are not counted
- Before 0.4.0 the plugin was called `usage-panel`; old data is migrated automatically on first start
