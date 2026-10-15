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
 * Opt-in, sampled diagnostics for a live client. Construct after the client's
 * instruction handler is installed, before connecting the tunnel. Only numeric
 * counters are retained; instruction contents are never stored or logged.
 *
 * @constructor
 * @param {!Guacamole.Display} display The client's display.
 * @param {!Guacamole.Tunnel} tunnel The client's tunnel.
 */
Guacamole.ClientPerformance = function ClientPerformance(display, tunnel) {

    var enabled = false;
    var bytes = 0;
    var started = 0;
    var latest = null;
    var updated = 0;
    var previousWindow;
    var previousStatistics;
    var instruction = tunnel.oninstruction;
    var frames = new Guacamole.FrameMetrics();

    var now = function now() { return window.performance.now(); };

    // Count UTF-8 protocol bytes without allocating another copy of image data.
    var elementSize = function elementSize(value, ascii) {
        var text = String(value);
        var points = text.length;
        var length = text.length;
        if (!ascii) {
            for (var i = 0; i < text.length; i++) {
                var code = text.charCodeAt(i);
                if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length
                        && text.charCodeAt(i + 1) >= 0xDC00 && text.charCodeAt(i + 1) <= 0xDFFF) {
                    length += 2;
                    points--;
                    i++;
                }
                else if (code > 0x7FF)
                    length += 2;
                else if (code > 0x7F)
                    length++;
            }
        }
        return length + String(points).length + 2; // length prefix, dot, delimiter
    };

    tunnel.oninstruction = function measuredInstruction(opcode, args) {
        if (enabled) {
            var size = elementSize(opcode, true);
            for (var i = 0; i < args.length; i++)
                size += elementSize(args[i], opcode === 'blob');
            bytes += size;
            frames.receive(opcode, args, size, now());
        }
        if (instruction)
            return instruction.apply(this, arguments);
    };

    var statistics = function statistics(value) {
        latest = value;
        updated = now();
        frames.rendered(value.processingLag, updated);
        if (previousStatistics)
            previousStatistics.apply(display, arguments);
    };

    /** Enables collection. Repeated calls do not reset an active sample. */
    this.start = function start() {
        if (enabled)
            return;
        enabled = true;
        bytes = 0;
        latest = null;
        frames.reset();
        started = now();
        previousWindow = display.statisticWindow;
        previousStatistics = display.onstatistics;
        display.statisticWindow = 1000;
        display.onstatistics = statistics;
    };

    /** Stops collection and restores the display's previous statistics handler. */
    this.stop = function stop() {
        if (!enabled)
            return;
        enabled = false;
        bytes = 0;
        latest = null;
        frames.reset();
        if (display.onstatistics === statistics) {
            display.onstatistics = previousStatistics;
            display.statisticWindow = previousWindow;
        }
    };

    /**
     * Returns and resets the current throughput sample. Rates represent decoded
     * Guacamole protocol text, excluding transport headers, TLS and compression.
     * Browser processing lag is not network RTT or input-to-display latency.
     * @returns {!object} Current numeric measurements and transport name.
     */
    this.sample = function sample() {
        var current = now();
        var duration = current - started;
        var connected = tunnel.isConnected();
        var recent = enabled && connected && latest && current - updated < 1500 ? latest : null;
        var result = {
            transport: tunnel.getTransport(),
            connected: connected,
            kibPerSecond: enabled && duration > 0 ? bytes / 1024 * 1000 / duration : 0,
            clientFps: recent ? recent.clientFps : null,
            desktopFps: recent ? recent.desktopFps : null,
            processingLag: recent ? recent.processingLag : null,
            width: display.getWidth(),
            height: display.getHeight()
        };
        var frameSample = frames.sample(current);
        Object.keys(frameSample).forEach(function(key) { result[key] = frameSample[key]; });
        if (duration > 0 || !enabled) {
            bytes = 0;
            started = current;
        }
        return result;
    };

};
