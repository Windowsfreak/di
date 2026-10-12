/**
 * Dream Improvisation - Audio Engine, Offline Manager & UI Controller
 */

// ============================================================================
// 1. Audio Engine
// ============================================================================
class AudioEngine {
    constructor() {
        this.ctx = null;
        this.nodes = {};
        this.audioElement = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.currentUrl = null;
        this.intentUrl = null;
        this.fades = { main: 1.0, playPause: 1.0, seek: 1.0, sleep: 1.0 };
    }

    init() {
        if (this.ctx) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        
        ['playPause', 'seek', 'sleep', 'main'].forEach(name => {
            this.nodes[name] = this.ctx.createGain();
            this.nodes[name].gain.value = 1.0;
        });

        this.nodes.playPause.connect(this.nodes.seek);
        this.nodes.seek.connect(this.nodes.sleep);
        this.nodes.sleep.connect(this.nodes.main);
        this.nodes.main.connect(this.ctx.destination);

        this.audioElement = new Audio();
        this.audioElement.crossOrigin = "anonymous";
        this.audioElement.preload = "auto";
        
        this.audioElement.onended = () => {
            if (this.isPlaying && !this.isPaused) {
                window.dispatchEvent(new CustomEvent('track-ended'));
            }
        };

        this.audioElement.onerror = (e) => {
            if (this.isPlaying && this.currentUrl) {
                const err = this.audioElement.error;
                console.warn("[Audio] Media error:", err ? err.code : 'unknown', err ? err.message : '');
                const currentTime = this.audioElement.currentTime;
                this.audioElement.load();
                if (currentTime > 0) this.audioElement.currentTime = currentTime;
                this.audioElement.play().catch(console.error);
            }
        };

        this.audioElement.addEventListener('pause', () => {
            if (typeof savePlaybackSession === 'function') {
                savePlaybackSession();
            }
        });

        this.source = this.ctx.createMediaElementSource(this.audioElement);
        this.source.connect(this.nodes.playPause);

        const savedVol = localStorage.getItem('di_volume');
        this.setVolume(savedVol !== null ? parseFloat(savedVol) : 1.0, false);
    }

    setVolume(value, smooth = true) {
        this.fades.main = Number(value);
        if (this.nodes.main && this.ctx) {
            if (smooth) this.nodes.main.gain.setTargetAtTime(this.fades.main, this.ctx.currentTime, 0.05);
            else this.nodes.main.gain.value = this.fades.main;
        }
        localStorage.setItem('di_volume', this.fades.main);
    }

    async play(url, startTime = 0, noFadeIn = false) {
        this.intentUrl = url;
        this.init();
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        if (this.intentUrl !== url) return;

        if (this.currentUrl !== url) {
            this.audioElement.pause();
            this.currentUrl = url;
            this.audioElement.src = url;
            this.audioElement.load();
        }

        if (startTime > 0) {
            if (this.audioElement.readyState >= 1) {
                try { this.audioElement.currentTime = startTime; } catch(e) {}
            } else {
                this.audioElement.onloadedmetadata = () => {
                    if (this.currentUrl === url) {
                        try { this.audioElement.currentTime = startTime; } catch(e) {}
                    }
                    this.audioElement.onloadedmetadata = null;
                };
            }
        }

        try {
            await this.audioElement.play();
        } catch(e) {
            console.error("[Audio] Playback failed:", e);
        }

        if (this.intentUrl !== url) return;

        if (startTime > 0 && Math.abs(this.audioElement.currentTime - startTime) > 1.0) {
            try { this.audioElement.currentTime = startTime; } catch(e) {}
        }

        this.isPlaying = true;
        this.isPaused = false;
        this.nodes.sleep.gain.value = 1.0;

        if (!noFadeIn) {
            this.nodes.playPause.gain.cancelScheduledValues(this.ctx.currentTime);
            this.nodes.playPause.gain.setValueAtTime(0.0, this.ctx.currentTime);
            this.fadeNode('playPause', 1.0, 1.0);
        } else {
            this.nodes.playPause.gain.value = 1.0;
        }

        this.nodes.seek.gain.value = 1.0;

        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
            this.updatePositionState();
        }
    }

    pause() {
        if (!this.isPlaying || this.isPaused) return;
        this.fadeNode('playPause', 0.0, 0.8);
        this.isPaused = true;
        if (typeof savePlaybackSession === 'function') savePlaybackSession();
        setTimeout(() => {
            if (this.isPaused && this.audioElement) {
                this.audioElement.pause();
                this.nodes.sleep.gain.value = 1.0;
                if ('mediaSession' in navigator) {
                    navigator.mediaSession.playbackState = 'paused';
                    this.updatePositionState();
                }
                if (typeof savePlaybackSession === 'function') savePlaybackSession();
            }
        }, 800);
    }

    resume() {
        if (!this.isPaused) return;
        this.isPaused = false;
        this.isPlaying = true;
        this.audioElement.play().catch(console.error);
        this.fadeNode('playPause', 1.0, 0.8);
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
            this.updatePositionState();
        }
    }

    seek(time) {
        if (!this.audioElement) return;
        const target = Math.max(0, time);
        this.fadeNode('seek', 0.0, 0.1);
        setTimeout(() => {
            try {
                this.audioElement.currentTime = target;
                this.updatePositionState();
                if (typeof savePlaybackSession === 'function') savePlaybackSession();
            } catch (err) {
                console.error("[Audio] Seek error:", err);
            }
            this.fadeNode('seek', 1.0, 0.1);
        }, 100);
    }

    fadeNode(name, target, duration) {
        if (!this.nodes[name] || !this.ctx) return;
        if (duration === 0) {
            this.nodes[name].gain.cancelScheduledValues(this.ctx.currentTime);
            this.nodes[name].gain.value = target;
        } else {
            this.nodes[name].gain.setTargetAtTime(target, this.ctx.currentTime, duration / 3);
        }
    }

    getCurrentTime() {
        if (!this.isPlaying && !this.isPaused && state && state.restoredSeekTime > 0) {
            return state.restoredSeekTime;
        }
        return this.audioElement ? this.audioElement.currentTime : 0;
    }

    getDuration() {
        if (this.audioElement) {
            const dur = this.audioElement.duration;
            if (typeof dur === 'number' && isFinite(dur) && dur > 0) {
                return dur;
            }
        }
        // Fallback to track duration from metadata if audioElement.duration is Infinity or NaN (common in streamed Ogg Opus)
        if (state.playlist && state.playlist.currentTrack && isFinite(state.playlist.currentTrack.duration_sec) && state.playlist.currentTrack.duration_sec > 0) {
            return state.playlist.currentTrack.duration_sec;
        }
        if (state.playlist && state.playlist.playlistData && isFinite(state.playlist.playlistData.total_duration_sec) && state.playlist.playlistData.total_duration_sec > 0) {
            return state.playlist.playlistData.total_duration_sec;
        }
        return 0;
    }

    updatePositionState() {
        if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
            const dur = this.getDuration();
            const cur = this.getCurrentTime();
            if (isFinite(dur) && dur > 0 && isFinite(cur)) {
                try {
                    navigator.mediaSession.setPositionState({
                        duration: dur,
                        playbackRate: (this.audioElement && this.audioElement.playbackRate) || 1,
                        position: Math.min(cur, dur)
                    });
                } catch(e) {}
            }
        }
    }
}

