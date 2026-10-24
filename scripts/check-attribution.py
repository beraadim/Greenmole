#!/usr/bin/env python3
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Verify preserved upstream attribution and file-local modification notices.

The upstream revisions must already exist in this repository. No network access
or third-party dependencies are used. --update writes only the derived manifest;
notices themselves must be reviewed and added to each modified source file.
"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "DOWNSTREAM-CHANGES.json"
NOTICE = "Modified for Greenmole by its maintainers."
JSON_NOTICE_KEY = "_greenmoleModificationNotice"


def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=ROOT)


def blob_id(data):
    return hashlib.sha1(
        b"blob " + str(len(data)).encode("ascii") + b"\0" + data
    ).hexdigest()


def upstream_files(revision):
    files = {}
    for record in git("ls-tree", "-rz", revision).split(b"\0"):
        if record:
            metadata, name = record.split(b"\t", 1)
            mode, kind, digest = metadata.decode("ascii").split()
            if kind != "blob":
                raise ValueError("Unexpected non-file upstream entry")
            files[name.decode("utf-8")] = (mode, digest)
    return files


def is_attribution_file(name):
    """Include third-party notices with suffixes and their license directories."""
    path = Path(name)
    return (path.name.upper().startswith(("LICENSE", "NOTICE", "COPYING"))
            or "licenses" in path.parts)


def check_notice(path, data):
    if path.suffix == ".json":
        try:
            value = json.loads(data)
        except (UnicodeError, ValueError) as error:
            return "Invalid JSON: " + str(error)
        if not isinstance(value, dict):
            return "Modified JSON must contain a file-local notice"
        if not str(value.get(JSON_NOTICE_KEY, "")).startswith(NOTICE):
            return "Missing file-local JSON modification notice"
    elif NOTICE.encode("utf-8") not in data[:4096]:
        return "Missing prominent file-local modification notice"
    return None


def inspect():
    errors = []
    components = {}
    protected = 0
    metadata = json.loads((ROOT / "UPSTREAM.json").read_text())
    for component, upstream in sorted(metadata["components"].items()):
        revision = upstream["commit"]
        reachable = subprocess.run(
            ["git", "merge-base", "--is-ancestor", revision, "HEAD"],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        ).returncode == 0
        if not reachable:
            errors.append(f"{component}: recorded upstream revision is not an ancestor of HEAD")
        modified = []
        removed = []
        for name, (mode, digest) in sorted(upstream_files(revision).items()):
            path = ROOT / component / name
            relative = path.relative_to(ROOT).as_posix()
            if path.is_symlink():
                data = path.readlink().as_posix().encode("utf-8")
            elif path.is_file():
                data = path.read_bytes()
            else:
                if is_attribution_file(name):
                    errors.append(f"{relative}: upstream attribution file was removed")
                else:
                    # Retiring obsolete code is allowed, but must be explicitly
                    # recorded in the reviewed manifest. The reachable upstream
                    # revision and original blob retain its source attribution.
                    removed.append({"path": relative, "upstream_blob": digest})
                continue
            if is_attribution_file(name):
                protected += 1
                if blob_id(data) != digest:
                    errors.append(f"{relative}: upstream attribution text changed")
            if blob_id(data) == digest:
                continue
            issue = check_notice(path, data)
            if issue:
                errors.append(f"{relative}: {issue}")
            modified.append(relative)
        components[component] = {
            "upstream_url": upstream["url"],
            "upstream_commit": revision,
            "modified_files": modified,
            "removed_files": removed,
        }

    # The root license is an exact upstream copy. Root NOTICE adds independent
    # downstream attribution after the intact Apache client NOTICE.
    client = metadata["components"]["client"]["commit"]
    server = metadata["components"]["server"]["commit"]
    if (ROOT / "LICENSE").read_bytes() != git("show", server + ":LICENSE"):
        errors.append("LICENSE: root Apache license differs from upstream")
    root_notice = (ROOT / "NOTICE").read_bytes()
    if not root_notice.startswith(git("show", client + ":NOTICE")):
        errors.append("NOTICE: root Apache attribution was not preserved verbatim")
    if b"Greenmole" not in root_notice or b"not affiliated with" not in root_notice:
        errors.append("NOTICE: independent Greenmole attribution is missing")

    manifest = {
        "format_version": 2,
        "description": "Files modified or retired for Greenmole from the recorded Apache Guacamole source revisions.",
        "modification_notice": NOTICE,
        "json_notice_key": JSON_NOTICE_KEY,
        "components": components,
    }
    return manifest, protected, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true", help="Regenerate the modified-file manifest")
    options = parser.parse_args()
    manifest, protected, errors = inspect()
    expected = json.dumps(manifest, indent=2) + "\n"
    if options.update:
        MANIFEST.write_text(expected)
    elif not MANIFEST.exists() or MANIFEST.read_text() != expected:
        errors.append("DOWNSTREAM-CHANGES.json is stale; run scripts/check-attribution.py --update")
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    count = sum(len(value["modified_files"]) for value in manifest["components"].values())
    retired = sum(len(value["removed_files"]) for value in manifest["components"].values())
    print(f"Attribution verified: {count} modified files carry notices; "
          f"{retired} retired source files are recorded; "
          f"{protected} upstream license/notice files are unchanged; "
          "both upstream histories remain reachable.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
