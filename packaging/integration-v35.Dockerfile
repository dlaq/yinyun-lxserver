# Incremental integration image.  It keeps the v29 runtime and layers the
# current Yinyun API/UI; no music data or Songloft/Navidrome source is copied.
FROM yinyun-lxserver:integration-20260813-v29
WORKDIR /server
COPY server/server/apiV1.js ./server/apiV1.js
COPY server/server/playlistIntegration.js ./server/playlistIntegration.js
COPY server/server/songloftClient.js ./server/songloftClient.js
COPY public/index.html ./public/index.html
COPY public/style.css ./public/style.css
COPY public/js/library-integration.js ./public/js/library-integration.js
COPY public/music/index.html ./public/music/index.html
COPY public/music/app.js ./public/music/app.js
COPY public/music/js/common_ui.js ./public/music/js/common_ui.js
COPY public/music/js/single_song_ops.js ./public/music/js/single_song_ops.js
