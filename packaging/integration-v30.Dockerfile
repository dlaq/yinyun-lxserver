# Incremental deployment image on top of v29. Only the playlist-management API,
# native Songloft client and management UI are overlaid; shared music files and
# the Songloft/Navidrome containers are not touched.
FROM yinyun-lxserver:integration-20260813-v29
WORKDIR /server
COPY server/server/apiV1.js ./server/apiV1.js
COPY server/server/songloftClient.js ./server/songloftClient.js
COPY public ./public
