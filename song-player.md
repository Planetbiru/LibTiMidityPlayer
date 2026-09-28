# SongPlayer Manual

`SongPlayer` extends `TimidityPlayer` with **audio-clip playback**, **simultaneous MIDI + audio**, **repeated playback**, and **offline rendering** (merged or per-track, mono or stereo).

It does not modify `TimidityPlayer`; it adds a layer on top. All existing TimidityPlayer methods (`load`, `play`, `seek`, `setMasterVolume`, `setTranspose`, `sendEvent`, `resume`, `pause`, `stop`, `noteOn`, `noteOff`, `renderOffline`, `getBankList`, …) keep working as documented in the upstream repo.

---

## 1. Loading

```html
<script>window.patchUrlBase = '.../gus-patch';</script>
<script src="timidity-player.js"></script>
<script src="libtimidity.js"></script>
<script src="SongPlayer.js"></script>
```

`window.SongPlayer` is created. Requires the WASM `Module` to be present (i.e. `timidity-player.js` + `libtimidity.js` already loaded).

---

## 2. Quick start

```js
const player = new SongPlayer({
    patchUrlBase: window.patchUrlBase,
    bufferSize: 4096,
    sampleRate: 44100,
});

await player.init();                       // MUST be called from a user gesture

// 1) Register audio assets
await player.loadAudioAssetFromUrl('kick',  '/audio/kick.wav');
await player.loadAudioAssetFromUrl('snare', '/audio/snare.wav');
await player.loadAudioAssetFromUrl('pad',   '/audio/pad.wav');

// 2) Describe your audio tracks
player.setAudioTracks([
  {
    id: 'drums', name: 'Drums', muted: false, solo: false,
    clips: [
      { id: 'k1', audioAssetId: 'kick',  startTick: 0,   trimmedDurationTicks: 240, trimStartOffsetTicks: 0, volume: 1.0 },
      { id: 's1', audioAssetId: 'snare', startTick: 480, trimmedDurationTicks: 240, trimStartOffsetTicks: 0, volume: 0.7 },
    ]
  },
  {
    id: 'pad', name: 'Pad', muted: false, solo: false,
    clips: [{
      id: 'p1', audioAssetId: 'pad',
      startTick: 0, trimmedDurationTicks: 3840, trimStartOffsetTicks: 0,
      volume: 0.6,
      fadeIn:  { enable: true, from: 0.0, to: 0.8, shape: 'easeIn'  },
      fadeOut: { enable: true, from: 3.0, to: 3.8, shape: 'easeOut' }
    }]
  },
]);

// 3) Load MIDI (or skip for audio-only)
await player.load('data:audio/midi;base64,...');

// 4) Play
await player.resume();
await player.play();               // play() is async now — see §3.5
```

---

## 3. API Reference

### 3.1 Constructor

```js
new SongPlayer({ patchUrlBase, bufferSize = 4096, sampleRate = 44100 })
```

Same options as `TimidityPlayer`.

### 3.2 Audio assets

| Method | Description |
|---|---|
| `await loadAudioAsset(id, arrayBuffer, metadata?)` | Decode ArrayBuffer → AudioBuffer, register as `id`. |
| `await loadAudioAssetFromUrl(id, url, metadata?)` | Fetch + decode + register. |
| `setAudioAsset(id, audioBuffer, metadata?)` | Register a pre-decoded AudioBuffer. |
| `getAudioAsset(id)` | Returns the record `{ audioBuffer, ...metadata }`. |
| `removeAudioAsset(id)` | Unregister. |

### 3.3 Audio tracks

```js
player.setAudioTracks([ ... ]);
player.addAudioTrack({ id, name, muted, solo, clips: [...] });
player.clearAudioTracks();
```

Each **track** object:
```js
{
  id,                     // any stable identifier
  name,                   // display name
  muted: false,
  solo:  false,
  clips: [ /* clip objects */ ]
}
```

Each **clip** object:
```js
{
  id,                        // any stable identifier
  audioAssetId,              // must exist in player.audioAssets
  startTick,                 // where the clip begins on the timeline
  trimmedDurationTicks,      // how long the clip plays
  trimStartOffsetTicks,      // offset into the source asset
  volume,                    // 0..1 (default 1)
  fadeIn:  { enable, from, to, shape },  // from/to in SECONDS, clip-relative
  fadeOut: { enable, from, to, shape }   // shape: 'linear' | 'easeIn' | 'easeOut'
}
```

> **Timing convention** — `startTick` and `trimmedDurationTicks` are in **MIDI ticks**. They are converted to seconds using the MIDI tempo map. Fade `from`/`to` are in **seconds relative to the clip's start**.

### 3.4 Song duration

```js
player.getSongDuration(); // → number (seconds)
```

Equal to `max(MIDI duration, end-time of every clip)`. Ensures audio longer than MIDI is never truncated. Works even with **empty MIDI**.

### 3.5 Playback

