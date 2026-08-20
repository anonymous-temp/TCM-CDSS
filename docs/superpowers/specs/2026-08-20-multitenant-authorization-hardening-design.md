# 固定 Token 多租户授权与隔离加固设计

## 1. 状态与背景

- 需求输入：甲方《TCM-CDSS 多租户实现计划》。该文档按旧基线 `main@e3fb57b6` 编写。
- 当前基线：`main@028b78ab`。
- 已确认范围：同一份既定 CDSS API Token 可以访问多个预先授权的客户；未知客户必须拒绝。
- 明确约束：既定客户接口 Token 不轮换、不写入源码、文档或日志。
- 设计原则：复用当前客户上下文、库存隔离、签名、快照和限流实现，只补真实缺口，不另建租户平台。

## 2. 当前能力与真实缺口

当前代码已经具备：

- `x-cdss-customer-id` 与签名客户 Cookie；两者冲突时返回 `409 customer_context_mismatch`。
- 12 条临床路由、库存路由、M04、HIS、病例签名和快照均绑定 `customerId`。
- 每客户独立的库存文件、缓存和分片路径。
- 模型限流按认证身份和客户分桶。
- v2 快照 AAD、旧库存迁移脚本和对外接口说明。

真实缺口是：

1. 认证成功后，任意格式合法的 `customerId` 当前都会被接受，没有 Token 到客户白名单的授权校验。
2. 库存文件未持久化 `schemaVersion/customerId`，读取时无法做文件归属二次校验。
3. 客户缓存没有容量上限；同客户并发整批导入、分片读改写和相同 PID 临时文件存在覆盖窗口。
4. strict health 尚不校验多租户授权配置。
5. 现有路由传播测试使用人工清单，但没有强制所有新增 API 路由必须被归类。

## 3. 方案比较

### 方案 A：单 Token + 静态客户白名单（选定）

部署环境配置一个非敏感 `clientId` 和多个允许的 `customerId`。所有业务代码从共享授权模块取得可信上下文。该方案与当前单实例、文件库存和固定 Token 交付方式一致，改动最小，能够立即阻止任意客户 ID 越权。

### 方案 B：JIT 自动注册与动态注册表（暂缓）

首次库存 POST 自动创建租户，需要注册表、状态机、幂等、抢注处理、恢复任务、配额和告警。它适用于开放式 SaaS 开户，但甲方当前目标是已知客户的独立药品库，首期投入和运维风险明显过高。

### 方案 C：每客户独立 Token（拒绝）

隔离直观，但违反所有甲方接口继续使用既定固定 Token 的交付约束，也会增加 HIS 对接和凭证轮换成本。

## 4. 配置契约

新增：

```text
CDSS_API_CLIENT_ID=his-integrator
CDSS_API_CUSTOMER_IDS=hospital-A,hospital-B
```

规则：

- `CDSS_API_CLIENT_ID` 为 3–64 位 ASCII 字母、数字、下划线或连字符，只用于审计和限流身份，不是秘密。
- `CDSS_API_CUSTOMER_IDS` 为英文逗号分隔列表；每项沿用现行 `customerId` 合同：6–64 位、大小写敏感、仅字母/数字/下划线/连字符。
- 不在本轮把客户 ID 强制改成小写，避免破坏已经交付的 `hospital-A` 一类标识。
- 空项、非法项、重复项、超过 1000 项均视为配置错误。
- `CDSS_DEFAULT_CUSTOMER_ID` 若存在，必须同时出现在授权白名单内；它仍只用于迁移期兼容。
- 生产环境或严格健康检查下，授权配置缺失/非法时 fail closed；不得退化成“任意合法 customerId 均可访问”。
- 客户 ID 列表不出现在健康响应、错误响应或日志中。

## 5. 共享授权边界

在现有 `customer-context.ts` 基础上增加一个小型、纯配置驱动的授权模块。可信上下文扩展为：

```ts
type CustomerContext = Readonly<{
  clientId: string;
  customerId: string;
  customerHash: string;
  source: "header" | "cookie" | "default";
}>;
```

请求顺序：

1. `proxy` 继续负责固定 Token 或 UI Cookie 认证。
2. 路由调用 `requireCustomerContext`。
3. 共享模块验证请求头/客户 Cookie/默认客户的一致性与格式。
4. 共享授权模块校验 `customerId` 是否属于 `CDSS_API_CUSTOMER_IDS`。
5. 成功后返回带 `clientId` 的可信上下文；业务代码不再读取授权配置。

错误合同：

| 场景 | HTTP | code |
|---|---:|---|
| 缺少客户上下文 | 400 | `customer_id_required` |
| 客户 ID 格式非法 | 400 | `invalid_customer_id` |
| 请求头、Cookie 或病例客户冲突 | 409 | `customer_context_mismatch` |
| 客户不存在或未获授权 | 403 | `customer_forbidden` |
| 生产授权配置缺失或非法 | 503 | `customer_authorization_not_configured` |

