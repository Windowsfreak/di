/**
 * Dream Improvisation - Audio Engine & UI Controller
 */

class AudioEngine {
    constructor() {
        this.ctx = null;
        this.nodes = {};
        this.audioElement = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.currentUrl = null;
        this.intentUrl = null;
        this.ticker = null;

        this.fades = { main: 1.0, playPause: 1.0, seek: 1.0, suno: 1.0, sleep: 1.0 };
        this.bufferCache = new Map();
    }

    init() {
        if (this.ctx) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        
        ['playPause', 'seek', 'suno', 'sleep', 'main'].forEach(name => {
            this.nodes[name] = this.ctx.createGain();
            this.nodes[name].gain.value = 1.0;
        });

        this.nodes.playPause.connect(this.nodes.seek);
        this.nodes.seek.connect(this.nodes.suno);
        this.nodes.suno.connect(this.nodes.sleep);
        this.nodes.sleep.connect(this.nodes.main);
        this.nodes.main.connect(this.ctx.destination);

        // Setting up HTML5 Audio native streaming
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
                console.warn("[Audio] Network stutter or media error. Code:", err ? err.code : 'unknown', err ? err.message : '');
                const currentTime = this.audioElement.currentTime;
                this.audioElement.load();
                if (currentTime > 0) {
                    this.audioElement.currentTime = currentTime;
                }
                this.audioElement.play().catch(console.error);
            }
        };

        this.source = this.ctx.createMediaElementSource(this.audioElement);
        this.source.connect(this.nodes.playPause);

        const savedVol = localStorage.getItem('volume');
        this.setVolume(savedVol !== null ? parseFloat(savedVol) : 1.0, false);

        if (!this.ticker) {
            this.ticker = setInterval(() => this.tick(), 1000);
        }
    }

    tick() {
        if (this.isPlaying && !this.isPaused) {
            this.checkSunoFade();
        }
    }

    setVolume(value, smooth = true) {
        this.fades.main = Number(value);
        if (this.nodes.main) {
            if (smooth) this.nodes.main.gain.setTargetAtTime(this.fades.main, this.ctx.currentTime, 0.05);
            else this.nodes.main.gain.value = this.fades.main;
        }
        localStorage.setItem('volume', this.fades.main);
    }

    async play(url, startTime = 0, noFadeIn = false) {
        this.intentUrl = url;
        this.init();
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        if (this.intentUrl !== url) return;

        if (this.currentUrl !== url) {
            this.audioElement.pause();
            
            this.currentUrl = url;
            // Always set raw URL to allow native Safari/iOS range-request seeking
            this.audioElement.src = url;
            this.audioElement.load();
        }

        try {
            await this.audioElement.play();
        } catch(e) {
            console.error("Playback failed:", e);
        }

        if (this.intentUrl !== url) return;

        if (this.audioElement.readyState >= 1) {
            this.audioElement.currentTime = startTime;
        } else {
            this.audioElement.onloadedmetadata = () => {
                if (this.currentUrl === url) this.audioElement.currentTime = startTime;
                this.audioElement.onloadedmetadata = null;
            };
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
        this.nodes.suno.gain.value = 1.0;

        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
            this.updatePositionState();
        }
    }

    pause() {
        if (!this.isPlaying || this.isPaused) return;
        this.fadeNode('playPause', 0.0, 1.0);
        this.isPaused = true;
        setTimeout(() => { 
            if (this.isPaused && this.audioElement) { 
                this.audioElement.pause(); 
                this.nodes.sleep.gain.value = 1.0; 
                if ('mediaSession' in navigator) {
                    navigator.mediaSession.playbackState = 'paused';
                    this.updatePositionState();
                }
            } 
        }, 1000);
    }

    resume() {
        if (!this.isPaused) return;
        this.isPaused = false;
        this.isPlaying = true;
        this.audioElement.play().catch(e => console.error(e));
        this.fadeNode('playPause', 1.0, 1.0);
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
            this.updatePositionState();
        }
    }

    seek(time) {
        if ((!this.isPlaying && !this.isPaused) || !this.audioElement) return;
        const target = Math.max(0, time);
        
        console.log(`[AudioEngine] Seeking to ${target}s (current: ${this.audioElement.currentTime}s, duration: ${this.getDuration()}s)`);
        
        this.fadeNode('seek', 0.0, 0.1);
        setTimeout(() => {
            try {
                this.audioElement.currentTime = target;
                this.updatePositionState();
            } catch (err) {
                console.error("[AudioEngine] Error seeking HTMLMediaElement:", err);
            }
            this.fadeNode('seek', 1.0, 0.1);
        }, 100);
    }

    fadeNode(name, target, duration) {
        if (!this.nodes[name]) return;
        if (duration === 0) {
            this.nodes[name].gain.cancelScheduledValues(this.ctx.currentTime);
            this.nodes[name].gain.value = target;
        } else {
            this.nodes[name].gain.setTargetAtTime(target, this.ctx.currentTime, duration / 3);
        }
    }

    checkSunoFade() {
        const duration = this.getDuration();
        if (duration > 478 || (duration > 58 && duration < 61)) {
            const remaining = duration - this.getCurrentTime();
            if (remaining <= 5 && remaining > 0) {
                this.fadeNode('suno', 0.0, remaining);
            }
        }
        this.updatePositionState();
    }

    getCurrentTime() {
        return this.audioElement ? this.audioElement.currentTime : 0;
    }

    getDuration() {
        if (!this.audioElement) return 0;
        const dur = this.audioElement.duration;
        return isNaN(dur) ? 0 : dur;
    }

    updatePositionState() {
        if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
            if (this.audioElement && this.audioElement.readyState >= 1 && !isNaN(this.audioElement.duration)) {
                navigator.mediaSession.setPositionState({
                    duration: this.audioElement.duration,
                    playbackRate: this.audioElement.playbackRate || 1,
                    position: this.audioElement.currentTime
                });
            }
        }
    }
}

