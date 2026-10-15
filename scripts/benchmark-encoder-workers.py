#!/usr/bin/env python3
"""Measure production Guacamole encoding on synthetic desktop tiles.

Requires Docker and a local image built with --target guacamole-server using the
release's pinned native build arguments. Does not use runtime config, network,
or real desktops. The live guacd service is never modified or contacted.
"""

import argparse
import json
from pathlib import Path
import shlex
import subprocess


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "scripts/benchmarks/encoder-workers.c"


def bounded(minimum, maximum):
    def parse(text):
        value = int(text)
        if not minimum <= value <= maximum:
            raise argparse.ArgumentTypeError(f"expected {minimum}..{maximum}")
        return value
    return parse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docker-image", required=True,
                        help="existing local native guacamole-server build-stage image")
    parser.add_argument("--samples", type=bounded(2, 1000), default=30)
    parser.add_argument("--warmup", type=bounded(0, 100), default=5)
    parser.add_argument("--cpuset-cpus", help="optional fixed CPU affinity for comparison")
    args = parser.parse_args()

    # All mount paths are literal argv entries. Only bounded numbers are added
    # to the fixed compiler command. No environment/configuration is mounted.
    command = """set -eu
export TMPDIR=/run/encoderbench
export LD_LIBRARY_PATH=/opt/guacamole/lib
cc -O2 -std=gnu11 -Wall -Werror -pedantic -pthread \\
    -I/tmp/guacamole-server/src/libguac \\
    $(pkg-config --cflags cairo) \\
    /bench/encoder-workers.c -L/opt/guacamole/lib \\
    -Wl,-rpath,/opt/guacamole/lib -Wl,-z,stack-size=8388608 \\
    -lguac $(pkg-config --libs cairo) \\
    -o /run/encoderbench/benchmark
exec /run/encoderbench/benchmark SAMPLES WARMUP
""".replace("SAMPLES", shlex.quote(str(args.samples))).replace(
            "WARMUP", shlex.quote(str(args.warmup)))
    docker = ["docker", "run", "--rm", "--pull=never", "--network=none",
              "--read-only", "--tmpfs", "/run/encoderbench:rw,exec,size=128m",
              "--cap-drop=ALL", "--security-opt", "no-new-privileges",
              "--memory=1g", "--pids-limit=128", "--mount",
              f"type=bind,src={SOURCE},dst=/bench/encoder-workers.c,readonly"]
    if args.cpuset_cpus:
        docker.extend(["--cpuset-cpus", args.cpuset_cpus])
    docker.extend([args.docker_image, "/bin/sh", "-c", command])
    result = subprocess.run(docker, text=True, stdout=subprocess.PIPE, check=True)
    cases = [json.loads(line) for line in result.stdout.splitlines() if line]
    if len(cases) != 16:
        raise RuntimeError(f"expected 16 complete benchmark cases, received {len(cases)}")
    image = json.loads(subprocess.check_output(
        ["docker", "image", "inspect", args.docker_image], text=True))[0]
    print(json.dumps({
        "measurement": "encode+Guacamole blob serialization to a shared discard socket; no network/browser",
        "fixtures": "deterministic synthetic grayscale text and gradient with grain",
        "quality": {"jpeg": 80, "webp": 80, "webp_lossless": False},
        "image_id": image["Id"],
        "source_revision": (image.get("Config", {}).get("Labels") or {}).get(
            "org.opencontainers.image.revision"),
        "cpuset_cpus": args.cpuset_cpus,
        "cpu_limit": "no additional CPU quota; host scheduling can affect results",
        "cases": sorted(cases, key=lambda case: (case["scenario"], case["workers"])),
    }, indent=2))


if __name__ == "__main__":
    main()
