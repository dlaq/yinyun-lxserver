# v51: local-first preview, editable source search, safe playlist replacement,
# and a viewport-safe draggable single-song preview player.
# Rebase on v41 to keep the legacy Docker builder below its layer-depth limit.
# Only the Yinyun image is rebuilt; Songloft and Navidrome remain external services.
FROM yinyun-lxserver:integration-20260814-v41
WORKDIR /server
COPY build-server/server/ ./server/
COPY build-server/modules/list/listDataManage.js ./modules/list/listDataManage.js
COPY public/ ./public/