class PlaylistManager {
    constructor() {
        this.currentGenre = null;
        this.genreData = null;
        this.queue = [];
        this.currentIndex = 0;
    }

    async setGenre(id) {
        const response = await fetch(`music/${id}/index.json`);
        this.genreData = await response.json();
        this.currentGenre = id;
        this.queue = this.getRandomTracks(Object.keys(this.genreData.tracks), 4);
        this.currentIndex = 0;
    }

    getRandomTracks(pool, count, exclude = []) {
        const result = [];
        const available = pool.filter(id => !exclude.includes(id) && !this.queue.includes(id));
        for (let i = 0; i < count && available.length > 0; i++) {
            const idx = Math.floor(Math.random() * available.length);
            result.push(available.splice(idx, 1)[0]);
        }
        return result;
    }

    maintainWindow() {
        while (this.currentIndex > 3) { this.queue.shift(); this.currentIndex--; }
    }

    next() {
        this.currentIndex++;
        if (this.queue.length - this.currentIndex <= 3) {
            const nextTrack = this.getRandomTracks(Object.keys(this.genreData.tracks), 1, this.queue)[0];
            if (nextTrack) this.queue.push(nextTrack);
        }
        this.maintainWindow();
    }

    jumpTo(idxInQueue) {
        this.currentIndex = idxInQueue;
        while (this.queue.length - this.currentIndex <= 3) {
            const nextTrack = this.getRandomTracks(Object.keys(this.genreData.tracks), 1, this.queue)[0];
            if (nextTrack) this.queue.push(nextTrack);
            else break;
        }
        this.maintainWindow();
    }

    prev() { if (this.currentIndex > 0) this.currentIndex--; }
    get currentTrackId() { return this.queue[this.currentIndex]; }
}

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
    genres: [],
    sleepTimer: null,
    sleepRemainingSeconds: 0,
    sleepOnFinish: false,
    sleepFadeActive: false
};

