# v46: final responsive queue guard and built-in playlist card rhythm.
# Rebase on v41 to keep Docker's legacy layer depth bounded.
FROM yinyun-lxserver:integration-20260814-v41
WORKDIR /server
COPY build-server/server/apiV1.js ./server/apiV1.js
COPY build-server/modules/list/listDataManage.js ./modules/list/listDataManage.js
COPY public/index.html ./public/index.html
COPY public/style.css ./public/style.css
COPY public/js/library-integration.js ./public/js/library-integration.js
COPY public/music/app.js ./public/music/app.js
COPY public/music/index.html ./public/music/index.html
COPY public/music/css/app.css ./public/music/css/app.css
COPY public/music/js/songlist_manager.js ./public/music/js/songlist_manager.js
