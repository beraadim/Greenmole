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

// Browser-side fixture for benchmark-browser-render.mjs --scenario protocol.
export const protocolReplay = String.raw`
window.__renderReplay = (async function() {
    const originalSocket = window.WebSocket;
    const originalTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    const pendingTimeouts = new Set();
    let counters = null;
    if (window.__measureTimers) {
        window.setTimeout = function(callback, delay, ...args) {
            if (counters) counters.created++;
            const id = originalTimeout.call(window, function(...values) {
                pendingTimeouts.delete(id);
                callback(...values);
            }, delay, ...args);
            pendingTimeouts.add(id);
            if (counters) counters.peak = Math.max(counters.peak, pendingTimeouts.size);
            return id;
        };
        window.clearTimeout = function(id) {
            if (counters) counters.cleared++;
            pendingTimeouts.delete(id);
            return originalClearTimeout.call(window, id);
        };
    }
    const scenarios = [];
    const packet = values => Guacamole.Parser.toInstruction(values);
    for (const scenario of [
        { name: 'small-copy-burst', frames: 22000, copies: 1, width: 128, height: 128, fill: false },
        { name: 'window-copy-burst', frames: 6000, copies: 4, width: 1280, height: 720, fill: false },
        { name: 'mixed-1080p-burst', frames: 3000, copies: 8, width: 1920, height: 1080, fill: true },
        ...(window.__measureTimers ? [{ name: 'packetized-copy-burst', frames: 6000, copies: 4,
            width: 1280, height: 720, fill: false, packetFrames: 6 }] : [])
    ]) {
        let socket;
        let initial;
        let finish;
        let started;
        const initialized = new Promise(resolve => { initial = resolve; });
        const complete = new Promise(resolve => { finish = resolve; });
        const acknowledgements = [];
        const ackParser = new Guacamole.Parser();
        ackParser.oninstruction = (opcode, args) => {
            if (opcode !== 'sync') return;
            const timestamp = Number(args[0]);
            if (timestamp === 1000) initial();
            else {
                acknowledgements.push({ timestamp, time: performance.now() });
                if (timestamp === 1000 + scenario.frames) finish();
            }
        };
        window.WebSocket = function() {
            socket = this;
            this.send = text => ackParser.receive(text);
            this.close = () => {};
        };
        const tunnel = new Guacamole.WebSocketTunnel('ws://localhost/synthetic-no-network');
        const client = new Guacamole.Client(tunnel);
        const display = client.getDisplay();
        document.body.appendChild(display.getElement());
        let failure;
        client.onerror = status => { failure = status; initial(); finish(); };
        client.connect('synthetic-no-credentials');
        socket.onmessage({ data: packet(['', 'synthetic-uuid'])
            + packet(['size', 0, scenario.width, scenario.height])
            + packet(['size', -1, scenario.width, scenario.height])
            + packet(['rect', -1, 0, 0, scenario.width, scenario.height])
            + packet(['cfill', 12, -1, 20, 40, 60, 255])
            + packet(['sync', 1000]) });
        await initialized;
        if (failure) throw Error('Initialization failed: ' + failure.message);

        let burst = '';
        const packets = [];
        let wireLength = 0;
        for (let frame = 1; frame <= scenario.frames; frame++) {
            for (let copy = 0; copy < scenario.copies; copy++)
                burst += packet(['copy', -1, 0, 0, scenario.width, scenario.height, 12, 0, 0, 0]);
            if (scenario.fill)
                burst += packet(['rect', 0, 0, 0, 64, 64])
                    + packet(['cfill', 12, 0, frame % 256, 80, 120, 255]);
            burst += packet(['sync', 1000 + frame]);
            if (scenario.packetFrames && frame % scenario.packetFrames === 0) {
                packets.push(burst);
                wireLength += burst.length;
                burst = '';
            }
        }
        if (burst) { packets.push(burst); wireLength += burst.length; }
        let inputTask;
        const inputChannel = new MessageChannel();
        const inputComplete = new Promise(resolve => {
            inputChannel.port1.onmessage = () => {
                inputTask = { delay: performance.now() - started, completed: acknowledgements.length };
                inputChannel.port1.close(); inputChannel.port2.close(); resolve();
            };
        });
        started = performance.now();
        counters = window.__measureTimers ? { created: 0, cleared: 0, peak: pendingTimeouts.size } : null;
        inputChannel.port2.postMessage(null);
        for (const text of packets) socket.onmessage({ data: text });
        await Promise.all([complete, inputComplete]);
        if (failure) throw Error('Replay failed: ' + failure.message);
        if (acknowledgements.length !== scenario.frames
                || acknowledgements.some((ack, index) => ack.timestamp !== 1001 + index))
            throw Error('Frame acknowledgement order changed');
        const pixel = Array.from(display.getDefaultLayer().getCanvas().getContext('2d').getImageData(1, 1, 1, 1).data);
        const expected = scenario.fill ? [scenario.frames % 256, 80, 120, 255] : [20, 40, 60, 255];
        if (JSON.stringify(pixel) !== JSON.stringify(expected))
            throw Error('Final canvas pixels changed: ' + JSON.stringify(pixel));
        const times = acknowledgements.map(ack => ack.time);
        scenarios.push({ scenario: scenario.name, frames: scenario.frames,
            canvas_width: scenario.width, canvas_height: scenario.height,
            copies_per_frame: scenario.copies, wire_text_code_units: wireLength, packets: packets.length,
            completion_ms: times[times.length - 1] - started,
            input_task_delay_ms: inputTask.delay, input_task_completed_frames: inputTask.completed,
            maximum_ack_gap_ms: Math.max(...times.slice(1).map((time, index) => time - times[index])),
            final_pixel: pixel, acknowledgements_in_order: true,
            ...(counters ? { timeouts_created: counters.created, timeouts_cleared: counters.cleared,
                peak_pending_timeouts: counters.peak } : {}) });
        counters = null;
        client.disconnect();
        display.getElement().remove();
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    window.WebSocket = originalSocket;
    window.setTimeout = originalTimeout;
    window.clearTimeout = originalClearTimeout;
    return scenarios;
})();`;

export const timerReplay = 'window.__measureTimers = true;\n' + protocolReplay;