// ============================================================================
// 2. Queue & Playlist Manager (Preserving Magic Shuffle)
// ============================================================================
class PlaylistManager {
    constructor() {
        this.currentCategory = null;
        this.currentPlaylist = null;
        this.playlistData = null; // Full index.json for current playlist
        this.currentTrackIndex = 0;

        // Magic Reservoir Shuffle for multi-track playlists:
        // Window of past tracks + lookahead upcoming tracks
        this.trackQueue = [];
        this.trackQueueIndex = 0;

        // Magic Reservoir Shuffle for Category Radio:
        this.categoryQueue = [];
        this.categoryQueueIndex = 0;

        // Modes: 'shuffle', 'repeat-one', 'sequential'
        this.mode = 'shuffle';
    }

    setMode(mode) {
        this.mode = mode;
    }

    // Set active category and reset category shuffle queue
    setCategory(categorySlug, playlistsInCat) {
        this.currentCategory = categorySlug;
        const slugs = playlistsInCat.map(p => p.slug);
        this.categoryQueue = this.getRandomSlugs(slugs, 3, []);
        this.categoryQueueIndex = 0;
    }

    async setPlaylist(playlistSlug) {
        const response = await fetch(`db/playlist/${playlistSlug}/index.json`);
        this.playlistData = await response.json();
        this.currentPlaylist = playlistSlug;

        // Initialize track queue with magic shuffle
        if (this.playlistData.tracks && this.playlistData.tracks.length > 1) {
            const trackIndices = this.playlistData.tracks.map((_, i) => i);
            this.trackQueue = this.getRandomIndices(trackIndices, Math.min(4, trackIndices.length), []);
            this.trackQueueIndex = 0;
            this.currentTrackIndex = this.trackQueue[0];
        } else {
            this.trackQueue = [0];
            this.trackQueueIndex = 0;
            this.currentTrackIndex = 0;
        }
    }

    // Magic Sliding Window Shuffle for tracks (never repeats recent 4 in next 3)
    getRandomIndices(pool, count, exclude = []) {
        const result = [];
        const available = pool.filter(i => !exclude.includes(i) && !this.trackQueue.includes(i));
        const workingPool = available.length > 0 ? available : pool.slice();

        for (let i = 0; i < count && workingPool.length > 0; i++) {
            const idx = Math.floor(Math.random() * workingPool.length);
            result.push(workingPool.splice(idx, 1)[0]);
        }
        return result;
    }

    getRandomSlugs(pool, count, exclude = []) {
        const result = [];
        const available = pool.filter(s => !exclude.includes(s) && !this.categoryQueue.includes(s));
        const workingPool = available.length > 0 ? available : pool.slice();

        for (let i = 0; i < count && workingPool.length > 0; i++) {
            const idx = Math.floor(Math.random() * workingPool.length);
            result.push(workingPool.splice(idx, 1)[0]);
        }
        return result;
    }

    maintainTrackWindow() {
        while (this.trackQueueIndex > 3) {
            this.trackQueue.shift();
            this.trackQueueIndex--;
        }
    }

    nextTrack() {
        if (!this.playlistData || !this.playlistData.tracks) return null;
        const total = this.playlistData.tracks.length;

        if (total === 1) {
            return this.currentTrackIndex;
        }

        if (this.mode === 'sequential') {
            this.currentTrackIndex = (this.currentTrackIndex + 1) % total;
            return this.currentTrackIndex;
        }

        // Magic Shuffle mode
        this.trackQueueIndex++;
        if (this.trackQueue.length - this.trackQueueIndex <= 3) {
            const allIndices = this.playlistData.tracks.map((_, i) => i);
            const nextIdx = this.getRandomIndices(allIndices, 1, this.trackQueue)[0];
            if (nextIdx !== undefined) this.trackQueue.push(nextIdx);
        }
        this.maintainTrackWindow();
        this.currentTrackIndex = this.trackQueue[this.trackQueueIndex];
        return this.currentTrackIndex;
    }

    prevTrack() {
        if (!this.playlistData || !this.playlistData.tracks) return null;
        const total = this.playlistData.tracks.length;

        if (this.mode === 'sequential') {
            this.currentTrackIndex = (this.currentTrackIndex - 1 + total) % total;
            return this.currentTrackIndex;
        }

        if (this.trackQueueIndex > 0) {
            this.trackQueueIndex--;
            this.currentTrackIndex = this.trackQueue[this.trackQueueIndex];
        }
        return this.currentTrackIndex;
    }

    // Category Radio: Pick next playlist in category using reservoir shuffle
    getNextCategoryPlaylistSlug(categoryPlaylists) {
        if (!categoryPlaylists || categoryPlaylists.length === 0) return null;
        if (categoryPlaylists.length === 1) return categoryPlaylists[0].slug;

        const allSlugs = categoryPlaylists.map(p => p.slug);
        this.categoryQueueIndex++;

        if (this.categoryQueue.length - this.categoryQueueIndex <= 2) {
            const nextSlug = this.getRandomSlugs(allSlugs, 1, this.categoryQueue)[0];
            if (nextSlug) this.categoryQueue.push(nextSlug);
        }

        while (this.categoryQueueIndex > 3) {
            this.categoryQueue.shift();
            this.categoryQueueIndex--;
        }

        return this.categoryQueue[this.categoryQueueIndex] || categoryPlaylists[0].slug;
    }

    get currentTrack() {
        if (!this.playlistData || !this.playlistData.tracks) return null;
        return this.playlistData.tracks[this.currentTrackIndex] || null;
    }

    getTrackAudioUrl(index = this.currentTrackIndex) {
        if (!this.playlistData || !this.playlistData.tracks) return null;
        const track = this.playlistData.tracks[index];
        if (!track) return null;
        const num = String(index + 1).padStart(2, '0');
        return `db/playlist/${this.currentPlaylist}/${num}-${track.slug}.${track.format || 'opus'}`;
    }

    getTrackVttUrl(index = this.currentTrackIndex) {
        if (!this.playlistData || !this.playlistData.tracks) return null;
        const track = this.playlistData.tracks[index];
        if (!track) return null;
        const num = String(index + 1).padStart(2, '0');
        return `db/playlist/${this.currentPlaylist}/${num}-${track.slug}.vtt`;
    }
}

// ============================================================================
// 3. WebVTT Parser
// ============================================================================
function parseVTT(vttText) {
    const lines = vttText.split(/\r?\n/);
    const cues = [];
    let i = 0;

    function parseTimestamp(ts) {
        const parts = ts.trim().split(':');
        let sec = 0;
        if (parts.length === 3) {
            sec = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        } else if (parts.length === 2) {
            sec = parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
        }
        return isNaN(sec) ? 0 : sec;
    }

    while (i < lines.length) {
        const line = lines[i].trim();
        if (line.includes('-->')) {
            const [startStr, endStr] = line.split('-->');
            const start = parseTimestamp(startStr);
            const end = parseTimestamp(endStr.trim().split(' ')[0]);
            let text = '';
            i++;
            while (i < lines.length && lines[i].trim() !== '') {
                text += (text ? ' ' : '') + lines[i].trim();
                i++;
            }
            if (text) cues.push({ start, end, text });
        } else {
            i++;
        }
    }
    return cues;
}

