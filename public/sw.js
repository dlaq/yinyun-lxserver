const BUILD_HASH = 'd1e9763';
const CACHE_PREFIX = 'yinyun-admin-';
const PRECACHE_NAME = `${CACHE_PREFIX}${BUILD_HASH}-precache`;
const RUNTIME_CACHE_NAME = `${CACHE_PREFIX}${BUILD_HASH}-runtime`;

const PRECACHE_URLS = [
    './',
    './index.html',
    './style.css',
    './tailwind.generated.css',
    './app.js',
    './js/ui-utils.js',
    './js/notification-engine.js',
    './icon.svg',
    './manifest.json',
    './vendor/js/marked.min.js',
    './vendor/fonts/inter.css',
    './vendor/fonts/inter-1.woff2',
    './vendor/fonts/inter-2.woff2',
    './vendor/fonts/inter-3.woff2',
    './vendor/fonts/inter-4.woff2',
    './vendor/fonts/inter-5.woff2',
    './vendor/fonts/inter-6.woff2',
    './vendor/fonts/inter-7.woff2',
    '/_player/assets/fontawesome/css/all.min.css',
    '/_player/assets/fontawesome/webfonts/fa-brands-400.woff2',
    '/_player/assets/fontawesome/webfonts/fa-regular-400.woff2',
    '/_player/assets/fontawesome/webfonts/fa-solid-900.woff2',
    '/_player/assets/logo.svg',
    '/_player/assets/icons/icon-180.png',
    '/_player/assets/icons/icon-192.png',
    '/_player/assets/icons/icon-512.png',
    '/_player/assets/icons/icon-maskable-512.png',
];

const PRECACHE_URLS_ABSOLUTE = new Set(PRECACHE_URLS.map(url => new URL(url, self.registration.scope).href));

const isCacheableResponse = (response) => Boolean(
    response && response.ok && (response.type === 'basic' || response.type === 'cors')
);

const shouldBypass = (request, url) => {
    if (request.method !== 'GET' || url.origin !== self.location.origin) return true;
    if (request.headers.has('range')) return true;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rest/')) return true;
    if (url.pathname === '/js/config.js') return true;
    return /\.(mp3|flac|m4a|ogg|aac|wav|opus|mp4|webm)(?:$|\/)/i.test(url.pathname);
};

const putIfCacheable = async (cacheName, request, response) => {
    if (!isCacheableResponse(response)) return response;
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
    return response;
};

const networkFirstNavigation = async (request) => {
    const runtimeCache = await caches.open(RUNTIME_CACHE_NAME);
    const precache = await caches.open(PRECACHE_NAME);
    try {
        const response = await fetch(request);
        return await putIfCacheable(RUNTIME_CACHE_NAME, request, response);
    } catch {
        return (await runtimeCache.match(request, { ignoreSearch: true })) ||
            (await precache.match(request, { ignoreSearch: true })) ||
            (await precache.match(new URL('./', self.registration.scope).href, { ignoreSearch: true })) ||
            Response.error();
    }
};

const staleWhileRevalidate = async (event, request) => {
    const cacheName = PRECACHE_URLS_ABSOLUTE.has(request.url) ? PRECACHE_NAME : RUNTIME_CACHE_NAME;
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request, { ignoreSearch: true });
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
            const absoluteUrl = new URL(url, self.registration.scope).href;
            const fetchUrl = new URL(absoluteUrl);
            fetchUrl.searchParams.set('__pwa', BUILD_HASH);
            const request = new Request(fetchUrl.href, { cache: 'reload', credentials: 'same-origin' });
            const response = await fetch(request);
            if (!isCacheableResponse(response)) {
                throw new Error(`[Admin SW] Precache failed for ${absoluteUrl}: HTTP ${response.status}`);
            }
            await cache.put(absoluteUrl, response);
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
    event.respondWith(staleWhileRevalidate(event, event.request));
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
    }
});
