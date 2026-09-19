/*
Link to repository: https://github.com/Planetbiru/LibTiMidityPlayer
*/
var Module = {};

Module.timidityReady = false;
Module.onRuntimeInitialized = function () {
    Module.timidityReady = true;
};

// This must be defined *before* libtimidity.js is loaded and executed.
// You must include `timidity-player.js` or `timidity-player.min.js` before `libtimidity.js` or `libtimidity.min.js`

Module.preRun = [() => {
    FS.mkdir('/gus-patch');
    FS.createPreloadedFile('/gus-patch', 'timidity.cfg', patchUrlBase + '/timidity.cfg', true, true);
}];

Module.printErr = function (text) {
    if (text.includes('Enlarging memory arrays')) return;
    console.warn(text);
};

/**
 * TimidityPlayer provides a high-level JavaScript interface to the libTiMidity WebAssembly module.
 * It handles MIDI playback, real-time MIDI input, audio context management, and patch loading.
 */
class TimidityPlayer {
    /**
     * Creates a new instance of TimidityPlayer.
     * @param {Object} options - Configuration options for the player.
     * @param {string} [options.patchUrlBase] - Base URL path for loading GUS patches (e.g., 'gus-patch').
     * @param {number} [options.bufferSize] - Buffer size for audio processing. Default value is 1024.
     * @param {number} [options.sampleRate] - Sample rate to render PCM. Default value is 44100.
     */
    constructor(options = {}) {
        this.virtualPatchDir = '/gus-patch'; // The absolute path inside the virtual filesystem
        this.patchUrlBase = options.patchUrlBase;
        this.bufferSize = options.bufferSize || 4096;
        this.sampleRate = options.sampleRate || 44100;
        this.Module = Module;
        this.audioContext = null;
        this.scriptNode = null;
        this.songPtr = 0; // Pointer to the C MidSong object
        this.loadedPatches = new Map(); // Map of filename -> Promise
        this.eventListeners = {}; // Event listeners for player events
        this.playingInterval = null;
        this.isPlaying = false;
        this.isSyncEnabled = false; // Flag to enable mixer state synchronization on seek
        this.isPaused = false;
        this.isSeeking = false; // Flag to prevent onPlaying updates while user is dragging the seeker
        this.channelMuteState = new Array(16).fill(false); // Cache for mute state
        this.totalDuration = 0; // Total duration in seconds
        this.midiInfo = {};
        this.lastDebugMessage = '';

        // MIDI Event Constants from libtimidity
        // Do not change this value
        this.ME_NOTEON              =  1;
        this.ME_NOTEOFF             =  2;
        this.ME_KEYPRESSURE         =  3;
        this.ME_MAINVOLUME          =  4;
        this.ME_PAN                 =  5;
        this.ME_SUSTAIN             =  6;
        this.ME_EXPRESSION          =  7;
        this.ME_PITCHWHEEL          =  8;
        this.ME_PROGRAM             =  9;
        this.ME_TEMPO               = 10;
        this.ME_PITCH_SENS          = 11;
        this.ME_ALL_SOUNDS_OFF      = 12;
        this.ME_RESET_CONTROLLERS   = 13;
        this.ME_ALL_NOTES_OFF       = 14;
        this.ME_TONE_BANK           = 15;
        this.ME_CONTROL_CHANGE      = 16;

        // If the WebAssembly module has already finished initializing, set up the C bindings immediately.
        if (this.Module.timidityReady) {
            this._onRuntimeInitialized();
        } else {
            // Otherwise, we must wait. Since this wrapper might be used synchronously,
            // we override the existing onRuntimeInitialized to also call our internal setup.
            const orig = this.Module.onRuntimeInitialized;
            this.Module.onRuntimeInitialized = () => {
                if (orig) orig();
                this._onRuntimeInitialized();
            };
        }

        return new Proxy(this, {
            get(target, prop, receiver) {
                // Capture access to "onXxx" properties that do not yet exist → turn them into event registrars.
                // player.onLoaded(func) equals to player.on('onLoaded', func)
                if (
                    typeof prop === 'string' &&
                    prop.startsWith('on') &&
                    !(prop in target)
                ) {
                    return (...args) => target.on(prop, ...args);
                }
                return Reflect.get(target, prop, receiver);
            }
        });
    }

    // --- Event Emitter ---

    /**
     * Registers a listener callback for a specific event.
     * @param {string} eventName - The name of the event to listen for.
     * @param {Function} listener - The callback function to be executed when the event is emitted.
     */
    on(eventName, listener) {
        if (!this.eventListeners[eventName]) this.eventListeners[eventName] = [];
        this.eventListeners[eventName].push(listener);
    }

    /**
     * Emits an event, calling all registered listeners with the provided arguments.
     * @param {string} eventName - The name of the event to emit.
     * @param {...any} args - The arguments to pass to the listeners.
     */
    emit(eventName, ...args) {
        this.eventListeners[eventName]?.forEach(listener => listener(...args));
    }

    // --- Private Methods ---

