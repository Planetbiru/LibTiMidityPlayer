GUS Patch Generator — Output Package
=====================================

Sample rate : 22050 Hz
Format      : Gravis Ultrasound Patch (.pat, 16-bit signed PCM, little-endian)

Package contents:
  timidity.cfg   TiMidity++ configuration
  README.txt     This file
  melodic/       128 GM program patches (000–127)
  drums/         57 drum kit patches (notes 25–84)

─── Usage with TiMidity++ ─────────────────
  1. Extract the entire ZIP into one folder.
  2. cd into that folder.
  3. Run:
        timidity -c timidity.cfg song.mid

  Render to WAV:
        timidity -c timidity.cfg -Ow -o out.wav song.mid

  Render to OGG:
        timidity -c timidity.cfg -Ov -o out.ogg song.mid

─── Usage with WildMIDI ───────────────────
  WildMIDI automatically reads the "wildmidi/" folder:
    wildmidi/         → rename melodic/, then rename each
                        file to program number (000.pat …)
    wildmidi/perc/    → rename drums/, file name = note number
                        (35.pat … 81.pat)

─── Usage with DOSBox ─────────────────────
  Set the ULTRASND environment variable to the patch folder:
    ULTRASND=240,1,1,3,3
  Place .pat files in:
    <ULTRASND>\MELODIC\<program>.pat   (e.g. 0.pat, 1.pat)
    <ULTRASND>\DRUMS\STANDARD\<note>.pat (e.g. 35.pat)

─── Technical notes ───────────────────────
  - All patches are generated purely from JavaScript oscillators.
  - Melodic: 16-bit signed PCM with sustain looping enabled for instruments
    that sustain (strings, brass, reed, pipe, pad, lead, organ, ensemble,
    overdriven/distortion guitar, and synth bass), from loopStart → loopEnd.
  - Looped samples include MENV and a default envelope (attack ~10ms,
    release ~148ms) so note-off releases notes correctly.
  - Drum   : one-shot, no loop.
  - Vibrato and performance envelopes are handled by the GUS synth
    during playback, not baked into the sample (avoids
    "telephone ring" artifacts in loops).