// ============================================================================
// 4. Global State & Service Worker Communication
// ============================================================================
const SLEEP_INTERVALS = [];
for (let i = 1; i <= 20; i++) SLEEP_INTERVALS.push(i);
for (let i = 22; i <= 30; i += 2) SLEEP_INTERVALS.push(i);
for (let i = 35; i <= 55; i += 5) SLEEP_INTERVALS.push(i);
for (let i = 60; i <= 240; i += 10) SLEEP_INTERVALS.push(i);

function sendSWMessage(msg) {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage(msg);
    } else if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(reg => {
            if (reg.active) reg.active.postMessage(msg);
        });
    }
}

const state = {
    audio: new AudioEngine(),
    playlist: new PlaylistManager(),
    categories: [],
    playlistsByCat: new Map(), // categorySlug -> array of playlists
    allPlaylistsMeta: [],

    // Restored session state
    restoredSeekTime: 0,

    // Offline state
    offlinePlaylists: new Set(),
    offlineFilterActive: false,
    downloadingSlugs: new Set(),

    // Subtitles state
    cues: [],
    activeCueIndex: -1,
    hasVtt: false,

    // Sleep timer state
    sleepTimer: null,
    sleepRemainingSeconds: 0,
    sleepOnFinish: false,
    sleepTimerActive: false
};

// UI Elements map
const el = {
    app: document.getElementById('app'),
    networkPill: document.getElementById('network-pill'),
    settingsBtn: document.getElementById('settings-btn'),
    offlineFilterBtn: document.getElementById('offline-filter-btn'),
    downloadedCountBadge: document.getElementById('downloaded-count-badge'),
    categoryList: document.getElementById('category-list'),
    
    // Main view
    backBtn: document.getElementById('back-btn'),
    viewTitle: document.getElementById('view-title'),
    viewMeta: document.getElementById('view-meta'),
    offlineActiveBanner: document.getElementById('offline-active-banner'),
    playlistsView: document.getElementById('playlists-view'),
    playlistGrid: document.getElementById('playlist-grid'),

    // Hero player & tracklist
    playerDetailView: document.getElementById('player-detail-view'),
    heroBackdrop: document.getElementById('hero-backdrop'),
    heroCover: document.getElementById('hero-cover'),
    heroTitle: document.getElementById('hero-title'),
    heroNarrator: document.getElementById('hero-narrator'),
    heroMeta: document.getElementById('hero-meta'),
    tracklistContainer: document.getElementById('tracklist-container'),
    trackList: document.getElementById('track-list'),

    // Playback bar controls
    trackName: document.getElementById('current-track-name'),
    playlistName: document.getElementById('current-playlist-name'),
    progressBar: document.getElementById('progress-bar'),
    progressFill: document.getElementById('progress-fill'),
    currentTime: document.getElementById('current-time'),
    totalTime: document.getElementById('total-time'),
    playPauseBtn: document.getElementById('play-pause-btn'),
    playIcon: document.getElementById('play-icon'),
    pauseIcon: document.getElementById('pause-icon'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    volumeSlider: document.getElementById('volume-slider'),
    playbackModeBtn: document.getElementById('playback-mode-btn'),
    modeIcon: document.getElementById('mode-icon'),
    vttBtn: document.getElementById('vtt-btn'),
    sleepTimerBtn: document.getElementById('sleep-timer-btn'),
    navToggle: document.getElementById('nav-toggle'),

    // HUD Action Hint Toast
    hudToast: document.getElementById('hud-toast'),
    hudToastIcon: document.getElementById('hud-toast-icon'),
    hudToastTitle: document.getElementById('hud-toast-title'),
    hudToastDesc: document.getElementById('hud-toast-desc'),

    // Fullscreen VTT Modal
    vttOverlay: document.getElementById('vtt-overlay'),
    vttTrackTitle: document.getElementById('vtt-track-title'),
    vttCuesContainer: document.getElementById('vtt-cues-container'),
    closeVttBtn: document.getElementById('close-vtt-btn'),
    vttCurrentTime: document.getElementById('vtt-current-time'),
    vttTotalTime: document.getElementById('vtt-total-time'),
    vttProgressBar: document.getElementById('vtt-progress-bar'),
    vttProgressFill: document.getElementById('vtt-progress-fill'),
    vttPlayPauseBtn: document.getElementById('vtt-play-pause-btn'),
    vttPlayIcon: document.getElementById('vtt-play-icon'),
    vttPauseIcon: document.getElementById('vtt-pause-icon'),

    // Modals
    settingsModal: document.getElementById('settings-modal'),
    closeSettingsBtn: document.getElementById('close-settings-btn'),
    storageStatusText: document.getElementById('storage-status-text'),
    clearDownloadsBtn: document.getElementById('clear-downloads-btn'),
    forceReloadBtn: document.getElementById('force-reload-btn'),

    sleepModal: document.getElementById('sleep-timer-modal'),
    timerSlider: document.getElementById('timer-slider'),
    timerDisplay: document.getElementById('selected-timer-display'),
    startTimerBtn: document.getElementById('start-timer-btn'),
    finishTrackCheckbox: document.getElementById('finish-track-checkbox'),
    cancelTimer: document.getElementById('cancel-timer')
};

// ============================================================================
// 4.5. Playback Session Persistence (Every 30s, Pause, Leave)
// ============================================================================
function savePlaybackSession() {
    if (!state.playlist || !state.playlist.currentPlaylist || !state.playlist.currentTrack) {
        return;
    }

    let curTime = 0;
    if (state.audio.isPlaying || state.audio.isPaused) {
        curTime = state.audio.getCurrentTime();
    } else if (state.restoredSeekTime > 0) {
        curTime = state.restoredSeekTime;
    }

    const duration = state.audio.getDuration() || state.playlist.currentTrack.duration_sec || 0;

    // Reset to beginning if track was essentially finished (within 2s of end)
    if (duration > 0 && curTime >= duration - 2) {
        curTime = 0;
    }

    const session = {
        categorySlug: state.playlist.currentCategory,
        playlistSlug: state.playlist.currentPlaylist,
        trackIndex: state.playlist.currentTrackIndex || 0,
        trackSlug: state.playlist.currentTrack.slug,
        seekTime: Math.max(0, Math.floor(curTime)),
        mode: state.playlist.mode || 'shuffle',
        savedAt: Date.now()
    };

    try {
        localStorage.setItem('di_playback_session', JSON.stringify(session));
    } catch (e) {
        console.warn('[Session] Failed to persist session to localStorage:', e);
    }
}

async function restorePlaybackSession() {
    const raw = localStorage.getItem('di_playback_session');
    if (!raw) return false;

    let session = null;
    try {
        session = JSON.parse(raw);
    } catch (e) {
        return false;
    }

    if (!session || !session.playlistSlug) return false;

    // Verify playlist exists in catalog
    const playlistMeta = state.allPlaylistsMeta.find(p => p.slug === session.playlistSlug);
    if (!playlistMeta) return false;

    // Check offline availability if currently offline or in offline-only mode
    const isOffline = !navigator.onLine || state.offlineFilterActive;
    if (isOffline && !state.offlinePlaylists.has(session.playlistSlug)) {
        return false;
    }

    // Determine category
    let catSlug = session.categorySlug;
    if (!catSlug || !state.categories.some(c => c.slug === catSlug)) {
        for (const [cSlug, pls] of state.playlistsByCat.entries()) {
            if (pls.some(p => p.slug === session.playlistSlug)) {
                catSlug = cSlug;
                break;
            }
        }
    }
    if (!catSlug && state.categories.length > 0) {
        catSlug = state.categories[0].slug;
    }

    if (catSlug) {
        state.playlist.currentCategory = catSlug;
        const cat = state.categories.find(c => c.slug === catSlug);
        const playlists = state.playlistsByCat.get(catSlug) || [];
        state.playlist.setCategory(catSlug, playlists);
        el.viewTitle.textContent = cat ? cat.title : 'Playlists';
        renderCategories();
    }

    // Restore playback mode
    if (session.mode) {
        state.playlist.setMode(session.mode);
        if (session.mode === 'repeat-one') {
            el.modeIcon.textContent = '🔂';
            el.playbackModeBtn.title = 'Mode: Repeat Track';
        } else if (session.mode === 'sequential') {
            el.modeIcon.textContent = '🔁';
            el.playbackModeBtn.title = 'Mode: Sequential';
        } else {
            el.modeIcon.textContent = '🔀';
            el.playbackModeBtn.title = 'Mode: Shuffle & Radio';
        }
    }

    // Load playlist data
    try {
        await state.playlist.setPlaylist(session.playlistSlug);
    } catch (err) {
        console.warn('[Session] Failed to load playlist for restoration:', err);
        return false;
    }

    // Restore track index
    let trackIdx = session.trackIndex || 0;
    if (state.playlist.playlistData && state.playlist.playlistData.tracks) {
        if (session.trackSlug) {
            const foundIdx = state.playlist.playlistData.tracks.findIndex(t => t.slug === session.trackSlug);
            if (foundIdx >= 0) trackIdx = foundIdx;
        }
        trackIdx = Math.max(0, Math.min(trackIdx, state.playlist.playlistData.tracks.length - 1));
        state.playlist.currentTrackIndex = trackIdx;
        state.playlist.trackQueue = [trackIdx];
        state.playlist.trackQueueIndex = 0;
    }

    const track = state.playlist.currentTrack;
    if (!track) return false;

    const duration = track.duration_sec || state.playlist.playlistData?.total_duration_sec || 0;
    let seekTime = session.seekTime || 0;
    if (duration > 0 && seekTime >= duration - 2) {
        seekTime = 0;
    }
    state.restoredSeekTime = seekTime;

    // Render UI for this playlist & track
    renderPlaylists();
    renderPlayerDetail();

    el.trackName.textContent = track.title;
    el.playlistName.textContent = state.playlist.playlistData ? state.playlist.playlistData.title : '';

    // Load VTT subtitles
    await loadVTTForCurrentTrack();

    if (seekTime > 0) {
        updateVttActiveCue(seekTime);
    }

    showPlaylistsView();
    return true;
}

// ============================================================================
// 5. App Initialization & Data Loading
// ============================================================================
async function init() {
    registerServiceWorker();
    loadOfflineRegistry();
    setupNetworkListeners();
    setupEventListeners();
    setupMediaSessionHandlers();

    // Ask browser for persistent storage
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(granted => {
            console.log('[Storage] Persistent storage granted:', granted);
        });
    }

    // Load Categories & Playlists metadata
    try {
        const catResp = await fetch('db/categories.json');
        state.categories = await catResp.json();

        const plsResp = await fetch('db/playlists.json');
        state.allPlaylistsMeta = await plsResp.json();

        // Load playlists per category
        for (const cat of state.categories) {
            try {
                const cResp = await fetch(`db/category/${cat.slug}.json`);
                const cData = await cResp.json();
                state.playlistsByCat.set(cat.slug, cData.playlists || []);
            } catch(e) {
                state.playlistsByCat.set(cat.slug, []);
            }
        }
    } catch(err) {
        console.error("[Init] Failed loading DB JSON:", err);
    }

    renderCategories();

    // Restore saved playback position & track, or fallback to first category
    const restored = await restorePlaybackSession();
    if (!restored && state.categories.length > 0) {
        await selectCategory(state.categories[0].slug);
    }

    updateDownloadedBadge();
    requestAnimationFrame(updateUI);
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js').then((reg) => {
            console.log('[SW] Registered successfully:', reg.scope);
        }).catch(err => console.error('[SW] Registration failed:', err));

        navigator.serviceWorker.addEventListener('message', handleSWMessage);
    }
}

