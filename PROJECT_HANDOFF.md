# 音云 Yinyun 联动版项目交接手册

> 用途：新会话、新维护者或新部署人员开始工作前先阅读本文件。它记录当前仓库的边界、远端部署结构、已经修复的关键问题、验证方法和发布流程。
>
> 文档生成时间：2026-08-23（Asia/Shanghai）。最后一次真实远端验证基线：2026-08-16，代码提交 `7168f34a303df69ca6799589c7578576a39bfb07`，版本 `v1.5.6`。
>
> 本文件不保存 SSH 密码、管理员密码、Docker Hub Token 或 Songloft 密码。凭据只能从用户提供的安全渠道、部署 Secret 或远端持久化配置读取，禁止写入 Git、README、Dockerfile、镜像层和日志。

## 1. 先记住的边界

1. 本仓库是 `dlaq/yinyun-lxserver`，基于音云上游项目 fork，不能把 `server/` 生成目录当成主要源码修改位置。
2. Songloft 是独立服务。不得修改 Songloft 源码、不得用本项目替代 Songloft 的扫描器；只能调用它暴露的原生 API、OpenSubsonic API 和扫描接口。
3. MusicHub、`navidrome-ai-playlist` 只作为曲库/歌单匹配方案参考，不是第二条下载链路。
4. 歌曲来源只有两类：音云已有音源通过洛雪下载，或用户/外部程序直接复制到共享音乐目录。补齐功能不能偷偷引入其它下载器。
5. 音云和 Songloft 必须看到同一宿主机音乐目录，但两个索引的刷新时机和元数据解析可能不同，界面必须分别显示两端状态，不能直接假定数量相等。
6. 普通用户可以维护自己的歌单、导入记录、匹配选择和下载队列；删除共享音乐文件属于管理员操作。涉及真实下载、替换或删除前要确认目标歌单和文件。
7. 所有改动都要考虑将来合并上游：优先在 integration bridge 和标记区块中修改，避免把业务逻辑散落到上游播放器代码。
8. 多用户数据采用“私有配置、共享持久音乐”的边界：自定义音源、平台开关、歌单、缓存和下载队列按用户隔离；`/music/<用户>` 中的长期音乐对所有已登录用户只读可见。跨用户写入只能通过管理员同步接口显式执行。
9. Songloft 覆盖同步必须保留完整安全协议：普通用户只追加；管理员明确目标并先预演；五分钟一次性令牌；空源、未匹配、重复/无效 ID 和不稳定快照拒绝；写前持久化备份；先添加后删除；写后按 ID/顺序精确校验；失败恢复歌曲和原名称。删除音云歌单只能移除本地映射，不能顺带删除远端 Songloft 歌单。

## 2. 项目和远端拓扑

### 2.1 代码与服务

| 项目 | 用途 | 代码边界/地址 |
| --- | --- | --- |
| `dlaq/yinyun-lxserver` | 音云服务端、Web 播放器、下载和曲库联动 | 本仓库；Web 根入口 `/`，管理后台 `/admin`，API `/api/v1` |
| Songloft | 共享曲库扫描、Songloft 歌单和 Subsonic/OpenSubsonic | 远端 `http://192.168.25.104:58091/api/v1`；Subsonic `http://192.168.25.104:58091/api/v1/jsplugin/subsonic`；Web `http://192.168.25.104:8899/` |
| 音云远端容器 | 本项目生产实例 | `http://192.168.25.104:59527/`，容器内监听 `9527` |
| 远端 SSH | 维护 Docker、日志和持久化目录 | `root@192.168.25.104 -p 22333`；密码不要写入文档 |

远端部署最后一次核对到的 Compose 路径和挂载如下（路径可能因迁移变化，操作前必须重新 `docker inspect`）：

```text
/mnt/scsi2.1-1/1panel/1panel/docker/compose/yinyun-lxserver/docker-compose.yml
/mnt/scsi2.1-1/1panel/1panel/docker/compose/yinyun-lxserver/data  -> /server/data
/mnt/scsi2.1-1/1panel/1panel/docker/compose/yinyun-lxserver/logs  -> /server/logs
/mnt/scsi2.1-1/1panel/1panel/docker/compose/yinyun-lxserver/cache -> /server/cache
/mnt/scsi2.1-1/Public/Music                                      -> /server/music/dlaq
/mnt/scsi2.1-1/docker                                          Docker Root
```

上次检查时 `/dev/sdb1`（音乐分区）约 294.7G，总使用 39%，剩余约 171G。远端快满的分区不能作为构建上下文、Docker 临时目录或 npm 缓存；构建和 Compose 工作目录应放在存音乐的分区。

### 2.3 参考项目的职责