    /**
     * Callback triggered when the WebAssembly runtime is fully initialized.
     * Binds the C functions to JavaScript for internal usage.
     * @private
     */
    _onRuntimeInitialized() {
        const cwrap = this.Module.cwrap;
        this.c = {
            init: cwrap('mid_init', 'number', ['string']),
            exit: cwrap('mid_exit', null, []),
            getVersion: cwrap('mid_get_version', 'number', []),
            loadSong: cwrap('mid_song_load', 'number', ['number', 'number']),
            setDebugCallback: cwrap('mid_set_debug_msg_callback', null, ['number']),
            freeSong: cwrap('mid_song_free', null, ['number']),
            createSong: cwrap('mid_song_create', 'number', ['number']),
            getRequiredPatches: cwrap('mid_song_get_required_patches', 'string', ['number']),
            startSong: cwrap('mid_song_start', null, ['number']),
            setEventCallback: cwrap('mid_song_set_event_callback', null, ['number', 'number']),
            setTranspose: cwrap('mid_song_set_transpose', null, ['number', 'number']),
            setChannelMute: cwrap('mid_song_set_channel_mute', null, ['number', 'number', 'number']),
            setTrackMute: cwrap('mid_song_set_track_mute', null, ['number', 'number', 'number']),
            panic: cwrap('mid_song_panic', null, ['number']),
            readWave: cwrap('mid_song_read_wave', 'number', ['number', 'number', 'number', 'number']),
            openMemoryStream: cwrap('mid_istream_open_mem', 'number', ['number', 'number']),
            seekStream: cwrap('mid_istream_seek', 'number', ['number', 'number', 'number']),
            closeStream: cwrap('mid_istream_close', null, ['number']),
            seekSong: cwrap('mid_song_seek', null, ['number', 'number']),
            setVolume: cwrap('mid_song_set_volume', null, ['number', 'number']),
            getTime: cwrap('mid_song_get_time', 'number', ['number']),
            getTotalTime: cwrap('mid_song_get_total_time', 'number', ['number']),
            getCurrentTick: cwrap('mid_song_get_current_tick', 'number', ['number']),
            noteOn: cwrap('mid_note_on', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']),
            noteOff: cwrap('mid_note_off', null, ['number', 'number', 'number']),
            loadProgram: cwrap('mid_song_load_program', 'number', ['number', 'number', 'number', 'number']),
            sendEvent: cwrap('mid_send_event', null, ['number', 'number', 'number', 'number', 'number']),
            resendActiveNotes: cwrap('mid_song_resend_active_notes', null, ['number']),
            getControllerValueAtTick: cwrap('mid_song_get_controller_value_at_tick', 'number', ['number', 'number', 'number', 'number']),
            getInfoJson: cwrap('mid_song_get_info_json', 'string', ['number']),
            getActiveVoices: cwrap('mid_song_get_active_voices', 'number', ['number']),
            updateEvents: cwrap('mid_song_update_events', 'number', ['number', 'number']),
            getMasterPeak: cwrap('mid_song_get_master_peak', 'number', ['number', 'number', 'number']),
            forceMonoPan: cwrap('mid_song_force_mono_pan', null, ['number']),
            malloc: cwrap('malloc', 'number', ['number']),
            createOptions: cwrap('mid_create_options', 'number', ['number', 'number', 'number', 'number']),
        };

        this._setupDebugCallback();

        this.emit('onRuntimeInitialized');
    }

    /**
     * Sets up a debug callback function for the WebAssembly module.
     *
     * The callback receives a pointer to a UTF-8 encoded debug message,
     * converts it to a string, trims it, and stores it in `lastDebugMessage`.
     * The callback is registered with the native C interface.
     */
    _setupDebugCallback() {
        const debugCallback = (messagePtr) => {
            const message = this.Module.UTF8ToString(messagePtr);
            this.lastDebugMessage = message.trim();
        };
        const callbackPtr = this.Module.addFunction(debugCallback, 'vp');
        this.c.setDebugCallback(callbackPtr);
    }

    /**
     * Handles incoming MIDI events from the WebAssembly module.
     *
     * Converts the event timestamp from milliseconds to seconds,
     * extracts optional text data, and emits corresponding events:
     * - 'onNoteOn' when a Note On event occurs with velocity > 0
     * - 'onNoteOff' when a Note Off event occurs, or a Note On with velocity = 0
     * - 'onMidiEvent' for all MIDI events with full details
     *
     * @param {number} tick - MIDI tick position of the event.
     * @param {number} timeMilisecond - Event time in milliseconds.
     * @param {number} eventStatus - Raw MIDI status byte.
     * @param {number} channel - MIDI channel number.
     * @param {number} eventType - Internal event type identifier.
     * @param {number} a - First event parameter (e.g., pitch).
     * @param {number} b - Second event parameter (e.g., velocity).
     * @param {number} textPtr - Pointer to optional UTF-8 text data.
     */
    _handleMidiEvent(tick, timeMilisecond, eventStatus, channel, eventType, a, b, textPtr) {
        const timeSecond = timeMilisecond / 1000.0; // Convert milliseconds to seconds
        let text = '';
        if (textPtr) {
            text = this.Module.UTF8ToString(textPtr);
        }

        // Must before onMidiEvent
        if (eventType === this.ME_NOTEON && b > 0) { // Note On on any channel
            this.emit('onNoteOn', { tick: tick, channel: channel, pitch: a, velocity: b });
        } else if (eventType === this.ME_NOTEOFF || (eventType === this.ME_NOTEON && b === 0)) { // Note Off on any channel
            this.emit('onNoteOff', { tick: tick, channel: channel, pitch: a });
        }

        this.emit('onMidiEvent', { tick: tick, timeSecond, status: eventStatus, eventType, channel, a, b, text });

    }

    /**
     * Loads the required instrument patch files into the WebAssembly virtual filesystem.
     *
     * This function parses a newline-separated list of patch filenames, ensures
     * their directories exist inside the VFS, and preloads each patch asynchronously
     * from the server. It tracks progress and emits events during the loading process.
     *
     * Events emitted:
     * - 'onInstrumentLoading': emitted each time a patch starts or finishes loading,
     *   with arguments (loadedCount, totalCount, fileName).
     * - 'onInstrumentLoaded': emitted once all patches are loaded, with the total
     *   number of loaded patches.
     *
     * @param {string} patchListString - Newline-separated list of patch filenames to load.
     * @returns {Promise<void>} Resolves when all required patches are successfully preloaded.
     */
    async _loadRequiredPatches(patchListString) {
        if (!patchListString) return Promise.resolve();

        const requiredPatches = patchListString.split('\n').filter(p => p.length > 0);
        const total = requiredPatches.length;
        if (total === 0) return Promise.resolve();

        let loadedCount = 0;
        this.emit('onInstrumentLoading', loadedCount, total, '');

        const preloadPromises = requiredPatches.map(file => {
            if (this.loadedPatches.has(file)) {
                loadedCount++;
                this.emit('onInstrumentLoading', loadedCount, total, file);
                return this.loadedPatches.get(file);
            }
            
            // Construct the virtual path using the dedicated virtual directory property.
            // This path is used inside the WebAssembly filesystem.
            const fullVirtualPath = `${this.virtualPatchDir}/${file}`; // e.g., /gus-patch/pat/0/arachno-000.pat
            this.Module.FS.mkdirTree(this.Module.PATH.dirname(fullVirtualPath)); // Create /gus-patch/pat/0 inside VFS

            const promise = new Promise((resolve, reject) => {
                try {
                    let url = `${this.patchUrlBase}/${file}`;
                    this.Module.FS.createPreloadedFile(this.Module.PATH.dirname(fullVirtualPath), this.Module.PATH.basename(file), url, true, true, resolve, reject); // Preload from server
                } catch (e) {
                    if (e.name === 'ErrnoError' || (e.message && e.message.includes('File exists'))) {
                        resolve();
                    } else {
                        console.warn("Patch loading error:", file, e);
                        reject(e);
                    }
                }
            }).then(() => {
                loadedCount++;
                this.emit('onInstrumentLoading', loadedCount, total, file);
            }).catch(e => {
                console.warn("Failed to load patch asynchronously:", file, e);
            });

            this.loadedPatches.set(file, promise);
            return promise;
        });

        return Promise.all(preloadPromises).then(() => {
            this.emit('onInstrumentLoaded', this.loadedPatches.size);
        });
    }

    /**
     * Parses the raw MIDI data to extract the division and all tempo changes.
     * @param {Uint8Array} midiData 
     * @returns {Object} { division, timeMap: [{tick, timeSec, mpqn}] }
     * @private
     */
    _buildTempoMap(midiData) {
        let offset = 0;

        const readString = (len) => {
            let str = '';
            for (let i = 0; i < len; i++) str += String.fromCharCode(midiData[offset++]);
            return str;
        };
        const readUint16 = () => (midiData[offset++] << 8) | midiData[offset++];
        const readUint32 = () => (midiData[offset++] << 24) | (midiData[offset++] << 16) | (midiData[offset++] << 8) | midiData[offset++];
        const readVLQ = () => {
            let val = 0; let byte;
            do { byte = midiData[offset++]; val = (val << 7) | (byte & 0x7F); } while (byte & 0x80);
            return val;
        };

        if (readString(4) !== 'MThd') throw new Error("Not a valid MIDI file");
        readUint32(); // length
        const format = readUint16();
        const tracksCount = readUint16();
        const division = readUint16();

        const tempoEvents = [];
        const timeSigEvents = [];
        const trackNames = [];
        const trackHasNotes = [];
        let maxTick = 0;

        for (let t = 0; t < tracksCount; t++) {
            if (readString(4) !== 'MTrk') break;
            const trackLen = readUint32();
            const trackEnd = offset + trackLen;

            let absTick = 0;
            let runningStatus = 0;
            let currentTrackName = null;
            let hasChannelEvents = false;

            while (offset < trackEnd) {
                absTick += readVLQ();
                let status = midiData[offset];
                if (status >= 0x80) { runningStatus = status; offset++; } else { status = runningStatus; }

                if (status === 0xFF) { // Meta
                    const type = midiData[offset++];
                    const len = readVLQ();
                    if (type === 0x51 && len === 3) { // Set Tempo
                        const mpqn = (midiData[offset] << 16) | (midiData[offset + 1] << 8) | midiData[offset + 2];
                        tempoEvents.push({ tick: absTick, mpqn: mpqn });
                    } else if (type === 0x58 && len === 4) { // Time Signature
                        const num = midiData[offset];
                        const denom = Math.pow(2, midiData[offset + 1]);
                        timeSigEvents.push({ tick: absTick, num: num, denom: denom });
                    } else if (type === 0x03) { // Track Name
                        const nameBytes = midiData.slice(offset, offset + len);
                        try {
                            const nameStr = new TextDecoder().decode(nameBytes);
                            // Only set it if it's the first track name found in the track
                            if (!currentTrackName) currentTrackName = nameStr;
                        } catch (e) { }
                    }
                    offset += len;
                } else if (status === 0xF0 || status === 0xF7) { // SysEx
                    const len = readVLQ();
                    offset += len;
                } else { // Channel event
                    const cmd = status >> 4;
                    if (cmd >= 0x8 && cmd <= 0xE) {
                        hasChannelEvents = true;
                    }
                    if (status >= 0xF8) {
                        // System Realtime (no data bytes)
                    } else if (status === 0xF1 || status === 0xF3 || cmd === 0xC || cmd === 0xD) {
                        offset += 1;
                    } else {
                        offset += 2;
                    }
                }
            }
            if (absTick > maxTick) maxTick = absTick;
            trackNames.push(currentTrackName || `Track ${t}`);
            trackHasNotes.push(hasChannelEvents);
        }

        tempoEvents.sort((a, b) => a.tick - b.tick);
        if (tempoEvents.length === 0 || tempoEvents[0].tick !== 0) {
            tempoEvents.unshift({ tick: 0, mpqn: 500000 }); // Default 120 BPM
        }

        const timeMap = [];
        let currentTime = 0;
        let currentTick = 0;
        let currentMpqn = 500000;

        for (const ev of tempoEvents) {
            if (ev.tick > currentTick) {
                const deltaTicks = ev.tick - currentTick;
                const deltaTimeSec = (deltaTicks / division) * (currentMpqn / 1000000);
                currentTime += deltaTimeSec;
                currentTick = ev.tick;
            }
            currentMpqn = ev.mpqn;
            timeMap.push({ tick: currentTick, timeSec: currentTime, mpqn: currentMpqn });
        }

        // Build Time Signature Map
        timeSigEvents.sort((a, b) => a.tick - b.tick);
        if (timeSigEvents.length === 0 || timeSigEvents[0].tick !== 0) {
            timeSigEvents.unshift({ tick: 0, num: 4, denom: 4 }); // Default 4/4
        }

        const measureMap = [];
        let currentAbsBeat = 0;
        let currentMeasure = 1;
        let lastSigTick = 0;
        let currentNum = 4;
        let currentDenom = 4;

        for (const ev of timeSigEvents) {
            if (ev.tick > lastSigTick) {
                const deltaTicks = ev.tick - lastSigTick;
                const ticksPerBeat = division * (4 / currentDenom);
                const elapsedBeats = deltaTicks / ticksPerBeat;
                currentAbsBeat += elapsedBeats;
                currentMeasure += elapsedBeats / currentNum;
                lastSigTick = ev.tick;
            }
            currentNum = ev.num;
            currentDenom = ev.denom;
            measureMap.push({
                tick: lastSigTick,
                absBeat: currentAbsBeat,
                measure: currentMeasure,
                num: currentNum,
                denom: currentDenom,
                ticksPerBeat: division * (4 / currentDenom)
            });
        }

        let totalSeconds = 0;
        if (timeMap.length > 0) {
            const lastMap = timeMap[timeMap.length - 1];
            const deltaTicks = maxTick - lastMap.tick;
            const deltaSec = (deltaTicks / division) * (lastMap.mpqn / 1000000);
            totalSeconds = lastMap.timeSec + deltaSec;
        }

        return { division, timeMap, measureMap, tracksCount, trackNames, trackHasNotes, maxTick, totalSeconds };
    }

    /**
     * Converts an array of PCM audio chunks into a WAV file Blob.
     *
     * This function constructs a standard 44-byte WAV header and appends
     * the provided PCM data chunks to form a valid WAV file.
     *
     * @param {ArrayBufferView[]} chunks - Array of PCM audio chunks to be written.
     * @param {number} totalSamples - Total number of audio samples across all chunks.
     * @param {number} sampleRate - Sampling rate in Hz (e.g., 44100).
     * @param {number} [channels=2] - Number of audio channels (1 = mono, 2 = stereo).
     * @returns {Blob} A Blob object containing the generated WAV file data.
     */
    _chunksToWav(chunks, totalSamples, sampleRate, channels = 2) {
        const buffer = new ArrayBuffer(44 + totalSamples * 2);
        const dataView = new DataView(buffer);

        function writeString(view, offset, string) {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        }

        const byteLength = totalSamples * 2;

        writeString(dataView, 0, 'RIFF');
        dataView.setUint32(4, 36 + byteLength, true);
        writeString(dataView, 8, 'WAVE');
        writeString(dataView, 12, 'fmt ');
        dataView.setUint32(16, 16, true);
        dataView.setUint16(20, 1, true); // PCM format
        dataView.setUint16(22, channels, true); // Mono or Stereo
        dataView.setUint32(24, sampleRate, true);
        dataView.setUint32(28, sampleRate * channels * 2, true); // byte rate
        dataView.setUint16(32, channels * 2, true); // block align
        dataView.setUint16(34, 16, true); // bits per sample
        writeString(dataView, 36, 'data');
        dataView.setUint32(40, byteLength, true);

        let offset = 44;
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const uint8View = new Uint8Array(buffer, offset, chunk.byteLength);
            uint8View.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            offset += chunk.byteLength;
        }

        return new Blob([dataView], { type: 'audio/wav' });
    }