function handleSWMessage(event) {
    const data = event.data;
    if (!data) return;

    if (data.type === 'DOWNLOAD_PROGRESS') {
        const { playlistSlug, percent } = data;
        state.downloadingSlugs.add(playlistSlug);
        updatePlaylistCardDownloadUI(playlistSlug, 'downloading', percent);
    }

    if (data.type === 'DOWNLOAD_COMPLETE') {
        const { playlistSlug } = data;
        state.downloadingSlugs.delete(playlistSlug);
        state.offlinePlaylists.add(playlistSlug);
        saveOfflineRegistry();
        updatePlaylistCardDownloadUI(playlistSlug, 'downloaded');
        updateDownloadedBadge();
    }

    if (data.type === 'DELETE_COMPLETE') {
        const { playlistSlug } = data;
        state.offlinePlaylists.delete(playlistSlug);
        saveOfflineRegistry();
        updatePlaylistCardDownloadUI(playlistSlug, 'idle');
        updateDownloadedBadge();
    }

    if (data.type === 'STORAGE_REPORT') {
        const mb = (data.totalBytes / (1024 * 1024)).toFixed(1);
        el.storageStatusText.textContent = `${mb} MB used across ${data.fileCount} cached files.`;
    }

    if (data.type === 'ALL_AUDIO_CLEARED') {
        state.offlinePlaylists.clear();
        saveOfflineRegistry();
        renderPlaylists();
        updateDownloadedBadge();
        el.storageStatusText.textContent = "0 MB used. All audio downloads cleared.";
    }
}

// ============================================================================
// 6. Offline Registry & Network State
// ============================================================================
function loadOfflineRegistry() {
    try {
        const saved = localStorage.getItem('di_offline_playlists');
        if (saved) {
            state.offlinePlaylists = new Set(JSON.parse(saved));
        }
    } catch(e) {
        state.offlinePlaylists = new Set();
    }
}

function saveOfflineRegistry() {
    localStorage.setItem('di_offline_playlists', JSON.stringify(Array.from(state.offlinePlaylists)));
}

