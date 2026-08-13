# Incremental deployment image on top of v23. Only the integration bridge and
# management UI are overlaid; Songloft/Navidrome remain untouched.
FROM yinyun-lxserver:integration-20260813-v23
WORKDIR /server
COPY server/server/apiV1.js ./server/apiV1.js
COPY server/server/fileCache.js ./server/fileCache.js
COPY server/server/playlistIntegration.js ./server/playlistIntegration.js
COPY server/server/server.js ./server/server.js
COPY public ./public
