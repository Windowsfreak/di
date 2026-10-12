/**
 * Dream Improvisation - Service Worker
 * Robust Offline Engine with Separate Shell & Audio Caches
 */

const SHELL_CACHE = 'di-shell-v10';
const AUDIO_CACHE = 'di-audio-offline-v1';

const SHELL_ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './manifest.json',
    './icon.png',
    './db/categories.json',
    './db/playlists.json'
];

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(SHELL_CACHE).then((cache) => {
            return cache.addAll(SHELL_ASSETS).catch((err) => {
                console.warn('[SW] Some initial assets could not be pre-cached:', err);
            });
        })
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    // Evict old shell versions, but never delete AUDIO_CACHE
                    if (key.startsWith('di-shell-') && key !== SHELL_CACHE) {
                        console.log(`[SW] Evicting outdated shell cache: ${key}`);
                        return caches.delete(key);
                    }
                    if (key === 'di-v1' || key === 'di-v2' || key === 'audio-cache-v1') {
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Broadcast helper to communicate with all open windows/tabs
async function broadcast(message) {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    for (const client of clients) {
        client.postMessage(message);
    }
}

// Background Download Manager
const activeDownloads = new Map();

self.addEventListener('message', async (e) => {
    const data = e.data;
    if (!data || !data.type) return;

    if (data.type === 'DOWNLOAD_PLAYLIST') {
        const { playlistSlug, files } = data;
        handlePlaylistDownload(playlistSlug, files);
    }

    if (data.type === 'DELETE_PLAYLIST') {
        const { playlistSlug, files } = data;
        handlePlaylistDelete(playlistSlug, files);
    }

    if (data.type === 'GET_OFFLINE_STORAGE') {
        handleStorageReport();
    }

    if (data.type === 'CLEAR_ALL_AUDIO') {
        await caches.delete(AUDIO_CACHE);
        await caches.open(AUDIO_CACHE);
        broadcast({ type: 'ALL_AUDIO_CLEARED' });
    }

    if (data.type === 'CLEAR_SHELL_CACHE') {
        await caches.delete(SHELL_CACHE);
        broadcast({ type: 'SHELL_CACHE_CLEARED' });
    }

    if (data.type === 'PRELOAD_TRACK') {
        const { url } = data;
        const normalizedUrl = new URL(url, self.location.origin).href;
        const cache = await caches.open(AUDIO_CACHE);
        if (!(await cache.match(normalizedUrl, { ignoreSearch: true, ignoreVary: true }))) {
            fetch(normalizedUrl).then(resp => {
                if (resp.ok) cache.put(normalizedUrl, resp);
            }).catch(() => {});
        }
    }
});

async function handlePlaylistDownload(playlistSlug, files) {
    if (!files || files.length === 0) return;
    const cache = await caches.open(AUDIO_CACHE);
    const controller = new AbortController();
    activeDownloads.set(playlistSlug, controller);

    let completed = 0;
    const total = files.length;

    broadcast({
        type: 'DOWNLOAD_PROGRESS',
        playlistSlug,
        completed: 0,
        total,
        percent: 0
    });

    for (const rawUrl of files) {
        if (controller.signal.aborted) {
            console.log(`[SW] Download aborted for ${playlistSlug}`);
            activeDownloads.delete(playlistSlug);
            broadcast({ type: 'DOWNLOAD_ABORTED', playlistSlug });
            return;
        }

        const absoluteUrl = new URL(rawUrl, self.location.origin).href;

        try {
            const existing = await cache.match(absoluteUrl, { ignoreSearch: true, ignoreVary: true });
            if (!existing) {
                const response = await fetch(absoluteUrl, { signal: controller.signal });
                if (response.ok) {
                    await cache.put(absoluteUrl, response);
                } else if (absoluteUrl.endsWith('.vtt')) {
                    // Optional subtitle file, ignore 404
                } else {
                    throw new Error(`HTTP ${response.status}`);
                }
            }
            completed++;
            const percent = Math.round((completed / total) * 100);
            broadcast({
                type: 'DOWNLOAD_PROGRESS',
                playlistSlug,
                completed,
                total,
                percent
            });
        } catch (err) {
            if (err.name === 'AbortError') {
                activeDownloads.delete(playlistSlug);
                broadcast({ type: 'DOWNLOAD_ABORTED', playlistSlug });
                return;
            }
            console.warn(`[SW] Failed downloading ${absoluteUrl} for ${playlistSlug}:`, err);
        }
    }

    activeDownloads.delete(playlistSlug);
    broadcast({
        type: 'DOWNLOAD_COMPLETE',
        playlistSlug,
        total
    });
}

async function handlePlaylistDelete(playlistSlug, files) {
    const cache = await caches.open(AUDIO_CACHE);
    for (const rawUrl of files) {
        const absoluteUrl = new URL(rawUrl, self.location.origin).href;
        await cache.delete(absoluteUrl, { ignoreSearch: true, ignoreVary: true });
    }
    broadcast({
        type: 'DELETE_COMPLETE',
        playlistSlug
    });
}

async function handleStorageReport() {
    const cache = await caches.open(AUDIO_CACHE);
    const keys = await cache.keys();
    let totalBytes = 0;
    const cachedUrls = [];

    for (const req of keys) {
        cachedUrls.push(req.url);
        const resp = await cache.match(req.url, { ignoreSearch: true, ignoreVary: true });
        if (resp) {
            const blob = await resp.blob();
            totalBytes += blob.size;
        }
    }

    broadcast({
        type: 'STORAGE_REPORT',
        totalBytes,
        fileCount: keys.length,
        cachedUrls
    });
}

// Fetch Interception
self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;

    const url = new URL(e.request.url);
    if (!url.protocol.startsWith('http')) return;

    // 1. Audio Media: Opus, M4A, MP3
    if (url.pathname.endsWith('.opus') || url.pathname.endsWith('.m4a') || url.pathname.endsWith('.mp3')) {
        e.respondWith(handleAudioRequest(e.request));
        return;
    }

    // 2. Subtitles (.vtt), Images (.webp, .png, .jpg), Metadata (.json)
    const mediaOrData = ['.vtt', '.webp', '.png', '.jpg', '.jpeg', '.json'];
    const isDataOrMedia = mediaOrData.some(ext => url.pathname.endsWith(ext));

    if (isDataOrMedia) {
        e.respondWith(
            (async () => {
                const requestUrl = new URL(e.request.url).href;
                const audioCache = await caches.open(AUDIO_CACHE);
                let cached = await audioCache.match(requestUrl, { ignoreSearch: true, ignoreVary: true });
                if (!cached) {
                    const shellCache = await caches.open(SHELL_CACHE);
                    cached = await shellCache.match(requestUrl, { ignoreSearch: true, ignoreVary: true });
                }
                if (cached) return cached;

                try {
                    const resp = await fetch(e.request);
                    if (resp && resp.status === 200) {
                        const clone = resp.clone();
                        // Cache DB files in audioCache if under db/
                        if (url.pathname.includes('/db/')) {
                            await audioCache.put(requestUrl, clone);
                        } else {
                            const shellCache = await caches.open(SHELL_CACHE);
                            await shellCache.put(requestUrl, clone);
                        }
                    }
                    return resp;
                } catch (err) {
                    // Offline fallback: check caches once more with URL matching
                    const fallback = (await audioCache.match(requestUrl, { ignoreSearch: true, ignoreVary: true })) ||
                                     (await (await caches.open(SHELL_CACHE)).match(requestUrl, { ignoreSearch: true, ignoreVary: true }));
                    if (fallback) return fallback;
                    return new Response('Not found', { status: 404, statusText: 'Not Found' });
                }
            })()
        );
        return;
    }

    // 3. App Shell (HTML, CSS, JS) - Cache First with Background Network Revalidation
    e.respondWith(
        (async () => {
            const requestUrl = new URL(e.request.url).href;
            const shellCache = await caches.open(SHELL_CACHE);
            const cached = await shellCache.match(requestUrl, { ignoreSearch: true, ignoreVary: true }) ||
                           await shellCache.match(e.request);

            const fetchPromise = fetch(e.request).then(async (networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                    await shellCache.put(requestUrl, networkResponse.clone());
                }
                return networkResponse;
            }).catch(() => null);

            if (cached) {
                // If we have cached version, revalidate in background and return cached immediately!
                fetchPromise.catch(() => {});
                return cached;
            }

            const netResp = await fetchPromise;
            if (netResp) return netResp;
            return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
        })()
    );
});