不存在和未授权客户使用同一个 `403 customer_forbidden`，不提供枚举信号。`/api/auth/access` 在签发客户 Cookie 前执行相同授权检查，不能仅凭格式合法创建任意客户会话。

## 6. 库存文件与并发加固

库存文件升级为：

```json
{
  "schemaVersion": "tcm-cdss-drug-inventory-v2",
  "customerId": "hospital-A",
  "inventoryVersion": "...",
  "items": []
}
```

行为：

- 新写入始终使用 v2，并把 `schemaVersion/customerId` 纳入库存版本摘要。
- 读取 v2 时必须核对文件内 `customerId` 与请求客户一致；不一致只隔离当前客户库存并记录客户哈希，不影响其他客户。
- 旧无客户字段文件只允许通过现有显式迁移脚本进入指定客户目录；运行时不自动复制给多个客户。
- 缓存保留按客户 Map，但增加 500 客户上限和 30 分钟空闲淘汰；按需加载，不全量预热。
- 整批提交按 `customerId` 串行；不同客户可以并行。
- 分片读改写按 `(customerId, importId)` 串行。
- 临时文件名使用随机 UUID，避免相同 PID 的并发写覆盖。
- 分片路径继续基于当前客户库存文件路径；不新增第二套存储目录结构。

## 7. 路由、缓存与健康

- 全部认证 API 响应由 `proxy` 统一设置 `Cache-Control: private, no-store`，并追加 `Vary: x-cdss-customer-id, x-cdss-api-token, authorization`。
- 库存 GET/POST 成功响应额外返回经验证的 `x-cdss-customer-id`；未授权错误不回显原始客户头。
- 保留当前“库存只影响可得性，不重写临床结论”的边界。
- M04、HIS、签名、快照、模型限流沿用已实现的客户参数传播，不重新实现。
- strict health 新增不泄露客户列表的 `customerAuthorization` 状态：`configured/valid/clientConfigured/customerCount/ready`。
- 生产授权配置未就绪时纳入 `degradedReasons` 并使 `strictReady=false`。

## 8. 路由分类防回归

维护一份代码内路由分类清单：

- 全局：登录、健康、模型健康、平台级知识库。
- 租户：库存、M01–M05、红旗、审方、HIS、快照、术语确认和紧急放行。

测试枚举 `src/app/api/**/route.ts`。任何新增路由未出现在分类清单时测试失败；租户路由还必须能够追溯到 `requireCustomerContext` 或 `readCustomerBoundCaseStateRequest`。

## 9. 测试设计

采用项目现有 `scripts/test-*.mjs`，先 RED 后 GREEN：

1. 同一固定 Token 对白名单 A/B 成功；C 返回 `403 customer_forbidden`。
2. 登录接口不得为未授权 C 签发客户 Cookie。
3. 缺配置、非法配置、重复客户、非法默认客户在生产/strict 模式 fail closed。
4. A/B 库存文件写入 v2 身份；把 A 文件放到 B 路径后 B 不得读取。
5. A/B 相同库存条目仍生成不同版本摘要。
6. A/B 相同 `importId` 独立；同客户并发分片不丢片；不同客户并发不共享锁。
7. 缓存超过上限后淘汰旧条目且不串读。
8. M04/HIS/签名/快照现有租户回归继续通过。
9. 新增未分类 API 路由时分类测试失败。
10. 响应缓存头和库存客户响应头符合合同。

完成后运行相关测试、普通/clean-env 确定性总回归、typecheck、lint、build、依赖审计和生产前严格健康检查。

## 10. 部署与回滚

部署顺序：

1. 不修改既定 `CDSS_API_TOKEN`。
2. 在受保护的生产运行时配置 `CDSS_API_CLIENT_ID` 和已确认客户白名单。
3. 校验默认客户属于白名单，运行现有库存迁移预演。
4. 发布不可变镜像并检查 strict health。
5. 使用同一 Token 分别验证两个授权客户，再验证一个未授权客户返回 403。
6. 验证 A/B 库存 GET、M04、HIS、快照和签名互不串用。

回滚时回退镜像和新增非秘密配置即可；不改 Token，不合并多个客户库存文件，不删除租户目录或迁移备份。

## 11. 明确不做

- JIT 自动注册、动态租户注册表和 `/api/customers/register`。
- 租户管理后台、客户选择列表接口和在线停用/删除功能。
- PostgreSQL、Redis、对象存储、分布式锁或多实例迁移。
- Prometheus 指标系统、告警平台或独立审计数据库。
- 每客户 Token、Token 轮换或把 Token 写入任何交付物。
- 与客户授权无关的临床、UI 或大文件重构。

这些能力只有在甲方出现开放式自助开户、多实例部署或在线租户运维需求时再单独立项。
