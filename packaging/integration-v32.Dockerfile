# Incremental deployment image on top of v29. This is the current management
# UI/API overlay; it does not include or modify the shared music directory.
FROM yinyun-lxserver:integration-20260813-v29
WORKDIR /server
COPY server/server/apiV1.js ./server/apiV1.js
COPY server/server/songloftClient.js ./server/songloftClient.js
COPY public ./public
