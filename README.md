# 音云 Yinyun

<p align="center"><img src="public/icon.svg" width="120" height="120" alt="音云 Yinyun"></p>

<div align="center">
  <!-- <img src="public/icon.svg" width="120" height="120" alt="Icon"> -->
  <!-- <br>
  <h1>音云 Yinyun</h1> -->
  <p>
    <img src="https://img.shields.io/badge/build-passing-brightgreen?style=flat-square" alt="Build Status">
    <img src="https://img.shields.io/badge/version-v1.5.6-blue?style=flat-square" alt="Version">
    <img src="https://img.shields.io/badge/node-%3E%3D22.12-green?style=flat-square" alt="Node Version">
    <img src="https://img.shields.io/github/license/dlaq/yinyun-lxserver?style=flat-square" alt="License">
    <br>
    <br>
    <a href="https://github.com/dlaq/yinyun-lxserver/stargazers"><img src="https://img.shields.io/github/stars/dlaq/yinyun-lxserver?style=flat-square&color=ffe16b" alt="GitHub stars"></a>
    <a href="https://github.com/dlaq/yinyun-lxserver/network/members"><img src="https://img.shields.io/github/forks/dlaq/yinyun-lxserver?style=flat-square" alt="GitHub forks"></a>
    <a href="https://github.com/dlaq/yinyun-lxserver/issues"><img src="https://img.shields.io/github/issues/dlaq/yinyun-lxserver?style=flat-square&color=red" alt="GitHub issues"></a>
    <a href="https://github.com/dlaq/yinyun-lxserver/commits/main"><img src="https://img.shields.io/github/last-commit/dlaq/yinyun-lxserver?style=flat-square&color=blueviolet" alt="Last Commit"></a>
    <img src="https://img.shields.io/github/commit-activity/m/dlaq/yinyun-lxserver?style=flat-square&color=ff69b4" alt="Commit Activity">
    <a href="https://github.com/dlaq/yinyun-lxserver/releases"><img src="https://img.shields.io/github/downloads/dlaq/yinyun-lxserver/total?style=flat-square&color=blue" alt="Total Downloads"></a>
  </p>
</div>

