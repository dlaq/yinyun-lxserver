let deferredPrompt;
let registrationPromise = Promise.resolve(null);
const installBtn = document.getElementById('pwa-install-btn');
const hadControllerAtLoad = Boolean(navigator.serviceWorker?.controller);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isLocalDevelopment = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const isIpv4Address = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(location.hostname);
const canUpgradeToHttps = location.protocol === 'http:' && !isLocalDevelopment && !isIpv4Address;

const showPwaMessage = (message) => {
    if (typeof window.showInfo === 'function') window.showInfo(message);
    else console.info(`[PWA] ${message}`);
};

const setInstallButtonVisible = (visible) => {
    if (!installBtn) return;
    installBtn.classList.toggle('hidden', !visible);
    installBtn.classList.toggle('flex', visible);
};

const requestWorkerMessage = async (message, timeoutMs = 3000) => {
    const worker = navigator.serviceWorker?.controller;
    if (!worker) return null;

    return await new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(null), timeoutMs);
        channel.port1.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event.data || null);
        };
        worker.postMessage(message, [channel.port2]);
    });
};

const clearRuntimeCaches = async () => {
    if (!('caches' in window)) return false;
    const response = await requestWorkerMessage({ type: 'CLEAR_RUNTIME_CACHES' });
    if (response?.ok) return true;

    const keys = await caches.keys();
    await Promise.all(keys
        .filter(key => key.startsWith('yinyun-player-') && key.endsWith('-runtime'))
        .map(key => caches.delete(key)));
    return true;
};

const getPwaStatus = async () => {
    const registration = await registrationPromise.catch(() => null);
    const workerStatus = await requestWorkerMessage({ type: 'GET_PWA_STATUS' });
    return {
        secureContext: window.isSecureContext,
        standalone: isStandalone(),
        serviceWorkerSupported: 'serviceWorker' in navigator,
        controlled: Boolean(navigator.serviceWorker?.controller),
        scope: registration?.scope || null,
        worker: workerStatus,
        cacheNames: 'caches' in window ? await caches.keys() : [],
    };
};

const checkPwaUpdates = async () => {
    const registration = await registrationPromise.catch(() => null);
    if (!registration) return false;
    await registration.update();
    return true;
};

window.yinyunPwa = {
    clearRuntimeCaches,
    getStatus: getPwaStatus,
    checkForUpdates: checkPwaUpdates,
};

if (canUpgradeToHttps) {
    const target = new URL(location.href);
    target.protocol = 'https:';
    location.replace(target.href);
} else if ('serviceWorker' in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadControllerAtLoad || refreshing) return;
        refreshing = true;
        location.reload();
    });

    registrationPromise = new Promise((resolve) => {
        window.addEventListener('load', async () => {
            try {
                const workerUrl = new URL('/sw.js', location.origin);
                if (window.CONFIG?.buildHash) workerUrl.searchParams.set('v', window.CONFIG.buildHash);
                const registration = await navigator.serviceWorker.register(workerUrl.href, {
                    scope: '/',
                    updateViaCache: 'none',
                });
                registration.addEventListener('updatefound', () => {
                    const installingWorker = registration.installing;
                    installingWorker?.addEventListener('statechange', () => {
                        if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            installingWorker.postMessage({ type: 'SKIP_WAITING' });
                        }
                    });
                });
                if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
                await registration.update();
                resolve(registration);
            } catch (error) {
                console.error('[PWA] Service Worker registration failed:', error);
                resolve(null);
            }
        }, { once: true });
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void checkPwaUpdates();
    });
}

window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    if (!isStandalone()) setInstallButtonVisible(true);
});

if (!isStandalone() && (isIos || !window.isSecureContext)) {
    setInstallButtonVisible(true);
}

installBtn?.addEventListener('click', async () => {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        setInstallButtonVisible(false);
        return;
    }
    if (canUpgradeToHttps) {
        const target = new URL(location.href);
        target.protocol = 'https:';
        location.assign(target.href);
        return;
    }
    if (!window.isSecureContext) {
        showPwaMessage('请使用受信任的 HTTPS 域名打开后再安装应用');
        return;
    }
    if (isIos) {
        showPwaMessage('请点 Safari“分享”→“添加到主屏幕”，并开启“作为网页 App 打开”');
        return;
    }
    showPwaMessage('请使用浏览器菜单中的“安装应用”或“添加到主屏幕”');
});

window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    setInstallButtonVisible(false);
});
