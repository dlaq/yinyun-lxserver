# 音云 × Songloft 歌单同步

本集成只做「本地曲库比对、网络歌单导入、歌单同步和扫描触发」；不改 Songloft 源码，只调用其已暴露的原生/Subsonic API：

- 音频来源只有音云现有的洛雪/LX Music 搜索下载队列，或管理员/外部程序直接复制到共享音乐目录。
- MusicHub 与 `navidrome-ai-playlist` 不参与下载、刮削、重命名或归档；它们只作为网络歌单同步/匹配方案的参考。
- Songloft 和音云共享同一个宿主机音乐目录。Songloft 扫描完成后，音云通过自己的文件索引看到同一批文件；不会把 Songloft 的下载目录当作音云曲库。

音云当前文件缓存按用户使用 `/server/music/<username>`。因此 Docker 共享挂载应挂到实际音云用户的这个路径（例如用户为 `dlaq` 时挂到 `/server/music/dlaq`），而不是只挂到 `/server/music`；否则音云不会索引共享根目录中由外部复制的文件。仓库 compose 使用 `${LX_MUSIC_USER:-admin}`，多用户部署应为每个用户分别规划挂载或改用专用共享实例。

## 配置

在 yinyun 容器设置以下环境变量（密码不要写入仓库或公开 compose 文件）：

```yaml
environment:
  SONGLOFT_API_URL: http://songloft-host:58091/api/v1
  SONGLOFT_USERNAME: <Songloft 用户名>
  SONGLOFT_PASSWORD: <Songloft 密码>
  # 可选：使用预先生成的访问令牌时可省略用户名/密码
  # SONGLOFT_ACCESS_TOKEN: <access token>
  SONGLOFT_SUBSONIC_URL: http://songloft-host:58091/api/v1/jsplugin/subsonic
  SONGLOFT_SUBSONIC_USERNAME: <Songloft 用户名>
  SONGLOFT_SUBSONIC_PASSWORD: <Songloft 密码>
  SONGLOFT_SCAN_ON_DOWNLOAD: "true"
```

适配器会自动把 Subsonic 根地址规范化为 `/rest`。Songloft 原生 API 用于歌单写入和扫描；原生 API 不可用时，Subsonic 只用于只读歌单列表和歌曲搜索匹配。下载永远走音云自己的洛雪解析/下载队列，不会调用 Songloft、MusicHub 或 Navidrome 的下载能力。

## 音云 API

