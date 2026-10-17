#!/usr/bin/env python3
#
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""Package the public macrdp paired-codec fixtures for browser regressions.

Run macrdp's export_avc420_fixture example with --avc444 first, then pass its
fixture.json here. Source YUV/BGRA and the independently decoded I420 views
provide sparse, independent color references without retaining full raw frames
in the repository. No desktop capture or production account is used.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("manifest", type=Path)
args = parser.parse_args()
base = args.manifest.resolve().parent
manifest = json.loads(args.manifest.read_text())
assert manifest["synthetic"] is True and manifest["codec"] == "avc444"
assert manifest["version"] == 1 and manifest["singleDecoder"] is True
result = {"sequences": []}


def rgb(y, u, v):
    u -= 128
    v -= 128
    return [round(max(0, min(255, c))) for c in
            (y + 1.5748 * v, y - .187324 * u - .468124 * v, y + 1.8556 * u)]


for seq in manifest["sequences"]:
    frames = []
    for frame in seq["frames"]:
        frames.append({"main": base64.b64encode((base / frame["mainFile"]).read_bytes()).decode(),
                       "aux": base64.b64encode((base / frame["auxFile"]).read_bytes()).decode(),
                       "mainKey": frame["mainKeyframe"], "auxKey": frame["auxKeyframe"]})
    last = seq["frames"][-1]
    width, height = last["encodedWidth"], last["encodedHeight"]
    size = width * height
    main = (base / last["mainDecodedFile"]).read_bytes()
    auxiliary = (base / last["auxDecodedFile"]).read_bytes()
    source = (base / last["sourceFile"]).read_bytes()
    assert len(main) == len(auxiliary) == size * 3 // 2
    assert len(source) == seq["width"] * seq["height"] * 4

    def uv(data, x, y):
        offset = y // 2 * (width // 2) + x // 2
        return [data[size + offset], data[size + size // 4 + offset]]

    def odd(x, y):
        row = (y // 2 // 8) * 16 + (y // 2) % 8
        return [auxiliary[row * width + x], auxiliary[(row + 8) * width + x]]

    points = []
    coords = [(5, 5), (seq["width"] - 5, 5), (5, seq["height"] - 5),
              (seq["width"] - 5, seq["height"] - 5)]
    coords += [(x, y) for x in range(96, 104) for y in [96, 97, 120, 121, 142, 143]]
    for x, y in coords:
        if y % 2:
            u, v = odd(x, y)
        elif x % 2:
            u, v = uv(auxiliary, x, y)
        else:
            u, v = [max(0, min(255, 4 * a - b - c - d)) for a, b, c, d in
                    zip(uv(main, x, y), uv(auxiliary, x, y), odd(x, y + 1), odd(x + 1, y + 1))]
        offset = (y * seq["width"] + x) * 4
        b, g, r, _ = source[offset:offset + 4]
        points.append({"x": x, "y": y, "decoded": rgb(main[y * width + x], u, v),
                       "source": [r, g, b], "main420": rgb(main[y * width + x], *uv(main, x, y))})
    result["sequences"].append({"name": seq["name"], "width": seq["width"], "height": seq["height"],
                                "frames": frames, "points": points,
                                "lastMainDecodedSha256": hashlib.sha256(main).hexdigest(),
                                "lastAuxDecodedSha256": hashlib.sha256(auxiliary).hexdigest()})
root = Path(__file__).resolve().parent.parent
license_header = (root / "src/main/webapp/modules/AVC420VideoPlayer.js").read_text().split("var Guacamole")[0]
output = root / "src/test/javascript/AVC444SyntheticFixture.js"
output.write_text(license_header + "/* Public synthetic macrdp software/hardware streams, no user desktop data. */\n"
                  + "var AVC444_SYNTHETIC_FIXTURE = " + json.dumps(result, separators=(",", ":")) + ";\n")
print(output)
