#!/usr/bin/env python3
# Copyright 2026 Greenmole contributors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Verify the complete AngularJS security diff against its pinned MIT source.

This verifier never extracts arbitrary archive paths or runs downloaded code.
"""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    root = Path(__file__).resolve().parent
    provenance = json.loads((root / "provenance.json").read_text())
    upstream = provenance["upstream"]
    patch = root / "angular-1.8.3-security.patch"
    if digest(patch.read_bytes()) != provenance["patchSha256"]:
        raise ValueError("Security patch checksum mismatch")
    if digest((root / "angular.js").read_bytes()) != provenance["patchedAngularSha256"]:
        raise ValueError("Vendored AngularJS checksum mismatch")

    with tempfile.TemporaryDirectory(prefix="greenmole-angular-source-") as temporary:
        directory = Path(temporary)
        archive = directory / "angular.tgz"
        if len(sys.argv) == 2:
            archive.write_bytes(Path(sys.argv[1]).read_bytes())
        elif len(sys.argv) == 1:
            with urllib.request.urlopen(upstream["url"], timeout=30) as response:
                archive.write_bytes(response.read())
        else:
            raise ValueError("Usage: verify-source.py [angular-1.8.3.tgz]")
        if digest(archive.read_bytes()) != upstream["tarballSha256"]:
            raise ValueError("Upstream tarball checksum mismatch")
        with tarfile.open(archive) as package:
            source = package.extractfile("package/angular.js").read()
            license_text = package.extractfile("package/LICENSE.md").read()
        if digest(source) != upstream["angularSha256"]:
            raise ValueError("Upstream AngularJS checksum mismatch")
        if license_text != (root / "LICENSE.md").read_bytes():
            raise ValueError("Original Google MIT license has changed")
        (directory / "angular.js").write_bytes(source)
        subprocess.run(["patch", "--batch", "--forward", "-p1", "-i", str(patch)],
                       cwd=directory, check=True, stdout=subprocess.PIPE)
        if (directory / "angular.js").read_bytes() != (root / "angular.js").read_bytes():
            raise ValueError("Reapplying the security patch did not reproduce the vendored source")
    print("AngularJS upstream checksum, MIT license, and complete security patch verified.")


if __name__ == "__main__":
    main()
