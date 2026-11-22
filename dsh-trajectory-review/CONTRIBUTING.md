# 参与开发

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半个：订阅 `session/event`、批次审查、持久化、`/trajectory-review` 路由 |
| `core.js` | 纯函数：事件拆节点、组批、提示词、响应校验、评级与颜色 |
| `client.js` | 浏览器半个：注册 `conversation.view` 标签页并渲染 |
| `cordis.patch.yml` | bundle 的挂载行 |
| `locale/*.json` | 插件页的标题、描述、详情文档 |
| `test/` | 三组不依赖 DSH 的测试 |

`core.js` 不碰 Cordis、不做 I/O、不读时钟，所以离线回放和线上运行共用同一份实现——改行为先改它，再补测试。

## 本地开发

```sh
node --test test/core.test.mjs test/host.test.mjs test/client-smoke.test.mjs
```

改完代码后安装方式有两种：

- **链接安装**（开发时最省事）：DSH 插件页「添加插件」选这个目录；改完文件**重启应用**即可，不用重新打包。
- **tgz 安装**：`pnpm pack --pack-destination <dir>` 后安装，适合分发给别人。

⚠️ 两种方式都**必须重启 DSH 应用**才生效。只刷新页面不会重新加载宿主模块；替换已安装的包时，页面还可能丢掉这个插件的客户端入口。

调试客户端组合状态：

```sh
curl -s http://127.0.0.1:<port>/trajectory-review/diag
```

`graphEntry` 非空说明客户端入口已经进启动图，`clientPath` 是实际被服务的 bundle 路径。该端点里的 `resolve*` 两项是早期探针，依赖 Loader 的 `baseUrl`，可能显示错误，可以忽略。

## 加一个维度或改评级边界

1. 改 `core.js` 的 `DIMENSIONS`、`severityOf`、`validateResponse` 与 `REVIEW_SYSTEM_PROMPT`。
2. 同步改 `client.js` 的 `DIMENSION_LABELS` 与 `Findings`。
3. 在 `test/core.test.mjs` 里补一个能区分新旧边界的用例。

## 提交

- 一个改动一个分支，PR 描述里写清动机、做法和验证方式。
- 新增行为要有测试；只改文案可以只跑一遍测试。
- 版本号遵循 `0.x`：行为变化升次版本，修 bug 升修订号，同时更新 `CHANGELOG.md`。