- [MusicHub](https://github.com/dlaq/music-hub)：参考“网络歌单与本地 Navidrome/Songloft 曲库比对、补齐和同步”的产品流程；本仓库不把它作为第二下载服务。
- [navidrome-ai-playlist](https://github.com/dlaq/navidrome-ai-playlist)：参考歌单匹配、健康检查问题明细、定时测试和消息推送的交互逻辑。
- [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)：参考聚合音源的多平台搜索组织方式；不复制其桌面客户端，不替换音云下载器。
- [Songloft](https://github.com/songloft-org/songloft)：只使用其部署实例提供的原生/OpenSubsonic API；不修改源码。

这些项目的功能边界必须保持清楚：音云负责洛雪音源搜索、下载、元数据整理和队列；Songloft/Navidrome 负责共享目录索引和播放；联动 bridge 负责比较、选择、歌单映射和状态展示。

### 2.2 入口和认证

- `/`：Web 播放器；未登录时应先显示登录框。
- `/admin`：管理后台，由 `FRONTEND_PASSWORD`/持久化配置中的 `frontend.password` 保护。
- `/api/v1/player/...`：播放器、歌单和排行榜 API。登录后请求沿用前端的 `x-user-token`。
- `/api/v1/integration/...`：曲库联动适配层，按同步账户隔离。
- `/rest` 和 Songloft 的 Subsonic 地址：给第三方 Subsonic/OpenSubsonic 播放器使用。
- `/server/data`：配置、账户、导入账本、健康报告和快照的持久化目录。
- `/server/music/<用户>`：音频文件根目录；生产环境应直接挂载共享音乐目录。

不要把 `401` 当成空歌单或空排行榜。未登录的公共壳页面可能先发出几次 `401`，这是正常的；登录成功后必须等待令牌写入，再重新请求数据并在失败时显示错误。

## 3. 代码结构和修改位置

```text
src/                         TypeScript 源码，优先修改这里
server/                      构建生成的 JavaScript，不要只改这里
public/app.js                管理后台和播放器入口逻辑
public/music/app.js          Web 播放器联动页面入口
public/music/js/             歌单、排行榜、联动和队列前端模块
public/music/css/            联动、队列和响应式样式
src/server/apiV1.ts          API 路由及联动适配入口
src/server/playlistIntegration.ts 统一歌曲模型、匹配和导入账本
src/server/songloftClient.ts       Songloft 原生/Subsonic API 客户端
src/server/adminUserSync.ts        管理员跨用户音源/歌单复制与回滚
src/server/sharedLocalLibrary.ts   跨用户只读本地曲库聚合和 owner 边界
src/common/utils/musicMeta/         音频元数据、封面和刮削相关逻辑
scripts/update-build-hash.js        构建哈希生成
.github/workflows/docker.yml        Docker Hub/GHCR 构建发布
.github/workflows/release.yml       桌面包、服务端压缩包和 GitHub Release
docker-compose.yml                  本地/部署 Compose 示例
Dockerfile                           amd64 Docker 构建定义
docs/songloft-playlist-integration.md 详细联动说明
docs/upstream-integration-boundary.md  上游合并边界
```

### 3.1 多用户复制与本地曲库共享

- 管理后台入口：`/admin` → “跨用户同步”。
- `GET /api/v1/admin/user-sync/inventory?user=<name>`：读取指定用户拥有的音源和歌单摘要。
- `POST /api/v1/admin/user-sync/sources`：把源用户拥有的音源复制给多个目标用户；`append` 保留目标同 ID 源，`overwrite` 只替换同 ID 源，不清空其它源。
- `POST /api/v1/admin/user-sync/playlist`：把一个用户歌单复制到另一用户的新歌单或指定歌单；支持追加/覆盖、按目标互斥、快照和失败回滚，空源不能覆盖非空目标，回滚后必须重新落恢复快照。
- `/api/v1/player/music/cache/list` 默认返回本人缓存/音乐以及其他用户的长期音乐；`scope=own` 仅供缓存管理界面读取本人数据。
- 共享歌曲携带 `libraryOwner`、`localTrackId` 和 `_localOwner`。跨用户加入歌单时必须保留 owner；否则播放端会错误地到目标用户目录寻找文件。
- 文件和封面接口只允许跨用户读取 `folder=music`，绝不允许跨用户读取 `folder=cache`。共享条目在 UI 中必须保持只读，不能进入批量删除、重命名或元数据写入。

### 3.2 Songloft 覆盖同步安全不变量

1. 普通用户只允许 `push + merge`，不能传任意 Songloft 目标 ID，也不能调用 `replace`。
2. 管理员 `push + replace` 必须明确选择 Songloft 目标，先用 `dryRun` 查看增删数量，再回传五分钟有效且只能使用一次的确认令牌。
3. 空源、全未匹配、重复/无效远端 ID、声明数量矛盾或连续两次快照不一致时全部拒绝，不提供清空绕过参数。
4. 写前原子保存完整远端歌曲顺序、名称及源/目标哈希到 `playlist-replace-backups/<user>/`。
5. 先添加、后删除、再重排；写后必须按歌曲 ID 和顺序精确核验。
6. 写入或校验失败时恢复操作前的歌曲集合、顺序和名称，并再次精确核验；回滚失败必须返回备份 ID。
7. 删除音云歌单只删除音云记录和同步映射；远端删除只允许通过明确的 Songloft 删除接口执行。

联动代码使用 `[YINYUN-INTEGRATION]` 注释标出边界。将来合并上游时：

1. 先合并上游播放器、下载器和基础 API。
2. 只重新应用 `src/server/playlistIntegration.ts`、`src/server/apiV1.ts` 中的联动区块，以及对应 `public` 联动页面。
3. 不把生成的 `server/` 目录作为源码冲突源；合并后重新执行构建生成它。
4. 如果上游改变 `CacheItem`、歌单结构或静态入口，先适配 bridge 的类型和路由，再做定向 TypeScript 构建、API smoke 和浏览器测试。
5. Songloft URL、共享目录和所有凭据继续通过环境变量/设置项注入，不能写死在源码。

## 4. 持久化数据和配置

生产容器的关键环境变量：

```text
NODE_ENV=production
TZ=Asia/Shanghai
DATA_PATH=/server/data
LOG_PATH=/server/data/logs
CONFIG_PATH=/server/data/config.js
PORT=9527
```

常见数据位置：

```text
/server/data/config.js                         服务端配置
/server/data/users.json                        账户索引
/server/data/users/<账户>/settings.json       用户设置、主题、默认入口、节能模式等
/server/data/users/<账户>/list/                 播放器歌单快照索引
/server/data/playlist-import/<账户>_*.json     网络歌单导入账本
/server/data/playlist-sync/<账户>_*.json       Songloft/音云歌单映射状态
/server/data/health/<账户>.json                健康检查设置、最近报告和连续失败次数
/server/data/logs/                             服务日志
/server/music/<用户>/                          音频和外部复制的共享文件
```

配置回退的历史根因已经修复，但排查时要记住：

- 服务启动时不能无条件 `saveConfigToFile()`；文件存在时应只读取。
- 管理后台刷新用户、重新加载配置等只读按钮不能隐式提交表单。
- 用户修改服务器名称、前端访问密码、主题或默认入口后必须点击明确的“保存设置”。
- 重启后若值回退，先检查容器是否仍挂载同一个 `/server/data`，再检查 `CONFIG_PATH`，最后才怀疑保存逻辑。
- 不要因为当前配置是默认值就猜测原来的自定义密码；如果持久化文件已被旧版本覆盖，未知旧值无法从代码恢复。

## 5. 曲库联动的正确模型

### 5.1 匹配优先级

统一歌曲模型 `IntegrationTrack` 采用以下优先级：

1. 共享文件相对路径锚点；
2. ISRC 等稳定标识；
3. 音频指纹（存在时）；
4. 标准化标题、艺术家、专辑和时长；
5. 最后才使用模糊匹配。

标题标准化需要处理大小写、全半角、空白、常见括号后缀和艺术家分隔符；不能只比较文件名。嵌入标签优先于从路径猜测的艺术家/专辑，避免 soundtrack 路径被误解析成艺术家。

### 5.2 为什么音云和 Songloft 数量可能不同

两个软件读的是同一个物理目录，但索引是两个独立状态：

- Songloft 扫描是异步的，扫描提交后不代表已完成；
- 音云可能已经看到文件，但 Songloft 尚未提交到索引；
- 两端的元数据解析、忽略规则和缓存更新时间可能不同；
- 同一文件在一个索引里可能被识别为另一个版本或被判定为重复。

所以界面必须同时保留“音云找到”和“Songloft 找到”，并提供独立刷新按钮：

```text
POST /api/v1/integration/library/refresh/yinyun
POST /api/v1/integration/library/refresh/songloft
POST /api/v1/integration/library/refresh
GET  /api/v1/integration/library/status
```

刷新 Songloft 后应等待扫描状态结束，再重新匹配；不要在扫描刚提交时把暂时的差异当成匹配算法错误。

### 5.3 “需要确认”和本地桥接

- 两个候选版本分数接近时显示“需要确认”，系统不会擅自选择版本，也不会自动下载或删除文件。
- 用户在“选择版本”中试听并采用音云、Songloft 或本地版本后，选择结果写入导入账本；页面应重新拉取记录和匹配结果，不能只改前端计数。
- 某端显示“未找到（共享本地文件）”但试听能找到文件时，应优先采用本地桥接结果，不能一键重复下载。
- 采用在线版本表示替换当前本地文件：先完成下载和元数据整理，再删除旧文件、刷新音云索引、触发 Songloft 扫描并更新两端歌单；任何一步失败都要保留失败原因，不能先删除旧文件。
- 同名歌单按规范化名称复用映射，不重复创建副本；删除歌单时要明确是删除音云、Songloft 还是两端映射。

详细规则见 [`docs/songloft-playlist-integration.md`](docs/songloft-playlist-integration.md)。

## 6. 关键功能 API 速查

| 功能 | API |
| --- | --- |
| 曲库状态 | `GET /api/v1/integration/library/status` |
| 单独刷新音云索引 | `POST /api/v1/integration/library/refresh/yinyun` |
| 单独触发 Songloft 扫描 | `POST /api/v1/integration/library/refresh/songloft` |
| 双端刷新 | `POST /api/v1/integration/library/refresh` |
| 匹配导入歌单 | `POST /api/v1/integration/match` |
| 确认一个候选版本 | `POST /api/v1/integration/playlist/resolve-item` |
| 双向同步歌单 | `POST /api/v1/integration/playlists/sync` |
| 删除音云映射的 Songloft 歌单 | `DELETE /api/v1/integration/playlists/sync/{yinyunPlaylistId}` |
| 删除指定 Songloft 歌单 | `DELETE /api/v1/integration/songloft/playlists/{playlistId}` |
| Songloft 状态/歌单/扫描 | `GET /api/v1/integration/songloft/status`、`GET /api/v1/integration/songloft/playlists`、`GET/POST /api/v1/integration/songloft/scan` |
| 健康设置/状态/测试 | `GET/PUT /api/v1/health/settings`、`GET /api/v1/health/status`、`POST /api/v1/health/test` |
| 推送测试 | `POST /api/v1/health/notify-test` |
| 本地曲库流/封面 | `GET /api/v1/library/tracks/{id}/stream`、`GET /api/v1/library/tracks/{id}/cover` |
| 排行榜 | 播放器侧 `/api/v1/player/music/leaderboard/boards` 和 `/list` |
| 歌单 | 播放器侧 `/api/v1/player/music/songList/tags`、`/list`、`/detail`、`/userPlaylist` |

联动 API 需要同步账户令牌。后台管理员 API 与普通用户 API 的权限不能混用。

`subsonic.onlineSearch` 只控制第三方 Subsonic/OpenSubsonic 客户端是否在本地曲库之外请求在线搜索结果。它不会自动下载、不会写入音云补齐队列、不会改变音云/Songloft 的索引数量，也不会替代曲库联动的聚合搜索；需要验证时分别测试“在线搜索开关”和“网络歌单补齐”两个流程。

## 7. 曲源健康检查

健康检查的逻辑必须保持和参考项目一致：

- 使用一个用户配置的测试关键词；
- 对当前账户可见的每个自定义音源/平台执行搜索和播放链接解析；
- 不按每个歌单抽样，不下载歌曲；
- 结果包含绿色正常、黄色关注、红色失败计数，以及音源×平台矩阵；
- “问题明细”弹窗中状态单元格显示错误详情，最后一列放删除自定义音源按钮；
- 顶部“立即冒烟测试”是重新执行动作，不能再额外渲染一份底部失败列表；
- Cron、测试关键词、连续失败阈值和推送渠道均按用户持久化。

支持的告警渠道包括 message-pusher、Bark 和 Server 酱，每个渠道都有独立启用开关。Token/Key 只能存服务端用户数据目录，不在前端回显。

健康报告为空或不更新时，按以下顺序排查：

1. 确认登录令牌存在，`GET /api/v1/health/settings` 和 `/status` 是否为 `200`；
2. 检查页面是否仍停留在旧构建哈希；
3. 点击“立即冒烟测试”后等待异步请求完成，不要马上读取旧 DOM；
4. 检查 `/server/data/health/` 是否可写；
5. 再查看具体音源返回的 HTTP 状态。单个音源失败不应阻止其它音源报告。

## 8. 已修复问题和排查经验

| 用户现象 | 根因 | 修复/以后怎么查 |
| --- | --- | --- |
| 登录后歌单、排行榜为空 | 播放器请求缺少 `x-user-token`，`401` 被当成空列表 | 登录后等待令牌，再刷新歌单/排行榜；看 Network 的 `/songList/*`、`/leaderboard/*` 是否 `200` |
| 登录成功后长时间显示“正在同步”或退出要等很久 | 认证后把用户快照、歌单、健康状态和远端同步串行放在首屏；退出又等待远端注销/缓存清理 | 认证成功只完成令牌和最小账户资料，重同步放后台并设置超时；退出先清本地会话、停止轮询和播放器，再异步清理远端资源 |
| 管理密码、服务器名称重启后回默认 | 启动无条件写配置；后台刷新按钮用默认表单隐式保存 | 只在文件不存在时创建配置；只允许明确保存按钮写配置；先查 `/server/data` 挂载 |
| 音云和 Songloft 数量不一致 | 双索引异步、解析规则/缓存不同，不一定是文件不同 | 分别刷新两端，等待扫描完成，再匹配；保留两端独立计数 |
| 本地有文件却显示未找到 | provider 索引未更新，前端只看 provider 状态 | 使用相对路径/元数据桥接；显示“共享本地文件”并允许试听/采用 |
| 确认后计数不变 | 只更新前端或缓存，没有重新读取导入账本 | `resolve-item` 成功后重新加载匹配记录和歌单，不要只减计数 |
| 健康弹窗排版乱、删除按钮错位 | 原来用多行状态流和底部失败列表，没有固定表格列 | 使用矩阵表、固定最后操作列、状态原因放 `title`；响应式只让矩阵内部横向滚动 |
| 移动端曲库联动出现整页横向滚动 | 为桌面表格设置了全局 `min-width` | 只给表格容器 `overflow:auto`，页面主体保持 `max-width:100%` |
| 补齐队列统计不刷新 | 轮询生命周期没有和页面可见性绑定，或刷新后只更新列表不更新统计 | 只在联动页面且 `document.visibilityState === 'visible'` 时轮询；状态/统计一起重新取 |
| 试听遮挡、关闭后主播放器还在 | 试听复用了主播放器的自动播放策略 | 使用独立、可拖动、小型浮层播放器；只播放点击项，关闭对话框同步停止试听 |
| 搜索到的版本按钮过大/弹窗文字看不清 | 新功能直接套用桌面尺寸和固定深色样式 | 使用主题变量、紧凑按钮、弹窗 `z-index` 和最大高度；必须用真实截图验证浅色/深色/手机 |
| 封面在音云缺失但 Songloft 有 | 前端只取单一索引封面，或文件嵌入封面没有经过统一 fallback | 先检查 `/library/tracks/{id}/cover`、文件嵌入标签和缓存；修复服务端封面 fallback，不要只在卡片上伪造图片 |
| 首次打开跳到“关于” | 入口路由初始化和默认入口恢复时序冲突 | 检查 `/`、默认入口、管理后台“Web 播放器”三个入口的导航顺序；不能让关于页先闪出 |
| Docker 日志时区不对 | 容器未设置 TZ 或文件/控制台 logger 使用不同格式 | Compose/Dockerfile 设置 `TZ=Asia/Shanghai`，检查容器内 `date` 与日志时间 |
| GitHub Release 检查 403 | 未认证 GitHub REST API 限流；与本地歌单无关 | 使用缓存和退避；不要把 Release 检查失败当登录/歌单故障 |

## 9. 本地开发、测试和浏览器验证

本机当前约定使用 PowerShell 7；脚本开头使用：

```powershell
$ErrorActionPreference = 'Stop'
```

常用命令（在仓库根目录执行）：

```powershell
npm ci
npm test
npm run build
node --check public/app.js
node --check public/music/app.js
node --check public/music/js/songlist_manager.js
node --check public/music/js/leaderboard_manager.js
```

最后一次代码基线验证为 `npm test` 65/65、TypeScript 构建通过，构建哈希为 `617988e`。改动涉及 UI 时不能只跑单元测试，应使用真实浏览器检查：

1. 打开远端音云，接受协议并登录；等待 `localStorage` 中的用户令牌写入；
2. 检查左侧“歌单”有数据，点击“排行榜”检查榜单和歌曲卡片；
3. 进入“曲库联动”，检查曲库状态、单独刷新按钮、导入歌单和匹配计数；
4. 打开健康检查报告，确认矩阵行列、操作列、删除按钮和弹窗关闭按钮；
5. 在真实本地歌曲、在线候选、需要确认和失败队列四种状态下分别试听；
6. 使用浅色、深色、节能模式和手机视口截图检查，特别注意页面不能出现无意义的全局横向滚动；
7. 真实下载/替换/删除会产生持久化和队列副作用，必须得到用户明确授权后再执行。

Playwright 失败时先尝试系统 Edge 的实际可执行文件；测试脚本必须等待令牌和异步报告，不要用固定的 1～2 秒等待代替状态条件。浏览器控制台中登录前的 `401`、GitHub Release `403` 和无头 Edge 的 AudioWorklet 报错不能直接判定为本项目数据故障。

## 10. Docker 构建、发布和远端升级

### 10.1 构建定义

- `Dockerfile` 在仓库根目录，基于 `node:24-alpine`。
- 构建阶段执行 `npm ci` 和 `npm run build`，再安装生产依赖。
- 当前发布工作流只构建 `linux/amd64`；ARM 需要原生 ARM runner，不要用不稳定的 QEMU npm 构建结果冒充 ARM 镜像。
- `docker-compose.yml` 只提供示例，生产环境必须把 `./music` 替换成与 Songloft/Navidrome 相同的宿主机目录。

### 10.2 GitHub Actions

`.github/workflows/docker.yml`：

- 推送 `main` 或 `v*` tag 时构建并推送 GHCR、Docker Hub；也支持 `workflow_dispatch`。
- 使用仓库 Secrets：`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`。
- 镜像标签通常是 `dlaq/yinyun-lxserver:latest` 和 `v1.5.6` 这类版本标签。
- 构建哈希由 `scripts/update-build-hash.js` 生成；前端缓存问题先检查该哈希是否变化。
- `cleanup_legacy_v1=true` 只用于明确清理旧 `v1` 标签，不要拿它做全局清理。

`.github/workflows/release.yml`：

- tag 或手动发布时构建 Windows、macOS、Linux 桌面包和 Linux 服务端压缩包。
- 发布前运行 `npm test`、服务端构建和二进制准备。
- GitHub Release 失败时先看 Actions 中是构建失败、资产缺失还是 Release API 限流；不要因为播放器右上角的 403 就重启服务。

### 10.3 推荐发布流程

```text
1. git status --short --branch
2. 阅读本文件和 docs/upstream-integration-boundary.md
3. 只修改 src/、public/、Docker/工作流或文档中的必要文件
4. npm test
5. npm run build
6. 检查 git diff 和敏感信息（密码、Token、内网凭据不得出现）
7. 提交并推送 main，等待 GitHub Actions 成功
8. 核对 Docker Hub 镜像摘要和标签
9. 远端只对 yinyun 服务执行 docker compose pull/up
10. 记录升级前后的 yinyun 容器 ID，并确认 Songloft 容器 ID 不变
11. 运行登录、歌单、排行榜、健康检查和曲库联动 smoke
12. 再向用户报告已验证结果和剩余告警
```

远端升级时使用项目 Compose 目录，避免影响其它服务：

```bash
docker compose pull yinyun
docker compose up -d --no-deps --force-recreate yinyun
docker ps --format '{{.ID}}|{{.Image}}|{{.Names}}|{{.Status}}'
```

不要执行 `docker compose down`、全局 `docker system prune` 或未核对目标的批量删除。清理镜像时先用完整仓库名、标签、容器引用和 OCI source label 交叉确认；当前 `bobcc4/yinyun-lxserver` 是不同上游仓库，除非用户明确确认，不要删除。

## 11. 当前交付基线

最后一次已验证的本地 Git 状态：

```text
branch: main
commit: 7168f34a303df69ca6799589c7578576a39bfb07
working tree: clean
```

最后一次远端交付：

```text
Docker Hub digest:
sha256:3947cb1d07a48135354d15eeb2f36a21e67b26b66c0cc1e5301c002810039740

yinyun container: e575eb94a59b...
songloft container: 4b4602c75631...
```

上述远端容器 ID、镜像摘要、磁盘剩余空间和扫描数量都是时间点事实。新会话开始后必须重新检查，不能把它们当成永久配置。

## 12. 新会话接手清单

新会话收到“继续修复/发布”请求时，建议按下面顺序开始：

1. `Get-Content PROJECT_HANDOFF.md`，再读 `docs/songloft-playlist-integration.md` 和 `docs/upstream-integration-boundary.md`；
2. 检查 `git status --short --branch`、最近提交和当前分支；
3. 先只读检查远端 `docker ps`、Compose 路径、挂载、磁盘空间和日志；
4. 明确用户要的是诊断、代码修改、真实下载/删除，还是发布；不要从“检查”推断出“可以删除”；
5. 任何涉及 Songloft 的需求先确认是否能通过 API 完成，默认不改 Songloft 源码；
6. UI 问题用真实浏览器截图复现，API/认证问题同时看 Network 状态码和服务端日志；
7. 修改后按测试、构建、Actions、镜像摘要、远端容器和浏览器 smoke 的顺序验证；
8. 最终报告必须区分“已实际验证”“根据代码推断”和“仍需用户设置/确认”。

相关文档：

- [`README.md`](README.md)：用户可见功能、Compose 示例和发布入口。
- [`docs/songloft-playlist-integration.md`](docs/songloft-playlist-integration.md)：歌单同步、共享曲库匹配和 `subsonic.onlineSearch`。
- [`docs/upstream-integration-boundary.md`](docs/upstream-integration-boundary.md)：将来合并上游时的代码边界。
- [`docs/guide/troubleshooting.md`](docs/guide/troubleshooting.md)：通用播放器、下载、封面和日志排查。
- [`Dockerfile`](Dockerfile)、[`docker-compose.yml`](docker-compose.yml)：构建与部署定义。
- [GitHub Actions Docker workflow](.github/workflows/docker.yml)：Docker Hub/GHCR 发布。

## 13. 本会话完整需求—实现方案对照

本节把本次长期改造中用户明确提出的功能要求集中记录，后续会话不能只看“当前页面能打开”就认为需求已经完成；要按方案和验收条件逐项复核。

### 13.1 曲库、歌单和下载闭环

| 用户需求 | 实现方案和验收条件 |
| --- | --- |
| 导入第三方音乐软件歌单 | 接受网易云等网络歌单 URL，解析出标题、艺术家、专辑、时长和原始来源；导入后按当前账户隔离保存，不把 URL 解析当成已有本地文件。需要登录的私有歌单必须在对应来源具备可用会话。 |
| 导入记录不要让用户记内部 ID | 不再把“已有导入记录 ID”作为主入口；以导入歌单名称、来源、歌曲数和时间构成下拉列表，选择后直接打开/重新匹配。内部账本 ID 只作为后端关联键或调试信息，不要求用户复制。 |
| 同名重复导入不创建副本 | 用规范化歌单名称和来源映射复用已有记录；再次导入应更新匹配内容和时间，不在音云“我的歌单”生成同名副本。若用户明确要新歌单，必须通过明确的新名称创建。 |
| 音云和 Songloft 歌单保持一致 | 同步层维护 `yinyunPlaylistId`、`songloftPlaylistId` 和规范化名称映射；导入、删除、重命名、增删歌曲和采用替换版本都通过适配层调用 Songloft API。系统歌单或只读歌单必须显示不可操作原因。 |
| 分别删除音云和 Songloft 歌单 | UI 提供独立操作，并明确作用范围；删除音云歌单不能默默删除本地音频，删除 Songloft 歌单只能删除可写的映射歌单。删除映射后导入账本保留历史，避免下次导入误认成同一远端歌单。 |
| 一键补齐和手工补齐 | “一键补齐全部缺失”只处理明确缺失项，使用“聚合”音源并按匹配规则选择候选；“手工补齐”只处理用户勾选项，打开版本选择器让用户试听、切换音源、修改关键词并采用。两个按钮应在同一行，移动端可换行但不能形成难以辨认的上下错位。 |
| 一键补齐使用聚合音源 | 聚合层参考 `lyswhut/lx-music-desktop` 的多源并行搜索思想，复用音云现有音源脚本，不新增第二套下载器；每个结果保留真实平台标识，失败时可换源。聚合本身不是一个新的音源账号。 |
| 下载闭环 | 音云洛雪解析/下载 → 自动写入元数据和封面 → 按艺术家/专辑归档到共享音乐目录 → 触发音云索引刷新 → 触发 Songloft 扫描 → 等待两端索引可见 → 更新两端歌单。外部直接复制的文件走同一索引和匹配流程，但不经过音云下载队列。 |
| 替换本地版本 | 本地已有文件时试听优先播放本地；用户采用在线候选代表明确替换。先下载并完成元数据、归档和校验，成功后再删除原文件，并更新音云/Songloft 歌单；下载失败时保留原文件和原歌单。 |
| “需要确认”状态 | 当最佳候选和第二候选分数过近，或两个服务对版本判断不一致时显示“需要确认”。用户要在选择版本中选择音源/候选或本地文件后点击采用；后端写入导入账本并重新返回整条匹配记录，不能只在前端把数字减一。 |
| 共享库本地命中 | 即使音云或 Songloft 自己的索引暂时未命中，只要共享目录中存在能通过相对路径、ISRC、指纹或元数据确认的文件，就显示“共享本地文件”，提供本地试听/采用，不加入下载队列。 |
| 音云/Songloft 匹配数量不一致 | 两端数量分别展示，不再显示含义模糊的“任一共享库找到”。提供“刷新音云索引”“刷新 Songloft 索引”“刷新双端状态”三个动作；Songloft 扫描是异步的，提交后等待扫描完成再重新匹配。 |
| 补齐队列历史 | 每项保留所属歌单、歌曲、来源、加入时间、开始/完成/失败时间、状态、错误原因和最终文件；统计块必须同时刷新下载中、等待、完成、已存在、失败。历史不应无限增长，提供清理历史/移除记录操作，但不能误删仍在执行的任务。 |
| 失败任务处理 | 失败项提供重试、换源重试和移除；重试不能创建重复任务，换源应记录实际选择的平台。失败任务不能被一键补齐静默吞掉，用户必须能看到可操作原因。 |
| 音乐文件重复分析 | 对共享音乐目录做只读扫描，优先按文件内容哈希/音频指纹分组，再结合标题、艺术家、专辑、时长和相对路径列出疑似重复组与精确文件路径。报告完成后等待用户确认，不能因为“看起来重复”自动删除文件；删除必须限定为用户确认的具体路径并由管理员执行。 |
| 删除权限 | 普通用户可以删除自己的歌单、导入记录和队列历史；删除共享音乐文件、替换实际本地文件或清理全局曲库必须验证管理员身份。 |

### 13.2 试听、搜索和封面

| 用户需求 | 实现方案和验收条件 |
| --- | --- |
| 所有试听按钮有简单播放器 | 任意“试听”入口都使用统一的小型浮动试听播放器，显示歌曲、来源、加载进度、播放/暂停、进度条和关闭按钮；不能只弹 Toast 或等待很久后提示未找到。 |
| 本地优先试听 | 本地有文件时，试听对话框最上方显示本地文件信息，在线候选区域与本地区域有明显分隔；本地试听不触发下载。 |
| 在线试听播放器独立 | 试听浮层位于整个网页顶层、可拖动、不会被对话框或管理面板遮挡；关闭版本对话框时同步停止并销毁该试听播放器；试听不会驱动主播放器、不会自动切到下一首，也不套用主播放器的循环/播放列表策略。 |
| 缺少本地文件时的搜索时机 | 点“试听/替换”时若本地有文件，默认只展示本地信息，不自动搜索；本地没有文件时才自动搜索。用户随后可编辑关键词并点击“搜索”重新查询。所有调用音源搜索的界面都必须支持修改关键词。 |
| 选择版本时可选音源 | 版本选择器中的搜索源下拉列表必须真正可用，支持单一平台和“聚合”；每个候选保留平台名、标题、艺术家、专辑、时长、音质和试听/采用按钮。 |
| 试听按钮紧凑和可关闭 | 试听、采用、选择版本、搜索按钮使用紧凑尺寸，弹窗关闭按钮固定在最上层，内容超长时只在弹窗内部滚动，不能把关闭按钮推到视口外。 |
| 音频封面 | 音云曲目卡片优先读取本地嵌入封面或 `/api/v1/library/tracks/{id}/cover`，缺失时使用可靠的远端候选/专辑封面 fallback；不能仅因为音云索引的封面字段为空就显示默认图。先检查服务端封面接口和文件标签，再修改前端。 |
| 歌单封面 | 用户可选择歌单中的一首歌作为歌单封面；未选择且歌单本身没有封面时，自动使用第一首有封面的歌曲；全部无封面时使用默认占位图。Songloft Subsonic 可能不支持歌单封面传输，因此封面选择至少要在音云侧持久化，不能以 Subsonic 支持与否阻塞歌单同步。 |
| 标签含义 | `网易`、`Songloft` 等标签表示该条记录的来源/匹配来源；`LOCAL` 表示已解析到共享本地文件，不表示另下载了一份文件。 |

### 13.3 Web 播放器、管理后台和响应式 UI

| 用户需求 | 实现方案和验收条件 |
| --- | --- |
| 所有用户先登录 | 打开根入口、刷新播放器或从管理后台点击 Web 播放器时，未登录先显示登录框；禁止先闪“关于”再跳转。登录成功后先写入令牌，再加载歌单、排行榜和用户设置。 |
| 登录/退出不能慢 | 登录只等待必要的认证和最小用户资料；歌单、排行榜、健康状态和 Songloft 同步放到登录后的并行/后台任务，超时不能阻塞播放器。退出先立即清除本地令牌、停止轮询和浮层播放器，再异步结束远端会话；不能等一分钟后才退出。 |
| “我的歌单”菜单 | 左侧“我的歌单”和“歌单”是同级菜单，并有与其它菜单项一致的图标；我的歌单详情页面直接复用音云原生“歌单”详情页面的布局、卡片尺寸、间距、底部播放器和交互，不得另写一套放大图标的 UI。 |
| 默认入口 | 设置的“默认入口”下拉列表包含“我的歌单”，保存后重新登录和重启仍能恢复。 |
| 曲库联动归属 | 曲库联动维护个人歌单的功能放在用户 WebUI；管理员后台只保留系统级连接、扫描、权限和维护入口。普通用户的 Songloft 映射不能串到其它用户。 |
| 管理后台导入区 | 当前歌单通过歌单名称下拉列表控制；已废弃的内部导入记录 ID 输入、复制 ID、打开记录和重复导入说明文字不应重新出现。导入按钮、音质下拉框、打开歌单按钮要保持同一水平线，窄屏时按行布局。 |
| 普通用户导入和音质下拉框 | 普通用户页面也必须加载同一份音质选项和事件处理，不能因为管理员连接面板或未带令牌而出现“点下拉框无反应”；提交前显示最终音质，失败时保留用户选择。 |
| 管理后台连接音云用户 | 管理后台显示“已连接”时必须同时刷新当前账户的导入歌单列表；不能只更新连接徽章而保留空缓存。用户 WebUI 维护个人歌单时仍要使用自己的同步账户，不依赖管理员页面的临时连接状态。 |
| 自定义源和基础设置 | “源与基础设置”默认折叠，用户点击后才展开；折叠状态和表单设置按用户保存。 |
| 手机适配 | 我的歌单和曲库联动在手机视口中不能让整页左右滚动；宽表格只在局部容器内滚动，按钮可换行，统计块从多列变为单列/两列。 |
| 主题和配色 | 联动详情、试听弹窗、选择版本弹窗使用主题变量；浅色主题不能套深色黑底，深色主题仍保持对比度。所有新按钮必须截图检查文字不溢出。 |
| 节能模式 | 设置增加可持久化的节能模式，关闭背景模糊、波形/高频动画、过重阴影和不必要特效，保留播放、搜索、歌单和联动功能，降低 GPU/CPU 占用。 |
| 服务器名称和品牌 | 管理员保存的服务器名称要写入持久化配置，并用于登录页、播放器标题和管理后台标题；未配置自定义 Logo 时继续使用音云默认图标，不能把名称回退当成 Logo 加载失败。 |

### 13.4 健康检查、推送和运维

| 用户需求 | 实现方案和验收条件 |
| --- | --- |
| 健康检查逻辑 | 严格按参考 `navidrome-ai-playlist` 的“健康/设置”思想：一个测试关键词、逐源逐平台解析，不增加“抽查歌曲总数”这一自创配置；设置启用、Cron、关键词、连续失败阈值。 |
| 问题明细 | 弹出对话框显示最近时间、正常/关注/失败统计、测试关键词和问题详情；音源×平台矩阵最后一列放删除错误自定义音源按钮。底部不再重复渲染一份失败列表。 |
| 定期测试和告警 | scheduler 按每个账户的设置运行；连续失败达到阈值才推送，手动测试推送可单独验证。message-pusher、Bark、Server 酱均有独立启用开关、配置字段和“测试告警”动作。 |
| 推送安全 | 服务器端保存 Key/Token，API 返回时脱敏；不把第三方推送凭据放到浏览器 localStorage、README、镜像或日志。 |
| 日志时区 | Docker 和 Compose 设置 `TZ=Asia/Shanghai`，文件日志和控制台日志都用同一时区；检查时以容器 `date`、应用日志和主机时间三者对照。 |
| GitHub Release 403 | 只影响版本更新提示的 GitHub API；做缓存、退避和错误隔离，不得让它阻塞登录、歌单、排行、播放或曲库联动。 |
| 管理员/普通用户权限 | `/admin` 的前端访问密码是服务端管理入口保护，不等同于同步账户密码；普通用户用自己的同步账户登录播放器，管理员权限由后台配置/账户角色判定。排查“两个用户权限一样”时必须分别测试管理员 API、普通用户 API、删除音乐和删除歌单四类动作。 |

### 13.5 发布、数据安全和未来合并

| 用户需求 | 实现方案和验收条件 |
| --- | --- |
| Docker Hub 发布 | `main` 或版本 tag 触发 `.github/workflows/docker.yml`，使用 `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN`，发布 `dlaq/yinyun-lxserver:latest` 和版本标签；Token 不能写入代码。 |
| 在音乐分区构建 | 远端 Docker Root、Compose 构建上下文、临时缓存和 npm 缓存放在有空间的音乐分区；先 `df -h` 和 `docker info`，不要在快满的分区构建。 |
| 远端部署 | 只对 Compose 中的 `yinyun` 执行 pull/recreate；部署前后记录 yinyun 容器 ID，确认 Songloft 容器 ID、挂载和运行状态不变。 |
| 旧镜像清理 | 只列出明确的 `dlaq/yinyun-lxserver` 标签、容器引用和 OCI source label 后逐项删除；禁止全局 prune；不同命名空间如 `bobcc4/yinyun-lxserver` 默认保留，除非用户再次明确确认。 |
| 上游合并 | 保留上游播放器/下载器，重应用 integration bridge 和 `[YINYUN-INTEGRATION]` 区块；先适配类型/API，再构建和 smoke；不修改 Songloft。 |

## 14. 回归测试歌单和场景

以下 URL 是本会话用于复现匹配、需要确认、封面、歌单详情和导入问题的测试集。它们可能因来源登录状态、平台下架或歌单变更而变化，测试前记录实际歌曲总数，不要把历史数量当成永久期望值。

| 场景 | URL |
| --- | --- |
| 普通公开歌单/初始导入 smoke | <https://music.163.com/#/playlist?id=13641085&creatorId=17215113> |
| 私有/用户歌单匹配差异 | <https://music.163.com/#/my/m/music/playlist?id=5067816231> |
| 音云 13 / Songloft 12 差异复现 | <https://music.163.com/#/my/m/music/playlist?id=148402843> |
| 选择版本、本地命中但索引未命中 | <https://music.163.com/#/my/m/music/playlist?id=124679442> |
| 7 首中出现两端各 6 首/需要确认 | <https://music.163.com/#/my/m/music/playlist?id=455621147> |
| 截图中使用过的导入布局回归 | `633476512`（以截图中的完整 URL 为准） |

每个场景至少验证：

1. URL 导入和歌单名称下拉列表；
2. 音云找到、Songloft 找到、等待补齐、需要确认四类计数之和等于歌单总数；
3. 本地存在时是否出现试听本地/采用本地；
4. 需要确认后采用版本是否持久化，刷新页面和重新打开歌单是否仍为已处理；
5. 一键补齐是否只下载真正缺失歌曲；
6. 下载完成后是否写元数据、归档、触发扫描并更新两端歌单；
7. 删除或替换操作是否遵守普通用户/管理员权限。

## 15. 新会话的“不要重复踩坑”清单

- 不要把 Songloft、Navidrome 或 MusicHub 的索引数量当成同一个 API 的实时结果。
- 不要因为前端显示空数组就判断后端没有歌单；先看 HTTP 状态码和令牌。
- 不要只改 `server/` 生成文件；改 `src/` 后重新构建。
- 不要把“需要确认”通过重新导入掩盖；确认结果必须写账本并重新加载状态。
- 不要在本地已有文件时直接一键下载；先走本地桥接和试听。
- 不要把试听复用成主播放器，也不要让试听自动播放下一首。
- 不要用固定 `setTimeout` 代替登录令牌、扫描完成、健康报告完成等状态条件。
- 不要用全局 `overflow-x` 或桌面 `min-width` 修复宽表格；只能限制在表格容器。
- 不要为了解决 GitHub Release 403 重启音云或修改 Songloft。
- 不要把管理员密码、Docker Hub Token、Songloft 凭据和真实用户歌单内容提交到 Git。
- 不要在没有精确列出目标镜像、容器和挂载的情况下删除 Docker 数据。

## 16. 后续新增功能的推荐实施顺序

如果新会话继续扩展功能，按下面的顺序可以减少回归范围：

1. **先确认边界和数据模型**：明确功能属于音云、联动 bridge、Songloft 适配还是纯前端；先定义 `IntegrationTrack`、导入账本、队列历史和权限，不要直接在按钮事件里拼临时对象。
2. **先做只读 API**：实现状态查询、索引刷新状态、候选查询和报告查询；为成功、未登录、未配置、扫描中和上游失败分别返回明确 HTTP 状态和错误码。
3. **再做持久化写操作**：导入、确认、采用、同步、删除和重试都使用原子写入/幂等键；写入后重新读取账本和索引状态，不能只修改内存计数。
4. **再做下载闭环**：只把音云下载队列作为下载入口，完成元数据/归档/扫描/歌单同步的状态机；替换任务必须保留旧文件直到新文件可用。
5. **再做桌面宽屏 UI**：先复用音云原生歌单详情和播放器组件，再增加联动区域；不要复制出一份尺寸、主题和播放器策略不同的“我的歌单”页面。
6. **最后做响应式、权限和性能**：用主题变量、局部滚动容器、可见性轮询、取消请求和节能开关处理移动端、浅色主题、退出速度和 GPU/CPU 占用。
7. **验证顺序**：单元/接口测试 → TypeScript 构建 → 真实登录浏览器 → 私有/公开歌单导入 → 本地命中/需要确认/失败队列 → 健康检查和推送 → Docker Hub → 远端仅重建音云 → Songloft ID 和共享目录复核。

任何新增 UI 都要同时验证：未登录、普通用户、管理员、浅色主题、深色主题、手机宽度、本地有文件、本地无文件、网络错误和刷新后恢复。任何新增删除或下载功能都要单独记录副作用和恢复方法。