所有接口都需要音云自己的 Bearer 登录令牌：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/v1/integration/songloft/status` | 检查原生 API / Subsonic 连通性，不返回凭据 |
| GET | `/api/v1/integration/songloft/playlists` | 读取 Songloft 歌单（优先原生 API，必要时 Subsonic 回退） |
| POST | `/api/v1/integration/playlist/resolve` | 把音云可用音源的网络歌单解析成统一歌曲列表；支持 `source + id` 或常见分享 URL |
| POST | `/api/v1/integration/playlist/import` | 导入第三方网络歌单（`source + id`、分享 URL 或直接歌曲列表）；按本地曲库匹配，并建立可补齐的音云歌单和导入账本 |
| GET | `/api/v1/integration/playlist/import/{importId}` | 重新扫描本地曲库，查看该导入歌单的 matched/ambiguous/missing 状态 |
| POST | `/api/v1/integration/playlist/complete` | `mode: "selected"` 手工补齐；`mode: "all"` 或 `all: true` 一键补齐所有明确缺失歌曲 |
| POST | `/api/v1/integration/match` | 对输入歌曲同时匹配音云已下载曲库和 Songloft 曲库，返回 matched/ambiguous/missing |
| POST | `/api/v1/integration/playlists/sync` | `push` 音云→Songloft、`pull` Songloft→音云、`merge` 双向合并；`replace` 只允许 push |
| POST | `/api/v1/integration/songloft/scan` | 显式触发 Songloft 共享目录扫描 |
| GET | `/api/v1/integration/songloft/scan` | 读取扫描进度 |
| GET | `/api/v1/integration/library/status` | 读取音云与 Songloft 当前索引数量和扫描状态；不分页读取 Songloft 全曲库 |
| POST | `/api/v1/integration/library/refresh/yinyun` | 只刷新音云下载索引，不触发 Songloft 扫描 |
| POST | `/api/v1/integration/library/refresh/songloft` | 只触发 Songloft 扫描，不重建音云索引 |
| POST | `/api/v1/integration/library/refresh` | 同时刷新音云下载索引并提交 Songloft 扫描；匹配前建议执行一次 |

匹配优先级为共享相对路径、ISRC、指纹，再按标题/艺术家/专辑/时长和版本标记进行保守模糊匹配。低于阈值或候选过于接近的歌曲不会自动写入歌单。

## 建议工作流

1. 用 `/integration/playlist/import`（`source + id` 或 `url`）导入第三方音乐播放软件歌单；也可直接传入统一的 `tracks` 数组。URL 只用于识别音云已配置的网络音源和歌单 ID，实际下载仍走音云；导入时只把明确本地匹配项标记为已收录，歧义项不会自动下载。
2. 查看返回的 `importId`，或调用 `/integration/playlist/import/{importId}` 刷新本地状态。`items[].downloadable` 明确表示该歌曲是否能由当前音云音源下载。
3. 手工补齐：传 `mode: "selected"` 与 `indexes`/`trackIds` 到 `/integration/playlist/complete`；一键补齐：传 `mode: "all"`（只会加入明确 `missing` 项，`ambiguous` 仍需人工确认）。接口只把任务加入音云现有下载队列，队列仍由洛雪搜索下载、元数据处理和归档完成。
4. 下载完成后，若配置了 Songloft，音云会对连续完成的任务做防抖扫描触发；也可显式调用 `/integration/songloft/scan`，再刷新导入状态。
5. 已匹配项和下载后的本地歌曲可用 `/integration/playlists/sync` 的 `push` 写入 Songloft 歌单；Songloft 中共享目录已有但音云歌单没有的本地歌曲，可用 `pull` 写回音云歌单。音云会保留 `local_...` 标识和文件路径。

管理后台提供三个独立按钮：“刷新音云索引”只重建当前音云用户在两个存储位置的下载索引；“刷新 Songloft 索引”只提交 Songloft 扫描；“刷新状态”只读取两端计数、扫描状态、补齐队列和歌单，不会再次分页读取 Songloft 全曲库。联合刷新接口则依次执行前两项并清空匹配缓存。Songloft 扫描是异步任务，返回“已提交”不代表扫描已完成；应等待扫描状态为“已完成”后再打开导入记录或重新匹配。两套软件共用物理目录，但索引更新时间、挂载路径、元数据读取和扫描完成时间仍可能不同，所以“音云 2 首、Songloft 64 首”并不矛盾；执行刷新可以缩小差异，但无法把元数据缺失或标题差异强行变成可靠匹配。

播放器中创建、重命名、收藏歌曲到歌单或收藏外部歌单后，会自动延迟同步到 Songloft；侧边栏歌单的旋转箭头提供手动“同步到 Songloft”。播放器使用当前用户令牌，默认采用 `push + merge`：同名 Songloft 歌单复用，不存在则创建，只追加，不删除远端歌曲。管理后台仍可选择 `pull`、`merge` 或明确的 `replace`。

### `subsonic.onlineSearch` 是什么

此开关只控制音云暴露给第三方 Subsonic/OpenSubsonic 播放器的“搜索”接口。开启时，Subsonic 会先查本地曲库，再按 `subsonic.onlineSearchMode` 在结果不足时或合并模式下查询配置的在线平台；它返回可播放的在线搜索结果，不会下载文件、写入音云下载队列、刷新 Songloft，也不会增加本地匹配数量。要让导入歌单与共享曲库一致，应使用“刷新双端索引”，而不是开启此开关。

同步账本保存在音云数据目录 `playlist-sync/<user>.json`，记录双方最后共同歌曲集合及哈希，用于后续合并和冲突提示。默认 `merge` 只追加，不删除远端歌曲；只有明确使用 `mode: "replace"` 的 `push` 才会移除 Songloft 歌单中的多余歌曲。

导入账本保存在音云数据目录 `playlist-import/<user>.json`，只保存第三方歌单的规范化歌曲信息和对应音云歌单 ID，不保存 Songloft 凭据。管理界面默认把这些账本按“歌单名称（来源、歌曲数、最近更新时间）”放进下拉框，普通使用不需要记忆技术 ID；同一个来源和歌单再次导入时会复用最近账本和音云歌单，不再创建新的副本。旧版本已经产生的重复账本仍会显示为“历史副本”，需要用户确认后再在播放器中合并或删除。只有排查问题、跨设备恢复或调用 API 时，才需要展开“高级：导入记录 ID”；首次导入成功后 ID 会自动填入，也可以从结果卡片复制。选择歌单后点击“打开记录”会重新读取源歌曲并扫描当前音云索引和 Songloft 共享曲库，恢复最新的已收录/缺失/歧义状态，不需要重新粘贴网络歌单链接。

补齐队列会在打开“曲库联动”页面时加载，并且只有该面板处于前台可见时才每 4 秒自动刷新；离开面板或切到后台会停止轮询，避免已登录但未维护歌单的浏览器持续增加请求。点击“一键补齐全部缺失”成功入队后会立即重新读取队列和导入匹配结果。

队列是持久化的历史账本，不会在任务完成后自动清空。每一行会显示歌曲所属歌单、加入队列时间，以及完成时间或失败时间；旧版本没有保存歌单字段的历史任务会标记为“未关联歌单”，新导入任务会写入导入歌单名称和导入记录。失败行会保留错误原因，并提供“重试”“换源”和“移除”：

- “重试”沿用当前选择的音源和音质重新入队，并累计重试次数；适合网络超时、临时解析失败等情况。
- “换源”打开“聚合”候选搜索，可在所有已启用音源的结果中试听并采用一个版本；采用后会替换该失败任务的歌曲来源并立即重新入队，也可以切换到单一音源再搜索。
- “移除”只删除队列中的待处理记录，不删除已经存在的音乐文件。

一键补齐默认使用“聚合”搜索结果，从已启用的音云音源中选择可下载版本；手工补齐才使用用户在候选对话框中明确采用的版本。失败任务置顶显示，保证历史较早的失败项仍能直接操作。

播放器的“我的歌单”与原有“歌单”使用同一套卡片网格、详情页和歌曲行渲染；个人歌单额外提供搜索、封面选择和 Songloft 同步入口。歌单封面元数据由音云保存：用户可以选择歌单中的任意一首歌，未选择时自动使用第一张可用歌曲封面；读取歌单详情时，如果音云原始歌曲没有封面，会只读回退到 Songloft 的歌曲 artwork。当前 Songloft/OpenSubsonic 部署的标准 `getPlaylist` 响应没有可写的跨实现歌单封面字段，因此封面选择不会写入 Songloft，也不会修改 Songloft 源码；两个播放器仍共享同一首歌曲的封面资源。

## 共享曲库匹配范围

网络歌单导入和导入记录刷新会联合检查两套索引：

1. 音云用户已建立的本地音乐索引；
2. Songloft 已扫描到的共享音乐目录。

两套索引的结果不会互相覆盖：两边都找到时显示“双端已找到”；只有音云找到时显示“音云已收录，Songloft 待扫描”；只有 Songloft 找到时显示“共享文件已存在，等待音云索引”；两边都没有可靠匹配时才显示“可加入音云下载”。只有最后一种情况会进入音云洛雪下载队列。匹配器优先使用共享相对路径（并要求标题或艺术家、专辑、时长至少一项元数据通过校验）、ISRC、指纹，再使用标题、艺术家、专辑、时长等精确索引；最后才使用模糊候选，并对大曲库避免逐首全量暴力比较。相对路径只是两个索引指向同一物理文件的身份锚点，不会绕过元数据校验，也不会把任意同名歌曲强行判定为命中。结果中的 `matchedBy` 会标明最终复用的是 `yinyun` 还是 `songloft` 索引，`availability.yinyun` 与 `availability.songloft` 则保留两边的独立状态。

### 为什么要同时识别元数据和使用相对路径

“音云命中相对路径作为共享文件锚点”不是把一个模糊候选的分数硬加到阈值以上，而是把两个独立索引通过同一个物理文件键连接起来。比如音云索引中的 `neteasy/高梨康治 - 五月雨.flac` 与 Songloft 返回的 `/music/neteasy/高梨康治 - 五月雨.flac`，去掉各自容器挂载前缀后是同一个文件；即使两个服务从嵌入标签或来源返回了不同艺术家、专辑，桥接层仍能识别它们指向同一文件。

这不能替代元数据识别，所以音云索引刷新时会优先读取音频嵌入的标题、艺术家、专辑和时长，并对历史的 `unknown_*`/文件名反解析条目做一次修正。匹配器随后按“相对路径 → ISRC → 指纹 → 标准化标题/艺术家/专辑/时长 → 模糊候选”执行。相对路径命中还必须通过元数据 sanity check：精确 ISRC/指纹，或标题一致且艺术家、专辑、时长至少一项一致，才返回 `relative_path_metadata`；路径相同但标题和时长等都冲突时返回 `relative_path_conflict`（分数 0.72，低于 0.76 阈值），仍然是未匹配。因而 `score: 1` 表示“同一物理文件且基本元数据一致”的确定性身份，不是把低置信度模糊结果人为抬高。

仅做元数据识别仍不足以让 Songloft 和音云完全一致：两者各自维护索引和标签解析结果，且本项目不能修改 Songloft 源码。元数据识别负责把音云自己的索引修正到可靠状态；相对路径负责在允许的 API 桥接层把两套索引重新连接。两者结合，既能解决 `五月雨` 这类“同一文件、艺术家字段不同”的 13/12 差异，也能拒绝路径偶合但标题完全不同的陈旧索引项。

## 同名歌单的处理规则

同步接口的目标歌单选择按以下顺序处理：

- 如果请求明确提供 Songloft 歌单 ID，始终使用这个指定歌单，即使它和音云歌单名称不同；接口返回 `playlistResolution: "explicit"`。
- 如果没有指定 ID，则按规范化后的名称查找 Songloft 歌单。名称会进行 Unicode 规范化、去除首尾空格并合并连续空格；找到唯一同名歌单时直接复用，不会重复创建，返回 `playlistResolution: "existing_name"`。
- 如果没有同名歌单，才创建一个与音云歌单同名的 Songloft 歌单，返回 `playlistResolution: "created"`。
- 如果 Songloft 中存在多个同名歌单，接口返回 `409 songloft_playlist_name_ambiguous`，要求在管理界面明确选择目标歌单，避免把歌曲写入错误的歌单。

选择目标后，`merge` 只追加不删除；只有明确选择 `push + replace` 才会按音云歌单覆盖 Songloft。覆盖同步在存在未匹配歌曲时会整体取消，不会先删除远端已有歌曲。
