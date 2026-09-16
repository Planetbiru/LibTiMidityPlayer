# TimidityPlayer API Reference

`TimidityPlayer` is a high-level JavaScript class that provides an interface to the libTiMidity WebAssembly module. It handles MIDI playback, real-time MIDI input, audio context management, patch downloading, and offline audio rendering.

## Constructor

### `new TimidityPlayer(options)`
Creates a new instance of the TimidityPlayer.
- **Parameters:**
  - `options` *(Object)*: Configuration options.
    - `options.patchUrlBase` *(string)*: Base URL path for loading GUS patches and `timidity.cfg` (e.g., `'gus-patch'`).
    - `options.buffserSize` *(number)*: Buffer size for audio processing. Default value is 4096. 
      **Note**: A larger buffer size increases stability and reduces glitches, but it also introduces more latency, making real-time response (e.g., when playing notes from a MIDI controller) slower.
    - `options.bufferSizeRealtime` *(number)* - Buffer size for realtime event (e.g noteOn). Default value is 1024
    - `options.sampleRate` *(number)*: Sample rate to render PCM. Default value is 44100.

---

## Event Emitter Methods

The player exposes an internal event emitter that broadcasts state changes and MIDI events. Two registration styles are supported and are fully equivalent:

1. **Generic form:** `player.on(eventName, listener)` — the classic, explicit API.
2. **Shorthand form:** `player.onXxx(listener)` — a convenient proxy that forwards to `on('onXxx', listener)`.

### `on(eventName, listener)`
Registers a callback function for a specific event.
- **Parameters:**
  - `eventName` *(string)*: The name of the event, including the `on` prefix (e.g., `'onError'`, `'onMidiLoaded'`).
  - `listener` *(Function)*: Callback to execute when the event fires.

### `onXxx(listener, ...extraArgs)` — Shorthand
Dynamically generated for every supported event. Calling `player.onError(cb)` is exactly equivalent to `player.on('onError', cb)`.

The shorthand is implemented via a `Proxy` on the instance. Any property access that:
- starts with `"on"`, **and**
- is **not already defined** on the player,

is treated as an event registration function. It returns a function that forwards its arguments to `on(eventName, ...args)`.

- **Parameters:**
  - `listener` *(Function)*: Callback to execute when the event fires.
  - `...extraArgs` *(any)*: Optional additional arguments passed through to `on()` (reserved for future use, e.g. `{ once: true }`).
- **Returns:** `undefined`

> **Note:** The `Proxy` only intercepts properties that do **not** already exist on the instance. Existing methods such as `on`, `once` (if you add one), `onRuntimeInitialized` (if set as a real property), or any future method whose name starts with `on` will **not** be shadowed.

> **Note:** Because the shorthand is generated on-the-fly, it is not enumerable and does not appear in `Object.keys(player)`. Use the generic `on()` form if you need to iterate over registered handlers.

### `emit(eventName, ...args)`
Manually emits an event, invoking all registered listeners with the supplied arguments.
- **Parameters:**
  - `eventName` *(string)*: The event name (with the `on` prefix).
  - `...args` *(any)*: Arguments forwarded to each listener.

---

#### Supported Events

Events are listed in `onXxx` form. The equivalent generic name is `'onXxx'` (e.g., `player.onError(cb)` ⇔ `player.on('onError', cb)`).

