## Install emsdk

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
```

## Command to Convert

### Compile to asm.js

```bash
emcc common.c instrum.c mix.c output.c playmidi.c readmidi.c tables.c timidity.c stream.c resample.c -O0 -DTIMIDITY_DEBUG -s WASM=0 -o ..\js-bindings\libtimidity.js ^
  -s ASSERTIONS=1 ^
  -s EXPORTED_FUNCTIONS=["_mid_init_no_config","_mid_init","_mid_exit","_mid_get_version","_mid_song_load","_mid_song_create","_mid_create_options","_mid_song_free","_mid_dlspatches_load","_mid_dlspatches_free","_mid_song_load_dls","_mid_istream_open_mem","_mid_istream_close","_malloc","_free","_mid_song_read_wave","_mid_song_get_patch_names","_mid_istream_seek","_mid_song_get_required_patches","_mid_song_start","_mid_song_set_event_callback","_mid_song_set_volume","_mid_song_set_transpose","_mid_song_set_channel_mute","_mid_song_set_track_mute","_mid_song_panic","_mid_song_get_time","_mid_song_get_current_tick","_mid_song_get_info_json","_mid_song_seek","_mid_song_get_total_time","_mid_set_debug_msg_callback","_mid_note_on","_mid_note_off","_mid_song_load_program","_mid_send_event","_mid_song_resend_active_notes","_mid_song_get_controller_value_at_tick","_mid_song_get_active_voices","_mid_song_get_master_peak","_mid_song_update_events"] ^
  -s EXPORTED_RUNTIME_METHODS=["ccall","cwrap","getValue","setValue","UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAPU8","HEAP16","HEAP32","addFunction","FS","PATH"] ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -s ALLOW_TABLE_GROWTH


emcc common.c instrum.c mix.c output.c playmidi.c readmidi.c tables.c timidity.c stream.c resample.c -O2 -DTIMIDITY_DEBUG -s WASM=0 -o ..\js-bindings\libtimidity.min.js ^
  -s ASSERTIONS=1 ^
  -s EXPORTED_FUNCTIONS=["_mid_init_no_config","_mid_init","_mid_exit","_mid_get_version","_mid_song_load","_mid_song_create","_mid_create_options","_mid_song_free","_mid_dlspatches_load","_mid_dlspatches_free","_mid_song_load_dls","_mid_istream_open_mem","_mid_istream_close","_malloc","_free","_mid_song_read_wave","_mid_song_get_patch_names","_mid_istream_seek","_mid_song_get_required_patches","_mid_song_start","_mid_song_set_event_callback","_mid_song_set_volume","_mid_song_set_transpose","_mid_song_set_channel_mute","_mid_song_set_track_mute","_mid_song_panic","_mid_song_get_time","_mid_song_get_current_tick","_mid_song_get_info_json","_mid_song_seek","_mid_song_get_total_time","_mid_set_debug_msg_callback","_mid_note_on","_mid_note_off","_mid_song_load_program","_mid_send_event","_mid_song_resend_active_notes","_mid_song_get_controller_value_at_tick","_mid_song_get_active_voices","_mid_song_get_master_peak","_mid_song_update_events"] ^
  -s EXPORTED_RUNTIME_METHODS=["ccall","cwrap","getValue","setValue","UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAPU8","HEAP16","HEAP32","addFunction","FS","PATH"] ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -s ALLOW_TABLE_GROWTH

