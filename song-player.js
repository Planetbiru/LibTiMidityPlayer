
/**
 * SongPlayer
 * ----------
 * Extends TimidityPlayer to support:
 *   1. MIDI playback (inherits all TimidityPlayer features)
 *   2. Audio-clip playback with per-clip offset, fade-in, fade-out, volume
 *   3. Simultaneous MIDI + audio-clip playback, synced to one clock
 *   4. Offline rendering — merged or per-track — mono or stereo, with
 *      configurable sampleRate and bufferSize
 *   5. Song duration = max(MIDI duration, last clip end)
 *   6. Works with EMPTY MIDI (audio-only playback / render)
 *
 * Requires: TimidityPlayer (and its WASM Module) already loaded globally.
 *
 * Clip data format:
 *   {
 *     id, audioClipId,
 *     audioAssetId,
 *     startTick,             // position on timeline
 *     trimmedDurationTicks,  // clip length on timeline
 *     trimStartOffsetTicks,  // offset into the source asset
 *     volume,                // 0..1
 *     fadeIn:  { enable, from, to, shape },   // from/to in SECONDS, clip-relative
 *     fadeOut: { enable, from, to, shape }    // shape: 'linear' | 'easeIn' | 'easeOut'
 *   }
 */
class SongPlayer extends TimidityPlayer {
    constructor(options = {}) {
        super(options);

        /** @type {Map<string, {audioBuffer: AudioBuffer, [k: string]: any}>} */
        this.audioAssets = new Map();

        /** @type {Array<{id:any, name:string, muted:boolean, solo:boolean, clips:Array}>} */
        this.audioTracks = [];

        /** @type {Map<string, {source, gainNode, trackIndex, clip}>} */
        this._activeClips = new Map();

        /** @type {GainNode|null} */
        this._clipGainNode = null;

        /** @type {AudioContext|null} */
        this._decodeCtx = null;

        /** @type {Boolean} */
        this._reloading = false;

        /* --- Virtual clock (jalan setelah MIDI berakhir tapi audio masih main) --- */
        this._lastSongTime       = 0;      // song-time terakhir yang diketahui
        this._virtualRunning     = false;
        this._virtualClockRAF    = null;
        this._virtualAnchorSong  = 0;      // song-time saat anchor virtual di-set
        this._virtualAnchorAudio = 0;     // audioContext.currentTime saat anchor

        // Hook playback events to sync audio clips
        // onPlaying internal — update lastSongTime + sync clip.
        this.on('onPlaying', (tick, timeSec) => {
            this._lastSongTime = timeSec;
            try {
                this._syncAudioClips(timeSec);
            } catch (err) {
                console.error('[SongPlayer] _syncAudioClips error:', err);
            }
        });

        // onStop = benar-benar berhenti → matikan semua clip + clock virtual.
        this.on('onStop', () => {
            this._stopPostMidiClock();
            try { this._stopAllAudioClips(); }
            catch (err) { console.error('[SongPlayer] stop hook error:', err); }
        });

        // onEnded = MIDI selesai, TAPI audio mungkin masih panjang.
        // JANGAN stop clip. Ganti ke clock virtual sampai getSongDuration() tercapai.
        this.on('onEnded', () => {
            try { this._startPostMidiClock(); }
            catch (err) { console.error('[SongPlayer] post-MIDI clock error:', err); }
        });

        this._ensureTempoMap();
    }

    /* ================================================================== */
    /*  Convenience — load a full bundle                                  */
    /* ================================================================== */