function setupNetworkListeners() {
    function updateOnlineStatus() {
        const online = navigator.onLine;
        el.networkPill.textContent = online ? 'Online' : 'Offline';
        el.networkPill.className = `pill-badge ${online ? 'online' : 'offline'}`;

        if (!online) {
            state.offlineFilterActive = true;
            el.offlineFilterBtn.classList.add('active');
            el.offlineActiveBanner.classList.remove('hidden');
        } else if (!el.offlineFilterBtn.classList.contains('active')) {
            state.offlineFilterActive = false;
            el.offlineActiveBanner.classList.add('hidden');
        }
        renderPlaylists();
        renderCategories();
    }

    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();
}

function updateDownloadedBadge() {
    el.downloadedCountBadge.textContent = state.offlinePlaylists.size;
}

// ============================================================================
// 7. Navigation & Rendering
// ============================================================================
function showCategoriesView() {
    el.app.classList.add('show-categories');
    el.app.classList.remove('show-playlists');
}

function showPlaylistsView() {
    el.app.classList.add('show-playlists');
    el.app.classList.remove('show-categories');
}

function renderCategories() {
    el.categoryList.innerHTML = state.categories.map(c => {
        const playlists = state.playlistsByCat.get(c.slug) || [];
        const count = state.offlineFilterActive
            ? playlists.filter(p => state.offlinePlaylists.has(p.slug)).length
            : playlists.length;

        const isActive = state.playlist.currentCategory === c.slug;
        return `
            <div class="category-item ${isActive ? 'active' : ''}" data-slug="${c.slug}">
                <span class="category-name">${c.title}</span>
                <span class="category-meta">${count} playlists</span>
            </div>
        `;
    }).join('');
}

async function selectCategory(categorySlug) {
    state.playlist.currentCategory = categorySlug;
    const cat = state.categories.find(c => c.slug === categorySlug);
    const playlists = state.playlistsByCat.get(categorySlug) || [];

    state.playlist.setCategory(categorySlug, playlists);

    el.viewTitle.textContent = cat ? cat.title : 'Playlists';
    renderCategories();
    renderPlaylists();
}

