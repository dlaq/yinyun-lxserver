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

匹配优先级为共享相对路径、ISRC、指纹，再按标题/艺术家/专辑/时长和版本标记进行保守模糊匹配。低于阈值或候选过于接近的歌曲不会自动写入歌单。

## 建议工作流

1. 用 `/integration/playlist/import`（`source + id` 或 `url`）导入第三方音乐播放软件歌单；也可直接传入统一的 `tracks` 数组。URL 只用于识别音云已配置的网络音源和歌单 ID，实际下载仍走音云；导入时只把明确本地匹配项标记为已收录，歧义项不会自动下载。
2. 查看返回的 `importId`，或调用 `/integration/playlist/import/{importId}` 刷新本地状态。`items[].downloadable` 明确表示该歌曲是否能由当前音云音源下载。
3. 手工补齐：传 `mode: "selected"` 与 `indexes`/`trackIds` 到 `/integration/playlist/complete`；一键补齐：传 `mode: "all"`（只会加入明确 `missing` 项，`ambiguous` 仍需人工确认）。接口只把任务加入音云现有下载队列，队列仍由洛雪搜索下载、元数据处理和归档完成。
4. 下载完成后，若配置了 Songloft，音云会对连续完成的任务做防抖扫描触发；也可显式调用 `/integration/songloft/scan`，再刷新导入状态。
5. 已匹配项和下载后的本地歌曲可用 `/integration/playlists/sync` 的 `push` 写入 Songloft 歌单；Songloft 中共享目录已有但音云歌单没有的本地歌曲，可用 `pull` 写回音云歌单。音云会保留 `local_...` 标识和文件路径。

同步账本保存在音云数据目录 `playlist-sync/<user>.json`，记录双方最后共同歌曲集合及哈希，用于后续合并和冲突提示。默认 `merge` 只追加，不删除远端歌曲；只有明确使用 `mode: "replace"` 的 `push` 才会移除 Songloft 歌单中的多余歌曲。

导入账本保存在音云数据目录 `playlist-import/<user>.json`，只保存第三方歌单的规范化歌曲信息和对应音云歌单 ID，不保存 Songloft 凭据。管理界面中的“已有导入记录 ID”就是这个账本的编号：再次打开时会重新读取源歌曲并扫描当前的音云索引和 Songloft 共享曲库，恢复最新的已收录/缺失/歧义状态，不需要重新粘贴网络歌单链接。

## 共享曲库匹配范围

网络歌单导入和导入记录刷新会联合检查两套索引：

1. 音云用户已建立的本地音乐索引；
2. Songloft 已扫描到的共享音乐目录。

两套索引的结果不会互相覆盖：两边都找到时显示“双端已找到”；只有音云找到时显示“音云已收录，Songloft 待扫描”；只有 Songloft 找到时显示“共享文件已存在，等待音云索引”；两边都没有可靠匹配时才显示“可加入音云下载”。只有最后一种情况会进入音云洛雪下载队列。匹配器会优先使用标题、艺术家、专辑、时长等精确索引，并对大曲库避免逐首全量暴力比较。结果中的 `matchedBy` 会标明最终复用的是 `yinyun` 还是 `songloft` 索引，`availability.yinyun` 与 `availability.songloft` 则保留两边的独立状态。

## 同名歌单的处理规则

同步接口的目标歌单选择按以下顺序处理：

- 如果请求明确提供 Songloft 歌单 ID，始终使用这个指定歌单，即使它和音云歌单名称不同；接口返回 `playlistResolution: "explicit"`。
- 如果没有指定 ID，则按规范化后的名称查找 Songloft 歌单。名称会进行 Unicode 规范化、去除首尾空格并合并连续空格；找到唯一同名歌单时直接复用，不会重复创建，返回 `playlistResolution: "existing_name"`。
- 如果没有同名歌单，才创建一个与音云歌单同名的 Songloft 歌单，返回 `playlistResolution: "created"`。
- 如果 Songloft 中存在多个同名歌单，接口返回 `409 songloft_playlist_name_ambiguous`，要求在管理界面明确选择目标歌单，避免把歌曲写入错误的歌单。

选择目标后，`merge` 只追加不删除；只有明确选择 `push + replace` 才会按音云歌单覆盖 Songloft。覆盖同步在存在未匹配歌曲时会整体取消，不会先删除远端已有歌曲。