const el = {
    app: document.getElementById('app'),
    genreList: document.getElementById('genre-list'),
    playlistContainer: document.getElementById('playlist-container'),
    playPauseBtn: document.getElementById('play-pause-btn'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    playIcon: document.getElementById('play-icon'),
    pauseIcon: document.getElementById('pause-icon'),
    volumeSlider: document.getElementById('volume-slider'),
    progressBar: document.getElementById('progress-bar'),
    progressFill: document.getElementById('progress-fill'),
    currentTime: document.getElementById('current-time'),
    totalTime: document.getElementById('total-time'),
    trackName: document.getElementById('current-track-name'),
    genreName: document.getElementById('current-genre-name'),
    sleepBtn: document.getElementById('sleep-timer-btn'),
    genreToggle: document.getElementById('genre-toggle'),
    sleepModal: document.getElementById('sleep-timer-modal'),
    timerSlider: document.getElementById('timer-slider'),
    timerDisplay: document.getElementById('selected-timer-display'),
    startTimerBtn: document.getElementById('start-timer-btn'),
    finishTrackCheckbox: document.getElementById('finish-track-checkbox'),
    cancelTimer: document.getElementById('cancel-timer')
};

async function init() {
    sendSWMessage({ type: 'PAGE_LOADED' });
    const response = await fetch('music/index.json');
    state.genres = await response.json();
    renderGenres();
    const hash = window.location.hash.slice(1);
    const defaultGenre = state.genres.find(g => g.id === hash) || state.genres.find(g => g.id === 'meditation') || state.genres[0];
    if (window.innerWidth <= 768) showGenreView(); else showPlaylistView();
    if (defaultGenre) await selectGenre(defaultGenre.id, false);
    setupEventListeners();
    setupMediaSessionHandlers();
    requestAnimationFrame(updateUI);
}

function showGenreView() { el.app.classList.add('show-genres'); el.app.classList.remove('show-playlist'); }
function showPlaylistView() { el.app.classList.add('show-playlist'); el.app.classList.remove('show-genres'); }

function renderGenres() {
    el.genreList.innerHTML = state.genres.map(g => `
        <div class="genre-item ${state.playlist.currentGenre === g.id ? 'active' : ''}" data-id="${g.id}">
            <span class="genre-name">${g.name}</span>
            <span class="genre-meta">${g.trackCount} tracks • ${formatTime(g.totalPlaytime)}</span>
        </div>
    `).join('');
}

function syncPlaylistToSW() {
    if (!state.playlist.currentTrackId) return;
    const tid = state.playlist.currentTrackId;
    const upcomingUrls = [`music/${state.playlist.currentGenre}/${tid}.m4a`]; 
    for (let i = 1; i <= 3; i++) {
        const nextId = state.playlist.queue[state.playlist.currentIndex + i];
        if (nextId) upcomingUrls.push(`music/${state.playlist.currentGenre}/${nextId}.m4a`);
    }
    const visibleTracks = Array.from(document.querySelectorAll('.track-card')).map(card => {
        return `music/${state.playlist.currentGenre}/${card.dataset.id}.m4a`;
    });
    sendSWMessage({
        type: 'SYNC_PLAYLIST',
        visibleTracks: visibleTracks,
        upcomingTracks: upcomingUrls
    });
}

async function selectGenre(id, autoPlay = true) {
    if (state.playlist.currentGenre === id) {
        if (state.audio.isPaused) state.audio.resume();
        else if (!state.audio.isPlaying) playCurrent();
        showPlaylistView(); return;
    }
    const genre = state.genres.find(g => g.id === id);
    if (!genre) return;
    if (state.audio.isPlaying && autoPlay) {
        state.audio.fadeNode('playPause', 0.0, 1.0);
        await new Promise(r => setTimeout(r, 1000));
    }
    await state.playlist.setGenre(id);
    renderGenres(); renderPlaylist();
    el.genreName.textContent = genre.name;
    
    // Give SW a head start on queueing tracks immediately on load/change
    syncPlaylistToSW();

    if (autoPlay) { playCurrent(); showPlaylistView(); }
}

function renderPlaylist() {
    const { queue, currentIndex, currentGenre } = state.playlist;
    el.playlistContainer.innerHTML = queue.map((tid, idx) => {
        const status = idx < currentIndex ? 'past' : (idx === currentIndex ? 'active' : 'future');
        return `
            <div class="track-card ${status}" data-id="${tid}" data-index="${idx}">
                <img class="track-cover" src="music/${currentGenre}/${tid}.jpg" loading="lazy">
                <div class="track-overlay">
                    <span class="track-title">${tid}</span>
                    <span class="track-duration">${formatTime(state.playlist.genreData.tracks[tid])}</span>
                </div>
            </div>
        `;
    }).join('');
}

function playCurrent() {
    const tid = state.playlist.currentTrackId;
    state.audio.play(`music/${state.playlist.currentGenre}/${tid}.m4a`);

    el.trackName.textContent = tid;
    updateMediaSession(tid); updateTitle(tid);
    renderPlaylist();
    
    syncPlaylistToSW();
}

function formatTime(s) {
    if (!s) return "0:00";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

function formatTimerLabel(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}:${m.toString().padStart(2, '0')}`;
}

function updateUI() {
    if (state.audio.isPlaying || state.audio.isPaused) {
        const current = state.audio.getCurrentTime(), total = state.audio.getDuration() || 1;
        el.progressFill.style.width = `${(current / total) * 100}%`;
        el.currentTime.textContent = formatTime(current);
        el.totalTime.textContent = formatTime(total);
        if (state.audio.isPaused) { el.playIcon.classList.remove('hidden'); el.pauseIcon.classList.add('hidden'); }
        else { el.playIcon.classList.add('hidden'); el.pauseIcon.classList.remove('hidden'); }
    } else {
        el.playIcon.classList.remove('hidden'); el.pauseIcon.classList.add('hidden');
    }
    requestAnimationFrame(updateUI);
}

function updateMediaSession(t) {
    if ('mediaSession' in navigator) {
        const g = state.genres.find(g => g.id === state.playlist.currentGenre)?.name || '';
        navigator.mediaSession.metadata = new MediaMetadata({
            title: t, artist: g, album: 'Dream Improvisation',
            artwork: [{ src: `music/${state.playlist.currentGenre}/${t}.jpg`, sizes: '512x512', type: 'image/jpeg' }]
        });
    }
}

function updateTitle(t) {
    const g = state.genres.find(g => g.id === state.playlist.currentGenre)?.name || '';
    document.title = `🔊 ${g} - ${t} | Dream Improvisation`;
}

function setupMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;

    const handlers = {
        play: () => state.audio.isPaused ? state.audio.resume() : playCurrent(),
        pause: () => state.audio.pause(),
        stop: () => state.audio.pause(),
        previoustrack: () => el.prevBtn.click(),
        nexttrack: () => el.nextBtn.click(),
        seekbackward: (details) => state.audio.seek(state.audio.getCurrentTime() - (details.seekOffset || 10)),
        seekforward: (details) => state.audio.seek(state.audio.getCurrentTime() + (details.seekOffset || 10)),
        seekto: (details) => state.audio.seek(details.seekTime)
    };

    for (const [action, handler] of Object.entries(handlers)) {
        try {
            navigator.mediaSession.setActionHandler(action, handler);
        } catch (e) {
            console.warn(`[MediaSession] Action "${action}" not supported.`, e);
        }
    }
}

function setupEventListeners() {
    el.playPauseBtn.onclick = () => state.audio.isPaused ? state.audio.resume() : (state.audio.isPlaying ? state.audio.pause() : playCurrent());
    el.nextBtn.onclick = () => { state.playlist.next(); playCurrent(); };
    el.prevBtn.onclick = () => { state.playlist.prev(); playCurrent(); };
    el.volumeSlider.oninput = (e) => state.audio.setVolume(e.target.value);
    el.genreList.onclick = (e) => { const it = e.target.closest('.genre-item'); if (it) selectGenre(it.dataset.id); };
    el.genreToggle.onclick = () => el.app.classList.contains('show-genres') ? showPlaylistView() : showGenreView();
    el.progressBar.onclick = (e) => {
        const rect = el.progressBar.getBoundingClientRect();
        state.audio.seek(((e.clientX - rect.left) / rect.width) * state.audio.getDuration());
    };

    el.sleepBtn.onclick = () => el.sleepModal.classList.remove('hidden');
    el.timerSlider.oninput = (e) => {
        const mins = SLEEP_INTERVALS[e.target.value];
        el.timerDisplay.textContent = formatTimerLabel(mins);
    };

    el.startTimerBtn.onclick = () => {
        const mins = SLEEP_INTERVALS[el.timerSlider.value];
        startSleepCountdown(mins * 60, el.finishTrackCheckbox.checked);
        el.sleepModal.classList.add('hidden');
    };

    el.cancelTimer.onclick = () => {
        cancelSleepCountdown();
        state.sleepOnFinish = false;
        state.sleepFadeActive = false;
        state.audio.fadeNode('sleep', 1.0, 0); 
        el.sleepBtn.textContent = "Sleep Timer";
        el.sleepModal.classList.add('hidden');
    };

    el.sleepModal.onclick = (e) => { if (e.target === el.sleepModal) el.sleepModal.classList.add('hidden'); };

    el.playlistContainer.onclick = (e) => {
        const card = e.target.closest('.track-card.future, .track-card.past');
        if (card) { state.playlist.jumpTo(parseInt(card.dataset.index)); playCurrent(); }
    };

    window.addEventListener('track-ended', () => {
        if (state.sleepOnFinish) {
            state.sleepOnFinish = false;
            el.sleepBtn.textContent = "Sleep Timer";
            state.audio.pause();
        } else {
            el.nextBtn.click();
        }
    });

    window.onfocus = () => { const v = localStorage.getItem('volume'); if (v !== null && !state.audio.isPlaying) state.audio.setVolume(parseFloat(v), false); };
    window.onkeydown = (e) => {
        if (e.code === 'Space') { e.preventDefault(); el.playPauseBtn.click(); }
        if (e.code === 'ArrowRight') state.audio.seek(state.audio.getCurrentTime() + 10);
        if (e.code === 'ArrowLeft') state.audio.seek(state.audio.getCurrentTime() - 10);
        if (e.code === 'ArrowUp') { e.preventDefault(); el.volumeSlider.value = Math.min(1, parseFloat(el.volumeSlider.value) + 0.1); state.audio.setVolume(el.volumeSlider.value); }
        if (e.code === 'ArrowDown') { e.preventDefault(); el.volumeSlider.value = Math.max(0, parseFloat(el.volumeSlider.value) - 0.1); state.audio.setVolume(el.volumeSlider.value); }
    };
}

function startSleepCountdown(seconds, finishLast) {
    cancelSleepCountdown();
    state.sleepRemainingSeconds = seconds;
    const updateLabel = () => {
        const m = Math.floor(state.sleepRemainingSeconds / 60);
        el.sleepBtn.textContent = `Sleep in ${formatTimerLabel(m)}`;
    };
    updateLabel();
    state.sleepTimer = setInterval(() => {
        state.sleepRemainingSeconds--;
        if (state.sleepRemainingSeconds <= 0) {
            clearInterval(state.sleepTimer);
            state.sleepTimer = null;
            if (finishLast) {
                state.sleepOnFinish = true;
                el.sleepBtn.textContent = "Finishing Track...";
            } else {
                state.sleepFadeActive = true;
                el.sleepBtn.textContent = "Sleeping...";
                state.audio.fadeNode('sleep', 0.0, 60.0);
                setTimeout(() => {
                    if (state.sleepFadeActive) {
                        state.audio.pause();
                        setTimeout(() => {
                            state.sleepFadeActive = false;
                            el.sleepBtn.textContent = "Sleep Timer";
                        }, 1100); 
                    }
                }, 60000);
            }
        } else {
            updateLabel();
        }
    }, 1000);
}

function cancelSleepCountdown() {
    if (state.sleepTimer) clearInterval(state.sleepTimer);
    state.sleepTimer = null;
}

init();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js');