function renderPlaylists() {
    const currentCatSlug = state.playlist.currentCategory;
    let playlists = state.playlistsByCat.get(currentCatSlug) || [];

    if (state.offlineFilterActive) {
        playlists = playlists.filter(p => state.offlinePlaylists.has(p.slug));
    }

    el.viewMeta.textContent = `${playlists.length} Playlists`;

    if (playlists.length === 0) {
        el.playlistGrid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 3rem 1rem; color: var(--text-dim);">
                <p>No ${state.offlineFilterActive ? 'downloaded ' : ''}playlists found in this category.</p>
            </div>
        `;
        return;
    }

    el.playlistGrid.innerHTML = playlists.map(p => {
        const isDownloaded = state.offlinePlaylists.has(p.slug);
        const isDownloading = state.downloadingSlugs.has(p.slug);
        const isActive = state.playlist.currentPlaylist === p.slug;

        let downloadIcon = '⬇';
        let downloadClass = '';
        if (isDownloaded) {
            downloadIcon = '✓';
            downloadClass = 'downloaded';
        } else if (isDownloading) {
            downloadIcon = '⟳';
            downloadClass = 'downloading';
        }

        return `
            <div class="playlist-card ${isActive ? 'active-card' : ''}" data-slug="${p.slug}">
                <div class="card-cover-wrapper">
                    <img class="card-cover" src="db/playlist/${p.slug}/index.webp" loading="lazy" alt="${p.title}">
                    <button class="card-download-btn ${downloadClass}" data-slug="${p.slug}" title="${isDownloaded ? 'Downloaded (Tap to remove)' : 'Download offline'}">
                        ${downloadIcon}
                    </button>
                </div>
                <div class="card-info">
                    <h3 class="card-title">${p.title}</h3>
                    <span class="card-narrator">${p.narrator || 'Calm'}</span>
                    <div class="card-meta">
                        <span>${p.total_tracks} ${p.total_tracks === 1 ? 'track' : 'tracks'}</span>
                        <span>${formatTime(p.total_duration_sec)}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function updatePlaylistCardDownloadUI(slug, status, percent = 0) {
    const btn = document.querySelector(`.card-download-btn[data-slug="${slug}"]`);
    if (!btn) return;

    btn.className = `card-download-btn ${status}`;
    if (status === 'downloaded') {
        btn.textContent = '✓';
        btn.title = 'Downloaded (Tap to remove)';
    } else if (status === 'downloading') {
        btn.textContent = '⟳';
        btn.title = `Downloading (${percent}%)...`;
    } else {
        btn.textContent = '⬇';
        btn.title = 'Download offline';
    }
}

// ============================================================================
// 8. Playback Execution & Player Detail UI
// ============================================================================
async function playPlaylist(playlistSlug, trackIndex = 0) {
    state.restoredSeekTime = 0;
    await state.playlist.setPlaylist(playlistSlug);
    state.playlist.currentTrackIndex = trackIndex;

    renderPlaylists();
    renderPlayerDetail();
    await playCurrentTrack(0);

    showPlaylistsView();
}

function renderPlayerDetail() {
    const pl = state.playlist.playlistData;
    if (!pl) return;

    el.playerDetailView.classList.remove('hidden');
    el.heroCover.src = `db/playlist/${pl.slug}/index.webp`;
    el.heroBackdrop.style.backgroundImage = `url(db/playlist/${pl.slug}/index.webp)`;
    el.heroTitle.textContent = pl.title;
    el.heroNarrator.textContent = pl.narrator || pl.author || '';
    el.heroMeta.textContent = `${pl.total_tracks} ${pl.total_tracks === 1 ? 'track' : 'tracks'} • ${formatTime(pl.total_duration_sec)}`;

    // Tracklist rendering for multi-track playlists
    if (pl.tracks && pl.tracks.length > 1) {
        el.tracklistContainer.classList.remove('hidden');
        el.trackList.innerHTML = pl.tracks.map((t, idx) => {
            const isActive = idx === state.playlist.currentTrackIndex;
            return `
                <div class="track-row ${isActive ? 'active' : ''}" data-index="${idx}">
                    <span class="track-row-num">${isActive ? '▶' : idx + 1}</span>
                    <span class="track-row-title">${t.title}</span>
                    <span class="track-row-duration">${formatTime(t.duration_sec)}</span>
                </div>
            `;
        }).join('');
    } else {
        el.tracklistContainer.classList.add('hidden');
    }
}

async function playCurrentTrack(startTime = null) {
    const track = state.playlist.currentTrack;
    if (!track) return;

    const audioUrl = state.playlist.getTrackAudioUrl();
    if (!audioUrl) return;

    el.trackName.textContent = track.title;
    el.playlistName.textContent = state.playlist.playlistData ? state.playlist.playlistData.title : '';

    // Load VTT subtitles if available
    await loadVTTForCurrentTrack();

    const seekTo = (startTime !== null) ? startTime : (state.restoredSeekTime || 0);
    state.restoredSeekTime = 0;

    await state.audio.play(audioUrl, seekTo);

    savePlaybackSession();
    updateMediaSession();
    renderPlayerDetail();
}

async function loadVTTForCurrentTrack() {
    state.cues = [];
    state.activeCueIndex = -1;
    state.hasVtt = false;

    const vttUrl = state.playlist.getTrackVttUrl();
    try {
        const resp = await fetch(vttUrl);
        if (resp.ok) {
            const text = await resp.text();
            state.cues = parseVTT(text);
            state.hasVtt = state.cues.length > 0;
        }
    } catch(e) {
        state.hasVtt = false;
    }

    if (state.hasVtt) {
        el.vttBtn.classList.remove('hidden');
        renderVttCues();
    } else {
        el.vttBtn.classList.add('hidden');
        closeVttOverlay();
    }
}

// ============================================================================
// 9. Fullscreen VTT Subtitle / Realtime Lyrics Modal
// ============================================================================
let userIsScrollingVtt = false;
let userScrollTimeout = null;

function renderVttCues() {
    el.vttTrackTitle.textContent = state.playlist.currentTrack ? state.playlist.currentTrack.title : '';
    el.vttCuesContainer.innerHTML = state.cues.map((cue, idx) => `
        <div class="vtt-cue" data-index="${idx}" data-start="${cue.start}" data-end="${cue.end}">
            ${cue.text}
        </div>
    `).join('');
    userIsScrollingVtt = false;
}

function updateVttActiveCue(currentTime) {
    if (!state.hasVtt || state.cues.length === 0) return;

    // Find the latest cue that has started (persisting during narrator breath/silence pauses)
    let newIndex = -1;
    for (let i = 0; i < state.cues.length; i++) {
        if (currentTime >= state.cues[i].start) {
            newIndex = i;
        } else {
            break;
        }
    }

    if (newIndex !== -1 && newIndex !== state.activeCueIndex) {
        state.activeCueIndex = newIndex;

        const cueElements = el.vttCuesContainer.querySelectorAll('.vtt-cue');
        cueElements.forEach((elem, i) => {
            if (i === newIndex) {
                elem.classList.add('active');
                if (!userIsScrollingVtt) {
                    elem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            } else {
                elem.classList.remove('active');
            }
        });
    }
}

function openVttOverlay() {
    el.vttOverlay.classList.remove('hidden');
}

function closeVttOverlay() {
    el.vttOverlay.classList.add('hidden');
}

// ============================================================================
// 10. Offline Download Manager Action
// ============================================================================
async function handleDownloadToggle(playlistSlug) {
    if (state.offlinePlaylists.has(playlistSlug)) {
        // Remove from offline
        state.offlinePlaylists.delete(playlistSlug);
        saveOfflineRegistry();
        updatePlaylistCardDownloadUI(playlistSlug, 'idle');
        updateDownloadedBadge();
        if (state.offlineFilterActive) renderPlaylists();

        try {
            const plResp = await fetch(`db/playlist/${playlistSlug}/index.json`);
            const plData = await plResp.json();
            const urls = [
                `db/playlist/${playlistSlug}/index.json`,
                `db/playlist/${playlistSlug}/index.webp`
            ];
            if (plData.tracks) {
                plData.tracks.forEach((t, i) => {
                    const num = String(i + 1).padStart(2, '0');
                    urls.push(`db/playlist/${playlistSlug}/${num}-${t.slug}.${t.format || 'opus'}`);
                    urls.push(`db/playlist/${playlistSlug}/${num}-${t.slug}.vtt`);
                });
            }
            sendSWMessage({
                type: 'DELETE_PLAYLIST',
                playlistSlug,
                files: urls
            });
        } catch(e) {
            console.warn('[Offline] Error deleting playlist:', e);
        }
    } else {
        // Start download
        state.downloadingSlugs.add(playlistSlug);
        updatePlaylistCardDownloadUI(playlistSlug, 'downloading', 0);

        try {
            const plResp = await fetch(`db/playlist/${playlistSlug}/index.json`);
            const plData = await plResp.json();
            const urls = [
                `db/playlist/${playlistSlug}/index.json`,
                `db/playlist/${playlistSlug}/index.webp`
            ];
            if (plData.tracks) {
                plData.tracks.forEach((t, i) => {
                    const num = String(i + 1).padStart(2, '0');
                    urls.push(`db/playlist/${playlistSlug}/${num}-${t.slug}.${t.format || 'opus'}`);
                    urls.push(`db/playlist/${playlistSlug}/${num}-${t.slug}.vtt`);
                });
            }
            sendSWMessage({
                type: 'DOWNLOAD_PLAYLIST',
                playlistSlug,
                files: urls
            });
        } catch(e) {
            console.warn('[Offline] Error initiating download:', e);
            state.downloadingSlugs.delete(playlistSlug);
            updatePlaylistCardDownloadUI(playlistSlug, 'idle');
        }
    }
}

// ============================================================================
// 11. Sleep Timer
// ============================================================================
function setSleepTimer(minutes, finishTrack) {
    clearSleepTimer();
    state.sleepRemainingSeconds = minutes * 60;
    state.sleepOnFinish = finishTrack;
    state.sleepTimerActive = true;
    updateSleepButtonText();

    state.sleepTimer = setInterval(() => {
        state.sleepRemainingSeconds--;
        updateSleepButtonText();

        // Smooth 10s fade-out near the end
        if (state.sleepRemainingSeconds <= 10 && state.sleepRemainingSeconds > 0) {
            state.audio.fadeNode('sleep', 0.0, state.sleepRemainingSeconds);
        }

        if (state.sleepRemainingSeconds <= 0) {
            if (!state.sleepOnFinish) {
                state.audio.pause();
                clearSleepTimer();
            } else {
                // Wait for track-ended event
                clearInterval(state.sleepTimer);
                state.sleepTimer = null;
            }
        }
    }, 1000);
}

function clearSleepTimer() {
    if (state.sleepTimer) clearInterval(state.sleepTimer);
    state.sleepTimer = null;
    state.sleepRemainingSeconds = 0;
    state.sleepTimerActive = false;
    el.sleepTimerBtn.textContent = 'Sleep Timer';
    el.sleepTimerBtn.classList.remove('active');
    state.audio.nodes.sleep && (state.audio.nodes.sleep.gain.value = 1.0);
}

function updateSleepButtonText() {
    if (state.sleepRemainingSeconds > 0) {
        const m = Math.floor(state.sleepRemainingSeconds / 60);
        const s = state.sleepRemainingSeconds % 60;
        el.sleepTimerBtn.textContent = `🌙 ${m}:${s.toString().padStart(2, '0')}`;
        el.sleepTimerBtn.classList.add('active');
    }
}

// ============================================================================
// 12. Media Session & Controls
// ============================================================================
function updateMediaSession() {
    if ('mediaSession' in navigator && state.playlist.currentTrack) {
        const pl = state.playlist.playlistData;
        navigator.mediaSession.metadata = new MediaMetadata({
            title: state.playlist.currentTrack.title,
            artist: pl ? (pl.narrator || pl.author || 'Calm') : 'Dream Improvisation',
            album: pl ? pl.title : 'Meditation',
            artwork: [
                { src: `db/playlist/${pl.slug}/index.webp`, sizes: '512x512', type: 'image/webp' }
            ]
        });
    }
}

function setupMediaSessionHandlers() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', () => {
            if (state.audio.isPaused) state.audio.resume();
            else if (!state.audio.isPlaying) playCurrentTrack();
        });
        navigator.mediaSession.setActionHandler('pause', () => state.audio.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => onPrevClicked());
        navigator.mediaSession.setActionHandler('nexttrack', () => onNextClicked());
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.seekTime !== undefined) state.audio.seek(details.seekTime);
        });
    }
}

