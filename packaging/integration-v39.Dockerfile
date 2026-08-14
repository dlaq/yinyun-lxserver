# Incremental integration image.  It keeps v38 and hardens panel visibility
# detection for queue polling; no backend/music/container changes.
FROM yinyun-lxserver:integration-20260814-v38
WORKDIR /server
COPY public/js/library-integration.js ./public/js/library-integration.js