    /**
     * Load MIDI + audio assets + audio tracks in one call.
     *
     * @param {Object} bundle
     * @param {string} [bundle.midiContent]              base64 / Data URI
     * @param {Array}  [bundle.audioAssetsMetadata]      [{audioAssetId, fileExtension, ...}]
     * @param {Array}  [bundle.audioTracksMetadata]      [{id,name,muted,solo,audioClips}]
     * @param {(meta)=>Promise<ArrayBuffer>} [bundle.assetFetcher]
     */
    async loadBundle(bundle) {
        // Normalize keys to camelCase first
        const normalized = this.toCamelCaseKeys(bundle);
        this._stopAllAudioClips();
        this.audioAssets.clear();
        this.audioTracks = [];

        // Load assets
        if (Array.isArray(normalized.audioAssetsMetadata) && typeof normalized.assetFetcher === 'function') {
            const promises = normalized.audioAssetsMetadata.map(async (meta) => {
                try {
                    const id = meta.audioAssetId || meta.id;
                    if (!id) return;
                    const buf = await normalized.assetFetcher(meta);
                    await this.loadAudioAsset(id, buf, meta);
                } catch (e) {
                    console.error('[SongPlayer] asset load error:', meta, e);
                }
            });
            await Promise.allSettled(promises);
        }

        // Build tracks
        if (Array.isArray(normalized.audioTracksMetadata)) {
            this.audioTracks = normalized.audioTracksMetadata.map((t, idx) => ({
                id: t.id ?? idx,
                name: t.name || `Audio ${idx + 1}`,
                muted: !!t.muted,
                solo: !!t.solo,
                clips: (t.audioClips || []).map(c => ({ ...c })),
            }));
        }

        // Load MIDI
        if (normalized.midiContent) {
            let uri = normalized.midiContent.trim().replace(/\s/g, '');
            if (!uri.startsWith('data:')) uri = 'data:audio/midi;base64,' + uri;
            await this.load(uri);
            this._ensureTempoMap();
        }

        return {
            duration: this.getSongDuration(),
            midiTracks: this._getMidiTrackCount(),
            audioTracks: this.audioTracks.length,
            audioAssets: this.audioAssets.size,
        };
    }

    /* ================================================================== */
    /*  Audio asset management                                             */
    /* ================================================================== */

    /**
     * Decode an ArrayBuffer into an AudioBuffer and register it as an asset.
     *
     * @param {string} id - Unique identifier for the asset.
     * @param {ArrayBuffer} arrayBuffer - Raw audio data to decode.
     * @param {Object} [metadata={}] - Optional metadata to associate with the asset.
     * @returns {Promise<AudioBuffer>} A decoded AudioBuffer instance.
     */
    async loadAudioAsset(id, arrayBuffer, metadata = {}) {
        const ctx = this._getDecodeContext();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
        const normalizedMeta = this.toCamelCaseKeys(metadata); // normalize metadata
        this.audioAssets.set(id, { audioBuffer, ...normalizedMeta });
        return audioBuffer;
    }

