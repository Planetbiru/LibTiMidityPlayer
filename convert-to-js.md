## Install emsdk

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
```

## Command to Convert

### Compile to asm.js

The `-O0 -DTIMIDITY_DEBUG -s WASM=0` command is for debugging only and may
stutter during real-time playback with channel effects. For production, use
`-O2 -s WASM=1` and omit `-DTIMIDITY_DEBUG`.
Do not use `-O3` for asm.js because it may rename functions, making them inaccessible from JavaScript.

```bash
emcc common.c instrum.c mix.c output.c playmidi.c readmidi.c tables.c timidity.c stream.c resample.c -O0 -DTIMIDITY_DEBUG -s WASM=0 -o ..\js-bindings\libtimidity.js ^
  -s ASSERTIONS=1 ^
  -s EXPORTED_FUNCTIONS=['_mid_init_no_config','_mid_init','_mid_exit','_mid_get_version','_mid_song_load','_mid_song_create','_mid_create_options','_mid_song_free','_mid_dlspatches_load','_mid_dlspatches_free','_mid_song_load_dls','_mid_istream_open_mem','_mid_istream_close','_malloc','_free','_mid_song_read_wave','_mid_song_get_patch_names','_mid_istream_seek','_mid_song_get_required_patches','_mid_song_start','_mid_song_set_event_callback','_mid_song_set_volume','_mid_song_set_transpose','_mid_song_set_channel_mute','_mid_song_set_track_mute','_mid_song_panic','_mid_song_get_time','_mid_song_get_current_tick','_mid_song_get_info_json','_mid_song_seek','_mid_song_get_total_time','_mid_set_debug_msg_callback','_mid_set_memory_limit','_mid_note_on','_mid_note_off','_mid_song_load_program','_mid_send_event','_mid_song_resend_active_notes','_mid_song_get_controller_value_at_tick','_mid_song_get_active_voices','_mid_song_get_master_peak','_mid_song_update_events','_mid_song_force_mono_pan','_mid_song_set_effects','_mid_song_set_channel_effects','_mid_song_set_channel_reverb','_mid_song_set_channel_chorus','_mid_song_set_channel_brightness','_mid_song_set_channel_bass'] ^
  -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap','getValue','setValue','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8','HEAP16','HEAP32','addFunction','FS','PATH'] ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -s ALLOW_TABLE_GROWTH


emcc common.c instrum.c mix.c output.c playmidi.c readmidi.c tables.c timidity.c stream.c resample.c -O2 -DTIMIDITY_DEBUG -s WASM=0 -o ..\js-bindings\libtimidity.min.js ^
  -s ASSERTIONS=1 ^
  -s EXPORTED_FUNCTIONS=['_mid_init_no_config','_mid_init','_mid_exit','_mid_get_version','_mid_song_load','_mid_song_create','_mid_create_options','_mid_song_free','_mid_dlspatches_load','_mid_dlspatches_free','_mid_song_load_dls','_mid_istream_open_mem','_mid_istream_close','_malloc','_free','_mid_song_read_wave','_mid_song_get_patch_names','_mid_istream_seek','_mid_song_get_required_patches','_mid_song_start','_mid_song_set_event_callback','_mid_song_set_volume','_mid_song_set_transpose','_mid_song_set_channel_mute','_mid_song_set_track_mute','_mid_song_panic','_mid_song_get_time','_mid_song_get_current_tick','_mid_song_get_info_json','_mid_song_seek','_mid_song_get_total_time','_mid_set_debug_msg_callback','_mid_set_memory_limit','_mid_note_on','_mid_note_off','_mid_song_load_program','_mid_send_event','_mid_song_resend_active_notes','_mid_song_get_controller_value_at_tick','_mid_song_get_active_voices','_mid_song_get_master_peak','_mid_song_update_events','_mid_song_force_mono_pan','_mid_song_set_effects','_mid_song_set_channel_effects','_mid_song_set_channel_reverb','_mid_song_set_channel_chorus','_mid_song_set_channel_brightness','_mid_song_set_channel_bass'] ^
  -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap','getValue','setValue','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8','HEAP16','HEAP32','addFunction','FS','PATH'] ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -s ALLOW_TABLE_GROWTH

