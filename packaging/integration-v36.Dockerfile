# Incremental integration image.  It keeps the v35 runtime and layers the
# local-candidate preview and stale-import-state fixes; music data and the
# Songloft/Navidrome containers are not copied or rebuilt.
FROM yinyun-lxserver:integration-20260814-v35
WORKDIR /server
COPY public/js/library-integration.js ./public/js/library-integration.js
COPY public/music/app.js ./public/music/app.js
