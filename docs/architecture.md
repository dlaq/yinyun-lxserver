# 音云整体架构与治理说明

本文描述 `yinyun-lxserver` 当前代码的真实边界、主要数据流、持久化约束和发布原则。它是开发与运维文档，不包含生产密码、令牌或 Songloft 内部实现。

## 1. 规格、计划与交接资料

开始修改前应按以下顺序阅读：

1. 根目录 `README.md`、`function.md`：产品能力和公开用法。
2. 根目录 `PROJECT_HANDOFF.md`：生产拓扑、历史修复、数据目录和发布步骤。
3. `docs/songloft-playlist-integration.md`：曲库联动与 Songloft 歌单同步的安全语义。
4. `docs/upstream-integration-boundary.md`：与上游合并时必须保留的本项目边界。
5. `docs/guide/storage-backup.md`、`docs/guide/accounts-sync.md`：数据恢复与账户快照约束。
6. `test/**/*.test.ts`：可执行规格。遇到文档和测试不一致时，先确认生产行为，再同时修正文档和测试。

Songloft 是外部联调服务，不是本仓库的第二个子项目。音云只通过其公开接口读取曲库和受控写入测试歌单；不得修改 Songloft 源码、容器、配置、镜像或持久化目录。

## 2. 运行时分层

```text
浏览器 / PWA / Subsonic 客户端
          │ HTTP、Bearer、Subsonic token
          ▼
server.ts：配置装配、生命周期、兼容路由
          │
          ├─ apiV1.ts / subsonic.ts：协议与输入输出
          ├─ authService.ts：凭据、会话、撤销、限速
          ├─ adminUserSync.ts：跨用户歌单/音源事务
          ├─ playlistIntegration.ts：歌曲匹配与同步账本
          ├─ songloftClient.ts：外部 Songloft/Subsonic 适配
          ├─ fileCache.ts / serverDownloadQueue.ts：媒体索引与下载
          ├─ externalMusicLibraries.ts：只读外部曲库注册
          ├─ networkPlaylistMonitor.ts：只读状态观察
          └─ AtomicJsonStore：关键 JSON 的校验、串行和原子落盘
                     │
                     ▼
       /server/data、/server/cache、共享音乐目录
```

`src/server/server.ts` 仍承担旧路由兼容和依赖装配，是当前最大的结构债务；新增高风险能力不得继续以内联读写方式堆入该文件，而应先放入独立 service/repository，再由入口挂载。公开 URL 保持兼容，以免破坏播放器和既有 Subsonic 客户端。

## 3. 主要模块与职责

| 模块 | 职责 | 不允许承担的职责 |
| --- | --- | --- |
| `server.ts` | 读取配置、装配依赖、启动/停止任务、挂载路由 | 直接实现新的跨用户事务或解析外部不可信响应 |
| `apiV1.ts` | `/api/v1` 协议、输入验证、媒体/播放器/联动路由 | 把失败响应转换为空歌单，或绕过 service 直接覆盖数据 |
| `authService.ts` | scrypt 凭据、AES-GCM 兼容材料、JWT/HKDF、会话轮换与撤销 | 输出明文密码、把前端管理员密码当签名密钥 |
| `atomicJsonStore.ts` | schema 校验、revision、文件锁、临时文件 + fsync + rename、备份恢复 | 对关键数据损坏静默返回空对象 |
| `adminOperations.ts` | 预览令牌、一次性确认、操作状态和审计 | 保存密码、完整音源秘密或可复用确认令牌 |
| `adminUserSync.ts` | 多目标锁、预览、追加/覆盖、备份、写后验证、失败回滚、重启恢复 | 无预览直接写；部分目标成功后仍提交 |
| `playlistInvariants.ts` / `playlistRepair.ts` | 歌单 schema、唯一 ID、历史重复项的专用修复 | 在普通导入时猜测性合并冲突数据 |
| `playlistIntegration.ts` | 标准化歌曲、稳定匹配、冲突判断、导入/同步账本 | 因网络错误生成“0 首”并覆盖目标 |
| `songloftClient.ts` | Songloft 和 Subsonic HTTP 适配、结构校验 | 修改外部服务配置或把异常响应伪装成合法空列表 |
| `networkPlaylistMonitor.ts` | 周期读取网络歌单状态、保留最后成功状态、局部通知 | 写入、替换、删除任何歌单 |
| `customSourceHandlers.ts` | 单用户音源 CRUD、账户快照导入导出 | 管理员跨用户直接写；该能力只能走 `adminUserSync.ts` |
| `customSourceSharing.ts` / `playlistSharing.ts` | 显式分享关系和收件箱 | 代替管理员事务同步 |
| `sharedLocalLibrary.ts` | 共享持久化本地音乐的可见性与所有者校验 | 暴露其他用户缓存或允许普通用户删除共享原文件 |
| `externalMusicLibraries.ts` | `/server/external` 下只读曲库注册、索引和路径边界 | 删除外部原始媒体 |
| `remoteUrlPolicy.ts` | HTTP(S) 限制、DNS 全结果校验、私网拦截、DNS pin、大小/超时限制 | 信任重定向目标或请求中的 Host 作为内部回环地址 |
| `fileCache.ts` | 媒体定位、元数据、封面/歌词、缓存索引 | 跨用户复用未带用户名的私有缓存键 |
| `serverDownloadQueue.ts` / `remasterQueue.ts` | 下载和洗版任务生命周期 | 在用户删除后继续持有任务或文件句柄 |
| `subsonic.ts` | Subsonic/OpenSubsonic 兼容协议 | 改变原客户端登录方式或泄漏兼容密码材料 |

