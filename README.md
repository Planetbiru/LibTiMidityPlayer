# LibTiMidity Web (DAW Edition)

This is a WebAssembly port of the `libTiMidity` MIDI synthesizer engine, equipped with a comprehensive JavaScript API (`TimidityPlayer`) designed specifically for integration into a **Digital Audio Workstation (DAW)** operating in the web browser.

This project provides JavaScript bindings for libTiMidity. The bindings are licensed under MIT. The original C core remains under LGPL/Artistic.

Modified C source code is included in src/c-core/modified and distributed under MIT, while original libTiMidity code remains under LGPL/Artistic

## Overview

The standard libTiMidity engine has been heavily modified and extended to meet the real-time interaction, sample accuracy, and dynamic requirements of modern web-based DAWs. 

### Key Features
- **Real-Time Synthesizer (MIDI Controller Support)**: 
  A dedicated background synthesizer instance runs independently of the main playback. This allows you to play notes via a MIDI controller or computer keyboard with zero latency, even if the main track is paused.
- **Dynamic Instrument Loading**: 
  Instead of freezing the browser to load hundreds of megabytes of soundfonts at once, the engine analyzes your `.mid` files or takes direct commands to load *only* the specific patches required for playback on-the-fly.
- **Sample-Accurate Callbacks**:
  Events (such as Lyrics, Meta-events, and Note On/Off triggers) are dispatched back to JavaScript precisely when the audio buffer reaches that exact sample. This guarantees flawless UI synchronization (like lighting up virtual piano keys or updating lyrics). Furthermore, callbacks are crucial for DAW integration, such as displaying per-channel VU meters. The VU meters don't just calculate initial velocity; they can be dynamically updated during real-time control changes like volume, expression, and pan. Pitch bend controls can also be updated directly from the callback, ensuring that the DAW's UI updates smoothly and stays perfectly in sync with automation.
- **DAW Controller Emulation**:
  Full support for sending and retrieving `Control Change` events (Volume, Pan, Pitch Bend, Expression, Sustain) dynamically.
- **Offline Rendering Protection**:
  Automatically manages Web Audio API contexts, preventing accidental real-time inputs from corrupting offline rendering tasks (e.g., bouncing tracks to a WAV file).

## Why Create a DAW edition of a MIDI Player?

1. **Real-time events for playing notes**
   - Supports different instruments and banks directly.
   - Can receive input from MIDI controllers or computer keyboards with minimum delay.

2. **Real-time control events during playback**
   - Loads new MIDI data without resetting the engine.
   - Performs dynamic transposition.
   - Sends control events such as volume, pan, expression, pitch bend, sustain pedal, and modulation.
   - Mute, unmute, and solo each channel.
   - Changes tempo in real time.

3. **Enhancing trigger events required by DAWs**
   - Lyric, meta-event, and note on/off events are sent back to the UI with sample-accurate precision.
   - Synchronization is perfectly aligned with visuals such as piano rolls, VU meters, and automation lanes.
   - Pitch bend, pan, and expression can be updated in real time so the DAW UI remains synchronized.

4. **Integration with modern DAW workflows**
   - Supports offline rendering (bounce to WAV) without being interrupted by real-time input.
   - Separates the playback instance from the synthesizer instance for more flexible control.
   - Provides an API that DAWs can use for automation, mixing, and channel monitoring.

5. **Scalability and efficiency**
   - There is no need to load all instruments at once; only the required patches are loaded.
   - Reduces browser overhead and helps maintain smooth performance in large projects with many tracks.

6. **Combining MIDI synthesis and audio during playback and rendering**
   - Enables mixing MIDI instruments with recorded audio or sample libraries.
   - Provides flexibility for hybrid arrangements, such as audio drums plus MIDI strings.
   - During rendering, the final result can be a single audio mix that combines both sound sources.

## Quick Start

Include the scripts in your HTML:

```html
<script src="timidity-player.js"></script>
<script src="libtimidity.js"></script>
```

Initialize the player:

```javascript
const player = new TimidityPlayer();

player.on('onInit', async () => {
    console.log("Synthesizer is ready!");
    
    // Load a MIDI file
    await player.load(midiDataBuffer);
    
    // Start playback
    player.play();
});

// Initialize the engine
player.init();
```

### Handling Real-Time MIDI Input

If you have a MIDI controller connected, you can directly inject real-time events into the engine:

```javascript
// Press Middle C (Pitch 60) on Channel 0
player.noteOn(0, instrumentProgram, 60, 100);

// Release Middle C
player.noteOff(0, 60);

// Adjust Pitch Bend
player.sendEvent(256, 0, bendValue);
```

## Documentation
Please refer to the JSDoc comments within `timidity-player.js` for an exhaustive list of methods and events. For a detailed list of changes made to the C Core, read `CHANGELOG.md`.

## License

- The original C synthesizer engine (`src/c-core/original`) is licensed under **LGPL v2.1** and the **Artistic License**.  
- Any modifications to the C source (`src/c-core/modified`) are distributed under MIT, but remain subject to LGPL/Artistic obligations for the original portions.  
- The compiled JavaScript file (`src/js-bindings/libtimidity.js`) is licensed under **MIT**.


### MIT License (JavaScript bindings & modifications)

Copyright (c) 2026 Kamshory, MT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

```txt
Copyright (c) 2026 Kamshory, MT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### LGPL / Artistic License (C core)

The original C synthesizer engine (`src/c-core/original`) is licensed under
**LGPL v2.1** and the **Artistic License**.

Any modifications to the C source code (`src/c-core/modified`) are distributed under MIT,
but remain subject to the obligations of the LGPL/Artistic License for the original portions.

See `licenses/COPYING` and `licenses/LICENSE-ARTISTIC.md` for the complete license texts.


## Attribution

**TiMidity (1995)** – Tuukka Toivonen

**libTiMidity (2004)** – lostclus

**Maintenance** – Ozkan Sezer (sezero)

**JavaScript bindings & modifications (2026)** – Kamshory, MT


## Repository Structure

```txt
LibTiMidityPlayer/
├── src/
│   ├── c-core/original   # Original libTiMidity C source (LGPL/Artistic)
│   ├── c-core/modified   # Modified C source (MIT + LGPL obligations)
│   └── js-bindings       # Compiled JavaScript: libtimidity.js (MIT)
├── licenses/
│   ├── LICENSE-MIT.md
│   ├── COPYING           # LGPL v2.1
│   └── LICENSE-ARTISTIC.md
├── README.md
└── LICENSE.md
```

## Notes

- If distributing binaries (e.g., npm package or DLL), include a link to this repository so users can access the modified source code as required by LGPL.

- The JavaScript binding (`libtimidity.js`) is fully MIT-licensed, making it free to use in both commercial and open-source projects.