```

### Compile to WebAssembly

```bash
emcc common.c instrum.c mix.c output.c playmidi.c readmidi.c tables.c timidity.c stream.c resample.c -O2 -DTIMIDITY_DEBUG -s WASM=1 -o ..\js-bindings\libtimidity.js ^
  -s ASSERTIONS=1 ^
  -s EXPORTED_FUNCTIONS=["_mid_init_no_config","_mid_init","_mid_exit","_mid_get_version","_mid_song_load","_mid_song_create","_mid_create_options","_mid_song_free","_mid_dlspatches_load","_mid_dlspatches_free","_mid_song_load_dls","_mid_istream_open_mem","_mid_istream_close","_malloc","_free","_mid_song_read_wave","_mid_song_get_patch_names","_mid_istream_seek","_mid_song_get_required_patches","_mid_song_start","_mid_song_set_event_callback","_mid_song_set_volume","_mid_song_set_transpose","_mid_song_set_channel_mute","_mid_song_set_track_mute","_mid_song_panic","_mid_song_get_time","_mid_song_get_current_tick","_mid_song_get_info_json","_mid_song_seek","_mid_song_get_total_time","_mid_set_debug_msg_callback","_mid_note_on","_mid_note_off","_mid_song_load_program","_mid_send_event","_mid_song_resend_active_notes","_mid_song_get_controller_value_at_tick","_mid_song_get_active_voices","_mid_song_get_master_peak","_mid_song_update_events"] ^
  -s EXPORTED_RUNTIME_METHODS=["ccall","cwrap","getValue","setValue","UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAPU8","HEAP16","HEAP32","addFunction","FS","PATH"] ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -s ALLOW_TABLE_GROWTH

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
emcc common.c instrum.c mix.c output.c playmidi.c readmidi.c tables.c timidity.c stream.c resample.c -O2 -s WASM=0 -o ..\..\cipta-lagu\composer\assets\libtimidity-player\libtimidity.js ^
  -s ASSERTIONS=1 ^
  -s EXPORTED_FUNCTIONS=["_mid_init_no_config","_mid_init","_mid_exit","_mid_get_version","_mid_song_load","_mid_song_create","_mid_create_options","_mid_song_free","_mid_dlspatches_load","_mid_dlspatches_free","_mid_song_load_dls","_mid_istream_open_mem","_mid_istream_close","_malloc","_free","_mid_song_read_wave","_mid_song_get_patch_names","_mid_istream_seek","_mid_song_get_required_patches","_mid_song_start","_mid_song_set_event_callback","_mid_song_set_volume","_mid_song_set_transpose","_mid_song_set_channel_mute","_mid_song_set_track_mute","_mid_song_panic","_mid_song_get_time","_mid_song_get_current_tick","_mid_song_get_info_json","_mid_song_seek","_mid_song_get_total_time","_mid_set_debug_msg_callback","_mid_note_on","_mid_note_off","_mid_song_load_program","_mid_send_event","_mid_song_resend_active_notes","_mid_song_get_controller_value_at_tick","_mid_song_get_active_voices","_mid_song_get_master_peak","_mid_song_update_events"] ^
  -s EXPORTED_RUNTIME_METHODS=["ccall","cwrap","getValue","setValue","UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAPU8","HEAP16","HEAP32","addFunction","FS","PATH"] ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -s ALLOW_TABLE_GROWTH

```

### Compile to WebAssembly

```bash
emcc common.c instrum.c mix.c output.c playmidi.c readmidi.c tables.c timidity.c stream.c resample.c -O2 -s WASM=1 -o ..\browser\libtimidity.js ^
  -s ASSERTIONS=1 ^
  -s EXPORTED_FUNCTIONS=["_mid_init_no_config","_mid_init","_mid_exit","_mid_get_version","_mid_song_load","_mid_song_create","_mid_create_options","_mid_song_free","_mid_dlspatches_load","_mid_dlspatches_free","_mid_song_load_dls","_mid_istream_open_mem","_mid_istream_close","_malloc","_free","_mid_song_read_wave","_mid_song_get_patch_names","_mid_istream_seek","_mid_song_get_required_patches","_mid_song_start","_mid_song_set_event_callback","_mid_song_set_volume","_mid_song_set_transpose","_mid_song_set_channel_mute","_mid_song_set_track_mute","_mid_song_panic","_mid_song_get_time","_mid_song_get_current_tick","_mid_song_get_info_json","_mid_song_seek","_mid_song_get_total_time","_mid_set_debug_msg_callback","_mid_note_on","_mid_note_off","_mid_song_load_program","_mid_send_event","_mid_song_resend_active_notes","_mid_song_get_controller_value_at_tick","_mid_song_get_active_voices","_mid_song_get_master_peak","_mid_song_update_events"] ^
  -s EXPORTED_RUNTIME_METHODS=["ccall","cwrap","getValue","setValue","UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAPU8","HEAP16","HEAP32","addFunction","FS","PATH"] ^
  -s ALLOW_MEMORY_GROWTH=1 ^
  -s ALLOW_TABLE_GROWTH

```

---

## ⚙️ Optimization Levels

- **`-O0`**  
  No optimization. Produces large, readable output. Best for debugging. Performance is low.

- **`-O1`**  
  Light optimization. Removes dead code and applies basic improvements. Output is still fairly readable but runs faster than `-O0`. Good for debugging with some performance.

- **`-O2`**  
  Standard optimization. Balances performance and file size. Enables common optimizations like inlining and loop unrolling. Recommended for production builds.

- **`-O3`**  
  Aggressive optimization. Includes all `-O2` optimizations plus advanced techniques like vectorization and heavy inlining.  
  ⚠️ **Warning:** Do not use `-O3` for this project because it can change internal function names and make debugging or direct function calls unreliable. Stick to `-O2` for stable builds.

---

👉 Use `-O0` or `-O1` during development/debugging, and switch to `-O2` for production. Avoid `-O3` in this case to prevent function name obfuscation.