[帮助文档 Documentation](https://dlaq.github.io/yinyun-lxserver/) | [项目交接与维护手册](PROJECT_HANDOFF.md) | [同步服务器 SyncServer](md/lxserver.md) | [Songloft 曲库联动说明](docs/songloft-playlist-integration.md) | [更新日志 Changelog](changelog.md) | [English](README_EN.md)

---

**音云（Yinyun）** 是一个洛雪魔改的，面向私有部署的音乐服务器，内置 Web 播放器、下载与本地曲库管理，支持独立 Windows 客户端账户快照和 Subsonic 客户端。

> [!IMPORTANT]
> v1.5.0 调整了固定访问入口：根地址 `/` 为 Web 播放器，管理后台为 `/admin`，旧 `/music` 网页入口已删除。`/api/v1`、Subsonic `/rest` 以及 `/server/music` 音频持久化目录不受影响。

## dlaq 部署分支：曲库联动、健康检查与节能模式

本仓库的 `dlaq/yinyun-lxserver` 部署分支在保留上游播放器和服务端接口的基础上，增加了与本地 Songloft/Navidrome 共享曲库配合使用的用户侧功能。Songloft 源码没有修改，联动只通过它暴露的原生 API、OpenSubsonic API 和可配置的曲库扫描接口实现，便于将来合并音云上游版本。

- **所有播放器用户先登录。** 打开 `/`、刷新页面或点击播放器功能时，未登录用户会看到登录框；登录后才可以搜索、播放、维护自己的歌单和导入记录。管理员后台仍使用 `/admin` 与 `FRONTEND_PASSWORD`。
- **我的歌单与曲库联动。** 左侧主菜单的“我的歌单”和“曲库联动”是同级入口。用户可按歌单名称选择旧导入记录、导入第三方歌单、查看音云/Songloft 独立匹配数、手工或一键补齐、重试/换源失败任务，并把个人歌单同步到 Songloft。普通用户只能删除歌单或队列记录；删除共享音乐文件仍要求管理员凭据。
- **聚合音源和试听。** “聚合”会并行搜索已启用的网易、QQ、酷我、酷狗、咪咕、百度等源，结果仍标明真实来源。选择版本前可编辑关键字；已有本地文件时先显示并可试听，不会自动发起在线搜索。试听播放器是可拖动的小型浮层，不会驱动主播放器或自动播放下一首。
- **队列历史。** 补齐队列保留历史累计统计，每项显示所属歌单、加入时间、完成/失败时间和错误原因；失败项提供重试、换源和移除。队列轮询只在用户停留在“曲库联动”且浏览器页面可见时运行（4 秒一次），离开页面或切到后台立即停止。
- **健康检查。** 设置中的“曲源健康检查”按参考项目的逻辑使用一个测试关键词，逐个测试当前账户可见的每个自定义音源及其平台（搜索一次并验证可解析播放链接），不按歌单乘倍抽查歌曲，也不下载文件。结果显示绿色/黄色/红色计数、音源×平台矩阵和“问题明细”对话框；错误行可以删除当前账户自己的自定义音源。支持启用/禁用、Cron、测试关键词和连续失败阈值，并可分别启用 [message-pusher](https://github.com/songquanpeng/message-pusher)、Bark、Server酱告警；密钥只保存在服务端用户数据目录，界面不会回显。
- **节能模式。** 设置中打开“节能模式”后会关闭页脚/详情波形、背景模糊和高频过渡动画，保留正常播放和歌单功能，以降低 Web 播放器 GPU/CPU 占用。若仍需进一步降低占用，可同时关闭普通可视化器和歌词荧光效果。
- **标签含义。** 歌曲卡片上的 `网易` 表示该行记录的在线来源是网易云（`wy`）；`LOCAL` 表示已解析到共享本地音乐文件，来自音云/Songloft 的本地索引或直接拷贝的音乐，不表示又下载了一份文件。`Songloft`、`Subsonic` 等标签同理表示解析或匹配所使用的来源。

### Docker 镜像与 Compose 文件

Docker 文件就在仓库根目录：[`Dockerfile`](Dockerfile)、[`.dockerignore`](.dockerignore) 和 [`docker-compose.yml`](docker-compose.yml)。GitHub Actions 使用仓库 Secrets `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN` 登录 Docker Hub，并在推送 `main` 或 `v*` 标签时构建并发布经过远端验证的 `linux/amd64` 镜像；令牌不会出现在 README、镜像层或日志中。ARM 镜像不通过 QEMU 交叉构建，需在原生 ARM runner 上按同一 Dockerfile 构建。

如果这是从上游 fork 的仓库，第一次使用时请打开 [Actions → Build and Push Docker Image](https://github.com/dlaq/yinyun-lxserver/actions/workflows/docker.yml)，按页面提示启用本仓库的 Actions；也可以点击 **Run workflow**、选择 `main` 手动构建。若 Actions 页面显示 “This workflow has no runs yet”，通常就是 fork 的 Actions 尚未启用，不能仅靠推送代码生成 Docker Hub 镜像。

拉取最新镜像：

```bash
docker pull dlaq/yinyun-lxserver:latest
```

当前 Compose 文件内容（共享音乐目录应与 Songloft/Navidrome 挂载到同一宿主机目录）：

```yaml
services:
  yinyun:
    image: dlaq/yinyun-lxserver:latest
    container_name: yinyun
    restart: unless-stopped
    ports:
      - "9527:9527"
    volumes:
      - ./data:/server/data
      - ./logs:/server/logs
      - ./cache:/server/cache
      - ./music:/server/music/${LX_MUSIC_USER:-admin}
    environment:
      NODE_ENV: production
      TZ: Asia/Shanghai
      DATA_PATH: /server/data
      LOG_PATH: /server/data/logs
      CONFIG_PATH: /server/data/config.js
      # 以下变量按实际部署填写，不要提交密码或令牌：
      # SONGLOFT_API_URL: http://songloft-host:58091/api/v1
      # SONGLOFT_USERNAME: your-songloft-user
      # SONGLOFT_PASSWORD: your-songloft-password
      # SONGLOFT_SUBSONIC_URL: http://songloft-host:58091/api/v1/jsplugin/subsonic
      # SONGLOFT_SUBSONIC_USERNAME: your-songloft-user
      # SONGLOFT_SUBSONIC_PASSWORD: your-songloft-password
      # SONGLOFT_SCAN_ON_DOWNLOAD: "true"
```

启动或升级：

```bash
docker compose pull
docker compose up -d
```

保留 `/server/data`、`/server/logs`、`/server/cache` 和 `/server/music/<用户>` 挂载，不要把远端快满的分区作为 Docker 构建上下文或临时目录。

### 本次联动版改动清单

| 模块 | 行为 |
| --- | --- |
| 登录与权限 | Web 播放器所有用户必须登录；登录会复用 `/verify` 返回的会话令牌，歌单同步在前台最多等待 3 秒，超时转后台；退出不再等待远端注销或缓存清理。管理员后台仍由 `FRONTEND_PASSWORD` 保护，普通用户不能删除共享音乐文件。 |
| 我的歌单 | “我的歌单”和“曲库联动”为同级菜单，导入记录按歌单名称下拉选择；导入、删除、重命名和同步动作按账户隔离，并通过 Songloft 原生 API/OpenSubsonic API 同步，不修改 Songloft 源码。 |
| 联合匹配 | 音云索引、Songloft 共享曲库和物理共享文件使用同一套标题/艺术家/专辑/时长/相对路径规则；已存在的本地文件即使某一端索引落后，也会显示为可直接采用，不重复下载。对近似候选保留“需要确认”，确认本地版本会写入导入账本。 |
| 补齐与试听 | 一键补齐使用“聚合”音源（已启用的平台并行搜索）；手工补齐可编辑关键词、切换音源、试听和选择版本。试听本地文件不会触发下载；采用在线版本会等待下载完成后替换原文件并同步两端歌单。浮动试听播放器独立于主播放器，不自动播放下一首。 |
| 队列 | 保留累计状态、歌单、加入/完成/失败时间和错误原因；失败任务支持重试、换源、移除，队列轮询仅在联动页面且页面可见时运行。 |
| 设置与外观 | 自定义源默认折叠；主题、外观、默认入口和节能模式保存到用户设置接口，重新登录/重启后恢复。联动页面使用主题变量，浅色主题不会再出现黑色详情面板；服务器名称写入持久化 `CONFIG_PATH` 并同步播放器标题。 |
| 日志与发布 | Docker 默认设置 `TZ=Asia/Shanghai`，log4js 文件/控制台统一输出本地时间格式；GitHub Release 检查改为 6 小时缓存、失败退避，不参与登录、歌单或联动请求。 |

GitHub Release 接口只用于播放器右上角的版本/更新提示。GitHub 对未认证 REST 请求按 IP 限流，短时间刷新或多个浏览器共用出口时可能收到 403/限流；这不会影响本地 API、登录、播放、歌单或曲库联动。客户端现在优先使用本地缓存，非手动检查失败后退避一小时；手动检查仍可立即重试。

## 项目地址与推荐使用方式

- **服务端：** [dlaq/yinyun-lxserver](https://github.com/dlaq/yinyun-lxserver)
  支持使用 Docker 搭建，也提供 Windows、macOS 等平台的安装包。
- **Windows 客户端：** [bobcc4/yinyun-windows](https://github.com/bobcc4/yinyun-windows)
  当前仅制作了 Windows 客户端；其他平台更推荐使用成熟的第三方客户端。

**推荐使用方式：** 在 NAS 或服务器上通过 Docker 部署音云服务端，再使用音流、箭头音乐等支持 Subsonic 的第三方客户端连接。客户端填写服务端 `IP:端口`，并使用音云用户名和密码登录即可。

使用 Lucky 等工具进行反向代理时，请确保放行 `/rest/*` 路径。

**交流群：** [点击加入音云 issue 反馈群](https://qm.qq.com/q/MW7cns1eMe)

## ✨ Web 播放器核心特性

### 1. 多平台搜索与播放

支持聚合搜索主流音乐平台，搜索结果可直接播放、收藏或下载，并可按平台和内容类型快速切换。

<p align="center">
  <img src="docs/public/screenshots/web-search.png" width="900" alt="Web 播放器在线搜索">
</p>

### 2. 本地曲库管理

自动扫描 `/music` 与 `/cache`，支持多层目录、快速搜索、高级布尔筛选、批量选择、歌单收藏和元数据管理。

<p align="center">
  <img src="docs/public/screenshots/web-local-music.png" width="900" alt="本地音乐曲库">
</p>

### 3. 八档音质与服务器下载

支持标准、高品、无损、24bit 无损、高解析度、空间音频、增强空间音频和母带音质。下载前会显示解析到的文件大小及最终来源平台，服务端下载队列可在关闭浏览器后继续运行。

<p align="center">
  <img src="docs/public/screenshots/web-download-quality.png" width="900" alt="下载音质、文件大小和来源平台">
</p>

### 4. 本地歌曲洗版

可筛选并批量选择本地歌曲，按指定目标音质重新下载；目标音质不可用时可按规则降级，并在任务结果中列出成功与失败歌曲。

<p align="center">
  <img src="docs/public/screenshots/web-remaster.png" width="900" alt="歌曲洗版选择页面">
</p>

### 5. 播放器设置与自定义源

支持默认音质、缓存与下载、代理、歌词、主题、音效和播放行为设置。外置与内嵌歌词可分别选择逐行、逐字或增强型 LRC，TX 支持原生 QRC 逐字歌词。同步账户可按音源选择启用平台；管理员共享完整音源后，接收者可独立配置自己使用的平台。

<p align="center">
  <img src="docs/public/screenshots/web-settings.png" width="900" alt="播放器设置与自定义源">
</p>

### 6. 服务状态与维护

管理后台集中展示连接数、用户数、运行时间和资源占用，并提供数据、快照、WebDAV、日志和系统维护入口。

<p align="center">
  <img src="docs/public/screenshots/admin-dashboard.png" width="900" alt="管理后台仪表盘">
</p>

### 7. 用户与权限管理

支持创建和管理同步账户、标识管理员身份，并隔离各用户的歌单、设置、自定义源、缓存与下载目录。

<p align="center">
  <img src="docs/public/screenshots/admin-users.png" width="900" alt="用户管理页面">
</p>

### 8. 服务器配置

可在后台配置访问路径、Subsonic、WebDAV、缓存限制、代理和其他服务端选项，Docker 环境变量仍具有最高优先级。

<p align="center">
  <img src="docs/public/screenshots/admin-config.png" width="900" alt="系统配置页面">
</p>

### 9. Subsonic 协议与全网检索

适配 Subsonic 协议，可使用音流、LMP、Feishin 等客户端连接本地曲库和歌单。搜索支持 `wy:`、`kg:`、`tx:`、`kw:`、`mg:` 平台前缀，以及 `online:` / `local:` 范围前缀。`subsonic.onlineSearch` 只控制第三方 Subsonic 客户端的在线搜索结果，不会下载文件、写入补齐队列或改变本地曲库匹配；两端索引需要在管理后台使用“刷新双端索引”。

## 🔒 访问控制与安全

管理后台使用 `FRONTEND_PASSWORD` 保护服务器配置；Web 播放器中的歌单、自定义源、下载与个人设置由同步账户认证并按用户隔离。通过公网访问时，建议同时在反向代理层启用 HTTPS 和访问控制。

## 🚀 快速启动

本项目基于 **Node.js** 开发，支持多种部署方式。

直接运行源码需要 Node.js `22.12.0` 或更高版本，推荐使用 Node.js 24 LTS。

### 方式一：Windows 客户端

独立 [音云 Windows 客户端](https://github.com/bobcc4/yinyun-windows) 连接 NAS 上已部署的服务端，不会在电脑上启动第二套服务。客户端使用服务器地址、同步账户用户名和密码登录，并在 Windows 安全存储中保留加密账户快照。

当服务端容器和全部持久化数据意外丢失时，重新部署服务端并创建相同的小写用户名，客户端会在确认服务端账户为空后提示恢复。音频、缓存与下载任务不在账户快照内。

### 方式二：使用 Docker

本项目支持从 Docker Hub 或 GitHub Packages 拉取镜像：

- **Docker Hub**: `dlaq/yinyun-lxserver:latest`
- **GitHub Packages**: `ghcr.io/dlaq/yinyun-lxserver:latest`

> [!IMPORTANT]
> Docker 正式镜像已改用 `latest` 标签，原 `v1` 标签停止更新。现有用户必须把 Compose 或 NAS 容器中的镜像改为 `dlaq/yinyun-lxserver:latest`。每次正式发布还会永久保留完整版本标签，例如 `dlaq/yinyun-lxserver:v1.5.6`，用于锁定版本或回滚。数据目录结构没有变化，请保留原有 `/server/data`、`/server/logs`、`/server/cache` 和 `/server/music` 挂载。

**Docker Run 示例：**

```bash
docker run -d \
  -p 9527:9527 \
  -v $(pwd)/data:/server/data \
  -v $(pwd)/logs:/server/logs \
  -v $(pwd)/cache:/server/cache \
  -v $(pwd)/music:/server/music \
  --name yinyun \
  --restart unless-stopped \
  dlaq/yinyun-lxserver:latest
```

**Docker Compose 示例：**

新建 `docker-compose.yml` 文件：

```yaml
services:
  yinyun:
    image: dlaq/yinyun-lxserver:latest
    container_name: yinyun
    restart: unless-stopped
    ports:
      - "9527:9527"
    volumes:
      - ./data:/server/data
      - ./logs:/server/logs
      - ./cache:/server/cache
      - ./music:/server/music
    environment:
      NODE_ENV: production
```

启动服务：

```bash
docker compose up -d
```

升级镜像：

```bash
docker compose pull
docker compose up -d
```

升级容器不会删除已挂载目录。请始终保留 `/server/data`、`/server/logs`、`/server/cache` 和 `/server/music` 的持久化挂载。

### 方式三：直接运行 (Git Clone)

```bash
# 1. 克隆项目
git clone https://github.com/dlaq/yinyun-lxserver.git && cd yinyun-lxserver

# 2. 安装依赖并编译
npm ci && npm run build

# 3. 启动服务
npm start
```

### 方式四：使用 Release 版本

1. 在 GitHub Releases 下载压缩包。
2. 解压后运行 `npm install --production`。
3. 执行 `npm start` 启动。

### 3. 访问说明

- **Web 播放器**: `http://your-ip:9527/`
- **管理后台**: `http://your-ip:9527/admin`（首次部署请通过环境变量设置管理密码；不要使用示例密码）
- **Subsonic**: `http://your-ip:9527/rest`

---

## 🏗️ 项目架构

本项目基于 Node.js 采用前后端分离架构：

- **Backend (Node.js HTTP)**: 用户 API、媒体处理、Subsonic 与 WebDAV 备份。
- **Console (Vanilla JS)**: 固定访问路径为 `/admin`，负责用户与数据管理。
- **WebPlayer (Vanilla JS)**: 固定访问路径为 `/`，负责音乐播放业务。

---

## 🛠️ 配置说明

可以直接编辑 `config.js`。环境变量优先级最高：

| 环境变量                                | 对应配置项                           | 说明                                                               | 默认值             |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ | ------------------ |
| `PORT`                                | `port`                             | 服务端口                                                           | `9527`           |
| `BIND_IP`                             | `bindIP`                           | 绑定 IP                                                            | `0.0.0.0`        |
| `SUBSONIC_ENABLE`                     | `subsonic.enable`                  | 是否启用 Subsonic 协议支持 (服务默认开启)                          | `true`           |
| `SUBSONIC_PATH`                       | `subsonic.path`                    | Subsonic 访问路径 (默认为 `/rest`)                               | `/rest`          |
| `FRONTEND_PASSWORD`                   | `frontend.password`                | Web 管理界面访问密码                                               | 部署时设置         |
| `SERVER_NAME`                         | `serverName`                       | 同步服务名称                                                       | `yinyun`        |
| `MAX_SNAPSHOT_NUM`                    | `maxSnapshotNum`                   | 保留的最大快照数量                                                 | `10`             |
| `CONFIG_PATH`                         | -                                    | 指定外部配置文件的绝对路径                                         | -                  |
| `DATA_PATH`                           | -                                    | 指定数据存储目录的绝对路径                                         | `./data`         |
| `LOG_PATH`                            | -                                    | 指定日志输出目录的绝对路径                                         | `./logs`         |
| `PROXY_HEADER`                        | `proxy.header`                     | 代理转发 IP 头 (如 `x-real-ip`)                                  | -                  |
| `WEBDAV_ENABLE`                       | `webdav.enable`                    | 是否启用 WebDAV 同步与备份                                         | `false`          |
| `WEBDAV_URL`                          | `webdav.url`                       | WebDAV 地址                                                        | -                  |
| `WEBDAV_USERNAME`                     | `webdav.username`                  | WebDAV 用户名                                                      | -                  |
| `WEBDAV_PASSWORD`                     | `webdav.password`                  | WebDAV 密码                                                        | -                  |
| `WEBDAV_SYNC_PATH`                    | `webdav.syncPath`                  | WebDAV 增量同步远端路径                                            | `/lx-sync`         |
| `WEBDAV_BACKUP_PATH`                  | `webdav.backupPath`                | WebDAV 全量备份远端路径                                            | `/lx-sync-backups` |
| `SYNC_INTERVAL`                       | `sync.interval`                    | WebDAV 增量同步检测间隔(分钟)                                      | `60`             |
| `BACKUP_INTERVAL`                     | `sync.backupInterval`              | WebDAV 全量备份间隔(小时)                                          | `24`             |
| `DISABLE_TELEMETRY`                   | `disableTelemetry`                 | 是否禁用匿名数据统计，系统更新提示以及系统公告提示                 | `false`          |
| `ENABLE_LOGIN_USER_CACHE_RESTRICTION` | `user.enableLoginCacheRestriction` | 是否启用登录用户缓存限制 (开启后限非管理员登录用户的缓存设置)      | `false`          |
| `ENABLE_CACHE_SIZE_LIMIT`             | `user.enableCacheSizeLimit`        | 是否启用缓存空间限制 (开启后超出容量将按 LRU 自动清理)             | `false`          |
| `CACHE_SIZE_LIMIT`                    | `user.cacheSizeLimit`              | 缓存空间限制大小 (单位: MB)                                        | `2000`           |
| `LIST_ADD_MUSIC_LOCATION_TYPE`        | `list.addMusicLocationType`        | 添加歌曲到列表时的位置 (`top` / `bottom`)                      | `top`            |
| `PROXY_ALL_ENABLED`                   | `proxy.all.enabled`                | 是否启用外发请求代理 (针对 Music SDK)                              | `false`          |
| `PROXY_ALL_ADDRESS`                   | `proxy.all.address`                | 代理地址 (支持 http:// 或 socks5://)                               | -                  |
| `SINGER_SOURCE_PRIORITY`              | `singer.sourcePriority`            | 歌手信息获取来源优先级 (如 `tx,wy` 或 `wy,tx`)                 | `tx,wy`          |
| `LX_USER_<用户名>`                    | `users` 数组                       | 快速添加用户，值为该用户的密码 (如 `LX_USER_test=123`)           | -                  |

### 仅在 `config.js` 中生效的高级配置项

部分高级选项仅可通过直接修改 `config.js` 进行配置：

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| `subsonic.enableDebug` | 是否开启 Subsonic 调试日志模式 | `true` |
| `subsonic.onlineSearch` | 是否开启 Subsonic 在线全网搜索（仅影响第三方客户端搜索，不触发下载或本地索引） | `true` |
| `subsonic.onlineSearchMode` | Subsonic 在线搜索模式 (`fallback` 回退模式 / `merge` 合并模式 / `local_only` 仅本地) | `"fallback"` |
| `subsonic.onlineSearchSources` | Subsonic 在线搜索默认音源列表 | `"wy,tx,kw,kg,mg"` |
| `subsonic.lyricTranslation` | Subsonic 歌词中是否包含翻译 | `true` |
| `artist.maxFetchPages` | 歌手歌曲最大抓取页数 | `20` |
| `cache.namingPattern` | 缓存文件命名规则 (`simple` / `custom`) | `"simple"` |
| `system.allowUnsafeVM` | 是否允许运行 VM 模式自定义源脚本 (需注意安全风险) | `false` |

---

## 🛡️ 数据收集与隐私说明

本项目集成了 PostHog 匿名数据统计，主要用于：

1. **Bug 追踪**: 收集版本号、环境类型。
2. **通知推送**: 弹出 **版本更新提醒** 与 **紧急维护公告**。

- **绝对匿名**: 绝不收集 IP、用户名或具体歌单内容。
- **关闭方法**: 环境变量设置 `DISABLE_TELEMETRY=true`。**注意：关闭后将无法收到新版本通知。**

---

## 🤝 贡献与致谢

- 修改自 [lyswhut/lx-music-sync-server](https://github.com/lyswhut/lx-music-sync-server)。
- Web 播放器逻辑参考 [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)。
- 接口实现基于 `musicsdk`。

### 👥 贡献者 (Contributors)

<a href="https://github.com/dlaq/yinyun-lxserver/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=dlaq/yinyun-lxserver" />
</a>


## 📈 Star History

[![Star History Chart](md/star-history.svg)](https://github.com/dlaq/yinyun-lxserver/stargazers)



## 📄 开源协议

本项目基于 Apache License 2.0 许可证发行，以下协议是对于 Apache License 2.0 的补充，如有冲突，以以下协议为准。

Apache License 2.0 copyright (c) 2026 [bobcc4](https://github.com/bobcc4)

**词语约定**：本协议中的“本项目”指音云 Yinyun；“使用者”指签署本协议的使用者；“官方音乐平台”指对本项目内置的包括酷我、酷狗、咪咕等音乐源的官方平台统称；“版权数据”指包括但不限于图像、音频、名字等在内的他人拥有所属版权的数据。

### 一、数据来源

1. **官方平台**: 本项目的各官方平台在线数据来源原理是从其公开服务器中拉取数据，经过对数据简单地筛选与合并后进行展示(与未登录状态在官方APP获取的数据相同)，因此本项目不对数据的合法性、准确性负责。
2. **音频数据**: 本项目本身没有获取某个音频数据的能力，所使用的在线音频数据来源来自设置内“自定义源”所选择的“源”返回的在线链接。本项目无法校验其准确性，使用过程中可能会出现播放异常。
3. **其他数据**: 本项目的非官方平台数据（例如“我的列表”内列表）来自服务器存储数据，本项目不对这些数据的合法性、准确性负责。

### 二、免责声明

1. **版权数据**: 使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在 **24 小时内** 清除使用本项目的过程中所产生的版权数据。
2. **责任承担**: 由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害由使用者负责。
3. **法律法规**: 本项目完全免费，且开源发布于 GitHub 面向全世界人用作对技术的学习交流。**禁止**在违反当地法律法规的情况下使用本项目。对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担。

### 三、其他

1. **资源使用**: 本项目内使用的部分包括但不限于字体、图片等资源来源于互联网。如果出现侵权可联系本项目移除。
2. **非商业性质**: 本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。
3. **接受协议**: 若你使用了本项目，即代表你接受本协议。
