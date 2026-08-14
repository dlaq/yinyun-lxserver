# Incremental integration image.  It keeps v39 and layers the failed-task
# visibility fix so retry/change-source actions are always reachable.
FROM yinyun-lxserver:integration-20260814-v39
WORKDIR /server
COPY public/js/library-integration.js ./public/js/library-integration.js