    // --- Public API ---

    /**
     * Initializes the WebAudio context and the libTiMidity engine.
     * Must be called before loading or playing any MIDI files.
     * @param {boolean} [offline=false] - Whether to initialize an OfflineAudioContext for rendering without playback.
     * @returns {Promise<boolean>} True if initialization was successful, false otherwise.
     */
    async init(offline = false) {
        if (this.audioContext) {
            this.emit('onError', "Already initialized.");
            return false;
        }
        
        // Initialize AudioContext synchronously so load() doesn't fail its check
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.audioContext = offline ? new OfflineAudioContext(2, this.sampleRate * 60, this.sampleRate) : new AudioContextClass({ sampleRate: this.sampleRate });
        this.gainNode = this.audioContext.createGain();
        this.gainNode.connect(this.audioContext.destination);
        if (!offline) {
            this.audioContext.suspend();
        }

        return this._waitForRuntime().then(() => {
            // Use the virtual path for initialization inside the WASM module.
            const configPath = `${this.virtualPatchDir}/timidity.cfg`;
            const rc = this.c.init(configPath); // Initialize libTiMidity with config file from VFS
            if (rc === 0) {
                if (!offline) {

                    // Removed await this.initRealtimeSong() because we'll chain it
                    let rtPromise = this.initRealtimeSong() || Promise.resolve();
                    
                    // We use this to reduce latency, especially for playing notes in real time such as noteOn and noteOff
                    this.scriptNode = this.audioContext.createScriptProcessor(this.bufferSize, 0, 2);

                    this.scriptNode.onaudioprocess = (e) => {
                        const outL = e.outputBuffer.getChannelData(0);
                        const outR = e.outputBuffer.getChannelData(1);
                        outL.fill(0);
                        outR.fill(0);

                        const pcmBytes = this.bufferSize * 2 * 2;
                        let bytesReadMain = 0;

                        if (this.songPtr !== 0 && !this.isPaused && this.isPlaying) {
                            const pcmBufferPtr = this.Module._malloc(pcmBytes);
                            bytesReadMain = this.c.readWave(this.songPtr, pcmBufferPtr, pcmBytes, 0);
                            if (bytesReadMain > 0) {
                                const samplesRead = bytesReadMain / 4;
                                for (let i = 0; i < samplesRead; i++) {
                                    outL[i] = this.Module.HEAP16[(pcmBufferPtr >> 1) + (i * 2)] / 32768.0;
                                    outR[i] = this.Module.HEAP16[(pcmBufferPtr >> 1) + (i * 2) + 1] / 32768.0;
                                }
                            }
                            this.Module._free(pcmBufferPtr);

                            if (bytesReadMain <= 0) {
                                this.stop();
                                this.emit('onEnded');
                            }
                        }

                        if (this.realtimeSongPtr) {
                            const rtBufferPtr = this.Module._malloc(pcmBytes);
                            const rtBytes = this.c.readWave(this.realtimeSongPtr, rtBufferPtr, pcmBytes, 0);
                            if (rtBytes > 0) {
                                const samplesRead = rtBytes / 4;
                                for (let i = 0; i < samplesRead; i++) {
                                    outL[i] += this.Module.HEAP16[(rtBufferPtr >> 1) + (i * 2)] / 32768.0;
                                    outR[i] += this.Module.HEAP16[(rtBufferPtr >> 1) + (i * 2) + 1] / 32768.0;
                                }
                            }
                            this.Module._free(rtBufferPtr);
                        }
                    };

                    this.scriptNode.connect(this.gainNode);
                }

                // Preload the default instrument (Acoustic Grand Piano) for the real-time player.
                // This ensures that the debug buttons and initial MIDI controller input work immediately.
                return this.setRealtimeInstrument(0, 0, 0).then(() => {
                    const callbackPtr = this.Module.addFunction((...args) => this._handleMidiEvent(...args), 'viiiiippp');
                    this.c.setEventCallback(0, callbackPtr);
                    this.emit('onInit');
                    return true;
                });
            } else {
                this.emit('onError', `Initialization failed. Check patch files.`);
                return false;
            }
        });
    }

    /**
     * Initializes the real-time synthesizer song instance if it hasn't been created yet.
     * This prepares an empty song specifically used for real-time MIDI input.
     * @returns {Promise<void>}
     */
    initRealtimeSong(options = {}) {
        if (this.realtimeSongPtr) return;

        const midiBytes = [
            0x4D, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x00, 0x78,
            0x4D, 0x54, 0x72, 0x6B, 0x00, 0x00, 0x00, 0x0C,
            0x00, 0xFF, 0x51, 0x03, 0xFF, 0xFF, 0xFF,
            0x81, 0xEA, 0x30, 0x80, 0x00, 0x00,
            0x00, 0xFF, 0x2F, 0x00
        ];

        const emptyMidi = new Uint8Array(midiBytes);
        const midiDataPtr = this.Module._malloc(emptyMidi.length);
        this.Module.HEAPU8.set(emptyMidi, midiDataPtr);

        const bufferSize = options.bufferSize || 1024;

        let optionsPtr;
        if (this.c.createOptions) {
            optionsPtr = this.c.createOptions(this.audioContext.sampleRate, 0x8010, 2, bufferSize);
        } else {
            optionsPtr = this.Module._malloc(12);
            this.Module.setValue(optionsPtr + 0, this.audioContext.sampleRate, 'i32');
            this.Module.setValue(optionsPtr + 4, 0x8010, 'i16'); // S16LSB, signed 16-bit
            this.Module.setValue(optionsPtr + 6, 2, 'i8');       // stereo output
            this.Module.setValue(optionsPtr + 8, bufferSize, 'i32');   // buffer size
        }

        const streamPtr = this.c.openMemoryStream(midiDataPtr, emptyMidi.length);
        this.realtimeSongPtr = this.c.loadSong(streamPtr, optionsPtr);

        this.c.closeStream(streamPtr);
        this.Module._free(midiDataPtr);
        this.Module._free(optionsPtr);

        if (this.realtimeSongPtr !== 0) {
            this.c.startSong(this.realtimeSongPtr);
        }
        return Promise.resolve();
    }

    /**
     * Resends active notes to the synthesizer. Useful when seeking or changing instruments
     * to ensure sustained notes continue playing correctly.
     */
    resendActiveNotes(channel = -1) {
        if (this.songPtr !== 0) {
            // The C function expects -1 for all channels.
            this.c.resendActiveNotes(this.songPtr, channel);
        }
        if (this.realtimeSongPtr !== 0) {
            this.c.resendActiveNotes(this.realtimeSongPtr, channel);
        }
    }

    /**
     * Gets the current value of a specific MIDI controller at a given tick.
     * @param {number} channel - The MIDI channel (0-15).
     * @param {number} cc - The Control Change (CC) number (0-127).
     * @param {number} tick - The absolute tick position.
     * @returns {number} The controller value (0-127), or -1 if the song is not loaded.
     */
    getControllerValueAtTick(channel, cc, tick) {
        if (this.songPtr !== 0) {
            return this.c.getControllerValueAtTick(this.songPtr, channel, cc, tick);
        }
        return -1;
    }

    /**
     * Loads a MIDI file into the player and prepares required patches.
     * @param {File|Uint8Array} midi - The MIDI file data to load.
     * @param {Function} [callback=null] - Optional callback function called when loading finishes.
     * @returns {Promise<boolean>} True if loaded successfully, false otherwise.
     */
    async load(midi, callback = null) {
        if (!this.audioContext) {
            this.emit('onError', "Player not initialized. Call init() first.");
            if (callback) callback(false);
            return Promise.resolve(false);
        }
        if (this.songPtr !== 0) {
            this.stop();
        }

        this.emit('onMidiLoading', midi);
        this.midiInfo = {};

        let midiDataPromise;
        if (midi instanceof Uint8Array) {
            midiDataPromise = Promise.resolve(midi);
        } else if (typeof midi === 'string') {
            if (midi.substring(0, 4) === 'MThd') {
                const md = new Uint8Array(midi.length);
                for (let i = 0; i < midi.length; i++) md[i] = midi.charCodeAt(i);
                midiDataPromise = Promise.resolve(md);
            } else if (midi.indexOf("data:") !== -1) {
                const dataOffset = midi.indexOf(",") + 1;
                const binaryString = atob(midi.substring(dataOffset));
                const md = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) md[i] = binaryString.charCodeAt(i);
                midiDataPromise = Promise.resolve(md);
            } else {
                midiDataPromise = fetch(midi).then(response => {
                    if (!response.ok) throw new Error("Failed to load MIDI file from URL: " + response.statusText);
                    return response.arrayBuffer().then(buf => new Uint8Array(buf));
                });
            }
        } else if (midi && typeof midi.arrayBuffer === 'function') {
            midiDataPromise = midi.arrayBuffer().then(buffer => new Uint8Array(buffer));
        } else {
            return Promise.reject(new Error("Unsupported MIDI data format"));
        }

