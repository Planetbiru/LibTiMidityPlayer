GUS Patch Generator — Output Package
=====================================

Sample rate : 44100 Hz
Format      : Gravis Ultrasound Patch (.pat, 8-bit signed PCM)

Package contents:
  timidity.cfg   TiMidity++ configuration
  README.txt     This file
  melodic/       128 GM program patches (000–127)
  drums/         47 GM drum kit patches (note 35–81)

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
  - Melodic: loop (sustain) from loopStart → loopEnd.
  - Drum   : one-shot, no loop.
  - Vibrato and performance envelopes are handled by the GUS synth
    during playback, not baked into the sample (avoids
    "telephone ring" artifacts in loops).
