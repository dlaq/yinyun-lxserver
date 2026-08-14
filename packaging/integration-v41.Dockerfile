# Incremental integration image.  It keeps v40 and fixes the player startup
# initialization order so settings UI synchronization runs after const maps
# have been initialized.
FROM yinyun-lxserver:integration-20260814-v40
WORKDIR /server
COPY public/music/app.js ./public/music/app.js
