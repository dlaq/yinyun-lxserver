# v47: refresh signed local artwork URLs in the player playlist detail.
# The native snapshot can retain an expired media token. Rebase on v41 so the
# legacy Docker builder stays below its layer-depth limit, and copy the full
# current integration surface so no v42-v46 UI/API layer is lost. Songloft and
# Navidrome are not rebuilt.
FROM yinyun-lxserver:integration-20260814-v41
WORKDIR /server
COPY public/music/app.js ./public/music/app.js
COPY build-server/server/apiV1.js ./server/apiV1.js
COPY build-server/modules/list/listDataManage.js ./modules/list/listDataManage.js
COPY public/index.html ./public/index.html
COPY public/style.css ./public/style.css
COPY public/js/library-integration.js ./public/js/library-integration.js
COPY public/music/index.html ./public/music/index.html
COPY public/music/css/app.css ./public/music/css/app.css
COPY public/music/js/songlist_manager.js ./public/music/js/songlist_manager.js