// Seekable 206 Partial Content Audio Handler
async function handleAudioRequest(request) {
    const audioCache = await caches.open(AUDIO_CACHE);
    const requestUrl = new URL(request.url).href;
    let cachedResponse = await audioCache.match(requestUrl, { ignoreSearch: true, ignoreVary: true });

    if (!cachedResponse) {
        const shellCache = await caches.open(SHELL_CACHE);
        cachedResponse = await shellCache.match(requestUrl, { ignoreSearch: true, ignoreVary: true });
    }

    if (!cachedResponse) {
        try {
            const networkResponse = await fetch(request.url);
            if (networkResponse.ok) {
                await audioCache.put(requestUrl, networkResponse.clone());
                cachedResponse = await audioCache.match(requestUrl, { ignoreSearch: true, ignoreVary: true });
            } else {
                return networkResponse;
            }
        } catch (err) {
            console.warn('[SW] Offline and audio not cached:', requestUrl);
            return new Response('Audio not available offline', {
                status: 503,
                statusText: 'Service Unavailable'
            });
        }
    }

    if (!cachedResponse) {
        return new Response('Audio not available offline', {
            status: 503,
            statusText: 'Service Unavailable'
        });
    }

    // Serve from Cache with HTTP 206 Partial Content (essential for Safari/Chrome seeking)
    let rangeHeader = request.headers.get('Range');
    const blob = await cachedResponse.blob();
    const size = blob.size;

    if (!rangeHeader) {
        rangeHeader = 'bytes=0-';
    }

    let start = 0;
    let end = size - 1;

    const rangeMatch = rangeHeader.trim().match(/bytes=(\d*)-(\d*)/);
    if (rangeMatch) {
        if (rangeMatch[1] === '') {
            start = Math.max(0, size - parseInt(rangeMatch[2], 10));
        } else {
            start = parseInt(rangeMatch[1], 10);
            if (rangeMatch[2] !== '') end = parseInt(rangeMatch[2], 10);
        }
    }

    start = Math.max(0, Math.min(start, size - 1));
    end = Math.max(start, Math.min(end, size - 1));

    const sliced = blob.slice(start, end + 1);
    const headers = new Headers();
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', sliced.size.toString());

    let mimeType = 'audio/ogg; codecs=opus';
    if (request.url.endsWith('.mp3')) mimeType = 'audio/mpeg';
    else if (request.url.endsWith('.m4a')) mimeType = 'audio/mp4';

    headers.set('Content-Type', mimeType);
    headers.set('Accept-Ranges', 'bytes');

    return new Response(sliced, {
        status: 206,
        statusText: 'Partial Content',
        headers
    });
}