// ============================================================================
// HUD Toast Hint (Keycaster / IDE Style Action Feedback)
// ============================================================================
let hudToastTimeout = null;

function showHudToast(icon, title, desc) {
    if (!el.hudToast) return;
    el.hudToastIcon.textContent = icon;
    el.hudToastTitle.textContent = title;
    el.hudToastDesc.textContent = desc;

    el.hudToast.classList.remove('hidden');
    // Force DOM reflow for CSS transition
    void el.hudToast.offsetWidth;
    el.hudToast.classList.add('show');

    if (hudToastTimeout) clearTimeout(hudToastTimeout);
    hudToastTimeout = setTimeout(() => {
        el.hudToast.classList.remove('show');
        setTimeout(() => {
            if (!el.hudToast.classList.contains('show')) {
                el.hudToast.classList.add('hidden');
            }
        }, 250);
    }, 1500);
}

// ============================================================================
// 13. Event Listeners & User Interactions
// ============================================================================
function setupEventListeners() {
    // Category item selection
    el.categoryList.addEventListener('click', (e) => {
        const item = e.target.closest('.category-item');
        if (item) selectCategory(item.dataset.slug);
    });

    // Offline filter toggle
    el.offlineFilterBtn.addEventListener('click', () => {
        state.offlineFilterActive = !state.offlineFilterActive;
        el.offlineFilterBtn.classList.toggle('active', state.offlineFilterActive);
        el.offlineActiveBanner.classList.toggle('hidden', !state.offlineFilterActive);
        renderCategories();
        renderPlaylists();
    });

    // Playlist cards click & download button click
    el.playlistGrid.addEventListener('click', (e) => {
        const dlBtn = e.target.closest('.card-download-btn');
        if (dlBtn) {
            e.stopPropagation();
            handleDownloadToggle(dlBtn.dataset.slug);
            return;
        }

        const card = e.target.closest('.playlist-card');
        if (card) {
            state.restoredSeekTime = 0;
            playPlaylist(card.dataset.slug, 0);
        }
    });

    // Hero artwork click to toggle play/pause
    el.heroCover.addEventListener('click', () => {
        el.playPauseBtn.click();
    });

    // Tracklist row click
    el.trackList.addEventListener('click', (e) => {
        const row = e.target.closest('.track-row');
        if (row) {
            const idx = parseInt(row.dataset.index, 10);
            state.restoredSeekTime = 0;
            state.playlist.currentTrackIndex = idx;
            playCurrentTrack(0);
        }
    });

    // Play/Pause button
    el.playPauseBtn.addEventListener('click', () => {
        if (state.audio.isPaused) state.audio.resume();
        else if (state.audio.isPlaying) state.audio.pause();
        else playCurrentTrack();
    });

    // Prev / Next buttons
    el.prevBtn.addEventListener('click', onPrevClicked);
    el.nextBtn.addEventListener('click', onNextClicked);

    // Track ended event (Auto-Advance & Magic Shuffle)
    window.addEventListener('track-ended', () => {
        if (state.sleepOnFinish && state.sleepTimerActive) {
            clearSleepTimer();
            state.audio.pause();
            return;
        }

        if (state.playlist.mode === 'repeat-one') {
            state.audio.seek(0);
            state.audio.resume();
            return;
        }

        // Advance track or category
        onNextClicked();
    });

    // Progress bar seeking
    el.progressBar.addEventListener('click', (e) => {
        const rect = el.progressBar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const dur = state.audio.getDuration();
        if (isFinite(dur) && dur > 0) {
            if (!state.audio.isPlaying && !state.audio.isPaused) {
                state.restoredSeekTime = ratio * dur;
                updateVttActiveCue(state.restoredSeekTime);
                savePlaybackSession();
            } else {
                state.audio.seek(ratio * dur);
            }
        }
    });

    // Volume slider
    el.volumeSlider.addEventListener('input', (e) => {
        state.audio.setVolume(parseFloat(e.target.value));
    });

    // Playback mode button toggle (Shuffle -> Repeat One -> Sequential)
    el.playbackModeBtn.addEventListener('click', () => {
        if (state.playlist.mode === 'shuffle') {
            state.playlist.setMode('repeat-one');
            el.modeIcon.textContent = '🔂';
            el.playbackModeBtn.title = 'Mode: Repeat Track';
            showHudToast('🔂', 'Repeat Track Active', 'Loop current track continuously');
        } else if (state.playlist.mode === 'repeat-one') {
            state.playlist.setMode('sequential');
            el.modeIcon.textContent = '🔁';
            el.playbackModeBtn.title = 'Mode: Sequential';
            showHudToast('🔁', 'Sequential Play Active', 'Play tracks in order (1 to N)');
        } else {
            state.playlist.setMode('shuffle');
            el.modeIcon.textContent = '🔀';
            el.playbackModeBtn.title = 'Mode: Shuffle & Radio';
            showHudToast('🔀', 'Magic Shuffle Active', 'Non-repeating queue & category radio');
        }
        savePlaybackSession();
    });

    // VTT Subtitles overlay toggle & cue seeking
    el.vttBtn.addEventListener('click', openVttOverlay);
    el.closeVttBtn.addEventListener('click', closeVttOverlay);

    el.vttCuesContainer.addEventListener('scroll', () => {
        userIsScrollingVtt = true;
        if (userScrollTimeout) clearTimeout(userScrollTimeout);
        userScrollTimeout = setTimeout(() => {
            userIsScrollingVtt = false;
        }, 2500);
    }, { passive: true });

    el.vttCuesContainer.addEventListener('click', (e) => {
        const cueElem = e.target.closest('.vtt-cue');
        if (cueElem) {
            const startSec = parseFloat(cueElem.dataset.start);
            userIsScrollingVtt = false;
            if (!state.audio.isPlaying && !state.audio.isPaused) {
                state.restoredSeekTime = startSec;
                savePlaybackSession();
            } else {
                state.audio.seek(startSec);
            }
            const idx = parseInt(cueElem.dataset.index, 10);
            state.activeCueIndex = idx;
            const cueElements = el.vttCuesContainer.querySelectorAll('.vtt-cue');
            cueElements.forEach((elem, i) => {
                if (i === idx) {
                    elem.classList.add('active');
                    elem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else {
                    elem.classList.remove('active');
                }
            });
        }
    });
    el.vttPlayPauseBtn.addEventListener('click', () => {
        if (state.audio.isPaused) state.audio.resume();
        else if (state.audio.isPlaying) state.audio.pause();
        else playCurrentTrack();
    });
    el.vttProgressBar.addEventListener('click', (e) => {
        const rect = el.vttProgressBar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const dur = state.audio.getDuration();
        if (isFinite(dur) && dur > 0) {
            if (!state.audio.isPlaying && !state.audio.isPaused) {
                state.restoredSeekTime = ratio * dur;
                updateVttActiveCue(state.restoredSeekTime);
                savePlaybackSession();
            } else {
                state.audio.seek(ratio * dur);
            }
        }
    });

    // Navigation toggles (Mobile)
    el.backBtn.addEventListener('click', showCategoriesView);
    el.navToggle.addEventListener('click', () => {
        if (el.app.classList.contains('show-categories')) showPlaylistsView();
        else showCategoriesView();
    });

    // Settings Modal
    el.settingsBtn.addEventListener('click', () => {
        sendSWMessage({ type: 'GET_OFFLINE_STORAGE' });
        el.settingsModal.classList.remove('hidden');
    });
    el.closeSettingsBtn.addEventListener('click', () => el.settingsModal.classList.add('hidden'));

    el.clearDownloadsBtn.addEventListener('click', () => {
        if (confirm('Delete all offline downloaded music files from device cache?')) {
            sendSWMessage({ type: 'CLEAR_ALL_AUDIO' });
        }
    });

    el.forceReloadBtn.addEventListener('click', () => {
        sendSWMessage({ type: 'CLEAR_SHELL_CACHE' });
        setTimeout(() => window.location.reload(), 300);
    });

    // Sleep Timer Modal
    el.sleepTimerBtn.addEventListener('click', () => el.sleepModal.classList.remove('hidden'));
    el.timerSlider.addEventListener('input', (e) => {
        const mins = SLEEP_INTERVALS[parseInt(e.target.value, 10)];
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        el.timerDisplay.textContent = `${h}:${m.toString().padStart(2, '0')}`;
    });
    el.startTimerBtn.addEventListener('click', () => {
        const mins = SLEEP_INTERVALS[parseInt(el.timerSlider.value, 10)];
        setSleepTimer(mins, el.finishTrackCheckbox.checked);
        el.sleepModal.classList.add('hidden');
    });
    el.cancelTimer.addEventListener('click', () => {
        clearSleepTimer();
        el.sleepModal.classList.add('hidden');
    });

    // Periodic session persistence (every 30 seconds while playing)
    setInterval(() => {
        if (state.audio.isPlaying && !state.audio.isPaused) {
            savePlaybackSession();
        }
    }, 30000);

    // Save session on page leave / backgrounding
    window.addEventListener('beforeunload', savePlaybackSession);
    window.addEventListener('pagehide', savePlaybackSession);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            savePlaybackSession();
        }
    });

    // Keyboard shortcuts (Space = Play/Pause, Arrows = Seek 10s)
    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.code === 'Space') {
            e.preventDefault();
            el.playPauseBtn.click();
        } else if (e.code === 'ArrowRight') {
            e.preventDefault();
            const dur = state.audio.getDuration();
            if (state.audio.isPlaying || state.audio.isPaused) {
                state.audio.seek(Math.min(dur, state.audio.getCurrentTime() + 10));
            } else if (state.restoredSeekTime > 0) {
                state.restoredSeekTime = Math.min(dur, state.restoredSeekTime + 10);
                savePlaybackSession();
            }
        } else if (e.code === 'ArrowLeft') {
            e.preventDefault();
            if (state.audio.isPlaying || state.audio.isPaused) {
                state.audio.seek(Math.max(0, state.audio.getCurrentTime() - 10));
            } else if (state.restoredSeekTime > 0) {
                state.restoredSeekTime = Math.max(0, state.restoredSeekTime - 10);
                savePlaybackSession();
            }
        }
    });
}