`play`, `pause`, `stop`, `seek` are overridden to manage audio clips and to support **repeated playback** after a song has finished.

```js
await player.play(offsetSeconds = 0);
player.pause();
player.stop();
player.seek(timeInSeconds);
await player.restart();      // safe restart from 0, reloads MIDI if needed
```

Behaviour:

| Call | Effect |
|---|---|
| `play()` while already playing | No-op (re-entrancy guard prevents the WASM engine freeze). |
| `play()` while paused | Resumes from the last position. Does not reload. |
| `play()` after the song ended | **Reloads the MIDI from cache (`lastMidiData`) automatically**, then starts from `offset` (default 0). |
| `play()` before any MIDI loaded | Logs a warning; only MIDI-driven playback is supported at the moment. |
| `pause()` | Stops MIDI + all audio clips. `resume()` continues both from the current position. |
| `stop()` | Fully stops MIDI (frees the song pointer). Next `play()` will reload. |
| `seek(t)` | Stops all clips, re-enters them from position `t` (offset preserved). |
| `restart()` | If playing → seek(0). If paused → resume + seek(0). If finished → `play(0)` (reloads). |

`play()` returns a `Promise<void>` — `await` it if you need to ensure playback has actually started (recommended after `render()` or after the first user gesture).

> **Repeated-play safety** — calling `play()` twice in a row is safe: the second call is ignored. To replay after completion, just call `play()` again — it will reload the MIDI transparently.

### 3.6 Events

All `TimidityPlayer` events fire normally. `SongPlayer` adds one:

| Event | Payload | Description |
|---|---|---|
| `onSongFinished` | `songTime` (number, seconds) | Emitted **once** when the *entire* song (MIDI **and** the longest audio clip) has finished. Different from `onEnded`, which only signals that the MIDI part ended. |

**Important semantic change vs. the base class:**

- `onEnded` — MIDI is over. **Audio clips keep playing** if their end time exceeds the MIDI duration. Do **not** treat this as end-of-song.
- `onSongFinished` — everything is over. Stop button state, reset UI, etc.

**Listener API** — `on`, `once`, `off`, `offAll`:

```js
// Register
const cb = (tick, sec) => drawPlayhead(sec);
player.on('onPlaying', cb);          // explicit
player.onPlaying(cb);                // proxy — same thing

// Fire once
player.once('onSongFinished', () => toast('Done!'));

// Unregister
player.off('onPlaying', cb);
player.offAll('onPlaying');          // remove all listeners for an event
player.offAll();                     // remove all listeners
```

Listener ordering:

1. `SongPlayer` internal sync (`_syncAudioClips`) — always first, wrapped in `try/catch` so its errors never block your listeners.
2. Your listeners, in registration order.

### 3.7 Virtual clock (post-MIDI audio tail)

When the MIDI ends **before** the last audio clip, `SongPlayer` starts an internal *virtual clock* driven by `AudioContext.currentTime`. From that point on:

- `onPlaying` continues to fire with the correct `songTime` and `tick` (tick computed from the tempo map).
- Audio clips continue to be scheduled and stopped correctly.
- When `songTime >= getSongDuration()`, the clock stops and `onSongFinished` fires.

You don't need to do anything — just listen to `onSongFinished` instead of `onEnded` for "song truly done".

### 3.8 Offline rendering

```js
const blob  = await player.render({ mode: 'merged',    channels: 'stereo', sampleRate: 44100 });
const files = await player.render({ mode: 'per-track', channels: 'mono',   sampleRate: 48000 });
```

Options:

| Option | Values | Default | Description |
|---|---|---|---|
| `mode` | `'merged'` \| `'per-track'` | `'merged'` | Single mixdown file, or one file per track. |
| `sampleRate` | number | `this.sampleRate` | Output sample rate. |
| `bufferSize` | number | `this.bufferSize` | Render buffer size passed to libTiMidity. |
| `channels` | `'stereo'` \| `'mono'` | `'stereo'` | Output channel count. |
| `onProgress` | `(pct, label) => void` | `null` | Progress callback (0..100). |

Return values:

- `mode: 'merged'` → `Promise<Blob>` (a single WAV).
- `mode: 'per-track'` → `Promise<Array<{ type: 'midi' | 'audio', trackIndex, name, blob }>>`.

Behaviour notes:

- Mute / solo is **respected** in `merged` mode.
- `per-track` mode renders each track **independently** (ignoring mute/solo).
- MIDI tracks are rendered via `TimidityPlayer.renderOffline({ soloTrack })`.
- Audio tracks are rendered via a fresh `OfflineAudioContext` per track.
- If the MIDI is empty (or absent), only audio tracks are rendered.
- If a track has no clips, its WAV will just be silent (correct length).

### 3.9 Bundle loader