## 4. 前端状态与导航

播放器仍采用无框架的经典脚本，状态必须分成四类：

- 服务端数据：登录用户、歌单、曲库、音源和同步状态。
- 视图状态：当前 tab、详情页、返回栈、原列表 DOM 和滚动位置。
- 播放状态：当前歌曲、队列、进度、音质和播放器展开状态。
- 后台观察状态：网络歌单监控徽标、下载进度和联动状态。

详情返回只恢复已有列表 DOM、选择和滚动位置。后台监控只能 patch 对应卡片，不能调用整个“我的歌单”渲染函数。否则异步回调会与返回栈竞争，产生页面闪烁、大片空白或点击后立即被旧回调关闭。

歌单、我的歌单、排行榜、本地音乐和曲库联动都使用页面级长滚动；标题/说明区属于正常文档流。移动端布局以 CSS 安全区域、动态视口和内容宽度为基准，不按某一个域名或某一台手机写死。

## 5. 核心数据流

### 5.1 登录和会话

1. 用户在 `/api/v1/auth/login` 提交用户名和密码。
2. `apiV1.ts` 调用 `AuthService.loginUser`；旧明文只在迁移阶段读取。
3. `AuthService` 验证 scrypt，创建带 `sid` 和 credential version 的访问/刷新令牌。
4. 刷新令牌每次使用后轮换；登出、改密和删用户会持久化撤销状态。
5. Subsonic 继续接受原协议，所需兼容材料由 `AUTH_MASTER_KEY` 加密保存。

### 5.2 本地音乐读取

1. 媒体索引产生带 owner 的稳定本地 track ID。
2. `sharedLocalLibrary.ts` 判断当前已认证用户是否可读取该持久化曲库。
3. 音频、Range、动态封面直接返回，不进入 Service Worker 缓存。
4. 外部音乐库先通过 `realpath` 与 `/server/external` 根包含校验，再以只读方式索引和播放。

### 5.3 管理员跨用户同步

```text
读取源和所有目标 → 校验 schema/revision → 生成差异预览
         → 绑定会话和输入哈希的一次性确认令牌
         → 固定用户名顺序加锁 → 为每个目标建精确备份
         → 逐目标原子写入 + API 初始化验证
         → 全部成功后提交；任一失败则逆序全部回滚
```

音源支持追加与覆盖；歌单支持复制为新歌单、追加去重和显式覆盖。普通用户默认追加。覆盖非空目标时，空源、结构异常、Songloft 请求失败、匹配不足或写后数量不符均必须失败关闭。

### 5.4 Songloft 歌单同步

1. 拉取源与 Songloft 目标的完整快照并验证 `list` 结构。
2. 规范化路径、ISRC、指纹、标题/艺术家/专辑/时长，模糊结果必须达到置信度且无并列冲突。
3. 自动同步只追加；替换必须先预览并确认。
4. 执行前重新核对输入哈希，避免用户预览后目标已变化。
5. 写入后重新读取目标验证数量与顺序；失败时使用操作备份回滚。
6. 合法空源只能形成被拒绝的替换预览，不能清空非空目标。

网络歌单监控与上述写入链完全分离，它只观察状态。

## 6. 持久化与一致性

关键 JSON 使用 `AtomicJsonStore` 或相同级别的原子写入：

