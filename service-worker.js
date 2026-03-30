const CACHE_NAME = 'di-v2';
const AUDIO_CACHE = 'audio-cache-v1';
const ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './manifest.json',
    './icon.png',
    './music/index.json'
];

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(self.clients.claim());
});

const downloadQueue = [];
let isDownloading = false;
const activeDownloads = new Map(); 
const downloadAttempts = new Map(); 

async function processDownloadQueue() {
    if (isDownloading || downloadQueue.length === 0) return;
    isDownloading = true;
    
    const url = downloadQueue.shift();
    await downloadWithRetry(url);
    
    isDownloading = false;
    processDownloadQueue();
}

async function downloadWithRetry(url) {
    const cache = await caches.open(AUDIO_CACHE);
    if (await cache.match(url)) return; 
    
    let now = Date.now();
    if (!downloadAttempts.has(url)) {
        downloadAttempts.set(url, { firstAttempt: now });
    }
    
    const attempts = downloadAttempts.get(url);
    if (now - attempts.firstAttempt > 60000) {
        console.warn(`[SW] Given up downloading ${url} after 1 minute.`);
        downloadAttempts.delete(url);
        return; 
    }

    const controller = new AbortController();
    activeDownloads.set(url, controller);

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        await cache.put(url, response);
        console.log(`[SW] Successfully background cached: ${url}`);
        activeDownloads.delete(url);
        downloadAttempts.delete(url); 
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log(`[SW] Aborted background download: ${url}`);
            activeDownloads.delete(url);
            return;
        }
        
        console.warn(`[SW] Error downloading ${url}. Retrying...`);
        
        await new Promise(r => setTimeout(r, 2000));
        downloadQueue.unshift(url);
    }
}

self.addEventListener('message', async (e) => {
    if (e.data.type === 'PAGE_LOADED') {
        const hasCache = await caches.has(CACHE_NAME);
        if (hasCache) {
             await caches.delete(CACHE_NAME);
             console.log('[SW] Cleared small files cache explicitly on reload/load.');
        }
    }
    
    if (e.data.type === 'SYNC_PLAYLIST') {
        const { visibleTracks, upcomingTracks } = e.data;
        
        const cache = await caches.open(AUDIO_CACHE);
        const keys = await cache.keys();
        for (const req of keys) {
            const cachedUrl = req.url;
            if (!visibleTracks.some(v => cachedUrl.endsWith(v))) {
                await cache.delete(req);
                console.log(`[SW] Evicted ${cachedUrl} from audio cache`);
            }
        }
        
        for (const [url, controller] of activeDownloads.entries()) {
            if (!upcomingTracks.some(v => url.endsWith(v))) {
                controller.abort();
            }
        }
        
        for (const trackUrl of upcomingTracks) {
            const fullUrl = new URL(trackUrl, self.location.origin).href;
            if (!downloadQueue.includes(fullUrl) && !activeDownloads.has(fullUrl)) {
                downloadAttempts.delete(fullUrl);
                downloadQueue.push(fullUrl);
            }
        }
        
        processDownloadQueue();
    }
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    
    const url = new URL(e.request.url);
    if (!url.protocol.startsWith('http')) return;
    
    if (url.pathname.endsWith('.m4a') || url.pathname.endsWith('.mp3')) {
        e.respondWith(handleAudioRequest(e.request));
        return;
    }

    e.respondWith(
        caches.match(e.request).then((cached) => {
            if (cached) return cached;
            
            const smallAssets = ['.json', '.css', '.js', '.png', '.jpg'];
            const isSmall = smallAssets.some(ext => url.pathname.endsWith(ext));
            
            return fetch(e.request).then((response) => {
                if (isSmall && response.status === 200) {
                    const cloned = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(e.request, cloned));
                }
                return response;
            });
        })
    );
});

async function handleAudioRequest(request) {
    const cache = await caches.open(AUDIO_CACHE);
    const cachedResponse = await cache.match(request);
    
    if (!cachedResponse) {
        const urlString = request.url;
        if (downloadAttempts.has(urlString) && Date.now() - downloadAttempts.get(urlString).firstAttempt > 60000) {
            console.log(`[SW] Re-engaging failed download loop for suddenly accessed track ${urlString}`);
            downloadAttempts.delete(urlString);
            if (!downloadQueue.includes(urlString)) {
                downloadQueue.push(urlString);
                processDownloadQueue();
            }
        }
        
        // Force header on raw network proxies so Safari doesn't explicitly disable seeking
        const networkResponse = await fetch(request);
        if (networkResponse.status === 200) {
             const headers = new Headers(networkResponse.headers);
             headers.set('Accept-Ranges', 'bytes');
             return new Response(networkResponse.body, {
                 status: 200,
                 statusText: networkResponse.statusText,
                 headers: headers
             });
        }
        return networkResponse;
    }
    
    let rangeHeader = request.headers.get('Range');
    const blob = await cachedResponse.blob();
    const size = blob.size;
    
    if (!rangeHeader) {
        // Force Safari/Chrome to treat the offline blob as a seekable 206 stream fully
        rangeHeader = 'bytes=0-';
    }
    
    let start = 0;
    let end = size - 1;
    
    const rangeMatch = rangeHeader.trim().match(/bytes=(\d*)-(\d*)/);
    if (rangeMatch) {
         if (rangeMatch[1] === "") {
              start = Math.max(0, size - parseInt(rangeMatch[2], 10));
         } else {
              start = parseInt(rangeMatch[1], 10);
              if (rangeMatch[2] !== "") end = parseInt(rangeMatch[2], 10);
         }
    }
    
    start = Math.max(0, Math.min(start, size - 1));
    end = Math.max(start, Math.min(end, size - 1));
    
    const sliced = blob.slice(start, end + 1);
    const headers = new Headers();
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', sliced.size.toString());
    headers.set('Content-Type', request.url.endsWith('.mp3') ? 'audio/mpeg' : 'audio/mp4');
    headers.set('Accept-Ranges', 'bytes');
    
    return new Response(sliced, {
        status: 206,
        statusText: 'Partial Content',
        headers
    });
}
