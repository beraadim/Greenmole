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

/* global Guacamole, AVC420_SYNTHETIC_FIXTURE, expect, pending */

describe('Guacamole AVC420 real WebCodecs integration', function() {
    function bytes(base64) {
        return Uint8Array.from(window.atob(base64), function(value) { return value.charCodeAt(0); });
    }
    function envelope(sequence, frame, width, height) {
        var data = bytes(frame.base64), packet = new Uint8Array(20 + data.length);
        var header = new DataView(packet.buffer);
        header.setUint32(0, 0x47415631); header.setUint32(4, sequence);
        header.setUint16(8, width); header.setUint16(10, height);
        header.setUint32(12, frame.keyframe ? 1 : 0); header.setUint32(16, data.length);
        packet.set(data, 20);
        return packet;
    }
    async function waitFor(condition) {
        var start = performance.now();
        while (!condition()) {
            if (performance.now() - start > 1500) throw new Error('Presentation/stream timeout');
            await new Promise(function pause(resolve) { window.setTimeout(resolve, 1); });
        }
    }
    function near(actual, expected) {
        for (var i = 0; i < 3; i++) expect(Math.abs(actual[i] - expected[i])).toBeLessThan(12);
        expect(actual[3]).toBe(255);
    }

    it('decodes macrdp software/hardware IDRs and deltas through Client, crops padding and restores image fallback', async function() {
        if (!await Guacamole.AVC420VideoPlayer.checkSupport()) {
            pending('Real H.264 WebCodecs requires a compatible browser and secure context');
            return;
        }
        var sent = [];
        var tunnel = new Guacamole.Tunnel();
        tunnel.connect = function() {};
        tunnel.disconnect = function() {};
        tunnel.sendMessage = function() { sent.push(Array.from(arguments)); };
        var client = new Guacamole.Client(tunnel);
        var instruction = function(opcode, args) { tunnel.oninstruction(opcode, args.map(String)); };
        client.setExperimentalAvc420Enabled(true);
        client.connect('synthetic-fixture');
        var timestamp = 1;
        try {
            for (var s = 0; s < AVC420_SYNTHETIC_FIXTURE.sequences.length; s++) {
                var sequence = AVC420_SYNTHETIC_FIXTURE.sequences[s];
                instruction('size', [0, sequence.width, sequence.height]);
                instruction('video', [s, 0, Guacamole.AVC420VideoPlayer.MIMETYPE]);
                expect(sent.some(function(ack) { return ack[0] === 'ack' && ack[1] === s && ack[2] === 'AVC420:ready'; })).toBe(true);
                // Deliberately batch six frames before allowing decoder callbacks.
                for (var f = 0; f < sequence.frames.length; f++) {
                    var packet = envelope(f + 1, sequence.frames[f], sequence.width, sequence.height);
                    for (var offset = 0; offset < packet.length; offset += 31)
                        instruction('blob', [s, window.btoa(String.fromCharCode.apply(null, packet.slice(offset, offset + 31)))]);
                    instruction('sync', [timestamp++]);
                }
                await waitFor(function() { return sent.some(function(ack) {
                    return ack[0] === 'ack' && ack[1] === s && ack[2] === 'AVC420:6';
                }); });
                expect(client.getVideoStatistics().status).toBe('playing');
                var canvas = client.getDisplay().flatten();
                expect(canvas.width).toBe(sequence.width); expect(canvas.height).toBe(sequence.height);
                var context = canvas.getContext('2d');
                near(context.getImageData(5, 5, 1, 1).data, [220, 16, 16]);
                near(context.getImageData(sequence.width - 5, 5, 1, 1).data, [16, 220, 16]);
                near(context.getImageData(5, sequence.height - 5, 1, 1).data, [16, 16, 220]);
                near(context.getImageData(90, 45, 1, 1).data, [255, 255, 255]);
                instruction('end', [s]);
            }
            // An image following stream end must replace video without any late
            // decoder output overwriting it. Exercise the actual img/blob path.
            var image = document.createElement('canvas'); image.width = 352; image.height = 208;
            var imageContext = image.getContext('2d'); imageContext.fillStyle = '#e020c0'; imageContext.fillRect(0, 0, 352, 208);
            instruction('img', [99, 12, 0, 'image/png', 0, 0]);
            instruction('blob', [99, image.toDataURL().split(',')[1]]); instruction('end', [99]);
            var finalTimestamp = timestamp++;
            instruction('sync', [finalTimestamp]);
            await waitFor(function() { return sent.some(function(message) { return message[0] === 'sync' && message[1] === finalTimestamp; }); });
            near(client.getDisplay().flatten().getContext('2d').getImageData(5, 5, 1, 1).data, [224, 32, 192]);
            expect(client.getVideoStatistics().status).toBe('fallback');
            expect(client.getVideoStatistics().presentedFrames).toBe(24);
            expect(sent.some(function(message) { return message[0] === 'ack' && message[2] === 'AVC420:fallback'; })).toBe(false);
        }
        finally { client.disconnect(); }
    });
});
