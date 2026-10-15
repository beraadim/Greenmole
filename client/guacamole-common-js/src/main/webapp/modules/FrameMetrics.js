/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

var Guacamole = Guacamole || {};

/**
 * Bounded numeric measurements for Guacamole sync frames. This helper retains
 * no image or instruction contents. The five-second window is additionally
 * capped at 256 observations, even if the peer sends frames unusually quickly.
 * @constructor
 */
Guacamole.FrameMetrics = function FrameMetrics() {
    var frames, processing, streams, streamCount, previousSync;
    var tiles, imageBytes, protocolBytes;

    var trim = function trim(values, current) {
        while (values.length && (values.length > 256 || current - values[0].time > 5000))
            values.shift();
    };

    var percentile = function percentile(values, fraction) {
        if (!values.length)
            return null;
        values.sort(function(a, b) { return a - b; });
        return values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
    };

    var blobSize = function blobSize(value) {
        var length = value.length;
        var padding = length && value.charAt(length - 1) === '=' ? 1 : 0;
        if (length > 1 && value.charAt(length - 2) === '=')
            padding++;
        return Math.max(0, Math.floor(length * 3 / 4) - padding);
    };

    /** Discards all measurements and image stream identifiers. */
    this.reset = function reset() {
        frames = [];
        processing = [];
        streams = Object.create(null);
        streamCount = 0;
        previousSync = null;
        tiles = imageBytes = protocolBytes = 0;
    };

    /**
     * Records one incoming instruction, using its already-counted wire text
     * size. Image payload counters exclude file/audio streams. Source frame
     * counts are available only when the server reports explicit boundaries.
     * @param {!string} opcode Instruction opcode.
     * @param {!string[]} args Instruction parameters.
     * @param {!number} size Decoded UTF-8 protocol bytes, including framing.
     * @param {!number} current Monotonic local timestamp in milliseconds.
     */
    this.receive = function receive(opcode, args, size, current) {
        protocolBytes += size;
        if (opcode === 'img') {
            tiles++;
            if (!streams[args[0]] && streamCount < 256) {
                streams[args[0]] = true;
                streamCount++;
            }
        }
        else if (opcode === 'png' || opcode === 'jpeg') {
            tiles++;
            imageBytes += blobSize(args[args.length - 1] || '');
        }
        else if (opcode === 'blob' && streams[args[0]])
            imageBytes += blobSize(args[1] || '');
        else if (opcode === 'end' && streams[args[0]]) {
            delete streams[args[0]];
            streamCount--;
        }

        if (opcode === 'sync') {
            var source = Number(args[1]);
            frames.push({
                time: current,
                tiles: tiles,
                imageBytes: imageBytes,
                protocolBytes: protocolBytes,
                sourceFrames: isFinite(source) && source > 0 ? source : 0,
                gap: previousSync !== null ? Math.max(0, current - previousSync) : null
            });
            previousSync = current;
            tiles = imageBytes = protocolBytes = 0;
            trim(frames, current);
        }
    };

    /** Records time from the last sync's arrival to completion of its flush. */
    this.rendered = function rendered(lag, current) {
        if (typeof lag === 'number' && isFinite(lag) && lag >= 0) {
            processing.push({time: current, lag: lag});
            trim(processing, current);
        }
    };

    /** Returns statistics for recent arrivals, not physical browser refreshes. */
    this.sample = function sample(current) {
        trim(frames, current);
        trim(processing, current);
        var count = frames.length;
        var sum = function sum(key) {
            return frames.reduce(function(total, frame) { return total + frame[key]; }, 0);
        };
        var gaps = frames.filter(function(frame) { return frame.gap !== null; })
            .map(function(frame) { return frame.gap; });
        var lags = processing.map(function(value) { return value.lag; });
        return {
            frameSamples: count,
            tilesPerFrame: count ? sum('tiles') / count : null,
            imageKiBPerFrame: count ? sum('imageBytes') / count / 1024 : null,
            protocolKiBPerFrame: count ? sum('protocolBytes') / count / 1024 : null,
            sourceFramesPerFrame: count && sum('sourceFrames') ? sum('sourceFrames') / count : null,
            syncGapP50: percentile(gaps, 0.5),
            syncGapP95: percentile(gaps, 0.95),
            processingP95: percentile(lags, 0.95)
        };
    };

    this.reset();
};