```

### Compile to WebAssembly

```bash
emcc common.c instrum.c mix.c output.c playmidi.c readmidi.c tables.c timidity.c stream.c resample.c -O2 -o ..\js-bindings\libtimidity.wasm.js ^
  -s ASSERTIONS=1 ^
  -s EXPORTED_FUNCTIONS="['_mid_init_no_config','_mid_init','_mid_exit','_mid_get_version','_mid_song_load','_mid_song_create','_mid_create_options','_mid_song_free','_mid_dlspatches_load','_mid_dlspatches_free','_mid_song_load_dls','_mid_istream_open_mem','_mid_istream_close','_malloc','_free','_mid_song_read_wave','_mid_song_get_patch_names','_mid_istream_seek','_mid_song_get_required_patches','_mid_song_start','_mid_song_set_event_callback','_mid_song_set_volume','_mid_song_set_transpose','_mid_song_set_channel_mute','_mid_song_set_track_mute','_mid_song_panic','_mid_song_get_time','_mid_song_get_current_tick','_mid_song_get_info_json','_mid_song_seek','_mid_song_get_total_time','_mid_set_debug_msg_callback','_mid_set_memory_limit','_mid_note_on','_mid_note_off','_mid_song_load_program','_mid_send_event','_mid_song_resend_active_notes','_mid_song_get_controller_value_at_tick','_mid_song_get_active_voices','_mid_song_get_master_peak','_mid_song_update_events','_mid_song_force_mono_pan','_mid_song_set_effects','_mid_song_set_channel_effects','_mid_song_set_channel_reverb','_mid_song_set_channel_chorus','_mid_song_set_channel_brightness','_mid_song_set_channel_bass']" ^
  -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8','HEAP16','HEAP32','addFunction','FS','PATH']" ^
  -s FORCE_FILESYSTEM=1 ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -s ALLOW_TABLE_GROWTH=1

```

Here’s the updated documentation with the **warning about `-O3`** included:

---

## Install emsdk

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
```

## Command to Convert

### Compile to asm.js

```bash
emcc common.c instrum.c mix.c output.c playmidi.c readmidi.c tables.c timidity.c stream.c resample.c -O2 -DTIMIDITY_DEBUG -s WASM=0 -o ..\js-bindings\libtimidity.min.js ^
  -s ASSERTIONS=1 ^
  -s EXPORTED_FUNCTIONS=['_mid_init_no_config','_mid_init','_mid_exit','_mid_get_version','_mid_song_load','_mid_song_create','_mid_create_options','_mid_song_free','_mid_dlspatches_load','_mid_dlspatches_free','_mid_song_load_dls','_mid_istream_open_mem','_mid_istream_close','_malloc','_free','_mid_song_read_wave','_mid_song_get_patch_names','_mid_istream_seek','_mid_song_get_required_patches','_mid_song_start','_mid_song_set_event_callback','_mid_song_set_volume','_mid_song_set_transpose','_mid_song_set_channel_mute','_mid_song_set_track_mute','_mid_song_panic','_mid_song_get_time','_mid_song_get_current_tick','_mid_song_get_info_json','_mid_song_seek','_mid_song_get_total_time','_mid_set_debug_msg_callback','_mid_set_memory_limit','_mid_note_on','_mid_note_off','_mid_song_load_program','_mid_send_event','_mid_song_resend_active_notes','_mid_song_get_controller_value_at_tick','_mid_song_get_active_voices','_mid_song_get_master_peak','_mid_song_update_events','_mid_song_force_mono_pan','_mid_song_set_effects','_mid_song_set_channel_effects','_mid_song_set_channel_reverb','_mid_song_set_channel_chorus','_mid_song_set_channel_brightness','_mid_song_set_channel_bass'] ^
  -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap','getValue','setValue','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8','HEAP16','HEAP32','addFunction','FS','PATH'] ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -s ALLOW_TABLE_GROWTH

```

### Compile to WebAssembly

#### Debug Version

```bash
emcc common.c instrum.c mix.c output.c playmidi.c readmidi.c tables.c timidity.c stream.c resample.c -O0 -o ..\js-bindings\libtimidity.wasm.js ^
  -s ASSERTIONS=1 ^
  -s EXPORTED_FUNCTIONS="['_mid_init_no_config','_mid_init','_mid_exit','_mid_get_version','_mid_song_load','_mid_song_create','_mid_create_options','_mid_song_free','_mid_dlspatches_load','_mid_dlspatches_free','_mid_song_load_dls','_mid_istream_open_mem','_mid_istream_close','_malloc','_free','_mid_song_read_wave','_mid_song_get_patch_names','_mid_istream_seek','_mid_song_get_required_patches','_mid_song_start','_mid_song_set_event_callback','_mid_song_set_volume','_mid_song_set_transpose','_mid_song_set_channel_mute','_mid_song_set_track_mute','_mid_song_panic','_mid_song_get_time','_mid_song_get_current_tick','_mid_song_get_info_json','_mid_song_seek','_mid_song_get_total_time','_mid_set_debug_msg_callback','_mid_set_memory_limit','_mid_note_on','_mid_note_off','_mid_song_load_program','_mid_send_event','_mid_song_resend_active_notes','_mid_song_get_controller_value_at_tick','_mid_song_get_active_voices','_mid_song_get_master_peak','_mid_song_update_events','_mid_song_force_mono_pan','_mid_song_set_effects','_mid_song_set_channel_effects','_mid_song_set_channel_reverb','_mid_song_set_channel_chorus','_mid_song_set_channel_brightness','_mid_song_set_channel_bass']" ^
  -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8','HEAP16','HEAP32','addFunction','FS','PATH']" ^
  -s FORCE_FILESYSTEM=1 ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -s ALLOW_TABLE_GROWTH=1

```

