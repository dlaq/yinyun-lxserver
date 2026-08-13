# Incremental deployment image. The upstream image remains the base; only the
# isolated integration bridge and its management UI are overlaid.
FROM yinyun-lxserver:integration-20260813-v21
WORKDIR /server
COPY server/server/apiV1.js ./server/apiV1.js
COPY server/server/fileCache.js ./server/fileCache.js
COPY server/server/playlistIntegration.js ./server/playlistIntegration.js
COPY server/server/server.js ./server/server.js
COPY public ./public