    /**
     * Fetch an audio file from a URL, decode it into an AudioBuffer,
     * and register it as an asset.
     *
     * @param {string} id - Unique identifier for the asset.
     * @param {string} url - URL of the audio file to fetch.
     * @param {Object} [metadata={}] - Optional metadata to associate with the asset.
     * @returns {Promise<AudioBuffer>} A decoded AudioBuffer instance.
     * @throws {Error} If the HTTP request fails.
     */
    async loadAudioAssetFromUrl(id, url, metadata = {}) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        const buf = await response.arrayBuffer();
        const normalizedMeta = this.toCamelCaseKeys(metadata); // normalize metadata
        return this.loadAudioAsset(id, buf, normalizedMeta);
    }

    /**
     * Register a pre-decoded AudioBuffer as an asset.
     *
     * @param {string} id - Unique identifier for the asset.
     * @param {AudioBuffer} audioBuffer - Already decoded AudioBuffer.
     * @param {Object} [metadata={}] - Optional metadata to associate with the asset.
     */
    setAudioAsset(id, audioBuffer, metadata = {}) {
        const normalizedMeta = this.toCamelCaseKeys(metadata); // normalize metadata
        this.audioAssets.set(id, { audioBuffer, ...normalizedMeta });
    }

    /**
     * Retrieve an asset record by its ID.
     *
     * @param {string} id - Unique identifier for the asset.
     * @returns {Object|undefined} The asset record, or undefined if not found.
     */
    getAudioAsset(id) { return this.audioAssets.get(id); }

    /**
     * Remove an asset from the registry.
     *
     * @param {string} id - Unique identifier for the asset.
     */
    removeAudioAsset(id) { this.audioAssets.delete(id); }

    /* ================================================================== */
    /* Track management                                                   */
    /* ================================================================== */

    /**
     * Replace the current audio tracks with a new set.
     * Stops all active clips before applying the new tracks.
     *
     * @param {Array<Object>} tracks - Array of track objects.
     */
    setAudioTracks(tracks) {
        this._stopAllAudioClips();
        this.audioTracks = Array.isArray(tracks) ? tracks : [];
    }

    /**
     * Add a new audio track to the current set.
     *
     * @param {Object} track - Track object to add.
     * @returns {Object} The added track.
     */
    addAudioTrack(track) { this.audioTracks.push(track); return track; }

    /**
     * Clear all audio tracks.
     * Stops all active clips before clearing.
     */
    clearAudioTracks() { this._stopAllAudioClips(); this.audioTracks = []; }

    /* ================================================================== */
    /* Duration                                                           */
    /* ================================================================== */

    /**
     * Get the total song duration in seconds.
     * Computed as the maximum of:
     *   - MIDI duration
     *   - End time of all non-deleted audio clips
     *
     * @returns {number} Total duration in seconds.
     */
    getSongDuration() {
        const midiDur = this.midiInfo?.duration_sec || this.totalDuration || 0;
        let maxDur = midiDur;

        for (const track of this.audioTracks) {
            for (const clip of (track.clips || [])) {
                if (clip.isDeleted) continue;
                const endSec = this._clipEndSec(clip);
                if (endSec > maxDur) maxDur = endSec;
            }
        }
        return maxDur;
    }

    /* ================================================================== */
    /* Playback overrides                                                 */
    /* ================================================================== */

    /**
     * Play the song. Safe to call repeatedly:
     *   - If already playing → no-op.
     *   - If paused → resume playback.
     *   - If stopped → reload MIDI from cache and restart.
     *
     * @param {number} [offset=0] - Start time offset in seconds.
     * @param {Object} [options={}] - Playback options.
     * @returns {Promise<void>} Resolves when playback has started.
     */
    async play(offset = 0, options = {}) {
        if (!this.audioContext) return;

        // Batalkan sisa clock virtual bila user klik Play saat lagu sedang
        // menyelesaikan ekor audio-nya.
        this._stopPostMidiClock();

        if (this.playingInterval !== null && !this.isPaused && this.songPtr !== 0) {
            return;
        }

        if (this.isPaused && this.songPtr !== 0) {
            this._lastSongTime = 0;
            return this.resume();
        }

        if (this.songPtr === 0) {
            if (!this.lastMidiData) {
                console.warn('[SongPlayer] play(): tidak ada MIDI ter-cache, hanya audio clip.');
                return;
            }
            if (this._reloading) return;
            this._reloading = true;
            try {
                const ok = await this.load(this.lastMidiData);
                if (!ok) {
                    console.error('[SongPlayer] Gagal reload MIDI.');
                    return;
                }
                this._ensureTempoMap();
            } finally {
                this._reloading = false;
            }
        }

        this._stopAllAudioClips();
        this._ensureClipGainNode();
        this._lastSongTime = offset || 0;
        super.play(offset, options);
    }

    /**
     * Pause playback and stop all audio clips.
     */
    pause() {
        this._stopPostMidiClock();
        super.pause();
        this._stopAllAudioClips();
    }

    /**
     * Stop playback and reset all audio clips.
     */
    stop() {
        this._stopPostMidiClock();
        this._stopAllAudioClips();
        super.stop();
    }

    /**
     * Seek to a specific time in seconds.
     *
     * @param {number} timeInSeconds - Target playback position.
     */
    seek(timeInSeconds) {
        this._stopPostMidiClock();
        this._stopAllAudioClips();
        this._lastSongTime = timeInSeconds;
        super.seek(timeInSeconds);
    }

    /**
     * Restart playback from the beginning without leaving the playing state.
     * If the song has naturally ended, `play()` will reload automatically.
     *
     * @returns {Promise<void>} Resolves when restart is complete.
     */
    async restart() {
        if (!this.audioContext) return;
        if (this.songPtr === 0) {
            // Natural end → cukup panggil play() lagi.
            return this.play(0);
        }
        if (this.isPaused) await this.resume();
        this.seek(0);
    }

    /**
     * Remove a specific event listener.
     *
     * @param {string} eventName - Name of the event.
     * @param {Function} listener - Reference to the listener function.
     */
    off(eventName, listener) {
        const arr = this.eventListeners?.[eventName];
        if (!arr) return;
        const i = arr.indexOf(listener);
        if (i !== -1) arr.splice(i, 1);
    }

    /**
     * Remove all listeners for a given event.
     *
     * @param {string} [eventName] - Event name. If omitted, removes all listeners.
     */
    offAll(eventName) {
        if (!this.eventListeners) return;
        if (eventName) {
            delete this.eventListeners[eventName];
        } else {
            this.eventListeners = {};
        }
    }

    /**
     * Register a listener that automatically removes itself after being called once.
     *
     * @param {string} eventName - Name of the event.
     * @param {Function} listener - Listener function.
     */
    once(eventName, listener) {
        const wrapper = (...args) => {
            this.off(eventName, wrapper);
            listener(...args);
        };
        // Simpan referensi ke listener asli untuk keperluan `off` manual.
        wrapper._original = listener;
        this.on(eventName, wrapper);
    }

    /* ================================================================== */
    /* Object converter                                                   */
    /* ================================================================== */

    /**
     * Convert any object/array keys to camelCase recursively.
     * Accepts both camelCase and snake_case input.
     *
     * @param {any} input - Object, array, or primitive.
     * @returns {any} New object/array with camelCase keys.
     */
    toCamelCaseKeys(input) {
        if (Array.isArray(input)) {
            return input.map(item => this.toCamelCaseKeys(item));
        } else if (input !== null && typeof input === 'object') {
            return Object.fromEntries(
                Object.entries(input).map(([key, value]) => [
                    this.snakeToCamel(key),
                    this.toCamelCaseKeys(value)
                ])
            );
        }
        return input;
    }

    /**
     * Convert any object/array keys to snake_case recursively.
     * Accepts both camelCase and snake_case input.
     *
     * @param {any} input - Object, array, or primitive.
     * @returns {any} New object/array with snake_case keys.
     */
    toSnakeCaseKeys(input) {
        if (Array.isArray(input)) {
            return input.map(item => this.toSnakeCaseKeys(item));
        } else if (input !== null && typeof input === 'object') {
            return Object.fromEntries(
                Object.entries(input).map(([key, value]) => [
                    this.camelToSnake(key),
                    this.toSnakeCaseKeys(value)
                ])
            );
        }
        return input;
    }

    /* ================================================================== */
    /* Helper methods                                                     */
    /* ================================================================== */

    /**
     * Convert snake_case string to camelCase.
     */
    snakeToCamel(str) {
        return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    }

    /**
     * Convert camelCase string to snake_case.
     */
    camelToSnake(str) {
        return str.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
    }

    /* ================================================================== */
    /* Internal — clock / clip lookup                                     */
    /* ================================================================== */

    _ensureTempoMap() {
        if (this.tempoMap && this.tempoMap.timeMap && this.tempoMap.division) return;
        this.tempoMap = {
            division: 480,
            timeMap: [{ tick: 0, timeSec: 0, mpqn: 500000 }],
            measureMap: [{
                tick: 0, absBeat: 0, measure: 1, num: 4, denom: 4, ticksPerBeat: 480
            }],
            tracksCount: 0,
            trackNames: [],
            trackHasNotes: [],
            maxTick: 0,
            totalSeconds: 0
        };
    }

    _getDecodeContext() {
        if (!this._decodeCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            this._decodeCtx = new Ctx();
        }
        return this._decodeCtx;
    }

    _ensureClipGainNode() {
        if (!this.audioContext) return null;
        if (!this._clipGainNode) {
            this._clipGainNode = this.audioContext.createGain();
            this._clipGainNode.gain.value = 1.0;
            const dest = this.gainNode || this.audioContext.destination;
            this._clipGainNode.connect(dest);
        }
        return this._clipGainNode;
    }

    _safeTickToTime(tick) {
        if (!this.noTempoMap()) return this.tickToTime(tick);
        // Fallback: 120 BPM, division 480
        return tick / 480 * 0.5;
    }

    _clipStartSec(clip) { return this._safeTickToTime(clip.startTick || 0); }

    _clipEndSec(clip) {
        return this._safeTickToTime(
            (clip.startTick || 0) + (clip.trimmedDurationTicks || 0)
        );
    }

    _getClipKey(clip, trackIndex) {
        if (clip.audioClipId) return String(clip.audioClipId);
        if (clip.id) return String(clip.id);
        return `clip_${trackIndex}_${clip.audioAssetId}_${clip.startTick}_${clip.trimmedDurationTicks}`;
    }

    /* ================================================================== */
    /*  Internal — real-time clip sync                                     */
    /* ================================================================== */

    _syncAudioClips(songTime) {
        if (!this.audioContext) return;
        const gain = this._ensureClipGainNode();
        if (!gain) return;

        const LOOKAHEAD = 0.05;                       // seconds
        const now = this.audioContext.currentTime;
        const hasSolo = this.audioTracks.some(t => t.solo);

        for (let ti = 0; ti < this.audioTracks.length; ti++) {
            const track = this.audioTracks[ti];
            const audible = hasSolo ? !!track.solo : !track.muted;
            const clips = track.clips || [];

            for (const clip of clips) {
                if (clip.isDeleted) continue;

                const key = this._getClipKey(clip, ti);
                const existing = this._activeClips.get(key);
                const startSec = this._clipStartSec(clip);
                const endSec   = this._clipEndSec(clip);

                const shouldBeActive =
                    audible &&
                    songTime < endSec &&
                    songTime >= startSec - LOOKAHEAD;

                if (!shouldBeActive) {
                    if (existing) this._stopClip(key);
                    continue;
                }
                if (existing) continue;

                const songTimeAtStart   = Math.max(songTime, startSec);
                const audioTimeAtStart  = now + (songTimeAtStart - songTime);
                const offsetInClip      = songTimeAtStart - startSec;
                const remaining         = endSec - songTimeAtStart;

                if (remaining <= 0) continue;
                if (audioTimeAtStart - now > LOOKAHEAD) continue;

                this._startClip(clip, ti, offsetInClip, remaining, audioTimeAtStart);
            }
        }
    }

    _startClip(clip, trackIndex, offsetInClip, duration, when) {
        const key = this._getClipKey(clip, trackIndex);
        const asset = this.audioAssets.get(clip.audioAssetId);
        if (!asset || !asset.audioBuffer) return;

        try {
            const source = this.audioContext.createBufferSource();
            source.buffer = asset.audioBuffer;

            const gainNode = this.audioContext.createGain();
            source.connect(gainNode);
            gainNode.connect(this._clipGainNode);

            this._applyClipGainSchedule(gainNode, clip, offsetInClip, when);

            const trimOffsetSec = this._safeTickToTime(clip.trimStartOffsetTicks || 0);
            const assetOffset = trimOffsetSec + offsetInClip;

            if (assetOffset >= source.buffer.duration) return;

            const maxDuration  = source.buffer.duration - assetOffset;
            const playDuration = Math.min(duration, maxDuration);

            source.start(when, assetOffset, playDuration);
            this._activeClips.set(key, { source, gainNode, trackIndex, clip });

            source.onended = () => {
                const entry = this._activeClips.get(key);
                if (entry && entry.source === source) {
                    try { gainNode.disconnect(); } catch (e) {}
                    this._activeClips.delete(key);
                }
            };
        } catch (err) {
            console.error('Failed to start clip:', err);
        }
    }

    _stopClip(key) {
        const entry = this._activeClips.get(key);
        if (!entry) return;
        try { entry.source.onended = null; } catch (e) {}
        try { entry.source.stop(); } catch (e) {}
        try { entry.source.disconnect(); } catch (e) {}
        try { entry.gainNode.disconnect(); } catch (e) {}
        this._activeClips.delete(key);
    }

    _stopAllAudioClips() {
        for (const key of Array.from(this._activeClips.keys())) this._stopClip(key);
    }

    /* ================================================================== */
    /* Virtual clock — menggantikan clock MIDI setelah MIDI berakhir      */
    /* ================================================================== */

    _hasAudioClips() {
        for (const t of this.audioTracks) {
            if ((t.clips || []).some(c => !c.isDeleted)) return true;
        }
        return false;
    }

    /**
     * Dipanggil dari event 'onEnded' TimidityPlayer.
     * Jika masih ada audio clip yang belum selesai, jalankan clock virtual
     * berbasis audioContext.currentTime supaya _syncAudioClips tetap
     * menerima "song time" sampai durasi lagu tercapai.
     */
    _startPostMidiClock() {
        // Idempotent — jangan dobel clock.
        this._stopPostMidiClock();

        const totalDur     = this.getSongDuration();
        const startSongTime = this._lastSongTime || 0;

        // Tidak ada clip → tidak ada yang perlu diteruskan.
        if (!this._hasAudioClips()) {
            this._stopAllAudioClips();
            this.emit('onSongFinished', startSongTime);
            return;
        }

        // MIDI sudah melewati (atau sudah setara dengan) durasi total.
        if (totalDur <= 0 || startSongTime >= totalDur - 0.02) {
            this._stopAllAudioClips();
            this.emit('onSongFinished', startSongTime);
            return;
        }

        // Anchor: song-time `startSongTime` sekarang sama dengan audioContext.currentTime.
        this._virtualAnchorSong  = startSongTime;
        this._virtualAnchorAudio = this.audioContext.currentTime;
        this._virtualRunning     = true;

        const tickFn = () => {
            if (!this._virtualRunning) return;

            const now         = this.audioContext.currentTime;
            const virtualTime = this._virtualAnchorSong +
                                (now - this._virtualAnchorAudio);

            this._lastSongTime = virtualTime;

            // Hitung tick untuk user (fallback kalau tempoMap kosong).
            let tickVal = 0;
            try {
                tickVal = this.tempoMap ? Math.round(this.timeToTick(virtualTime)) : 0;
            } catch (_) { /* noop */ }

            // emit → listener internal (sync clip) + listener user (UI).
            this.emit('onPlaying', tickVal, virtualTime);

            if (virtualTime >= this.getSongDuration() - 0.01) {
                this._finalizePostMidi();
                return;
            }

            this._virtualClockRAF = requestAnimationFrame(tickFn);
        };

        this._virtualClockRAF = requestAnimationFrame(tickFn);
    }

    _stopPostMidiClock() {
        this._virtualRunning = false;
        if (this._virtualClockRAF !== null) {
            try { cancelAnimationFrame(this._virtualClockRAF); } catch (e) {}
            this._virtualClockRAF = null;
        }
    }

    _finalizePostMidi() {
        this._stopPostMidiClock();
        this._stopAllAudioClips();

        // Event baru: "playback (MIDI + audio) benar-benar selesai".
        // Berbeda dari 'onEnded' yang hanya menandai akhir MIDI.
        this.emit('onSongFinished', this._lastSongTime);
    }

    /* ================================================================== */
    /*  Internal — gain / fades                                            */
    /* ================================================================== */

    _computeClipGain(clip, tInClip) {
        let gain = clip.volume ?? 1.0;

        const fi = clip.fadeIn;
        if (fi && fi.enable) {
            if (tInClip < fi.from) return 0;
            if (tInClip <= fi.to) {
                const range = fi.to - fi.from;
                if (range > 0) gain *= this._getFadeGain((tInClip - fi.from) / range, fi.shape);
            }
        }
        const fo = clip.fadeOut;
        if (fo && fo.enable) {
            if (tInClip > fo.to) return 0;
            if (tInClip >= fo.from) {
                const range = fo.to - fo.from;
                if (range > 0) gain *= (1 - this._getFadeGain((tInClip - fo.from) / range, fo.shape));
            }
        }
        return gain;
    }

    _getFadeGain(t, shape) {
        if (shape === 'easeIn')  return t * t;
        if (shape === 'easeOut') return 1 - (1 - t) * (1 - t);
        return t;
    }

    _applyClipGainSchedule(gainNode, clip, offsetInClip, when) {
        const v = clip.volume ?? 1.0;
        const p = gainNode.gain;

        try { p.cancelScheduledValues(when); } catch (e) {}

        // Hypothetical audio time when the clip *would have* started.
        const clipStartAudioTime = when - offsetInClip;

        const initialGain = this._computeClipGain(clip, offsetInClip);
        p.setValueAtTime(initialGain, when);

        const fi = clip.fadeIn;
        if (fi && fi.enable) {
            const fiFromAt = clipStartAudioTime + fi.from;
            const fiToAt   = clipStartAudioTime + fi.to;
            if (fiToAt > when) {
                if (fiFromAt > when) p.setValueAtTime(0, fiFromAt);
                p.linearRampToValueAtTime(v, fiToAt);
            }
        }
        const fo = clip.fadeOut;
        if (fo && fo.enable) {
            const foFromAt = clipStartAudioTime + fo.from;
            const foToAt   = clipStartAudioTime + fo.to;
            if (foToAt > when) {
                if (foFromAt > when) p.setValueAtTime(v, foFromAt);
                p.linearRampToValueAtTime(0, foToAt);
            }
        }
    }

    /* ================================================================== */
    /*  Offline rendering                                                  */
    /* ================================================================== */

    /**
     * Render the entire song offline into audio data.
     *
     * Depending on the mode, this will either produce a single merged audio file
     * or separate files for each track.
     *
     * @param {Object} opts - Rendering options.
     * @param {'merged'|'per-track'} [opts.mode='merged']
     *        Rendering mode:
     *          - 'merged': all tracks mixed into one audio file.
     *          - 'per-track': each track rendered individually.
     * @param {number} [opts.sampleRate=this.sampleRate]
     *        Output sample rate in Hz.
     * @param {number} [opts.bufferSize=this.bufferSize]
     *        Internal buffer size used during rendering.
     * @param {'mono'|'stereo'} [opts.channels='stereo']
     *        Channel layout of the output.
     * @param {(pct:number,label:string)=>void} [opts.onProgress]
     *        Optional callback invoked with progress percentage and label.
     *
     * @returns {Promise<Blob|Array<{type:string,trackIndex:number,name:string,blob:Blob}>>}
     *          Resolves to:
     *            - A single Blob (if mode='merged').
     *            - An array of objects containing track metadata and Blob (if mode='per-track').
     *
     * @throws {Error} If an unknown render mode is provided.
     */
    async render(opts = {}) {
        const {
            mode = 'merged',
            sampleRate = this.sampleRate,
            bufferSize = this.bufferSize,
            channels = 'stereo',
            onProgress = null,
        } = opts;

        if (mode === 'merged')    return this._renderMerged({ sampleRate, bufferSize, channels, onProgress });
        if (mode === 'per-track') return this._renderPerTrack({ sampleRate, bufferSize, channels, onProgress });
        throw new Error(`Unknown render mode: ${mode}`);
    }

    async _renderMerged({ sampleRate, bufferSize, channels, onProgress }) {
        const totalDur = this.getSongDuration();
        if (totalDur <= 0) throw new Error('Song duration is 0.');

        const numChannels  = channels === 'mono' ? 1 : 2;
        const totalSamples = Math.ceil(sampleRate * (totalDur + 1)); // +1 s tail

        const offlineCtx = new OfflineAudioContext(numChannels, totalSamples, sampleRate);
        const masterGain = offlineCtx.createGain();
        masterGain.gain.value = 1.0;
        masterGain.connect(offlineCtx.destination);

        /* -- MIDI -- */
        if (this.lastMidiData && (this.midiInfo?.duration_sec || 0) > 0) {
            onProgress?.(5, 'Rendering MIDI...');
            try {
                const midiBlob = await super.renderOffline({
                    sampleRate,
                    bufferSize,
                    isMono: channels === 'mono',
                });
                if (midiBlob) {
                    const midiBuf = await this._decodeBlob(midiBlob, sampleRate);
                    const src = offlineCtx.createBufferSource();
                    src.buffer = midiBuf;
                    src.connect(masterGain);
                    src.start(0);
                }
            } catch (e) {
                console.warn('[SongPlayer] MIDI offline render failed:', e);
            }
        }

        /* -- Audio clips (respect mute/solo) -- */
        onProgress?.(50, 'Rendering audio clips...');
        const hasSolo = this.audioTracks.some(t => t.solo);
        for (let ti = 0; ti < this.audioTracks.length; ti++) {
            const track = this.audioTracks[ti];
            const audible = hasSolo ? !!track.solo : !track.muted;
            if (!audible) continue;
            this._scheduleTrackOffline(offlineCtx, track, masterGain);
        }

        onProgress?.(80, 'Mixing...');
        const rendered = await offlineCtx.startRendering();

        onProgress?.(95, 'Encoding WAV...');
        const blob = this.audioBufferToWav(rendered);
        onProgress?.(100, 'Done');
        return blob;
    }

    async _renderPerTrack({ sampleRate, bufferSize, channels, onProgress }) {
        const results = [];
        const midiCount  = this._getMidiTrackCount();
        const audioCount = this.audioTracks.length;
        const totalUnits = midiCount + audioCount || 1;
        let done = 0;

        /* -- MIDI tracks -- */
        for (let i = 0; i < midiCount; i++) {
            const label = `MIDI Track ${i + 1}`;
            onProgress?.(Math.round((done / totalUnits) * 100), label);
            try {
                const blob = await super.renderOffline({
                    sampleRate,
                    bufferSize,
                    isMono: channels === 'mono',
                    soloTrack: i,
                });
                if (blob) results.push({ type: 'midi', trackIndex: i, name: label, blob });
            } catch (e) {
                console.warn(`[SongPlayer] MIDI track ${i} render failed:`, e);
            }
            done++;
        }

        /* -- Audio tracks (always rendered individually, ignoring mute/solo) -- */
        for (let i = 0; i < audioCount; i++) {
            const track = this.audioTracks[i];
            const label = track.name || `Audio Track ${i + 1}`;
            onProgress?.(Math.round((done / totalUnits) * 100), label);
            try {
                const blob = await this._renderSingleAudioTrack(track, i, {
                    sampleRate, bufferSize, channels,
                });
                results.push({ type: 'audio', trackIndex: i, name: label, blob });
            } catch (e) {
                console.warn(`[SongPlayer] Audio track ${i} render failed:`, e);
            }
            done++;
        }

        onProgress?.(100, 'Done');
        return results;
    }

    _getMidiTrackCount() {
        if (!this.lastMidiData) return 0;
        if ((this.midiInfo?.duration_sec || 0) <= 0) return 0;
        return (this.tempoMap && this.tempoMap.tracksCount) || 1;
    }

    _scheduleTrackOffline(offlineCtx, track, destination) {
        for (const clip of (track.clips || [])) {
            if (clip.isDeleted) continue;
            const asset = this.audioAssets.get(clip.audioAssetId);
            if (!asset || !asset.audioBuffer) continue;

            const startSec = this._clipStartSec(clip);
            const endSec   = this._clipEndSec(clip);
            const duration = endSec - startSec;
            if (duration <= 0) continue;

            const src = offlineCtx.createBufferSource();
            src.buffer = asset.audioBuffer;

            const gNode = offlineCtx.createGain();
            src.connect(gNode);
            gNode.connect(destination);

            this._applyClipGainSchedule(gNode, clip, 0, startSec);

            const trimOffset = this._safeTickToTime(clip.trimStartOffsetTicks || 0);
            if (trimOffset >= src.buffer.duration) continue;
            const playDur = Math.min(duration, src.buffer.duration - trimOffset);
            src.start(startSec, trimOffset, playDur);
        }
    }

    async _renderSingleAudioTrack(track, trackIndex, { sampleRate, bufferSize, channels }) {
        const totalDur = this.getSongDuration();
        if (totalDur <= 0) throw new Error('Song duration is 0.');

        const numChannels  = channels === 'mono' ? 1 : 2;
        const totalSamples = Math.ceil(sampleRate * (totalDur + 1));

        const offlineCtx = new OfflineAudioContext(numChannels, totalSamples, sampleRate);
        const masterGain = offlineCtx.createGain();
        masterGain.gain.value = 1.0;
        masterGain.connect(offlineCtx.destination);

        this._scheduleTrackOffline(offlineCtx, track, masterGain);

        const rendered = await offlineCtx.startRendering();
        return this.audioBufferToWav(rendered);
    }

    async _decodeBlob(blob, sampleRate) {
        const arrayBuffer = await blob.arrayBuffer();
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx({ sampleRate });
        try {
            return await ctx.decodeAudioData(arrayBuffer);
        } finally {
            try { ctx.close(); } catch (e) {}
        }
    }

}

// Export
if (typeof window !== 'undefined') window.SongPlayer = SongPlayer;
if (typeof module !== 'undefined' && module.exports) module.exports = SongPlayer;