- 写前 schema 验证；
- 同一文件串行互斥和 revision 冲突检测；
- 同目录临时文件、文件 `fsync`、原子 rename、父目录 `fsync`；
- 保存最后一个有效 `.bak`；
- 主文件损坏时保留带时间戳的 `.corrupt` 证据；
- 主备均无效时停止相关功能，不创建空数据替代。

媒体、封面和歌词是可重建或大文件，不进入 JSON 事务。跨多个用户的原子性由操作 journal、目标级备份和重启恢复共同保证；当前部署仍是单实例，进程内锁不能替代多实例分布式锁。

## 7. 采用的设计模式

- **Adapter**：`songloftClient.ts`、`subsonic.ts` 将外部协议转成内部歌曲与歌单模型。
- **Repository / Store**：`AtomicJsonStore`、歌单账本、用户存储封装持久化和 revision。
- **Service Layer**：认证、管理员同步、修复和网络监控承载业务不变量。
- **Two-phase confirmation**：危险操作采用“预览 → 一次性确认 → 状态查询”。
- **Unit of Work / compensating transaction**：跨用户同步先备份、统一加锁，失败后补偿回滚。
- **Strategy**：歌曲匹配、音质候选和多平台播放解析按优先级选择策略。
- **Observer**：网络歌单监控和下载进度只发布局部状态，前端局部更新。
- **State machine**：管理员 operation、会话、下载任务和 PWA 更新均有明确状态转移。
- **Cache-aside**：媒体和界面缓存可重建；关键源数据不以缓存为空作为真值。

## 8. PWA 缓存模型

- 播放器和管理端使用不同 scope、缓存前缀和 manifest。
- 缓存名包含构建 revision；预缓存清单由 `scripts/generate-pwa-precache.mjs` 自动生成。
- HTML 导航和非哈希入口脚本 network-first；真正带哈希的静态资源 cache-first。
- `/js/config.js` network-first，并只保留同构建的 last-known-good 安全配置。
- API、登录、管理写入、音频 Range、动态封面和敏感响应不缓存。
- 新 worker 不在 install 阶段强制接管；播放器空闲时激活，播放中由用户确认或延迟到暂停/结束。
- origin、安装地址和 scope 从当前访问地址推导，不写死生产域名。

## 9. 已控制风险与剩余结构债务

已建立自动化保护的高风险问题包括：

- 网络失败不再被解释为零首歌，Songloft 非空歌单不会被空源自动覆盖；
- 返回栈与异步渲染解耦，详情返回后立即或延迟点击均不被旧回调关闭；
- 重复歌单 ID 只能由专用修复流程处理；
- 管理员同步要求预览、锁、审计、写后验证和全目标回滚；
- 登录秘密不再从管理 API、URL、日志或永久 token 文件泄漏；
- 远程媒体代理校验每次重定向、全部 DNS 结果和 IPv4/IPv6 私网，并 pin 已批准地址；
- 删除用户时终止任务并清理分享、音源偏好、外部索引、凭据、会话和专属缓存；
- 过期的本地封面签名不会从 IndexedDB 被永久复用；
- PWA 不混用播放器/管理端或不同构建的缓存。

仍需遵守的结构限制：

1. `server.ts`、`apiV1.ts`、`fileCache.ts` 和 `subsonic.ts` 体积仍大。新改动必须沿现有 service seam 外移，并逐步为旧路由补依赖注入测试。
2. 进程内锁只支持单实例。若未来水平扩容，必须把锁、operation lease 和 revision CAS 放入共享事务存储。
3. 外部服务只能提供补偿事务，无法与本地 JSON 构成真正的分布式原子提交；因此写后校验和可审计回滚不可删除。
4. 旧数据不是无限兼容目标。迁移完成后的新 schema 若需回到旧程序，必须先明确说明旧程序可能无法读取；本项目不以静默降级为空数据换取兼容。

## 10. 变更和发布门槛

每次正式镜像必须依次通过：

1. `npm ci`
2. `npm test`
3. `npm audit --omit=dev`
4. `npm run build`
5. 镜像 OCI revision 与目标提交一致
6. 生产数据/配置备份和镜像 digest 记录
7. 只更新音云容器
8. 桌面、iPhone、Android、PWA、Subsonic、歌单返回和真实 Songloft 测试歌单验收
9. 比对 Songloft 容器 ID、镜像、挂载和状态均未改变

生产是家中路由器上的音云服务。公网反向转发节点只用于访问测试，不参与音云部署链，也不能作为生产数据源。
