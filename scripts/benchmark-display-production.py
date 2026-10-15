#!/usr/bin/env python3
"""Compare the real Guacamole planner/FIFO/encoder path without a live desktop."""

import argparse
import json
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "scripts/benchmarks/display-production.c"
CASES = ["small-text", "scroll-text", "partial-text-redraw", "mixed-4k-desktop",
         "wallpaper-4k", "partial-photo-on-4k", "small-photo-on-4k",
         "window-1920x944", "window-2560x1304"]


def bounded(minimum, maximum):
    def parse(text):
        value = int(text)
        if not minimum <= value <= maximum:
            raise argparse.ArgumentTypeError(f"expected {minimum}..{maximum}")
        return value
    return parse


def run(image, mode, samples, warmup, workers, cpuset, selected_cases):
    binary_mode = "adaptive" if mode.startswith("adaptive") else mode
    cap = int(mode.split("-")[1]) if "-" in mode else 1
    compile_flags = "-DBENCH_CONCURRENCY_FIELDS" if binary_mode != "baseline" else ""
    command = r"""set -eu
export TMPDIR=/run/encoderbench
export LD_LIBRARY_PATH=/opt/guacamole/lib
cd /run/encoderbench
cc -O2 -std=gnu11 -Wall -Werror -pedantic -pthread EXTRA_FLAGS \
    -I/tmp/guacamole-server/src/libguac $(pkg-config --cflags cairo) \
    /bench/display-production.c -L/opt/guacamole/lib \
    -Wl,-rpath,/opt/guacamole/lib -Wl,-z,stack-size=8388608 \
    -lguac -ldl $(pkg-config --libs cairo) -o /run/encoderbench/benchmark
exec /run/encoderbench/benchmark MODE SAMPLES WARMUP ACTIVE_CAP CASE_FILTER
""".replace("MODE", shlex.quote(binary_mode)).replace("SAMPLES", str(samples)).replace("WARMUP", str(warmup)).replace(
        "ACTIVE_CAP", str(cap)).replace("CASE_FILTER", shlex.quote(",".join(selected_cases))).replace("EXTRA_FLAGS", compile_flags)
    docker = ["docker", "run", "--rm", "--pull=never", "--network=none",
              "--read-only", "--tmpfs", "/run/encoderbench:rw,exec,size=128m",
              "--cap-drop=ALL", "--security-opt", "no-new-privileges",
              "--memory=1g", "--pids-limit=128", "--env",
              f"GUAC_DISPLAY_WORKER_THREADS={workers}", "--mount",
              f"type=bind,src={SOURCE},dst=/bench/display-production.c,readonly"]
    if cpuset:
        docker += ["--cpuset-cpus", cpuset]
    docker += [image, "/bin/sh", "-c", command]
    result = subprocess.run(docker, text=True, stdout=subprocess.PIPE, check=True)
    cases = [json.loads(line) for line in result.stdout.splitlines() if line]
    if len(cases) != len(selected_cases) or any(case["mode"] != binary_mode for case in cases):
        raise RuntimeError(f"expected {len(selected_cases)} complete {mode} cases")
    details = json.loads(subprocess.check_output(["docker", "image", "inspect", image], text=True))[0]
    return {"image": image, "image_id": details["Id"], "mode": mode,
            "source_revision": (details.get("Config", {}).get("Labels") or {}).get("org.opencontainers.image.revision"),
            "cases": cases}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-image", required=True)
    parser.add_argument("--candidate-image", required=True)
    parser.add_argument("--samples", type=bounded(2, 1000), default=30)
    parser.add_argument("--warmup", type=bounded(0, 100), default=5)
    parser.add_argument("--workers", type=bounded(1, 64), default=22)
    parser.add_argument("--cpuset-cpus")
    parser.add_argument("--modes", nargs="+", choices=["baseline", "fixed", "adaptive", "adaptive-8", "adaptive-12", "adaptive-16"],
                        default=["baseline", "fixed", "adaptive"])
    parser.add_argument("--cases", nargs="+", choices=CASES, default=CASES)
    parser.add_argument("--reverse", action="store_true", help="reverse mode order to check host drift")
    args = parser.parse_args()
    modes = [(args.baseline_image if mode == "baseline" else args.candidate_image, mode)
             for mode in args.modes]
    if args.reverse:
        modes.reverse()
    runs = [run(image, mode, args.samples, args.warmup, args.workers, args.cpuset_cpus, args.cases)
            for image, mode in modes]
    print(json.dumps({
        "measurement": "production display planner, copy search, FIFO, workers, codecs and serialization to a shared discard socket",
        "limitations": "synthetic fixtures; no capture, RDP transport, browser, Wi-Fi, physical input or frame pacing; copied pixels/planner/encoding included, fixture generation excluded",
        "fixture_note": "scroll-text translates existing text; partial-text-redraw changes glyph contents; full-window cases preserve actual non-4K dimensions",
        "worker_pool": args.workers, "cpuset_cpus": args.cpuset_cpus,
        "samples": args.samples, "warmup": args.warmup, "runs": runs,
    }, indent=2))


if __name__ == "__main__":
    main()