| Event | Arguments | Description |
|---|---|---|
| `onRuntimeInitialized` | *(none)* | Fired when the WASM runtime reports it is ready (before `onInit`). |
| `onInit` | *(none)* | Fired when the WebAudio context and WASM engine are initialized. |
| `onMidiLoading` | `(midi)` | Fired when a MIDI file starts loading. |
| `onMidiLoaded` | `(midi, duration)` | Fired when a MIDI file has been fully loaded and parsed. |
| `onMidiUpdated` | `(midi)` | Fired after `updateMidiData()` succeeds. |
| `onInstrumentLoading` | `(loadedCount, totalCount, filename)` | Fired while downloading required patch files. |
| `onInstrumentLoaded` | `(totalCount)` | Fired when all required patches have been successfully downloaded. |
| `onPlay` | *(none)* | Fired when playback starts. |
| `onPause` | *(none)* | Fired when playback is paused. |
| `onResume` | *(none)* | Fired when playback resumes after a pause. |
| `onStop` | *(none)* | Fired when playback is stopped and the song is unloaded. |
| `onEnded` | *(none)* | Fired when the song reaches its end naturally. |
| `onPlaying` | `(tick, timeInSeconds)` | Fired periodically during playback to report progress. |
| `onSeek` | `(tick, timeInSeconds)` | Fired when the playback position is manually shifted. Emitted twice per `seek()` call (before and after the engine seek). |
| `onRenderStart` | *(none)* | Fired when offline rendering starts. |
| `onRenderProgress` | `(progressPercent)` | Fired during offline rendering. |
| `onRenderComplete` | `(wavBlob)` | Fired when offline rendering finishes. |
| `onNoteOn` | `({tick, channel, pitch, velocity})` | Fired for Note On events. |
| `onNoteOff` | `({tick, channel, pitch})` | Fired for Note Off events (and Note On with velocity 0). |
| `onMidiEvent` | `({tick, timeSecond, status, eventType, channel, a, b, text})` | Fired for **every** MIDI event processed by the engine. |
| `onError` | `(message)` | Fired when an internal error occurs. |

---

#### Examples

```js
const player = new TimidityPlayer({ patchUrlBase: 'gus-patch' });
await player.init();

// Shorthand form
player.onInit(() => console.log('ready'));
player.onError(err => console.error(err));
player.onMidiLoaded((midi, duration) => console.log('duration', duration));
player.onNoteOn(({ pitch, velocity }) => console.log('note', pitch, velocity));

// Generic form — exactly equivalent
player.on('onInit', () => console.log('ready'));
player.on('onError', err => console.error(err));

// Listeners receive any number of arguments passed by emit()
player.onMidiEvent(ev => {
    console.log(ev.tick, ev.channel, ev.eventType, ev.a, ev.b);
});

// Manual emit (rarely needed; listeners will fire synchronously)
player.emit('onError', new Error('custom'));
```

---

## Initialization & Lifecycle

### `init(offline = false)`
Initializes the WebAudio context and the libTiMidity engine. Must be called before loading or playing any MIDI files.
- **Parameters:**
  - `offline` *(boolean)*: If `true`, creates an `OfflineAudioContext` for rendering without audio playback.
- **Returns:** `Promise<boolean>` - `true` if initialization was successful.

### `shutdown()`
Completely shuts down the player, stops playback, frees memory, and closes the WebAudio context.

---

## Playback & Controls

### `load(midi)`
Loads a MIDI file into the player and automatically analyzes and downloads the required patches.
- **Parameters:**
  - `midi` *(File | Uint8Array)*: The MIDI file data.
- **Returns:** `Promise<boolean>` - `true` if loaded successfully.

### `play(offset = 0, options = {})`
Starts or resumes playback of the currently loaded MIDI song.
- **Parameters:**
  - `offset` *(number)*: Time offset in seconds to start playing from.
  - `options` *(Object)*: Additional playback configuration. *(Note: Currently in `timidity-player.js`, this object is empty and reserved for future use. No specific properties are implemented yet.)*

### `loadAndPlay(midi, offset = 0, options = {})`
Convenience method to sequentially call `load()` and `play()`.
- **Parameters:**
  - `midi` *(File | Uint8Array)*: The MIDI file data.
  - `offset` *(number)*: Time offset in seconds.
  - `options` *(Object)*: Additional playback configuration.
- **Returns:** `Promise<void>`

### `pause()` / `resume()` / `stop()`
Controls the playback state. `stop()` will also free the currently loaded song from memory.

### `updateMidiData(midi)`
Updates the currently playing MIDI data on-the-fly without stopping playback. The player will seamlessly transition to the new event list from its current time.
- **Parameters:**
  - `midi` *(File | Uint8Array)*: The new MIDI file data to load.
- **Returns:** `Promise<boolean>` - `true` if the update was successful.

### `pause()` / `resume()` / `stop()`
Controls the playback state. `stop()` will also free the currently loaded song from memory.

