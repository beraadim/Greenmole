# Native container compiler flags

The shared native build helper defaults an **unset** `CFLAGS` to portable `-O2`
and appends the dependency include path. An explicitly supplied value, including
an empty value for an unoptimized diagnostic build, remains authoritative.
Architecture-specific instruction selection and fast-math are not enabled.
Previously, include-only `CFLAGS` suppressed Autoconf's normal optimization
default; the shipped private.7 libguac Makefile contained no `-O` option.

This helper builds guacamole-server and the pinned FreeRDP, libssh2, libtelnet,
libvncclient and libwebsockets sources. CMake targets may append their own
configuration-specific flags (FreeRDP already uses `Release`). Distribution
Cairo, PNG, JPEG and WebP packages are unaffected. This is a compiler-setting
change, not a dependency upgrade or image-quality adjustment.

Validate the installed library through the pinned native build's `make check`
and a preflight RDP plugin handshake before deployment. Inspect the generated
`src/libguac/Makefile` to confirm the actual `CFLAGS`; the benchmark driver's own
`-O2` does not prove that the linked library is optimized. Compare the planner
bitmap against an optimized control, rather than attributing all gains to the
bitmap. Fixed codec/quality benchmark controls avoid conflating faster execution
with the production framerate-dependent encoder policy. The lossless serialized
protocol replay remains a separate correctness gate.
