# Incremental integration image.  It keeps the v36 runtime and only layers
# the aggregate search, queue history/actions, and player UI changes.
# Songloft/Navidrome containers and shared music data are not copied or rebuilt.
FROM yinyun-lxserver:integration-20260814-v36
WORKDIR /server
COPY build-server/apiV1.js ./server/apiV1.js
COPY build-server/serverDownloadQueue.js ./server/serverDownloadQueue.js
COPY public/app.js ./public/app.js
COPY public/index.html ./public/index.html
COPY public/style.css ./public/style.css
COPY public/js/library-integration.js ./public/js/library-integration.js
COPY public/music/app.js ./public/music/app.js
COPY public/music/index.html ./public/music/index.html
COPY public/music/js/songlist_manager.js ./public/music/js/songlist_manager.js
