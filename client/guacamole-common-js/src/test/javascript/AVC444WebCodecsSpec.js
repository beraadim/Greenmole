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

/* global Guacamole, AVC444_SYNTHETIC_FIXTURE, expect, pending */

describe('Guacamole AVC444 real WebCodecs integration', function() {
    function bytes(base64) { return Uint8Array.from(window.atob(base64), function(value) { return value.charCodeAt(0); }); }
    function envelope(sequence, frame, width, height) {
        var main = bytes(frame.main), aux = bytes(frame.aux), packet = new Uint8Array(48 + main.length + aux.length);
        var view = new DataView(packet.buffer);
        view.setUint32(0, 0x47415632); view.setUint32(4, sequence); view.setUint16(8, width); view.setUint16(10, height);
        view.setUint32(12, 0x10000 | (frame.mainKey ? 1 : 0) | (frame.auxKey ? 2 : 0));
        view.setUint32(16, main.length); view.setUint32(20, aux.length); view.setUint16(24, 1); view.setUint16(26, 1);
        for (var side = 0; side < 2; side++) { view.setUint16(32 + side * 8 + 4, width); view.setUint16(32 + side * 8 + 6, height); }
        packet.set(main, 48); packet.set(aux, 48 + main.length); return packet;
    }
    async function waitFor(condition) {
        var start = performance.now();
        while (!condition()) {
            if (performance.now() - start > 1800) throw new Error('AVC444 presentation timeout');
            await new Promise(function pause(resolve) { window.setTimeout(resolve, 1); });
        }
    }
    it('decodes paired software/hardware streams, reconstructs full chroma, crops and returns to images', async function() {
        if (!await Guacamole.AVC444VideoPlayer.checkSupport()) {
            pending('Real AVC444 requires native I420/NV12 WebCodecs and WebGL2 in a secure browser'); return;
        }
        var sent = [], tunnel = new Guacamole.Tunnel();
        tunnel.connect = function() {}; tunnel.disconnect = function() {};
        tunnel.sendMessage = function() { sent.push(Array.from(arguments)); };
        var client = new Guacamole.Client(tunnel), timestamp = 1;
        var instruction = function(opcode, args) { tunnel.oninstruction(opcode, args.map(String)); };
        client.setExperimentalAvc444Enabled(true); client.connect('synthetic');
        try {
            var total = 0;
            for (var s = 0; s < AVC444_SYNTHETIC_FIXTURE.sequences.length; s++) {
                var sequence = AVC444_SYNTHETIC_FIXTURE.sequences[s];
                instruction('size', [0, sequence.width, sequence.height]);
                instruction('video', [s, 0, Guacamole.AVC444VideoPlayer.MIMETYPE]);
                expect(sent.some(function(a) { return a[0] === 'ack' && a[1] === s && a[2] === 'AVC444:ready'; })).toBe(true);
                for (var f = 0; f < sequence.frames.length; f++) {
                    var packet = envelope(f + 1, sequence.frames[f], sequence.width, sequence.height);
                    for (var offset = 0; offset < packet.length; offset += 29)
                        instruction('blob', [s, window.btoa(String.fromCharCode.apply(null, packet.slice(offset, offset + 29)))]);
                    instruction('sync', [timestamp++]);
                }
                await waitFor(function() { return sent.some(function(a) { return a[0] === 'ack' && a[1] === s && a[2] === 'AVC444:6'; }); });
                total += sequence.frames.length;
                expect(client.getVideoStatistics().codec).toBe('avc444');
                expect(client.getVideoStatistics().presentedFrames).toBe(total);
                var canvas = client.getDisplay().flatten(), context = canvas.getContext('2d');
                expect(canvas.width).toBe(sequence.width); expect(canvas.height).toBe(sequence.height);
                var error = 0, baseline = 0, sourceError = 0;
                sequence.points.forEach(function point(point) {
                    var actual = context.getImageData(point.x, point.y, 1, 1).data;
                    expect(actual[3]).toBe(255);
                    point.decoded.forEach(function channel(value, c) {
                        expect(Math.abs(actual[c] - value)).withContext(sequence.name + ' ' + point.x + ',' + point.y + ' channel ' + c).toBeLessThan(13);
                        error += Math.abs(actual[c] - point.source[c]);
                        baseline += Math.abs(point.main420[c] - point.source[c]);
                        sourceError += Math.abs(value - point.source[c]);
                    });
                });
                // Alternating one-pixel color patterns must retain their chroma
                // detail and improve substantially over the ordinary main view.
                expect(error).withContext(sequence.name + ' full color reconstruction').toBeLessThan(baseline * 0.35);
                expect(sourceError).toBeLessThan(baseline * 0.35);
                instruction('end', [s]);
            }
            var image = document.createElement('canvas'); image.width = 318; image.height = 178;
            var context = image.getContext('2d'); context.fillStyle = '#e020c0'; context.fillRect(0, 0, 318, 178);
            instruction('img', [99, 12, 0, 'image/png', 0, 0]); instruction('blob', [99, image.toDataURL().split(',')[1]]); instruction('end', [99]);
            var last = timestamp++; instruction('sync', [last]);
            await waitFor(function() { return sent.some(function(a) { return a[0] === 'sync' && a[1] === last; }); });
            expect(Array.from(client.getDisplay().flatten().getContext('2d').getImageData(5, 5, 1, 1).data)).toEqual([224, 32, 192, 255]);
            expect(client.getVideoStatistics().status).toBe('fallback');
            expect(sent.some(function(a) { return a[0] === 'ack' && a[2] === 'AVC444:fallback'; })).toBe(false);
        }
        finally { client.disconnect(); }
    });
});
