# Baggage 传播检查工作台

OpenTelemetry / [W3C Baggage](https://www.w3.org/TR/baggage/) 与
[Trace Context](https://www.w3.org/TR/trace-context/) 传播模拟工作台。
用户定义服务调用图、每跳 header 变换与限制，后端逐跳模拟传播，前端显示每个成员的
**保留 / 覆盖 / 丢弃原因**，并支持任意两跳对比与脱敏导出。

零依赖：仅使用 Node.js 内置模块（`node:http` / `node:crypto` /`node:test`）。

## 运行

```bash
npm start            # http://localhost:8080 （PORT 环境变量可改端口）
npm test             # node:test 全部用例
```

打开页面后会自动加载并运行内置示例（checkout 流水线，含重试、白名单、重命名、
敏感键删除、isolate/union 合流、超限截断）。

## 能力对照

| 需求 | 实现 |
| --- | --- |
| 保留成员顺序 / 属性 / 百分号编码 | `lib/baggage.js` 严格文法解析，属性按序保留；原编码文本（含十六进制大小写）可还原时原样输出，值被改动时按 RFC3986 规范化重编码 |
| 总长度 / 成员数 / 单项限制 | 服务级 `limits.maxTotalBytes`(UTF-8 字节) / `maxMembers` / `maxMemberBytes`，超限原因分别为 `total-size-limit` / `member-count-limit` / `member-size-limit`，0 = 不限 |
| 服务 allowlist / 重命名 / 敏感键删除 | 按 敏感删除 → 白名单 → 有序重命名（支持链式与碰撞报告）→ 限制 顺序执行；`ignoreCase` 可切换大小写不敏感匹配；键本身大小写敏感 |
| 每跳 header 变换 | 边级 `setMembers` / `addMembers`（同键覆盖）/ `deleteKeys` / `renameKeys`（链式）/ `dropAll` |
| 分叉隔离 | 出边逐帧深拷贝；一个分支的增删改不影响另一分支（`branchPath` 含 `eN` 边号区分） |
| 合流不能凭空合并 header | 默认 `merge: 'isolate'`：各路到达独立穿过，不产生合并；显式 `merge: 'union'` 才合并，重复键先到者得，后到者报 `merge-conflict`；跨 trace 合流报 `trace-mismatch-merge` |
| 重试 | 边级 `retries` 生成额外尝试跳，行李结果逐位一致；`retrySpan: new / reuse` 控制 span id，并标记 `reusedSpan` |
| 配置并发编辑 | `PUT /api/configs/:id` 必须带 `expectedRevision`，过期写入返回 **409 + 当前 revision**；每次接受写入产生新 revision，旧 revision 永久可读、可运行 |
| 旧运行不覆盖新图 | 运行记录 pin 住 revision/fingerprint；对旧 revision 的运行独立留存，列表中标记 `stale` |
| 确定性 | 引擎是 `(input, config)` 的纯函数：无随机数、无时钟；span/trace id 由 SHA-256 派生；相同输入返回 `resultHash` 相同的同一运行记录 |
| 两跳比较 | 右侧“两跳对比”：逐键 `=`/`≠`/`+`/`−`、字节差、成员数差、trace 是否相同 |
| 导出不含被删除敏感值 | `GET /api/runs/:id?export=redacted`：**所有** baggage 值（含未删除、以及任何跳数上曾经存在的值）一律移除，只保留 key/字节长度/属性长度/丢弃原因；原始 header 串与事件中的 `raw` 片段均不输出 |

### 丢弃原因一览

解析层：`bad-key`、`bad-value-charset`、`bad-percent-encoding`、`bad-property`、
`empty-member`、`duplicate-key`；trace：`invalid-traceparent`、`invalid-tracestate`、
`tracestate-member-limit`、`tracestate-total-limit`、`tracestate-duplicate-key`。
策略/变换层：`sensitive-key-removed`、`not-in-allowlist`、`rename-collision`、
`edge-deleted`、`overwritten`、`replaced`、`drop-all`、`member-size-limit`、
`member-count-limit`、`total-size-limit`、`merge-conflict`、
`tracestate-merge-conflict`、`trace-mismatch-merge`。

## 配置示例

```json
{
  "name": "my graph",
  "services": [
    {
      "id": "gateway",
      "sensitiveKeys": ["session-id"],
      "allowlist": ["user-id", "tenant"],
      "rename": [{ "from": "user-id", to": "uid" }],
      "ignoreCase": false,
      "limits": { "maxTotalBytes": 8192, "maxMembers": 100, "maxMemberBytes": 4096 }
    },
    { "id": "billing", "merge": "union" }
  ],
  "edges": [
    {
      "from": "gateway", "to": "billing",
      "retries": 1,
      "retrySpan": "new",
      "transform": {
        "setMembers": null,
        "addMembers": [{ "key": "region", "value": "cn-north" }],
        "deleteKeys": ["debug"],
        "renameKeys": [{ "from": "uid", "to": "user-id" }],
        "dropAll": false
      }
    }
  ]
}
```

运行输入支持单入口字段（`startService` / `baggageHeaders` / `traceparent` /
`tracestate`），或 `roots: [{service, baggageHeaders, traceparent, tracestate}]`
多入口数组，用于在一次运行中制造跨 trace 合流。

## HTTP API

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET /api/configs` | 配置列表 |
| `GET /api/configs/:id?revision=N` | 读取（默认 head） |
| `GET /api/configs/:id/revisions` | revision 历史 |
| `PUT /api/configs/:id` | body `{config, expectedRevision}`；新建传 0，冲突返回 409 |
| `POST /api/runs` | body `{configId, revision?, input, labels?}`；相同输入+revision 复用同一记录（200 vs 201） |
| `GET /api/runs` | 运行列表（含 stale 标记） |
| `GET /api/runs/:id` | 完整运行（供页面展示，含值） |
| `GET /api/runs/:id?export=redacted` | 脱敏导出（无任何 baggage 值） |
| `POST /api/sample/run` | 一键运行内置示例 |

## 目录

```
lib/
  encoding.js      UTF-8 字节长度、百分号编解码（坏转义/坏 UTF-8 显式失败）
  baggage.js       W3C baggage 解析/序列化
  tracecontext.js  traceparent 校验与 tracestate 32成员/512字节限制
  hash.js          规范化 JSON、SHA-256、确定性 trace/span id
  config.js        配置校验（含环检测、union 扇入校验）与默认值
  simulate.js      纯函数传播引擎（分叉/合流/重试/限制）
  store.js         revision + CAS 存储、运行去重
  export.js        脱敏导出
server/            HTTP API 与内置示例
public/            原生 JS 前端（调用图 / 逐跳审计 / 两跳对比 / 导出）
test/              node:test：解析、引擎、存储并发、HTTP 集成
```

## 安全说明

完整运行接口（`GET /api/runs/:id`）包含值，用于页面审计；任何外发/存档场景应使用
`?export=redacted`。脱敏是结构性的：导出路径根本不读取成员值，因此被标记为
sensitive 而删除的值不会从原始 header 串、事件 raw 文本或更早的跳记录中泄露。
