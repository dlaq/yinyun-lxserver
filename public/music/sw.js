const BUILD_HASH = '295a0a4';
const CACHE_PREFIX = 'yinyun-player-';
const PRECACHE_NAME = `${CACHE_PREFIX}${BUILD_HASH}-precache`;
const RUNTIME_CACHE_NAME = `${CACHE_PREFIX}${BUILD_HASH}-runtime`;
const OFFLINE_URL = '/';

const PRECACHE_URLS = [
    '/',
    '/manifest.json',
    '/_player/app.js',
    '/_player/css/theme_variables.css',
    '/_player/css/tailwind.generated.css',
    '/_player/css/app.css',
    '/_player/css/library-integration.css',
    '/_player/assets/fontawesome/css/all.min.css',
    '/_player/js/lyric-parser.js',
    '/_player/js/lyric-utils.js',
    '/_player/js/lyric-card.js',
    '/_player/js/quality.js',
    '/_player/js/idb_store.js',
    '/_player/js/user_sync.js',
    '/_player/js/batch_pagination.js',
    '/_player/js/single_song_ops.js',
    '/_player/js/songlist_manager.js',
    '/_player/js/list_search.js',
    '/_player/js/leaderboard_manager.js',
    '/_player/js/local_music.js',
    '/_player/js/download_manager.js',
    '/_player/js/pwa.js',
    '/_player/js/theme_manager.js',
    '/_player/js/log_viewer.js',
    '/_player/js/common_ui.js',
    '/_player/js/web_player_state.js',
    '/_player/js/ios-background-audio.js',
    '/_player/js/crypto-js.min.js',
    '/_player/js/NoSleep.min.js',
    '/_player/js/Sortable.min.js',
    '/_player/js/marked.min.js',
    '/_player/js/sound-effects.js',
    '/_player/js/visualizer.js',
    '/_player/js/wave.js',
    '/_player/js/pitch-shifter/fft.js',
    '/_player/js/pitch-shifter/ola-processor.js',
    '/_player/js/pitch-shifter/phase-vocoder.js',
    '/js/notification-engine.js',
    '/admin/js/library-integration.js',
    '/_player/assets/logo.svg',
    '/_player/assets/icons/icon-180.png',
    '/_player/assets/icons/icon-192.png',
    '/_player/assets/icons/icon-512.png',
    '/_player/assets/icons/icon-maskable-512.png',
    '/_player/assets/fontawesome/webfonts/fa-brands-400.woff2',
    '/_player/assets/fontawesome/webfonts/fa-regular-400.woff2',
    '/_player/assets/fontawesome/webfonts/fa-solid-900.woff2',
];

const PRECACHE_PATHS = new Set(PRECACHE_URLS);
const PLAYER_SHARED_ADMIN_PATHS = new Set(['/admin/js/library-integration.js']);

const isCacheableResponse = (response) => Boolean(
    response && response.ok && (response.type === 'basic' || response.type === 'cors')
);

const isAudioOrVideo = (pathname) => /\.(mp3|flac|m4a|ogg|aac|wav|opus|mp4|webm)(?:$|\/)/i.test(pathname);

const shouldBypass = (request, url) => {
    if (request.method !== 'GET' || url.origin !== self.location.origin) return true;
    if (request.headers.has('range') || isAudioOrVideo(url.pathname)) return true;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rest/')) return true;
    if (url.pathname === '/js/config.js') return true;
    if (url.pathname.startsWith('/admin/') && !PLAYER_SHARED_ADMIN_PATHS.has(url.pathname)) return true;

    return !(
        url.pathname === '/' ||
        url.pathname === '/index.html' ||
        url.pathname === '/manifest.json' ||
        url.pathname === '/sw.js' ||
        url.pathname.startsWith('/_player/') ||
        url.pathname === '/js/notification-engine.js' ||
        PLAYER_SHARED_ADMIN_PATHS.has(url.pathname)
    );
};

const putIfCacheable = async (cacheName, request, response) => {
    if (!isCacheableResponse(response)) return response;
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
    return response;
};

const networkFirstNavigation = async (request) => {
    try {
        const response = await fetch(request);
        return await putIfCacheable(RUNTIME_CACHE_NAME, request, response);
    } catch {
        return (await caches.match(request, { ignoreSearch: true })) ||
            (await caches.match(OFFLINE_URL, { ignoreSearch: true })) ||
            Response.error();
    }
};

const staleWhileRevalidate = async (event, request, pathname) => {
    const cacheName = PRECACHE_PATHS.has(pathname) ? PRECACHE_NAME : RUNTIME_CACHE_NAME;
    const cached = await caches.match(request, { ignoreSearch: true });
    const network = fetch(request).then(response => putIfCacheable(cacheName, request, response));

    if (cached) {
        event.waitUntil(network.catch(() => undefined));
        return cached;
    }
    return network;
};

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(PRECACHE_NAME);
        await Promise.all(PRECACHE_URLS.map(async (url) => {
            const fetchUrl = new URL(url, self.location.origin);
            fetchUrl.searchParams.set('__pwa', BUILD_HASH);
            const request = new Request(fetchUrl.href, { cache: 'reload', credentials: 'same-origin' });
            const response = await fetch(request);
            if (!isCacheableResponse(response)) {
                throw new Error(`[SW] Precache failed for ${url}: HTTP ${response.status}`);
            }
            await cache.put(url, response);
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (shouldBypass(event.request, url)) return;

    if (event.request.mode === 'navigate') {
        event.respondWith(networkFirstNavigation(event.request));
        return;
    }
    event.respondWith(staleWhileRevalidate(event, event.request, url.pathname));
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((cacheName) => {
            if (cacheName.startsWith(CACHE_PREFIX) &&
                cacheName !== PRECACHE_NAME &&
                cacheName !== RUNTIME_CACHE_NAME) {
                return caches.delete(cacheName);
            }
            return undefined;
        }));
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') {
        event.waitUntil(self.skipWaiting());
        return;
    }
    if (event.data?.type === 'CLEAR_RUNTIME_CACHES') {
        event.waitUntil((async () => {
            const cacheNames = await caches.keys();
            await Promise.all(cacheNames
                .filter(name => name.startsWith(CACHE_PREFIX) && name.endsWith('-runtime'))
                .map(name => caches.delete(name)));
            event.ports?.[0]?.postMessage({ ok: true, buildHash: BUILD_HASH });
        })());
        return;
    }
    if (event.data?.type === 'GET_PWA_STATUS') {
        event.ports?.[0]?.postMessage({
            ok: true,
            buildHash: BUILD_HASH,
            precacheName: PRECACHE_NAME,
            runtimeCacheName: RUNTIME_CACHE_NAME,
        });
    }
});
