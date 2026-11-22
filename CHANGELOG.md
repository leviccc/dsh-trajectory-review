# 版本记录

## 0.1.6

- 审查规则可配置：`reviewPrompt` 直接给规则文本，`reviewPromptFile` 指向规则文件（优先，相对路径按 `$DSH_HOME` 解析）。
- 内置规则拆成 `REVIEW_RULES` 与固定的 `REVIEW_OUTPUT_CONTRACT`：自定义规则只管判断口径，JSON 协议始终由插件追加，避免改坏解析。
- 自定义规则缺维度键、规则文件读不到都会在启动日志里警告并退回内置规则。
- `/trajectory-review/diag` 增加 `reviewPrompt.source` 与字符数，便于确认当前用的是哪份规则。

## 0.1.5

- 补充安装说明：替换已安装插件后必须重启 DSH，只刷新页面不会加载新代码。
- 新增只读的 `/trajectory-review/diag`，用于查看客户端入口是否进入启动图。
- `docs/` 增加两张截图，插件详情页引用就地展开的截图。

## 0.1.4

- 增加组合状态诊断端点（`/trajectory-review/diag`）。
- 排查并确认：替换已安装的包时，客户端模块表会丢掉这一行，且宿主模块按 URL 缓存，必须重启。

## 0.1.3

- `exports` 补 `"./package.json"`：客户端组合器在没有 Loader internals 时会 `resolve('<pkg>/package.json')`，缺这个子路径会拿不到 manifest。

## 0.1.2

- 详情从页面底部改为**就地展开**：点哪个节点，详情卡就插在那一行下面，其余节点顺延；支持 Esc 和「收起」。
- 不再有底部固定的「步骤详情」面板。

## 0.1.1

- 修复「审查中断」：`maxTokens` 4096 → 8192；提示词要求短输出；被 `max-tokens` 截断的批次自动对半拆开重试，不再计入失败预算。

## 0.1.0

- 首个可用版本：`conversation.view` 标签页、四维评级、形状与颜色图例、批次审查、响应校验、按会话持久化。
