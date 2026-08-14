# Incremental deployment image on top of v29. The overlay contains only the
# playlist-management API, native Songloft client and management UI; it never
# includes or modifies the shared music directory.
FROM yinyun-lxserver:integration-20260813-v29
WORKDIR /server
COPY server/server/apiV1.js ./server/apiV1.js
COPY server/server/songloftClient.js ./server/songloftClient.js
COPY public ./public