All build commands export `_mid_set_memory_limit` so `TimidityPlayer` can set
the C-core allocation limit. The limit applies only to allocations made through
the C core's `timi_*` allocator wrappers; it does not set the WebAssembly heap
maximum or constrain JavaScript-owned buffers. `ALLOW_MEMORY_GROWTH=1` lets
Emscripten grow the heap up to the build's configured maximum. Rebuild and
deploy the generated `libtimidity.js` after changing the C sources.
All build variants also export `_mid_song_set_channel_effects`,
`_mid_song_set_channel_reverb`, and `_mid_song_set_channel_chorus`. These
per-channel APIs are required for MIDI CC91/CC93 playback, live DAW events, and
offline rendering with independent channel sends.

#### Minified Version

Run this from the repository root in a Windows Command Prompt with Emscripten
activated. It writes the optimized loader and matching WASM binary to
`src\c-core\js-bindings`.

```bash
cd /d src\c-core\modified

emcc common.c instrum.c mix.c output.c playmidi.c readmidi.c tables.c timidity.c stream.c resample.c ^
  -Oz ^
  -DNDEBUG ^
  -o ..\js-bindings\libtimidity.wasm.js ^
  -s ASSERTIONS=0 ^
  -s EXPORTED_FUNCTIONS="['_mid_init_no_config','_mid_init','_mid_exit','_mid_get_version','_mid_song_load','_mid_song_create','_mid_create_options','_mid_song_free','_mid_dlspatches_load','_mid_dlspatches_free','_mid_song_load_dls','_mid_istream_open_mem','_mid_istream_close','_malloc','_free','_mid_song_read_wave','_mid_song_get_patch_names','_mid_istream_seek','_mid_song_get_required_patches','_mid_song_start','_mid_song_set_event_callback','_mid_song_set_volume','_mid_song_set_transpose','_mid_song_set_channel_mute','_mid_song_set_track_mute','_mid_song_panic','_mid_song_get_time','_mid_song_get_current_tick','_mid_song_get_info_json','_mid_song_seek','_mid_song_get_total_time','_mid_set_debug_msg_callback','_mid_set_memory_limit','_mid_note_on','_mid_note_off','_mid_song_load_program','_mid_send_event','_mid_song_resend_active_notes','_mid_song_get_controller_value_at_tick','_mid_song_get_active_voices','_mid_song_get_master_peak','_mid_song_update_events','_mid_song_force_mono_pan','_mid_song_set_effects','_mid_song_set_channel_effects','_mid_song_set_channel_reverb','_mid_song_set_channel_chorus','_mid_song_set_channel_brightness','_mid_song_set_channel_bass']" ^
  -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8','HEAP16','HEAP32','addFunction','FS','PATH']" ^
  -s FORCE_FILESYSTEM=1 ^
  -s ENVIRONMENT=web ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -s ALLOW_TABLE_GROWTH=1
```

`-Oz` optimizes for output size; it may run slower than `-O2`/`-O3`, so test
playback performance before deployment. `ENVIRONMENT=web` removes non-browser
runtime support. Keep `FS` in `EXPORTED_RUNTIME_METHODS` and
`FORCE_FILESYSTEM=1`, because the player loads configuration and patches through
the virtual filesystem. Do not add `--closure 1`: Closure can rename filesystem
API properties used by the external player wrapper (for example, `mkdirTree`).
The WASM build produces both `libtimidity.wasm.js` and the matching
`libtimidity.wasm.wasm`; deploy both files together.

---

## ⚙️ Optimization Levels

- **`-O0`**  
  No optimization. Produces large, readable output. Best for debugging. Performance is low.

- **`-O1`**  
  Light optimization. Removes dead code and applies basic improvements. Output is still fairly readable but runs faster than `-O0`. Good for debugging with some performance.

- **`-O2`**  
  Standard optimization. Balances performance and file size. Enables common optimizations like inlining and loop unrolling. Recommended for production builds.

- **`-O3`**  
  Aggressive optimization focused on execution speed. It can produce larger
  output than size-focused optimization.

- **`-Oz`**
  Optimizes for the smallest output and is used by the minified/release commands
  above. It may trade some runtime speed for a smaller download; test playback
  performance with representative MIDI files.

Use `-O0` or `-O1` for debugging, `-O2` for a speed/size balance, `-O3` when
prioritizing execution speed, and `-Oz` when download size is the priority.