### `seek(timeInSeconds)`
Seeks to a specific time position within the currently loaded MIDI song.
- **Parameters:**
  - `timeInSeconds` *(number)*: The absolute target time in seconds.

### `goTo(ticks)`
Seeks to a specific MIDI tick position. This method parses the MIDI tempo map internally to accurately calculate the corresponding absolute time in seconds.
- **Parameters:**
  - `ticks` *(number)*: The absolute target tick position.

### `setVolume(volume)`
Sets the master volume of the loaded song.
- **Parameters:**
  - `volume` *(number)*: The volume level (0 to 100).

### `setTranspose(semitones)`
Sets the global pitch transpose.
- **Parameters:**
  - `semitones` *(number)*: The number of semitones to shift (-12 to +12).

### `setChannelMute(channel, mute)`
Mutes or unmutes a specific MIDI channel.
- **Parameters:**
  - `channel` *(number)*: MIDI channel (0-15).
  - `mute` *(boolean)*: `true` to mute, `false` to unmute.

### `setTrackMute(track, mute)`
Mutes or unmutes a specific MIDI track.
- **Parameters:**
  - `track` *(number)*: MIDI track index (0-255).
  - `mute` *(boolean)*: `true` to mute, `false` to unmute.

### `panic()`
Instantly kills all currently sounding notes across all channels.

---

## Real-time Synthesizer (MIDI Input)

### `noteOn(channel, program, pitch, velocity = 100, params = {})`
Sends a MIDI Note On message. Dynamically downloads the instrument patch if it hasn't been loaded yet.
- **Parameters:**
  - `channel` *(number)*: MIDI channel (0-15).
  - `program` *(number)*: Instrument program number (0-127).
  - `pitch` *(number)*: MIDI pitch/note (0-127).
  - `velocity` *(number)*: Note velocity (0-127). Default is `100`.
  - `params` *(Object)*: Optional parameters to control the instrument's initial state.
    - `params.bank` *(number)*: Instrument bank number. Default is `0`.
    - `params.pan` *(number)*: Panning (0-127). Default is `64` (center).
    - `params.bend` *(number)*: Pitch bend (0-16383). Default is `8192` (center).
    - `params.modulation` *(number)*: Modulation wheel (0-127). Default is `0`.
    - `params.chorus` *(number)*: Chorus depth (0-127). Default is `0`.
    - `params.sustain` *(number)*: Sustain pedal (0-127). Default is `0`.

### `noteOff(channel, pitch)`
Sends a MIDI Note Off message.

### `sendEvent(eventType, channel, a, b = 0)`
Broadcasts a general MIDI event to the active synthesizer.
- **Parameters:**
  - `eventType` *(number)*: Internal TiMidity event constant (e.g., `this.ME_PITCHWHEEL`).

---

## Data & Information

### `getInfo()`
Gets metadata and information about the currently loaded song.
- **Returns:** `Object | null` - Parsed JSON object containing song info (title, copyright, text events, etc.).

### `getTempoMap()`
Gets the parsed tempo map of the currently loaded MIDI song.
- **Returns:** `Object | null` - An object containing the MIDI `division` (ticks per beat) and a `timeMap` array (`[{tick, timeSec, mpqn}]`), or `null` if no song is loaded.

### `tickToBeat(tick)`
Converts a MIDI tick into an absolute beat number (useful for syncing metronomes).
- **Parameters:**
  - `tick` *(number)*: The absolute tick position.
- **Returns:** `number` - The absolute beat count (e.g., `0.5`, `1.0`, `16.0`).

### `tickToMeasure(tick)`
Converts a MIDI tick into a measure/bar number (useful for vocal training or DAW measure sync).
- **Parameters:**
  - `tick` *(number)*: The absolute tick position.
- **Returns:** `number` - The absolute measure count (1-indexed).

### `getMetronome(tick)`
Checks if a specific MIDI tick aligns exactly with a metronome click.
- **Parameters:**
  - `tick` *(number)*: The absolute tick position.
