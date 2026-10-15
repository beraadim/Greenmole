#!/usr/bin/env python3
"""Build a matched private image pair from reviewed release inputs."""

import argparse
import json
import os
from pathlib import Path
import subprocess


def main():
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release", type=Path, help="release JSON containing pinned inputs")
    parser.add_argument("--component", choices=("all", "server", "client"), default="all")
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.jobs <= 32:
        parser.error("--jobs must be between 1 and 32")
    release = json.loads(args.release.read_text())
    revision = os.environ.get("SOURCE_REVISION") or subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    for component, spec in release["images"].items():
        if args.component not in ("all", component):
            continue
        command = [
            "docker", "build", "--progress=plain", "--platform", release["platform"],
            "--tag", spec["tag"],
            "--label", f"org.opencontainers.image.revision={revision}",
            "--label", f"org.opencontainers.image.version={release['version']}",
            "--label", "org.opencontainers.image.source=https://github.com/beraadim/guacamole-private",
        ]
        build_args = dict(spec["build_args"])
        if component == "server":
            build_args["BUILD_JOBS"] = str(args.jobs)
        for key, value in build_args.items():
            command.extend(["--build-arg", f"{key}={value}"])
        command.append(str(root / component))
        subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
