# 音云上游合并边界

本仓库的曲库联动是一个可剥离的 integration bridge，不修改 Songloft，也不把 MusicHub 或 navidrome-ai-playlist 变成第二条下载链路。下载仍只由音云洛雪队列负责，外部复制到共享音乐目录的文件由两端各自扫描。

## 保留的边界

- `src/server/playlistIntegration.ts`：跨来源的统一歌曲模型、规范化、路径/ISRC/指纹/元数据/时长和模糊匹配策略，以及导入账本。
- `src/server/apiV1.ts`：以 `[YINYUN-INTEGRATION]` 注释标出的曲库状态、独立索引刷新、歌单导入、确认和 Songloft 同步适配层。
- `src/server/fileCache.ts`：只在音云索引层补充嵌入标签优先规则，修复共享目录中艺术家优先文件名被反解析的问题；不改变下载器和上游音源协议。
- `public/index.html`、`public/style.css`、`public/js/library-integration.js`：管理后台的联动界面；`public/app.js` 只保留播放器入口修复。

## 将来合并音云上游版本

1. 先合并上游原始提交，保留上游的下载、播放器和 API 代码。
2. 只重新应用上述四个边界文件中的 `[YINYUN-INTEGRATION]` 区块；不要把生成的 `server/` 目录作为源码冲突源。
3. 如果上游改变 `CacheItem`、歌单结构或静态入口，先适配 bridge 的类型和路由，再运行定向 TypeScript 构建与 HTTP smoke。
4. Songloft API URL、共享目录和管理员设置继续通过环境变量/设置项注入，不把部署凭据写入源码。

## 匹配策略

四个项目的可取信息统一归一到 `IntegrationTrack`：相对路径优先，其次 ISRC、指纹，再是标准化标题/艺术家/专辑/时长，最后才使用模糊候选。最佳候选与第二候选过近时显示“需要确认”，用户选择后仅写入导入账本，不自动下载或删除文件。这样两个软件即使索引刷新时机不同，也不会用不同的文件名猜测覆盖可靠的嵌入标签。