        return midiDataPromise.then(async (midiData) => {
            return this._waitForRuntime().then(() => {
                this.lastMidiData = midiData; // Store for offline rendering reloading

                const midiDataPtr = this.Module._malloc(midiData.length);
                this.Module.HEAPU8.set(midiData, midiDataPtr);

                let optionsPtr;
                const bufferSize = this.bufferSize || 4096;
                if (this.c.createOptions) {
                    optionsPtr = this.c.createOptions(this.audioContext.sampleRate, 0x8010, 2, bufferSize);
                } else {
                    optionsPtr = this.Module._malloc(12);
                    this.Module.setValue(optionsPtr + 0, this.audioContext.sampleRate, 'i32');
                    this.Module.setValue(optionsPtr + 4, 0x8010, 'i16'); // S16LSB, signed 16-bit
                    this.Module.setValue(optionsPtr + 6, 2, 'i8');       // stereo output
                    this.Module.setValue(optionsPtr + 8, bufferSize, 'i32');   // buffer size
                }

                const streamPtr = this.c.openMemoryStream(midiDataPtr, midiData.length); // Create memory stream for MIDI data
                const patchListString = this.c.getRequiredPatches(streamPtr); // Analyze MIDI to get required patches

                return this._loadRequiredPatches(patchListString).then(() => {
                    this.c.seekStream(streamPtr, 0, 0); // Rewind stream to beginning
                    this.lastDebugMessage = '';
                    this.songPtr = this.c.loadSong(streamPtr, optionsPtr); // Load song

                    // Build tempo map for accurate goTo(ticks) functionality.
                    try {
                        this.tempoMap = this._buildTempoMap(this.lastMidiData);
                    } catch (e) {
                        console.warn("Failed to parse tempo map:", e);
                    }

                    if (this.songPtr !== 0) {
                        const callbackPtr = this.Module.addFunction(this._handleMidiEvent.bind(this), 'viiiiiii');
                        this.c.setEventCallback(this.songPtr, callbackPtr);
                    }

                    if (this.songPtr !== 0) {
                        this.totalDuration = this.c.getTotalTime(this.songPtr) / 1000; // in seconds
                        // Process initial events at tick 0 to set up the mixer state.
                        if (this.isSyncEnabled) {
                            this.seek(0);
                        }
                        this.emit('onMidiLoaded', midi, this.totalDuration);

                        this.currentStreamPtr = streamPtr;
                        this.currentMidiDataPtr = midiDataPtr;
                        this.currentOptionsPtr = optionsPtr;
                        this.midiInfo = this.getInfo();
                        this.totalDuration = this.midiInfo?.duration_sec || 0;

                        if (callback) callback(true);
                        return true;
                    } else {
                        const reason = this.lastDebugMessage || "Unknown error while loading MIDI file.";
                        this.emit('onError', `Failed to load MIDI file: ${reason}`);

                        this.c.closeStream(streamPtr); // Close memory stream
                        this.Module._free(midiDataPtr);
                        this.Module._free(optionsPtr);
                        if (callback) callback(false);
                        return false;
                    }
                });
            });
        });
    }

    /**
     * Starts or resumes playback of the currently loaded MIDI song.
     * @param {number} [offset=0] - The time offset in seconds to start playing from.
     * @param {Object} [options={}] - Additional playback options.
     */
    play(offset = 0, options = {}) {
        if (!this.audioContext || this.songPtr === 0) return;

        this.c.startSong(this.songPtr); // Prepare song for playback
        if (offset > 0) this.seek(offset); // Seek if offset is provided

        const emitPlaying = options.emitPlaying !== false;

        let lastAudioContextTime = this.audioContext.currentTime;
        let lastEngineTimeSec = this.c.getTime(this.songPtr) / 1000.0;
        let smoothTimeSec = lastEngineTimeSec;

        const updatePlaying = () => {
            if (this.isPlaying && !this.isPaused && this.audioContext.state === 'running' && !this.isSeeking) {
                const currentTick = this.c.getCurrentTick(this.songPtr);
                const engineTimeSec = this.c.getTime(this.songPtr) / 1000.0;

                const currentAudioTime = this.audioContext.currentTime;
                const dt = currentAudioTime - lastAudioContextTime;
                lastAudioContextTime = currentAudioTime;

                // Sync with the engine when a new block is synthesized or if drift occurs.
                if (engineTimeSec !== lastEngineTimeSec) {
                    lastEngineTimeSec = engineTimeSec;
                    if (Math.abs(smoothTimeSec - engineTimeSec) > 0.15) {
                        smoothTimeSec = engineTimeSec;
                    }
                }

                smoothTimeSec += dt;

                this.emit('onPlaying', currentTick, smoothTimeSec);
            } else {
                lastAudioContextTime = this.audioContext.currentTime;
            }
            
            if (this.isPlaying) {
                this.playingInterval = requestAnimationFrame(updatePlaying);
            }
        };

        if (this.playingInterval) {
            cancelAnimationFrame(this.playingInterval);
            clearInterval(this.playingInterval); // Fallback in case it was created with setInterval
            this.playingInterval = null;
        }
        
        if (emitPlaying) {
            this.playingInterval = requestAnimationFrame(updatePlaying);
        }

        this.isPlaying = true;
        this.isPaused = false;
        this.emit('onPlay');

        this.resume();
    }

    /**
     * Loads a MIDI file and automatically starts playing it.
     * @param {File|Uint8Array} midi - The MIDI file data to load.
     * @param {number} [offset=0] - The time offset in seconds to start playing from.
     * @param {Object} [options={}] - Additional playback options.
     * @returns {Promise<void>}
     */
    async loadAndPlay(midi, offset = 0, options = {}) {
        return this.load(midi).then((success) => {
            if (success) {
                this.play(offset, options);
            }
        });
    }

    /**
     * Updates the currently playing MIDI data on-the-fly without stopping playback.
     * The player will seamlessly transition to the new event list from its current time.
     * @param {File|Uint8Array} midi - The new MIDI file data to load.
     * @returns {Promise<boolean>} True if the update was successful, false otherwise.
     */
    async updateMidiData(midi) {
        if (!this.audioContext || this.songPtr === 0) {
            this.emit('onError', "Cannot update MIDI. No song is currently loaded or playing.");
            return Promise.resolve(false);
        }

        let midiDataPromise;
        if (midi instanceof Uint8Array) {
            midiDataPromise = Promise.resolve(midi);
        } else if (midi && typeof midi.arrayBuffer === 'function') {
            midiDataPromise = midi.arrayBuffer().then(buffer => new Uint8Array(buffer));
        } else {
            return Promise.reject(new Error("Unsupported MIDI data format for update."));
        }

        return midiDataPromise.then(midiData => {
            return this._waitForRuntime().then(() => {
                // We need to create a new stream for the C function.
                const newDataPtr = this.Module._malloc(midiData.length);
                this.Module.HEAPU8.set(midiData, newDataPtr);
                const newStreamPtr = this.c.openMemoryStream(newDataPtr, midiData.length);

                // First, get required patches from the new MIDI data.
                const patchListString = this.c.getRequiredPatches(newStreamPtr);
                this.c.seekStream(newStreamPtr, 0, 0); // Rewind for the next step.

                return this._loadRequiredPatches(patchListString).then(() => {
                    // Now, call the update function.
                    const result = this.c.updateEvents(this.songPtr, newStreamPtr);

                    // Clean up the stream and memory we created for the update.
                    this.c.closeStream(newStreamPtr);
                    this.Module._free(newDataPtr);

                    if (result === 0) {
                        // Rebuild tempo map dari data MIDI baru, sekaligus refresh totalDuration.
                        try {
                            this.tempoMap = this._buildTempoMap(midiData);
                            this.lastMidiData = midiData; // Simpan untuk renderOffline berikutnya
                            if (this.tempoMap && typeof this.tempoMap.totalSeconds === 'number' && this.tempoMap.totalSeconds > 0) {
                                this.totalDuration = this.tempoMap.totalSeconds;
                            } else {
                                // Fallback: kalau C-side kebetulan sudah menghitung ulang, pakai itu
                                this.totalDuration = this.c.getTotalTime(this.songPtr) / 1000;
                            }
                        } catch (e) {
                            console.warn("Failed to rebuild tempo map after update:", e);
                            this.totalDuration = this.c.getTotalTime(this.songPtr) / 1000;
                        }
                        this.emit('onMidiUpdated', midi, this.totalDuration); // 👈 kirim durasi baru ke listener
                        return true;
                    }
                });
            });
        });
    }

    /**
     * Set the global pitch transpose in semitones (-12 to +12).
     * @param {number} semitones - The number of semitones to transpose.
     */
    setTranspose(semitones) {
        if (this.songPtr !== 0) {
            this.c.setTranspose(this.songPtr, semitones);
        }
        if (this.realtimeSongPtr !== 0) {
            this.c.setTranspose(this.realtimeSongPtr, semitones);
        }
    }

    /**
     * Set the master volume for playback.
     * @param {number} volume - The volume level (0.0 to 1.0).
     */
    setMasterVolume(volume) {
        if (this.gainNode) {
            // Clamp between 0.0 and 1.0 for safety, although WebAudio allows > 1.0
            const clamped = Math.max(0, Math.min(1, volume));
            this.gainNode.gain.value = clamped;
        }
    }

    /**
     * Applies mute/solo logic to all channels, only updating channels whose state has changed.
     * This prevents unnecessary calls to the C function, reducing audio glitches.
     * @param {Array<Object>} tracksData - The array of all track data objects.
     */
    applyMuteState(tracksData) {
        if (!this.songPtr && !this.realtimeSongPtr) return;

        const soloChannels = tracksData.filter(t => t.solo && t.type !== 'audio').map(t => t.channel);

        for (let c = 0; c < 16; c++) {
            const isMutedBySolo = soloChannels.length > 0 ? !soloChannels.includes(c) : false;
            const isMutedDirectly = tracksData.some(t => t.channel === c && t.muted && t.type !== 'audio');
            const shouldBeMuted = isMutedBySolo || isMutedDirectly;

            if (this.channelMuteState[c] !== shouldBeMuted) {
                this.setChannelMute(c, shouldBeMuted);
                this.channelMuteState[c] = shouldBeMuted;
            }
        }
    }

    /**
     * Mute or unmute a specific MIDI channel (0-15).
     * @param {number} channel The MIDI channel (0-15)
     * @param {boolean} mute True to mute, false to unmute
     */
    setChannelMute(channel, mute) {
        if (this.songPtr !== 0) {
            this.c.setChannelMute(this.songPtr, channel, mute ? 1 : 0);
        }
        if (this.realtimeSongPtr !== 0) {
            this.c.setChannelMute(this.realtimeSongPtr, channel, mute ? 1 : 0);
        }
    }    
    
    /**
     * Mute or unmute a specific MIDI track (0-255).
     * @param {number} track The MIDI track (0-255)
     * @param {boolean} mute True to mute, false to unmute
     */
    setTrackMute(track, mute) {
        if (this.songPtr !== 0) {
            this.c.setTrackMute(this.songPtr, track, mute ? 1 : 0);
        }
        if (this.realtimeSongPtr !== 0) {
            this.c.setTrackMute(this.realtimeSongPtr, track, mute ? 1 : 0);
        }
    }

    /**
     * Instantly kill all currently sounding notes (Panic button).
     */
    panic() {
        if (this.songPtr !== 0) {
            this.c.panic(this.songPtr);
        }
        if (this.realtimeSongPtr !== 0) {
            this.c.panic(this.realtimeSongPtr);
        }
    }

    /**
     * Get metadata and information about the currently loaded song.
     * @returns {Object|null} The parsed JSON object with song info, or null if no song is loaded.
     */
    getInfo() {
        if (this.songPtr !== 0) {
            try {
                const jsonStr = this.c.getInfoJson(this.songPtr);
                return JSON.parse(jsonStr);
            } catch (e) {
                console.error("Failed to parse song info:", e);
                return null;
            }
        }
        return null;
    }

    /**
     * Get the number of currently sounding polyphony voices.
     * @returns {number} Active voices count.
     */
    getActiveVoices() {
        if (this.songPtr !== 0) {
            return this.c.getActiveVoices(this.songPtr);
        } else if (this.realtimeSongPtr !== 0) {
            return this.c.getActiveVoices(this.realtimeSongPtr);
        }
        return 0;
    }

    /**
     * Renders the currently loaded MIDI song to a WAV Blob offline, without playing it.
     * Yields to the main thread periodically and emits 'onRenderProgress'.
     * @param {Object} [options={}] - Options for rendering.
     * @param {number} [options.sampleRate=44100] - The target sample rate.
     * @param {boolean} [options.isMono=false] - If true, outputs 1 channel and centers pan.
     * @param {boolean} [options.isSpatial=false] - If true, applies 3D spatial audio (overrides isMono to false).
     * @param {boolean} [options.isSpatialInterpolation=false] - If true, interpolates spatial coordinates smoothly.
     * @param {boolean} [options.monoToStereo=false] - If true, applies stereo widening (Spectral Panning / EQ) to the final output.
     * @param {number} [options.monoToStereoWeight=5] - The intensity of the stereo widening effect (gain in dB).
     * @returns {Promise<Blob>} The generated WAV file as a Blob.
     */
    renderOffline(options = {}) {
        if (!this.lastMidiData) return null;

        this.emit('onRenderStart');

        if (this.isPlaying) {
            this.pause();
        }

        let { sampleRate = 44100, isMono = false, isSpatial = false, isSpatialInterpolation = false, monoToStereo = false, monoToStereoWeight = 5, soloTrack = -1 } = options;
        if (isSpatial || monoToStereo) {
            isMono = false; // Force stereo if spatial or stereo widening is requested
        }

        // Initialize offline processing parameters
        const channels = isMono ? 1 : 2;

        const bufferSize = options.bufferSize || 4096;

        // Setup options for libTiMidity reload
        let optionsPtr;
        if (this.c.createOptions) {
            optionsPtr = this.c.createOptions(sampleRate, 0x8010, channels, bufferSize);
        } else {
            optionsPtr = this.Module._malloc(12);
            this.Module.setValue(optionsPtr + 0, sampleRate, 'i32');
            this.Module.setValue(optionsPtr + 4, 0x8010, 'i16'); // S16LSB, signed 16-bit
            this.Module.setValue(optionsPtr + 6, channels, 'i8');
            this.Module.setValue(optionsPtr + 8, bufferSize, 'i32');   // buffer size MUST be i32 to avoid garbage upper bits
        }

        // Reload song from raw data for offline rendering
        const midiDataPtr = this.Module._malloc(this.lastMidiData.length);
        this.Module.HEAPU8.set(this.lastMidiData, midiDataPtr);
        const streamPtr = this.c.openMemoryStream(midiDataPtr, this.lastMidiData.length);

        // We assume patches are already loaded from the previous normal load()
        const renderSongPtr = this.c.loadSong(streamPtr, optionsPtr);

        this.c.closeStream(streamPtr);
        this.Module._free(midiDataPtr);
        this.Module._free(optionsPtr);

        if (renderSongPtr === 0) {
            this.emit('onError', "Failed to prepare song for rendering.");
            return null;
        }

        // Apply soloTrack if specified (mute all except the soloed track)
        if (soloTrack >= 0) {
            if (!this.c.setTrackMute && this.Module.cwrap) {
                this.c.setTrackMute = this.Module.cwrap('mid_song_set_track_mute', null, ['number', 'number', 'number']);
            }
            if (this.c.setTrackMute) {
                const totalTracks = (this.tempoMap && this.tempoMap.tracksCount) ? this.tempoMap.tracksCount : 256;
                for (let i = 0; i < totalTracks; i++) {
                    this.c.setTrackMute(renderSongPtr, i, i === soloTrack ? 0 : 1);
                }
            }
        }

        if (isMono && this.c.forceMonoPan) { // Optional C function we added
            this.c.forceMonoPan(renderSongPtr);
        }

        this.c.startSong(renderSongPtr);

        const totalTime = this.c.getTotalTime(renderSongPtr);
        const durationSeconds = totalTime / 1000.0;
        let currentTime = 0;

        const pcmBytes = this.bufferSize * channels * 2; // bytes per sample = 2
        const pcmBufferPtr = this.Module._malloc(pcmBytes);

        const chunks = [];
        let totalLength = 0;

        // Spatial Audio Setup
        let offlineCtx = null;
        let panner = null;
        let spatialSourceNode = null;
        let spatialBufferArray = null;
        let spatialChannelDataL = null;
        let spatialChannelDataR = null;
        let spatialOffset = 0;
        let spatialEvents = []; // To collect CC 20 and CC 21

        let renderCallbackPtr = 0;

        if (isSpatial && durationSeconds > 0) {
            offlineCtx = new OfflineAudioContext(2, Math.ceil(sampleRate * durationSeconds) + sampleRate, sampleRate);
            panner = offlineCtx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            panner.connect(offlineCtx.destination);

            // Initial center position
            panner.positionX.setValueAtTime(0, 0);
            panner.positionY.setValueAtTime(0, 0);
            panner.positionZ.setValueAtTime(0, 0);

            // Pre-allocate buffer for the entire song to feed into PannerNode
            spatialBufferArray = offlineCtx.createBuffer(2, Math.ceil(sampleRate * durationSeconds) + sampleRate, sampleRate);
            spatialChannelDataL = spatialBufferArray.getChannelData(0);
            spatialChannelDataR = spatialBufferArray.getChannelData(1);

            // Attach callback to capture CC events during readWave loop
            this._spatialEvents = [];
            spatialEvents = this._spatialEvents;

            if (!this._offlineCallbackPtr) {
                this._offlineCallbackPtr = this.Module.addFunction((tick, timeMilisecond, eventStatus, channel, eventType, a, b, textPtr) => {
                    if (this._spatialEvents && eventType === this.ME_CONTROL_CHANGE) {
                        if (a === 20 || a === 21) {
                            this._spatialEvents.push({
                                time: timeMilisecond / 1000.0,
                                cc: a,
                                val: b
                            });
                        }
                    }
                }, 'viiiiippp');
            }
            renderCallbackPtr = this._offlineCallbackPtr;
            this.c.setEventCallback(renderSongPtr, renderCallbackPtr);
        }

        return new Promise((resolve, reject) => {
            const processChunk = () => {
                let iterations = 0;
                while (iterations < 20) { // Render 20 chunks per frame
                    let bytesReadMain = this.c.readWave(renderSongPtr, pcmBufferPtr, pcmBytes, 1);
                    if (bytesReadMain > 0) {
                        const samples = bytesReadMain / 2;
                        const chunk = new Int16Array(samples);
                        chunk.set(new Int16Array(this.Module.HEAP16.buffer, pcmBufferPtr, samples));
                        chunks.push(chunk);
                        totalLength += chunk.length;
                    } else if (bytesReadMain <= 0) {
                        this.Module._free(pcmBufferPtr);
                        if (renderCallbackPtr !== 0) {
                            // Do not call removeFunction because it's not exported by default and crashes Emscripten.
                            // We reuse the _offlineCallbackPtr to prevent memory leak.
                            this._spatialEvents = null;
                        }
                        this.c.freeSong(renderSongPtr); // Free the temporary render instance

                        if (isSpatial && offlineCtx) {
                            // Cek apakah ada nilai CC selain 64
                            const hasSpatialData = spatialEvents.some(ev => ev.val !== 64);
                            if (!hasSpatialData) {
                                isSpatial = false; // Batalkan spatial processing
                            }
                        }

                        // Determine if we need OfflineAudioContext processing
                        const requiresWebAudio = (isSpatial && offlineCtx) || monoToStereo;

                        if (requiresWebAudio) {
                            // Pindahkan audio dari raw chunks ke Web Audio Buffer
                            if (!offlineCtx) {
                                offlineCtx = new OfflineAudioContext(2, Math.ceil(sampleRate * durationSeconds) + sampleRate, sampleRate);
                                spatialBufferArray = offlineCtx.createBuffer(2, Math.ceil(sampleRate * durationSeconds) + sampleRate, sampleRate);
                                spatialChannelDataL = spatialBufferArray.getChannelData(0);
                                spatialChannelDataR = spatialBufferArray.getChannelData(1);
                            }

                            let localOffset = 0;
                            for (let i = 0; i < chunks.length; i++) {
                                const chk = chunks[i];
                                const frameCount = chk.length / channels;
                                for (let j = 0; j < frameCount; j++) {
                                    spatialChannelDataL[localOffset + j] = chk[j * channels] / 32768.0;
                                    spatialChannelDataR[localOffset + j] = chk[j * channels + (channels === 2 ? 1 : 0)] / 32768.0;
                                }
                                localOffset += frameCount;
                            }

                            spatialSourceNode = offlineCtx.createBufferSource();
                            spatialSourceNode.buffer = spatialBufferArray;

                            let lastNode = spatialSourceNode;

                            if (monoToStereo) {
                                // EQ-Based Stereo Widening (Spectral Panning)
                                // Menggunakan EQ berkebalikan untuk L dan R tanpa delay agar tidak ada gema/phase shift.
                                const splitter = offlineCtx.createChannelSplitter(2);
                                const merger = offlineCtx.createChannelMerger(2);

                                spatialSourceNode.connect(splitter);

                                // Filter Left (Boost Highs, Cut Lows)
                                const filterL1 = offlineCtx.createBiquadFilter();
                                filterL1.type = 'highshelf';
                                filterL1.frequency.value = 2500;
                                filterL1.gain.value = monoToStereoWeight;
                                const filterL2 = offlineCtx.createBiquadFilter();
                                filterL2.type = 'lowshelf';
                                filterL2.frequency.value = 400;
                                filterL2.gain.value = -monoToStereoWeight;

                                // Filter Right (Cut Highs, Boost Lows)
                                const filterR1 = offlineCtx.createBiquadFilter();
                                filterR1.type = 'highshelf';
                                filterR1.frequency.value = 2500;
                                filterR1.gain.value = -monoToStereoWeight;
                                const filterR2 = offlineCtx.createBiquadFilter();
                                filterR2.type = 'lowshelf';
                                filterR2.frequency.value = 400;
                                filterR2.gain.value = monoToStereoWeight;

                                // Routing
                                splitter.connect(filterL1, 0, 0); // Ambil channel kiri
                                filterL1.connect(filterL2);
                                filterL2.connect(merger, 0, 0); // Masukkan ke kiri merger

                                splitter.connect(filterR1, 1, 0); // Ambil channel kanan
                                filterR1.connect(filterR2);
                                filterR2.connect(merger, 0, 1); // Masukkan ke kanan merger

                                lastNode = merger;
                                spatialSourceNode.start(0);
                            } else {
                                spatialSourceNode.start(0);
                            }


                            if (isSpatial) {
                                // Apply captured spatial events to the PannerNode
                                for (let ev of spatialEvents) {
                                    let mappedValue = ((ev.val - 64) / 64) * 10;

                                    if (ev.cc === 20) {
                                        if (isSpatialInterpolation) {
                                            panner.positionY.linearRampToValueAtTime(mappedValue, ev.time);
                                        } else {
                                            panner.positionY.setValueAtTime(mappedValue, ev.time);
                                        }
                                    } else if (ev.cc === 21) {
                                        if (isSpatialInterpolation) {
                                            panner.positionZ.linearRampToValueAtTime(mappedValue, ev.time);
                                        } else {
                                            panner.positionZ.setValueAtTime(mappedValue, ev.time);
                                        }
                                    }
                                }

                                if (!panner) {
                                    panner = offlineCtx.createPanner();
                                    panner.panningModel = 'HRTF';
                                    panner.distanceModel = 'inverse';
                                    panner.positionX.setValueAtTime(0, 0);
                                    panner.positionY.setValueAtTime(0, 0);
                                    panner.positionZ.setValueAtTime(0, 0);
                                }

                                lastNode.connect(panner);
                                panner.connect(offlineCtx.destination);
                            } else {
                                lastNode.connect(offlineCtx.destination);
                            }

                            offlineCtx.startRendering().then(renderedBuffer => {
                                const wavBlob = this.audioBufferToWav(renderedBuffer);
                                this.emit('onRenderComplete', wavBlob);
                                resolve(wavBlob);
                            });
                        } else {
                            const wavBlob = this._chunksToWav(chunks, totalLength, sampleRate, channels);
                            this.emit('onRenderComplete', wavBlob);
                            resolve(wavBlob);
                        }
                        return;
                    }
                    iterations++;
                }

                currentTime = this.c.getTime(renderSongPtr);
                const progress = totalTime > 0 ? Math.min(100, Math.max(0, (currentTime / totalTime) * 100)) : 0;
                this.emit('onRenderProgress', progress);

                setTimeout(processChunk, 0); // Yield to main thread
            };

            processChunk();
        });
    }

    /**
     * Resumes the audio context and playback.
     * @returns {Promise<void>} A promise that resolves when the context is running.
     */
    async resume() {
        if (!this.audioContext) return Promise.resolve();

        const onResumed = () => {
            // Hanya jalankan logika play jika ada lagu yang dimuat
            if (this.songPtr !== 0) {
                if (!this.isPlaying) this.emit('onPlay');
                else this.emit('onResume');
                this.isPlaying = true;
                this.isPaused = false;
            }
        };

        if (this.audioContext.state === 'suspended') {
            return this.audioContext.resume().then(onResumed);
        } else {
            onResumed();
            return Promise.resolve();
        }
    }

    /**
     * Pauses the playback without unloading the song.
     */
    pause() {
        if (!this.audioContext || this.songPtr === 0) return;

        this.isPaused = true;
        this.emit('onPause');
    }

    /**
     * Stops the playback, frees the loaded song from memory, and resets the player state.
     */
    stop() {
        if (this.songPtr !== 0) {
            if (this.playingInterval) {
                cancelAnimationFrame(this.playingInterval);
                clearInterval(this.playingInterval);
            }
            this.playingInterval = null;
            this.c.freeSong(this.songPtr);
            this.songPtr = 0;

            if (this.currentStreamPtr) { // This stream is owned by the song, but we close it just in case.
                this.c.closeStream(this.currentStreamPtr); 
                this.currentStreamPtr = 0;
            }
            if (this.currentMidiDataPtr) {
                this.Module._free(this.currentMidiDataPtr);
                this.currentMidiDataPtr = 0;
            }
            if (this.currentOptionsPtr) {
                this.Module._free(this.currentOptionsPtr);
                this.currentOptionsPtr = 0;
            }
            this.isPaused = false;
            this.isPlaying = false;
            this.emit('onStop');
            // After stopping a song, the real-time synth might also be affected if it shares resources.
            // We re-initialize it to ensure it's ready for the next input, which is crucial
            // for keeping a MIDI controller responsive.
            this.initRealtimeSong();
        }
    }

    /**
     * Completely shuts down the player, stops playback, and releases the WebAudio context.
     * @returns {void}
     */
    shutdown() {
        this.stop();
        this.c.exit(); // Shutdown libTiMidity
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }

    /**
     * Seeks to a specific time within the loaded MIDI song.
     * @param {number} timeInSeconds - The time position to seek to, in seconds.
     */
    seek(timeInSeconds) {
        if (this.songPtr !== 0) {
            this.emit('onSeek', this.c.getCurrentTick(this.songPtr), timeInSeconds);
            this.c.seekSong(this.songPtr, timeInSeconds * 1000);
            this.emit('onSeek', this.c.getCurrentTick(this.songPtr), timeInSeconds);
        }
    }

    /**
     * Sends a MIDI Note On message to the real-time synthesizer.
     * @param {number} channel - The MIDI channel (0-15).
     * @param {number} program - The MIDI program (instrument) number.
     * @param {number} pitch - The MIDI note pitch (0-127).
     * @param {number} [velocity=100] - The note velocity (0-127).
     * @param {Object} [params={}] - Additional note parameters.
     */
    noteOn(channel, program, pitch, velocity = 100, { bank = 0, pan = 64, bend = 8192, modulation = 0, chorus = 0, sustain = 0 } = {}) {
        if (!this.realtimeSongPtr || !this.audioContext || this.audioContext.state === 'closed') return;

        // If realtime synth was freed (e.g. after a stop()), re-initialize it.
        let p = Promise.resolve();
        if (!this.realtimeSongPtr) {
            p = this.initRealtimeSong() || Promise.resolve();
        }

        return p.then(() => { // Ensure realtime song is ready
            if (this.audioContext?.state == 'suspended') {
                this.audioContext.resume();
            }

            // missingProgram could be the missing program number or drum key
            const missingProgram = this.c.noteOn(this.realtimeSongPtr, channel, bank, program, pitch, velocity, pan, bend, modulation, chorus, sustain);

            if (missingProgram > 0) {
                const reqProgram = (channel === 9) ? pitch : program;
                // The required instrument is not loaded. Load it and then retry playing the note.
                return this.setRealtimeInstrument(channel, reqProgram, bank).then(loaded => {
                    if (loaded) {
                        this.c.noteOn(this.realtimeSongPtr, channel, bank, program, pitch, velocity, pan, bend, modulation, chorus, sustain);
                    }
                });
            }
        });
    }

    /**
     * Sends a MIDI Note Off message to the real-time synthesizer.
     * @param {number} channel - The MIDI channel (0-15).
     * @param {number} pitch - The MIDI note pitch (0-127) to stop.
     */
    noteOff(channel, pitch) {
        if (!this.realtimeSongPtr || !this.audioContext || this.audioContext.state !== 'running') {
            return;
        }
        this.c.noteOff(this.realtimeSongPtr, channel, pitch);
    }

    /**
     * Loads and sets an instrument program dynamically for the real-time synth.
     * @param {number} channel - The MIDI channel (0-15).
     * @param {number} program - The instrument program number.
     * @param {number} [bank=0] - The instrument bank number.
     * @returns {Promise<boolean>} True if successfully loaded.
     */
    async setRealtimeInstrument(channel, program, bank = 0) {
        if (!this.realtimeSongPtr) {
            console.warn("Realtime song not initialized, cannot set instrument.");
            return false;
        }

        // This function is the central point for loading patches for the realtime player.
        const isDrum = channel === 9;
        const testProgram = isDrum ? 0 : program;
        const testNote = isDrum ? program : 60;

        // 1. Create a tiny dummy MIDI file in memory to discover which patch file corresponds to this program.
        const midiBytes = [
            0x4D, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x00, 0x78, // MThd
            0x4D, 0x54, 0x72, 0x6B, 0x00, 0x00, 0x00, 0x16, // MTrk (length 22)
            0x00, 0xFF, 0x51, 0x03, 0xFF, 0xFF, 0xFF, // Tempo
            0x00, (0xB0 | (isDrum ? 9 : 0)), 0x00, bank & 0x7F, // Bank Select MSB (Control Change 0)
            0x00, (0xC0 | (isDrum ? 9 : 0)), testProgram & 0x7F, // Program Change
            0x00, (0x90 | (isDrum ? 9 : 0)), testNote & 0x7F, 0x64, // Note On
            0x00, 0xFF, 0x2F, 0x00 // End of Track
        ];
        const dummyMidi = new Uint8Array(midiBytes);
        const dummyMidiPtr = this.Module._malloc(dummyMidi.length);
        this.Module.HEAPU8.set(dummyMidi, dummyMidiPtr);
        const streamPtr = this.c.openMemoryStream(dummyMidiPtr, dummyMidi.length);
        const patchListString = this.c.getRequiredPatches(streamPtr);
        this.c.closeStream(streamPtr);
        this.Module._free(dummyMidiPtr);
        
        // 2. Download the required patch file(s) if they are not already in the virtual filesystem.
        if (patchListString) {
            return this._loadRequiredPatches(patchListString).then(() => {
                // 3. Command the C-side to load the patch into the active realtimeSongPtr instance.
                return this.c.loadProgram(this.realtimeSongPtr, bank, program, isDrum) === 0;
            });
        }
        return Promise.resolve(false);
    }

    /**
     * Loads and sets an instrument program dynamically for the main song player.
     * This is crucial for ensuring instruments changed via the UI are available for playback.
     * @param {number} channel - The MIDI channel (0-15).
     * @param {number} program - The instrument program number.
     * @param {number} [bank=0] - The instrument bank number.
     * @returns {Promise<boolean>} True if successfully loaded.
     */
    async loadInstrumentForSong(channel, program, bank = 0) {
        if (!this.songPtr) {
            // This can happen if no song is loaded yet. It's not a critical error,
            // as the instrument will be loaded when the song is loaded.
            return Promise.resolve(true);
        }

        const isDrum = channel === 9;
        const testProgram = isDrum ? 0 : program;
        const testNote = isDrum ? program : 60;

        // This logic is identical to setRealtimeInstrument, but targets songPtr
        const midiBytes = [
            0x4D, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x00, 0x78,
            0x4D, 0x54, 0x72, 0x6B, 0x00, 0x00, 0x00, 0x16,
            0x00, 0xFF, 0x51, 0x03, 0xFF, 0xFF, 0xFF,
            0x00, (0xB0 | (isDrum ? 9 : 0)), 0x00, bank & 0x7F,
            0x00, (0xC0 | (isDrum ? 9 : 0)), testProgram & 0x7F,
            0x00, (0x90 | (isDrum ? 9 : 0)), testNote & 0x7F, 0x64,
            0x00, 0xFF, 0x2F, 0x00
        ];
        const dummyMidi = new Uint8Array(midiBytes);
        const dummyMidiPtr = this.Module._malloc(dummyMidi.length);
        this.Module.HEAPU8.set(dummyMidi, dummyMidiPtr);
        const streamPtr = this.c.openMemoryStream(dummyMidiPtr, dummyMidi.length);
        const patchListString = this.c.getRequiredPatches(streamPtr);
        this.c.closeStream(streamPtr);
        this.Module._free(dummyMidiPtr);
        return this._loadRequiredPatches(patchListString).then(() => this.c.loadProgram(this.songPtr, bank, program, isDrum) === 0);
    }

    /**
     * Broadcasts a general MIDI event (like Pitch Bend, CC) to the active synthesizers.
     * @param {number} eventType - The Timidity event type constant.
     * @param {number} channel - The MIDI channel.
     * @param {number} a - The first parameter of the event.
     * @param {number} [b=0] - The second parameter of the event.
     */
    sendEvent(eventType, channel, a, b = 0) {
        // Disabled during offline rendering to avoid corrupting the output.
        if (typeof OfflineAudioContext !== 'undefined' && this.audioContext instanceof OfflineAudioContext) {
            return;
        }

        // Send event to BOTH realtime and main song so it affects any active voices on that channel
        if (this.realtimeSongPtr !== 0) {
            this.c.sendEvent(this.realtimeSongPtr, eventType, channel, a, b);
        }
        if (this.songPtr !== 0) {
            this.c.sendEvent(this.songPtr, eventType, channel, a, b);
        }
    }

    /**
     * Processes a raw Web MIDI API message and routes it to the real-time synthesizer.
     * Automatically handles Note On, Note Off, Pitch Bend, and various Control Changes.
     * @param {number} selectedChannel - The active channel selected in the UI.
     * @param {number} bank - The active bank.
     * @param {number} program - The active program (instrument).
     * @param {MIDIMessageEvent} event - The Web MIDI API event object.
     * @param {boolean} [sendBack=false] - If true, emits the event back to UI listeners for visual feedback.
     */
    sendMessage(selectedChannel, bank, program, event, sendBack = false) {
        // Extract command from the MIDI status byte
        const command = event.data[0] >> 4;

        // Gunakan channel yang dipilih di UI, jangan abaikan input jika channel aslinya berbeda
        const channel = selectedChannel;

        const note = event.data[1];
        const velocity = (event.data.length > 2) ? event.data[2] : 0;

        switch (command) {
            case 9: // Note On
                if (velocity > 0) {
                    player.noteOn(channel, program, note, velocity, { bank: bank });
                } else {
                    player.noteOff(channel, note);
                }
                break;
            case 8: // Note Off
                player.noteOff(channel, note);
                break;
            case 14: // Pitch Bend
                player.sendEvent(player.ME_PITCHWHEEL, channel, event.data[1], event.data[2]);
                break;
            case 11: // Control Change
                const cc = event.data[1];
                const val = event.data[2];
                if (cc === 7) { // Volume
                    player.sendEvent(player.ME_MAINVOLUME, channel, val);
                } else if (cc === 10) { // Pan
                    player.sendEvent(player.ME_PAN, channel, val);
                } else if (cc === 64) { // Sustain
                    player.sendEvent(player.ME_SUSTAIN, channel, val);
                } else if (cc === 11) { // Expression
                    player.sendEvent(player.ME_EXPRESSION, channel, val);
                }
                break;
        }

        if (sendBack) {
            if (command === 9) { // Note On
                if (velocity > 0) {
                    this.emit('onNoteOn', { tick: 0, channel: channel, pitch: note, velocity: velocity });
                } else {
                    this.emit('onNoteOff', { tick: 0, channel: channel, pitch: note });
                }
            } else if (command === 8) { // Note Off
                this.emit('onNoteOff', { tick: 0, channel: channel, pitch: note });
            }
        }
    }

    /**
     * Attempts to seek playback to a specific tick position.
     * Uses the parsed tempo map to convert ticks to absolute time in seconds.
     * @param {number} ticks - The target tick position.
     */
    goTo(ticks) {
        if (this.noTempoMap()) {
            this.emit('onError', 'Cannot seek to ticks. Tempo map is not available.');
            return;
        }

        let lastEvent = this.tempoMap.timeMap[0];
        for (const ev of this.tempoMap.timeMap) {
            if (ev.tick > ticks) break;
            lastEvent = ev;
        }

        const deltaTicks = ticks - lastEvent.tick;
        const deltaTimeSec = (deltaTicks / this.tempoMap.division) * (lastEvent.mpqn / 1000000);
        const targetTimeSec = lastEvent.timeSec + deltaTimeSec;

        this.seek(targetTimeSec);
    }

    /**
     * Converts a time in seconds to an approximate tick position with interpolation.
     * This is useful for DAW playhead synchronization.
     * @param {number} seconds - The time in seconds.
     * @returns {number} The approximate tick position (float).
     */
    timeToTick(seconds) {
        if (this.noTempoMap()) {
            // Cannot convert time to ticks without a tempo map.
            return 0;
        }

        let lastEvent = this.tempoMap.timeMap[0];
        for (const ev of this.tempoMap.timeMap) {
            if (ev.timeSec > seconds) break;
            lastEvent = ev;
        }

        const deltaTimeSec = seconds - lastEvent.timeSec;
        const deltaTicks = (deltaTimeSec * 1000000 / lastEvent.mpqn) * this.tempoMap.division;
        return lastEvent.tick + deltaTicks;
    }

    /**
     * Converts a MIDI tick into an absolute beat number (e.g. for a metronome).
     * @param {number} tick - The absolute tick position.
     * @returns {number} The absolute beat number (e.g., 0.5, 1.0, 16.0).
     */
    tickToBeat(tick) {
        if (this.noTempoMap()) return 0;
        let lastSig = this.tempoMap.measureMap[0];
        for (const sig of this.tempoMap.measureMap) {
            if (sig.tick > tick) break;
            lastSig = sig;
        }
        const deltaTicks = tick - lastSig.tick;
        const elapsedBeats = deltaTicks / lastSig.ticksPerBeat;
        return lastSig.absBeat + elapsedBeats;
    }

    /**
     * Converts a MIDI tick into a measure number (e.g. for vocal training sync).
     * @param {number} tick - The absolute tick position.
     * @returns {number} The absolute measure number (1-indexed).
     */
    tickToMeasure(tick) {
        if (this.noTempoMap()) return 1;
        let lastSig = this.tempoMap.measureMap[0];
        for (const sig of this.tempoMap.measureMap) {
            if (sig.tick > tick) break;
            lastSig = sig;
        }
        const deltaTicks = tick - lastSig.tick;
        const elapsedBeats = deltaTicks / lastSig.ticksPerBeat;
        const elapsedMeasures = elapsedBeats / lastSig.num;
        return lastSig.measure + elapsedMeasures;
    }

    /**
     * Checks if a specific MIDI tick aligns with a metronome click.
     * @param {number} tick - The absolute tick position.
     * @returns {Object|null} Metronome data { isClick, isDownbeat, beatNumber, measure } or null if invalid.
     */
    getMetronome(tick) {
        if (this.noTempoMap()) return null;
        let lastSig = this.tempoMap.measureMap[0];
        for (const sig of this.tempoMap.measureMap) {
            if (sig.tick > tick) break;
            lastSig = sig;
        }

        const deltaTicks = tick - lastSig.tick;
        const ticksPerBeat = lastSig.ticksPerBeat;

        // Use a small epsilon for floating point inaccuracies if ticksPerBeat is fractional
        const beatOffset = deltaTicks % ticksPerBeat;
        const isClick = (beatOffset === 0 || Math.abs(beatOffset - ticksPerBeat) < 0.001 || beatOffset < 0.001);

        if (!isClick) {
            return { isClick: false };
        }

        const elapsedBeats = Math.round(deltaTicks / ticksPerBeat);
        const beatNumber = (elapsedBeats % lastSig.num) + 1;
        const isDownbeat = (beatNumber === 1);

        return {
            isClick: true,
            isDownbeat: isDownbeat,
            beatNumber: beatNumber,
            measure: lastSig.measure + Math.floor(elapsedBeats / lastSig.num)
        };
    }

    /**
     * Checks whether the tempo map is unavailable.
     *
     * @returns {boolean} true if tempoMap does not exist
     *          or does not contain a measureMap, false otherwise.
     */
    noTempoMap() {
        return !this.tempoMap || !this.tempoMap.measureMap;
    }

    /**
     * Gets the parsed tempo map of the currently loaded MIDI song.
     * @returns {Object|null} The tempo map object containing { division, timeMap }, or null if no song is loaded.
     */
    getTempoMap() {
        return this.tempoMap || null;
    }

    /**
     * Sets the master volume of the loaded song.
     * @param {number} volume - The volume level (usually 0 to 100 or 0 to 127 depending on TiMidity internal scaling).
     */
    setVolume(volume) {
        if (this.songPtr !== 0) {
            this.c.setVolume(this.songPtr, volume); // Set volume (0-100)
        }
    }

    /**
     * Converts a Web Audio API AudioBuffer into a WAV file blob.
     * @param {AudioBuffer} buffer - The AudioBuffer to convert.
     * @returns {Blob} The generated WAV file as a Blob.
     */
    audioBufferToWav(buffer) {
        // Implementation from: https://github.com/mattdiamond/Recorderjs
        function interleave(inputL, inputR) {
            let length = inputL.length + inputR.length;
            let result = new Float32Array(length);
            let index = 0, inputIndex = 0;
            while (index < length) {
                result[index++] = inputL[inputIndex];
                result[index++] = inputR[inputIndex];
                inputIndex++;
            }
            return result;
        }

        function floatTo16BitPCM(output, offset, input) {
            for (let i = 0; i < input.length; i++, offset += 2) {
                let s = Math.max(-1, Math.min(1, input[i]));
                output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            }
        }

        function writeString(view, offset, string) {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        }

        const interleaved = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
        const dataView = new DataView(new ArrayBuffer(44 + interleaved.length * 2));

        writeString(dataView, 0, 'RIFF');
        dataView.setUint32(4, 36 + interleaved.length * 2, true);
        writeString(dataView, 8, 'WAVE');
        writeString(dataView, 12, 'fmt ');
        dataView.setUint32(16, 16, true);
        dataView.setUint16(20, 1, true);
        dataView.setUint16(22, 2, true);
        dataView.setUint32(24, buffer.sampleRate, true);
        dataView.setUint32(28, buffer.sampleRate * 4, true);
        dataView.setUint16(32, 4, true);
        dataView.setUint16(34, 16, true);
        writeString(dataView, 36, 'data');
        dataView.setUint32(40, interleaved.length * 2, true);
        floatTo16BitPCM(dataView, 44, interleaved);

        return new Blob([dataView], { type: 'audio/wav' });
    }

    /**
     * Exports audio stems by iteratively rendering selected tracks offline.
     * @param {number[]} trackList - Array of track numbers to export. If null/empty, exports all tracks.
     * @param {Object} options - Options to pass to renderOffline (e.g., { sampleRate: 44100, monoToStereo: true }).
     * @param {Function} callback - Callback function(wavBlob, trackIndex) executed after each stem is rendered.
     * @returns {Promise<void>} Resolves when all requested stems are exported.
     */
    exportStems(trackList, options = {}, callback) {
        let tracksToExport = trackList;

        if (!tracksToExport || tracksToExport.length === 0) {
            const totalTracks = (this.tempoMap && this.tempoMap.tracksCount) ? this.tempoMap.tracksCount : 1;
            tracksToExport = Array.from({ length: totalTracks }, (_, i) => i);
        }

        let p = Promise.resolve();
        for (let i = 0; i < tracksToExport.length; i++) {
            p = p.then(() => {
                const track = tracksToExport[i];
                const renderOptions = Object.assign({}, options, { soloTrack: track });

                return this.renderOffline(renderOptions).then(wavBlob => {

                    if (callback && typeof callback === 'function') {
                        callback(wavBlob, track);
                    }
                });
            });
        }
        return p;
    }

    /**
     * Formats a time in seconds into a human-readable string (e.g., M:SS or H:MM:SS).
     * @param {number} seconds - The time in seconds to format.
     * @param {boolean} [withMiliSecond=false] - Whether to include milliseconds in the output.
     * @returns {string} The formatted time string.
     */
    formatTime(seconds, withMiliSecond = false) {
        if (isNaN(seconds) || seconds < 0) {
            if (withMiliSecond) return "0:00.000";
            else return "0:00";
        }

        let mills = String(Math.floor((seconds % 1) * 1000)).padStart(3, '0');

        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        let formatedTime = '';

        if (hrs > 0) {
            formatedTime = `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else {
            formatedTime = `${mins}:${secs.toString().padStart(2, '0')}`;
        }
        if (withMiliSecond) {
            formatedTime += `.${mills}`;
        }
        return formatedTime;
    }

    /**
     * Waits for the WebAssembly runtime to be fully initialized.
     * @private
     * @returns {Promise<void>}
     */
    _waitForRuntime() {
        return new Promise((resolve) => { //NOSONAR
            const check = () => {
                if (this.Module.timidityReady) {
                    if (!this.c) this._onRuntimeInitialized();
                    resolve();
                } else {
                    setTimeout(check, 50);
                }
            };
            check();
        });
    }

    /**
     * Loads and parses timidity.cfg to extract bank and drumset information.
     */
    async _loadTimidityCfg() {
        if (this._cfgData) return Promise.resolve(this._cfgData);
        return fetch(`${this.patchUrlBase}/timidity.cfg`)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                return response.text();
            })
            .then(text => {

                const banks = new Map();
                const drums = new Map();

                let currentMode = 'bank';
                let currentId = 0;

                const lines = text.split('\n');
                for (let line of lines) {
                    line = line.replace(/#.*/, '').trim(); // Remove comments
                    if (!line) continue;

                    const parts = line.split(/\s+/);
                    if (parts[0] === 'bank') {
                        currentMode = 'bank';
                        currentId = parseInt(parts[1], 10);
                    } else if (parts[0] === 'drumset') {
                        currentMode = 'drumset';
                        currentId = parseInt(parts[1], 10);
                    } else if (parts[0] === 'dir' || parts[0] === 'source') {
                        // Ignore directory and source directives
                    } else if (!isNaN(parseInt(parts[0], 10))) {
                        const id = parseInt(parts[0], 10);
                        const file = parts.slice(1).join(' ');

                        if (currentMode === 'bank') {
                            if (!banks.has(currentId)) banks.set(currentId, []);
                            banks.get(currentId).push({ id: id, file: file });
                        } else if (currentMode === 'drumset') {
                            if (!drums.has(currentId)) drums.set(currentId, []);
                            drums.get(currentId).push({ id: id, file: file });
                        }
                    }
                }

                this._cfgData = { banks, drums };
                return this._cfgData;
            })
            .catch(e => {
                console.error("Failed to load timidity.cfg:", e);
                return { banks: new Map(), drums: new Map() };
            });
    }

    /**
     * Returns a list of available bank numbers.
     * @returns {Promise<number[]>} Array of bank IDs.
     */
    async getBankList() {
        return this._loadTimidityCfg().then(data => {
            return Array.from(data.banks.keys()).sort((a, b) => a - b);
        });
    }

    /**
     * Returns a list of instruments in the specified bank.
     * @param {number} bank - The bank number.
     * @returns {Promise<Array<{id: number, file: string}>>} List of instruments.
     */
    async getInstrumentList(bank) {
        return this._loadTimidityCfg().then(data => {
            const list = data.banks.get(bank) || [];
            return list.sort((a, b) => a.id - b.id);
        });
    }

    /**
     * Returns a list of drum instruments in the specified drumset (bank).
     * @param {number} bank - The drumset bank number.
     * @returns {Promise<Array<{id: number, file: string}>>} List of drums.
     */
    async getDrumList(bank) {
        return this._loadTimidityCfg().then(data => {
            const list = data.drums.get(bank) || [];
            return list.sort((a, b) => a.id - b.id);
        });
    }

    /**
     * 
     * @returns Update song duration
     * @returns {number} Las calculate song duration
     */
    updateSongDuration() {
        // Prioritas 1: nilai akurat dari tempoMap JS
        if (this.tempoMap && typeof this.tempoMap.totalSeconds === 'number' && this.tempoMap.totalSeconds > 0) {
            this.totalDuration = this.tempoMap.totalSeconds;
            return this.totalDuration;
        }
        // Fallback: nilai dari C (mungkin stale setelah updateEvents)
        this.totalDuration = this.c.getTotalTime(this.songPtr) / 1000;
        return this.totalDuration;
    }
}
