# On-demand native STEP preview experiment

The Workbench can run a Linux native OCCT helper through the existing settled
preview carrier. Build that browser variant with `vite build --mode
native-step-preview`. Configure its Product Host with
`stepPreviewConverter: { "executable": "/absolute/path/rustx-step-native",
"threads": 1 }` or use eight threads. The standard browser build remains the
WASM comparison variant. This experiment covers Workbench STEP and STP files.

The helper takes an inherited read-only regular-file descriptor, rejecting
references to external STEP files before XCAF transfer. The Host checks
workspace authority and descriptor and path versions again before it publishes
the GLB. Each conversion has one isolated working directory and one admitted
child per Host. The Host kills and joins the child on cancellation or its
60-second deadline. The helper limits its address space and file output.
The browser uses the existing GLB admission and renderer. This experiment
converts on each open and returns full-detail geometry in one response.
Meshing uses the existing WASM deflection and angle parameters on each free
assembly root. OCCT's GLB writer then serializes the XCAF hierarchy and meshes.

## Reproduce the same-version comparison

Use OCCT commit `d2abb6d844231cb8f29be6894440874a4700e4a5` (7.6.1), in a
writable copy. Apply the existing
`web-console/vendor/occt-import-js/step-bulk-lexer.patch` to that tree before
building. Use Release, enable RapidJSON for GLB writing, and include
`TKXDESTEP` and `TKRWMesh` and their required toolkits. In the comparison,
CMake used `-DBUILD_ADDITIONAL_TOOLKITS="TKXDESTEP TKRWMesh"` with every
`BUILD_MODULE_*` disabled, plus `-DUSE_RAPIDJSON=ON -DUSE_FREETYPE=OFF
-DUSE_TBB=OFF -DUSE_OPENGL=OFF`. Supply the RapidJSON headers through
`3RDPARTY_RAPIDJSON_INCLUDE_DIR` if necessary.

Build the helper from the repository root.

```sh
cmake -S web-console/host/step-native -B /tmp/native-step-helper -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DOCCT_HEADERS=/path/to/occt-build/include/opencascade \
  -DCMAKE_LIBRARY_PATH=/path/to/occt-build/lin64/gcc/lib
cmake --build /tmp/native-step-helper
```

Add the native browser build and helper paths to the local
[STEP browser benchmark manifest](step-browser-benchmark.md).

```json
{
  "native": {
    "dist": "/absolute/path/to/native-browser-dist",
    "executable": "/tmp/native-step-helper/rustx-step-native"
  }
}
```

With this field, the harness runs the existing bulk-lexer WASM build and both
native configurations against the same input hashes. Each run starts a fresh
fixture session for each variant outside the measured window. A fixture may
list a subset of `wasm`, `native-1` and `native-8` in `variants` when
repeating individual comparisons. Set `LD_LIBRARY_PATH`
to the matching OCCT build libraries when running the benchmark. The primary
comparison for output quality is full mesh to full mesh. WASM also reports
the first complete display, which can come from its optional coarse mesh.

The helper reports its file read, STEP parse, XCAF transfer and healing
(including the external-reference check), bounding and mesh preparation,
GLB encode, and peak RSS. The browser reports multipart response bytes,
WebGL draw completion and the next animation-frame opportunity. Native
conversion is fresh on both opens. A warm browser context may reuse already
loaded code. Both systems use the normal OS file cache.
