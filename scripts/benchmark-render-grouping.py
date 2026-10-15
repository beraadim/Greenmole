#!/usr/bin/env python3
"""Compare a pinned renderer and the working renderer using the same tile traces.

This is a virtual-clock scheduling experiment, not an end-to-end FPS benchmark.
Requires a C compiler, pkg-config, and Cairo headers. No running service is used.
"""

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path("server/src/libguac/display-render-thread.c")
HARNESS = ROOT / "server/src/libguac/tests/display/render-thread.c"

CUNIT_STUB = r'''
#include <stdio.h>
#include <stdlib.h>
#define CU_ASSERT_EQUAL(a,b) do { if ((a)!=(b)) { fprintf(stderr,"%s:%d assertion failed: %s == %s\n",__FILE__,__LINE__,#a,#b); exit(1); } } while(0)
#define CU_ASSERT_NOT_EQUAL(a,b) do { if ((a)==(b)) { fprintf(stderr,"%s:%d assertion failed: %s != %s\n",__FILE__,__LINE__,#a,#b); exit(1); } } while(0)
'''

SUPPORT = r'''
#include <stdlib.h>
#include <stdio.h>
void* PRIV_guac_mem_zalloc(size_t count, const size_t* factors) {
    size_t size = 1;
    for (size_t i = 0; i < count; i++) size *= factors[i];
    return calloc(1, size);
}
void PRIV_guac_mem_free(void* mem) { free(mem); }
void guac_client_log(guac_client* client, guac_client_log_level level,
        const char* format, ...) {}
'''

MAIN = r'''
static void report(const char* scenario, int tile_updates, int total) {
    printf("{\"scenario\":\"%s\",\"first_flush_ms\":%lld,\"tiles_received\":%d,\"tiles_total\":%d}\n",
            scenario, (long long) current_time, tile_updates, total);
}
int main(void) {
    const render_test_event jitter[] = {
        { 8, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 1, 0 },
        { 16, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 2, 0 },
        { 24, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 3, 0 }
    };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, jitter, 3);
    report("unmarked-jitter-0-8-16-24ms", next_event + 1, 4);

    const render_test_event marked[] = {
        { 0, 0, 0, 0, 1 },
        { 18, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 1, 0 },
        { 36, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 2, 0 },
        { 47, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY, 1, 3, 0 }
    };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, marked, 4);
    report("marked-frame-end-47ms", 1 + (next_event > 1) + (next_event > 2), 3);

    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, NULL, 0);
    printf("{\"scenario\":\"isolated-unmarked-update\",\"first_flush_ms\":%lld}\n",
            (long long) current_time);
    return 0;
}
'''


def capture(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def run_version(directory, name, source, baseline):
    # Reuse the exact deterministic clock/flag harness from regression tests.
    # Existing private.2 lacks the start/reset API; its original start-ignoring
    # behavior is represented by no-op adapters, without altering its loop.
    harness = HARNESS.read_text().split(
        "/** A source frame remains coherent")[0]
    harness = harness.replace('#include "../../display-render-thread.c"', source)
    adapters = ""
    if baseline:
        adapters = """
void render_test_notify_start(guac_display_render_thread* thread) {}
void render_test_reset(guac_display_render_thread* thread) {}
"""
    path = directory / (name + ".c")
    path.write_text(harness + adapters + SUPPORT + MAIN)
    binary = directory / name
    flags = shlex.split(capture("pkg-config", "--cflags", "cairo", "libpng"))
    flags += ["-I" + capture("pkg-config", "--variable=includedir", "cairo")]
    strip = "-Wl,-dead_strip" if sys.platform == "darwin" else "-Wl,--gc-sections"
    subprocess.run([
        os.environ.get("CC", "cc"), "-std=gnu11", "-O2",
        "-ffunction-sections", "-fdata-sections", "-I" + str(directory),
        "-I" + str(ROOT / "server/src/libguac"), *flags, str(path),
        strip, "-o", str(binary)
    ], check=True, cwd=ROOT)
    return [json.loads(line) for line in capture(str(binary)).splitlines()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default="1.6.1-private.2")
    args = parser.parse_args()
    baseline_commit = capture("git", "rev-parse", args.baseline + "^{commit}")
    baseline_source = capture("git", "show", baseline_commit + ":" + str(SOURCE))
    with tempfile.TemporaryDirectory(prefix="guacamole-render-bench-") as temporary:
        directory = Path(temporary)
        (directory / "CUnit").mkdir()
        (directory / "CUnit/CUnit.h").write_text(CUNIT_STUB)
        results = {
            "measurement": "virtual-clock first batch submission; not network or FPS",
            "baseline_commit": baseline_commit,
            "baseline": run_version(directory, "baseline", baseline_source, True),
            "working_tree": run_version(directory, "working", (ROOT / SOURCE).read_text(), False),
        }
        print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
