# Baggage 传播检查工作台（OpenTelemetry Baggage Workbench）

定义服务调用图、每跳 header 变换与限制，后端模拟 W3C Baggage 与 Trace Context
传播，前端逐跳展示每个 baggage 成员的**保留 / 覆盖 / 丢弃及原因**。

## 运行

```bash
npm install
npm start          # http://localhost:3000
npm test           # node --test（38 个用例）
```

启动时会内置一个演示图 `demo-shop`（frontend → api → auth/billing → notify），
可直接运行模拟查看分叉、合流、重试、重命名、敏感键删除等效果。

## 概念与模型

### 图与配置

- **节点（服务）**：`config` 可含
  - `allowlist`：允许传播的键（`null` 表示不限制）
  - `renames`：`{旧键: 新键}` 重命名
  - `sensitive`：敏感键列表，命中即删除并脱敏
  - `set`：服务注入/覆盖的键值
  - `limits`：`maxTotalBytes`（默认 8192）、`maxMembers`（180）、`maxMemberBytes`（1024）
- **边（跳）**：`overrides` 覆盖目标服务配置；`attempts`（1–5）模拟重试。
- 图必须是 **DAG**（保存时校验，环返回 400）。

### 每跳处理管线（顺序固定，保证确定性）

1. **解析**：保留成员顺序与属性（`;k=v` / 裸标志）；百分号解码（UTF-8）。
   坏编码（`%ZZ`、截断的 `%A`）不报错——保留原始字节并打 `invalid-percent-encoding` 标记。
2. **重复键**：首次出现胜出，后续丢弃（`duplicate-key`）。键**大小写敏感**（`Foo`≠`foo`）。
3. **敏感键删除**：`sensitive-removed`，值立即替换为 `[REDACTED]`。
4. **allowlist 过滤**：`not-in-allowlist`。
5. **重命名**：目标键冲突时后者丢弃（`rename-collision`）。
6. **set 注入**：已存在则 `overwritten`（记录原值），否则 `added`；多键按字典序应用。
7. **限制**：单项超限丢弃（`member-too-large`）；成员数/总长度超限**从尾部截断**
   （`too-many-members` / `total-length-exceeded`）。

### Trace Context

- 合法 `traceparent`：保留 trace-id 与 flags，每跳生成新 span-id。
- 缺失/非法：开启新 trace（事件 `new-trace` 及原因）。
- `tracestate`：透传，超限（32 成员 / 512 字符）从尾部截断并记录诊断。
- 所有 id 由 `sha256(runSeed | 路径 | 边 | 尝试次数)` 派生——**无随机源**。

### 分叉与合流

- 分叉：每个分支获得父状态的**副本**，互不影响（路径 id 形如 `p1>e2`）。
- 合流：每个入边状态独立进入合流节点，逐路径继续传播——
  **header 绝不凭空合并**；运行结果中的 `joins` 明确列出被隔离的状态。
- 重试：每次尝试重发**相同输入**，baggage 输出逐字节一致，仅 span-id 不同。

### 配置 revision 与运行绑定

- 每次图保存产生单调递增的 `revision`；保存必须携带 `expectedRevision`，
  不匹配返回 **409**（乐观并发，并发编辑安全）。
- 运行绑定创建时的 revision，并把图快照存进运行记录——
  **旧运行永远不受新配置影响**。
- `runId = sha256(图快照 + 入口)`：相同输入与配置产生相同 runId，
  重复提交返回同一运行（幂等，`existing: true`）。

### 脱敏与导出

- 敏感键在删除跳即脱敏；运行结束后再做一次**全记录清扫**：凡是被删除过的
  敏感值，无论在入口 header、更早的跳、还是重命名后的副本中出现，
  一律替换为 `[REDACTED]`（宁多勿漏；trace/span id 与键名不受影响）。
- `GET /api/runs/:id/export` 下载的记录因此**不含任何被删除的敏感值**。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/graphs` | 建图（校验 DAG） |
| GET | `/api/graphs` / `/api/graphs/:id` | 列表 / 当前版本 |
| GET | `/api/graphs/:id/revisions/:rev` | 历史 revision 快照 |
| PUT | `/api/graphs/:id` | 保存新 revision（需 `expectedRevision`，冲突 409） |
| POST | `/api/graphs/:id/runs` | 运行模拟（绑定当前 revision，幂等） |
| GET | `/api/runs/:runId` | 运行详情（含逐跳记录） |
| GET | `/api/runs/:runId/export` | 导出已脱敏 JSON |
| GET | `/api/compare?a=runId:hopId&b=runId:hopId` | 比较任意两跳 |

错误格式统一为 `{ "error": { "code", "message" } }`。

## 前端

单页（无构建步骤）：图编辑器（JSON + SVG 拓扑图）、运行面板、逐跳结果
（成员状态着色：保留绿 / 覆盖黄 / 丢弃红 / 新增蓝，附原因与诊断）、
任意两跳比较、按运行导出。保存遇 409 会提示重新加载。

## 测试覆盖（`npm test`）

- **解析**：保序、属性、百分号编解码、坏编码、非法 UTF-8、Unicode、
  重复键、大小写、裸标志属性、畸形成员、序列化不动点
- **引擎**：三类限制截断、allowlist、重命名与冲突、敏感删除、set 覆盖、
  分叉隔离、合流不合并、重试一致性、traceparent 合法/非法、tracestate 截断、
  配置合并优先级、逐字节确定性
- **API**：revision 递增、并发编辑 409、环拒绝、运行幂等、旧运行不被新配置
  影响、导出脱敏（含重命名后删除的泄漏路径）、两跳比较、404

## 目录结构

```
server.js            入口
src/baggage.js       W3C baggage 解析/序列化（纯函数）
src/tracecontext.js  traceparent / tracestate
src/engine.js        每跳管线 + 图执行 + 脱敏清扫
src/store.js         图 revision、运行存储、比较、导出
src/app.js           Express 路由
src/seed.js          演示图
public/              前端（index.html / app.js / style.css）
test/                node:test 测试
```
