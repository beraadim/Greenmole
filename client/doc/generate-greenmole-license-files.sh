#!/bin/sh
#
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
#

# Preserve the original Apache license metadata in the checkout. Additional
# reviewed license versions are applied only to a temporary copy, so both
# plain Maven and Docker builds can generate complete notices offline.
# The original generator still validates every runtime dependency and runs
# from the caller's directory to discover that module's bundled licenses.
set -eu
greenmole_doc=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
greenmole_license_overlay=$(mktemp -d "${TMPDIR:-/tmp}/greenmole-licenses.XXXXXXXX")
trap 'rm -rf -- "$greenmole_license_overlay"' EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$greenmole_license_overlay/doc"
cp "$greenmole_doc/../LICENSE" "$greenmole_doc/../NOTICE" "$greenmole_license_overlay/"
cp -R "$greenmole_doc/licenses" "$greenmole_license_overlay/doc/"

for supplement in "$greenmole_doc"/greenmole-license-supplements/*/LICENSE; do
    [ -f "$supplement" ] || continue
    dependency=$(basename -- "$(dirname -- "$supplement")")
    target="$greenmole_license_overlay/doc/licenses/$dependency/LICENSE"
    if [ ! -f "$target" ]; then
        printf 'No original license metadata for supplement: %s\n' "$dependency" >&2
        exit 1
    fi
    cat "$supplement" >> "$target"
done

# A dependency may change license terms between releases. In that case use
# explicit current-version metadata, not the old package's license label.
# The upstream generator fails if any requested version is absent.
for replacement in "$greenmole_doc"/greenmole-license-supplements/*/REPLACEMENT-LICENSE; do
    [ -f "$replacement" ] || continue
    dependency=$(basename -- "$(dirname -- "$replacement")")
    target="$greenmole_license_overlay/doc/licenses/$dependency/LICENSE"
    if [ ! -f "$target" ]; then
        printf 'No original license metadata for replacement: %s\n' "$dependency" >&2
        exit 1
    fi
    cp "$replacement" "$target"
done

"$greenmole_license_overlay/doc/licenses/generate-license-files.sh" "$@"