function onPrevClicked() {
    state.restoredSeekTime = 0;
    const pl = state.playlist.playlistData;
    if (pl && pl.tracks && pl.tracks.length > 1) {
        state.playlist.prevTrack();
        playCurrentTrack(0);
    } else {
        state.audio.seek(0);
    }
}

async function onNextClicked() {
    state.restoredSeekTime = 0;
    const pl = state.playlist.playlistData;
    // Multi-track playlist
    if (pl && pl.tracks && pl.tracks.length > 1) {
        state.playlist.nextTrack();
        playCurrentTrack(0);
    } else {
        // Single-track playlist: Category Radio!
        const currentCatSlug = state.playlist.currentCategory;
        let playlists = state.playlistsByCat.get(currentCatSlug) || [];
        if (state.offlineFilterActive) {
            playlists = playlists.filter(p => state.offlinePlaylists.has(p.slug));
        }
        const nextSlug = state.playlist.getNextCategoryPlaylistSlug(playlists);
        if (nextSlug) {
            await playPlaylist(nextSlug, 0);
        }
    }
}

// ============================================================================
// 14. UI Loop (Animations, Progress & Cues)
// ============================================================================
function updateUI() {
    const hasActiveTrack = Boolean(state.playlist && state.playlist.currentTrack);
    if (state.audio.isPlaying || state.audio.isPaused || state.restoredSeekTime > 0 || hasActiveTrack) {
        const cur = state.audio.getCurrentTime();
        const rawTotal = state.audio.getDuration();
        const total = (isFinite(rawTotal) && rawTotal > 0) ? rawTotal : 1;
        const pctVal = Math.min(100, Math.max(0, (cur / total) * 100));
        const pct = `${pctVal}%`;

        el.progressFill.style.width = pct;
        el.currentTime.textContent = formatTime(cur);
        el.totalTime.textContent = formatTime(total);

        // VTT Subtitles overlay progress
        el.vttProgressFill.style.width = pct;
        el.vttCurrentTime.textContent = formatTime(cur);
        el.vttTotalTime.textContent = formatTime(total);

        // Update real-time subtitle cue
        if (state.audio.isPlaying || state.audio.isPaused || state.restoredSeekTime > 0) {
            updateVttActiveCue(cur);
        }

        if (state.audio.isPaused || (!state.audio.isPlaying && !state.audio.isPaused)) {
            el.playIcon.classList.remove('hidden'); el.pauseIcon.classList.add('hidden');
            el.vttPlayIcon.classList.remove('hidden'); el.vttPauseIcon.classList.add('hidden');
        } else {
            el.playIcon.classList.add('hidden'); el.pauseIcon.classList.remove('hidden');
            el.vttPlayIcon.classList.add('hidden'); el.vttPauseIcon.classList.remove('hidden');
        }
    } else {
        el.playIcon.classList.remove('hidden'); el.pauseIcon.classList.add('hidden');
        el.vttPlayIcon.classList.remove('hidden'); el.vttPauseIcon.classList.add('hidden');
    }

    requestAnimationFrame(updateUI);
}

function formatTime(s) {
    if (!s || !isFinite(s) || s < 0) return "0:00";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

// Start app
window.addEventListener('DOMContentLoaded', init);