```js
await player.loadBundle({
    midiContent: 'base64-or-data-uri',
    audioAssetsMetadata: [ { audioAssetId, fileExtension, ... } ],
    audioTracksMetadata: [ { id, name, muted, solo, audioClips: [...] } ],
    assetFetcher: async (meta) => await (await fetch(url(meta))).arrayBuffer(),
});
```

Convenience method that wires up assets, tracks and MIDI in one call. Returns a summary `{ duration, midiTracks, audioTracks, audioAssets }`.

---

## 4. Extending the class

`SongPlayer` is a normal ES class. Override `_syncAudioClips`, `_scheduleTrackOffline`, `_applyClipGainSchedule`, or `_startClip` to customise clip scheduling.

You can also override `_startPostMidiClock`, `_stopPostMidiClock`, or `_finalizePostMidi` to change the virtual-clock behaviour.

---

## 5. Compatibility matrix

| Feature | TimidityPlayer | SongPlayer |
|---|---|---|
| MIDI playback | ✅ | ✅ |
| Note events (noteOn/noteOff) | ✅ | ✅ |
| Mute / solo MIDI channels | ✅ | ✅ |
| Transpose | ✅ | ✅ |
| Seek / pause / stop | ✅ | ✅ |
| Repeated playback after end | ⚠️ (requires manual reload) | ✅ (auto reload) |
| Audio clip playback | ❌ | ✅ |
| Multi-asset clips with offset | ❌ | ✅ |
| Fade in / fade out | ❌ | ✅ |
| MIDI + audio simultan | ❌ | ✅ |
| Audio tail beyond MIDI end | ❌ | ✅ (virtual clock) |
| Duration = max(MIDI, audio) | ❌ | ✅ |
| Empty-MIDI (audio only) | ❌ | ✅ (render only, see §7) |
| Offline render (MIDI) | ✅ | ✅ |
| Offline render (audio) | ❌ | ✅ |
| Offline render merged | partial | ✅ |
| Offline render per-track | partial (`exportStems`) | ✅ (returns array) |
| MONO / stereo render option | ✅ | ✅ |
| Configurable sample rate / buffer size | ✅ | ✅ |
| `once` / `off` / `offAll` listeners | ❌ | ✅ |

---

## 6. Example: mixing MIDI + audio clips

```js
const player = new SongPlayer({ patchUrlBase, sampleRate: 48000 });
await player.init();
await player.loadAudioAssetFromUrl('fx', '/sfx/impact.wav');

player.setAudioTracks([{
    id: 'fx', name: 'Impact SFX', clips: [
        { id: 'i1', audioAssetId: 'fx', startTick: 1920, trimmedDurationTicks: 480,
          trimStartOffsetTicks: 0, volume: 0.9,
          fadeIn:  { enable: true, from: 0.0, to: 0.05 } }
    ]
}]);

await player.load('/midi/song.mid');
await player.resume();
await player.play();                  // MIDI + FX play together

// UI: playhead via onPlaying, real "done" via onSongFinished
player.on('onPlaying',       (tick, sec) => drawPlayhead(sec));
player.on('onEnded',         ()          => console.log('MIDI finished, audio may still be running'));
player.on('onSongFinished',  (t)         => console.log('Song finished at', t));
```

---

## 7. Notes & gotchas

- **User gesture required.** `player.init()` and `player.resume()` must be called from inside a click/keypress handler, per browser autoplay policy.
- **`startTick` units.** Clip timing uses MIDI ticks, not seconds. When MIDI is loaded, ticks → seconds uses that MIDI's tempo map. Without MIDI, a default 120 BPM / 480 PPQ is assumed.
- **Fade units.** Fades are seconds relative to the clip start. If you seek into the middle of the clip and the fade-in has already finished, its effect is not re-applied; the effective gain at the seek point is used.
- **Real-time sync drift.** Audio clips are scheduled on the same `AudioContext` as the MIDI, with a 50 ms lookahead window. Under normal conditions this yields sample-accurate playback. Avoid heavy synchronous work on the main thread.
- **Virtual clock after MIDI end.** When MIDI ends before the last clip, `SongPlayer` starts an internal rAF-driven clock that keeps `onPlaying` and clip sync alive until `getSongDuration()` is reached. `onStop` and `onEnded` from the base class are **not** used to stop clips.
- **`onEnded` vs `onSongFinished`.** Use `onSongFinished` to detect end-of-song. `onEnded` only means "MIDI is over"; audio may still be playing.
- **Repeated `play()`.** Calling `play()` after a song has finished will transparently reload the MIDI and start over. Do not manually call `load()` again.
- **Rendering while playing.** `render()` internally pauses playback. If you were playing before calling `render()`, you may need to call `play()` again afterwards.
- **Empty-MIDI real-time playback is not supported yet.** `TimidityPlayer.play()` needs an active song pointer to drive the clock. Audio-only real-time playback requires a MIDI-less clock, which is not implemented. Audio-only **offline rendering** works fine.
- **Memory.** Audio assets stay in `player.audioAssets` until removed; call `removeAudioAsset(id)` for long sessions.

---

