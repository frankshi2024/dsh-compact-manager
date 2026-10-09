# dsh-compact-manager

面向 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）的分层压缩阈值管理器：让你按**全局 → 上下文长度档位 → 模型**三级覆盖自动压缩（compaction）的触发点，并在侧边栏里实时查看每个模型当前生效的阈值与策略。

> Layered compaction-threshold manager for DeepSeek Harness. Precedence: global → context-window tier → model. Configure it from a sidebar page and see every model's resolved threshold live.

---

## 为什么需要它

dsh 内置的 `@deepseek-ai/dsh-compaction-basic` 触发阈值是：

```
floor(min(W × 0.8, W − O − 65536))
```

其中 `W` 是模型的上下文窗口，`O` 是该路由请求的输出预留（模型配置里的 `maxTokens`）。当模型把输出上限报得很高时，`W − O − 65536` 这一项会把阈值压到很低。以 256K 窗口、128K 输出预留的 `kimi-coding/k3-256k` 为例：

| 项 | 取值 |
|---|---|
| `W × 0.8` | 209,715 |
| `W − O − 65536` | 262,144 − 131,072 − 65,536 = **65,536** |
| 内置阈值 | **65,536**（窗口的 25%） |

实测（同一 profile 的历史会话日志，7 次压缩）：压缩全部发生在 65,934–69,573 tokens，正好贴着 65,536。也就是说窗口用到四分之一就开始丢历史。

本插件把「什么时候压缩」变成可配置的三级策略，例如把 256K 档设成 `80% 或 W−32K`，阈值就从 65,536 变成 209,715。

> 它只改变**触发时机**。一次压缩保留多少逐字历史仍由内置后端决定（最近 `16% × (W − O)`）。区域选择、工具配对、摘要请求全部沿用官方实现。

---

## 三级策略与优先级

低 → 高，后者覆盖前者：

1. **全局** — 所有路由
2. **上下文长度档位** — 窗口长度落在档位值的 **±5%** 内即算同一档（例如档位 `256K = 262144`，则 `249,037 ~ 275,251` 都命中；多档重叠时取最近的一档）
3. **模型** — 精确的 `provider/model`

覆盖是**按策略项**进行的：上层只覆盖它写了的项，其余项继续从下层继承。所以可以让「全局开 80%」+「256K 档再加 W−32K」+「某个模型单独把比例改成 0.7」。

## 三个策略项

每个项都可以独立启用/停用，取值自定义；最终阈值取**已启用项的最小值再向下取整**：

| 项 | 公式 | 含义 |
|---|---|---|
| `ratio` | `W × v` | 上下文的比例（`0 < v < 1`） |
| `outputAware` | `W − O − v` | 扣掉该路由的输出预留 `O` 和固定值 `v` |
| `fixed` | `W − v` | 只扣固定值 |

没有启用任何项时，插件完全不介入，继续使用官方内置阈值。

---

## 安装

在 dsh 中让 agent 调用插件管理器，或使用 CLI：

```bash
# 从 npm（发布后）
dsh plugin --profile <profile> add dsh-compact-manager

# 从本地目录
dsh plugin --profile <profile> add link:/path/to/dsh-compact-manager
```

安装后侧边栏会出现「压缩策略」页面。通过 `plugin_manager` / `dsh plugin` 安装通常即时生效；若侧边栏没有出现，先刷新浏览器页面，再考虑重启 dsh。

> 本地 `link:` 安装不会自动安装被链接包自己的依赖，请在插件仓库里先执行一次 `pnpm install`（本插件需要 `zod`）。

## 侧边栏用法

打开侧边栏的「压缩策略」页：

- **模型下拉**：选择任意一个已知路由，右上角显示它的 `W`、`O`、**当前生效阈值**、官方内置阈值，以及各启用项的取值和决定项。
- **预设**：一键套用常见策略（含 `256K 档：80% 或 上下文−32K`）。
- **全局 / 档位 / 模型策略**：勾选并填写策略项；档位可增删，模型的 provider/model 可直接填写。
- **保存**：写回宿主并持久化；页面每 5 秒、窗口获得焦点时自动刷新，所以「实时看到阈值」不需要手动刷。

## 工作原理

- **宿主半**（`lib/index.js`）：把策略文档存进 `ctx.storageDomain`（域名 `compact_manager`，json 后端落在 `$DSH_HOME/storages/`），并通过两条自有 `/api/compact-manager/*` Fetch 路由给浏览器半读写。
- **阈值钩子**：Web 组合把压缩放在**每个 agent preset 的隔离作用域**里（`dsh-web-app` 停用了 profile 层的 `compaction-basic`，preset 内以 `isolate: { compaction: true }` 各挂一份），因此 profile 层的插件注入不到 `ctx.compaction`。本插件改为装饰 `@deepseek-ai/dsh-compaction-basic` 导出类的原型方法 `compactIfNeeded`：压力达到策略阈值就交回内置实现，否则直接返回「不压缩」。这样无论引擎实例在哪个作用域都能生效，`context-overflow` 恢复路径保持原样。
- **浏览器半**（`lib/client.js`）：手写的 `window.__ModuleLoader__.load(...)` 经典脚本。第三方插件无法向页面推送自定义事件（转发事件白名单是构建期固定的），因此采用「自行轮询 + 窗口聚焦刷新」。
- 引擎被替换或卸载时，宿主半边通过 Cordis effect 还原原型方法。

### HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/compact-manager/state[?refresh=1]` | 策略文档、模型表、预设、`revision` |
| `POST` | `/api/compact-manager/policy` | 提交 `{ document }`；校验失败返回 400 与 `issues` |

## 策略文档格式

```json
{
  "global": {
    "ratio": { "enabled": true, "value": 0.8 }
  },
  "tiers": [
    { "window": 262144, "policy": { "fixed": { "enabled": true, "value": 32768 } } }
  ],
  "models": [
    { "provider": "kimi-coding", "model": "k3-256k", "policy": { "ratio": { "enabled": true, "value": 0.7 } } }
  ]
}
```

## 开发

无构建步骤：宿主半是普通 ESM，浏览器半是手写的 ModuleLoader 包装。

```bash
npm test        # 纯函数策略测试（node --test）
```

```
lib/policy.js    纯策略词汇与解析（无依赖，可直接复用/测试）
lib/schema.js    storageDomain 记录 schema（zod）
lib/index.js     宿主插件
lib/client.js    浏览器插件
```

## 已知限制

- 只覆盖**压力触发**；上下文溢出恢复（`context-overflow`）仍走官方路径。
- 只改变触发阈值，不改变一次压缩的保留比例。
- 原型钩子作用于**所有会话**（策略本身就是进程级配置）。引擎模块被热替换后会重新导入并再次挂钩；若宿主改用不继承该原型的自定义压缩后端，钩子不会生效（宿主日志会给出告警）。
- 模型下拉来自 `ctx.llm.listProviders()` × `listModels()`；不公开目录的 provider（例如某些账号型 provider 未登录时）不会出现在列表里，可直接在「模型策略」里手填 provider/model。
- 页面数据来自宿主自有路由，因此不受 dsh 的 Remote 事件白名单限制，但也因此不会收到推送，只能轮询/聚焦刷新。
- 与任何同样装饰 `compactIfNeeded` 的插件（例如本仓库同作者早期的 `compaction-threshold-override`）功能重叠，建议只保留一个。

## License

MIT
