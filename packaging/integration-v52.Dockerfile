# v52: rebuild from the complete current public tree so the Web Player keeps
# the current "我的歌单" navigation and detail-page implementation.
# Rebase on v41 to keep the legacy Docker builder below its layer-depth limit.
# Only the Yinyun image is rebuilt; Songloft and Navidrome remain external services.
FROM yinyun-lxserver:integration-20260814-v41
WORKDIR /server
COPY build-server/server/ ./server/
COPY build-server/modules/list/listDataManage.js ./modules/list/listDataManage.js
COPY public/ ./public/
