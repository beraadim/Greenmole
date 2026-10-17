#!/bin/sh -e
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
#

# Apply only to the reviewed, pinned dependency. Other versions may contain a
# different implementation and must be reviewed instead of patched by context.
source_revision=9b678b6d5a40ce01607d8c3b1b1416437c8416c4
[ "$(git rev-parse HEAD)" = "$source_revision" ] || {
    echo "AVC444 primitive patch requires the reviewed FreeRDP source revision" >&2
    exit 1
}
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
patch_file="$script_dir/../patches/freerdp-avc444-ssse3-odd-chroma.patch"
printf '%s  %s\n' \
    df032d89ba1ffc779e71fe1affcac94ca99a7da2d5a107165f9e07f07495a9f2 \
    libfreerdp/primitives/prim_YUV_ssse3.c | sha256sum -c -
printf '%s  %s\n' \
    7ac74f19360d211efa45dac053e92ee32b1bbfc5f77292d5bd7fab55080e7a98 \
    "$patch_file" | sha256sum -c -
git apply --check "$patch_file"
git apply "$patch_file"
echo "Applied reviewed AVC444 SSSE3 placement and inverse-filter corrections"
