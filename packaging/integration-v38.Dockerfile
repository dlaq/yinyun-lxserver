# Incremental integration image.  It keeps the v37 runtime and layers the
# panel-activation polling fix; no Songloft/Navidrome or music data changes.
FROM yinyun-lxserver:integration-20260814-v37
WORKDIR /server
COPY public/js/library-integration.js ./public/js/library-integration.js