- **Returns:** `Object | null` - Metronome state at this tick: `{ isClick: boolean, isDownbeat?: boolean, beatNumber?: number, measure?: number }`, or `null` if invalid.

### `getActiveVoices()`
- **Returns:** `number` - The number of currently active polyphony voices.

### `getControllerValueAtTick(channel, cc, tick)`
- **Returns:** `number` - The controller value (0-127) at the exact tick position.

---

## Configuration & Patches

These methods read directly from the `timidity.cfg` file located at `patchUrlBase`.

### `getBankList()`
- **Returns:** `Promise<number[]>` - A sorted array of available bank IDs.

### `getInstrumentList(bank)`
- **Parameters:**
  - `bank` *(number)*: The target bank ID.
- **Returns:** `Promise<Array<{id: number, file: string}>>` - A sorted array of instrument objects containing the program `id` and the patch `file` or name.

### `getDrumList(bank)`
- **Parameters:**
  - `bank` *(number)*: The target drumset bank ID.
- **Returns:** `Promise<Array<{id: number, file: string}>>` - A sorted array of drum instrument objects.

---

## Utilities

### `renderOffline(options = {})`
Renders the currently loaded MIDI song to a WAV file offline (without playing it over speakers). Yields progress via the `onRenderProgress` event.
- **Parameters:**
  - `options` *(Object)*: Configuration options for rendering.
    - `options.sampleRate` *(number)*: The target sample rate (default `44100`).
    - `options.isMono` *(boolean)*: If true, forces audio to 1 channel and sets all CC pan events to center (default `false`).
    - `options.isSpatial` *(boolean)*: If true, applies 3D spatial audio processing using Web Audio `PannerNode` based on CC 20 (Y/Height) and CC 21 (Z/Depth) events. Forces `isMono` to false (default `false`).
    - `options.isSpatialInterpolation` *(boolean)*: If true, smoothly interpolates the spatial coordinates between CC events (default `false`).
    - `options.monoToStereo` *(boolean)*: If true, applies stereo widening (Spectral Panning / EQ) to the final output.
    - `options.monoToStereoWeight` *(number)*: The intensity of the stereo widening effect (gain in dB) (default `5`).
    - `options.soloTrack` *(number)*: If set to a valid track number, mutes all other tracks during rendering (default `-1`).
- **Returns:** `Promise<Blob>` - The generated WAV file as a `Blob`.

### `exportStems(trackList, options = {}, callback)`
Exports audio stems by iteratively rendering selected tracks offline. For each track, it solos the track, renders the full song duration, and calls the callback with the resulting WAV file. The `onRenderProgress` event will still fire repeatedly for each stem rendering cycle.
- **Parameters:**
  - `trackList` *(number[])*: Array of track numbers to export. If null or an empty array is provided, it defaults to exporting all parsed tracks in the MIDI file.
  - `options` *(Object)*: Configuration options passed directly to `renderOffline` (e.g., `{ monoToStereo: true }`).
  - `callback` *(Function)*: A function called after each stem completes. Signature: `callback(wavBlob, trackIndex)`.
- **Returns:** `Promise<void>` - Resolves when all requested stems have been successfully exported.

### `formatTime(seconds, withMiliSecond = false)`
Formats seconds into a human-readable string (e.g., `H:MM:SS` or `M:SS.mmm`).
- **Returns:** `string`

---

## Internal C API (WebAssembly Exports)

The following functions are compiled from C and exported directly to JavaScript via the WebAssembly module (`this.Module`). They are primarily used internally by `TimidityPlayer`.

### `mid_create_options(rate, format, channels, buffer_size)`
Creates a `MidSongOptions` struct dynamically via `malloc` and populates it. This is particularly used for setting up offline rendering audio configurations.
- **Parameters:**
  - `rate` *(number)*: Sample rate (e.g., 44100).
  - `format` *(number)*: Audio format flag (e.g., `0x8010` for `MID_AUDIO_S16LSB`).
  - `channels` *(number)*: Number of channels (`1` for mono, `2` for stereo).
  - `buffer_size` *(number)*: Buffer size in samples.
- **Returns:** `number` - A memory pointer to the allocated `MidSongOptions` struct.
