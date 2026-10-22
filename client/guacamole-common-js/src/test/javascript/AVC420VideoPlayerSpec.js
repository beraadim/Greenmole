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

/* global Guacamole, jasmine, expect */

describe('Guacamole experimental AVC420 video', function() {
    var display, layer, stream, player, originalDecoder, originalChunk, originalFromBase64, decoders, chunks;
    var key = [0, 0, 0, 1, 0x67, 0x42, 0xE0, 0x1F, 0, 0, 1, 0x68, 1, 0, 0, 1, 0x65, 1];
    var delta = [0, 0, 1, 0x41, 1];

    async function settle() { for (var i = 0; i < 12; i++) await Promise.resolve(); }
    function envelope(sequence, data, options) {
        options = options || {};
        var bytes = new Uint8Array(20 + data.length);
        var view = new DataView(bytes.buffer);
        view.setUint32(0, 0x47415631); view.setUint32(4, sequence);
        view.setUint16(8, options.width || 32); view.setUint16(10, options.height || 18);
        view.setUint32(12, options.flags === undefined ? (data === key ? 1 : 0) : options.flags);
        view.setUint32(16, data.length); bytes.set(data, 20);
        return bytes;
    }
    function send(bytes, size) {
        size = size || 4096;
        for (var i = 0; i < bytes.length; i += size) {
            if (!stream.onblob) return;
            stream.onblob(window.btoa(String.fromCharCode.apply(null, bytes.slice(i, i + size))));
        }
    }
    function frame(sequence, width, height) {
        return { timestamp: sequence * 1000, displayWidth: width || 32, displayHeight: height || 18,
            close: jasmine.createSpy('close') };
    }
    beforeEach(function() {
        originalDecoder = window.VideoDecoder; originalChunk = window.EncodedVideoChunk;
        originalFromBase64 = Uint8Array.fromBase64;
        decoders = []; chunks = [];
        window.VideoDecoder = function Decoder(callbacks) {
            this.callbacks = callbacks; this.decodeQueueSize = 0;
            this.configure = jasmine.createSpy('configure');
            this.decode = function decode(chunk) { chunks.push(chunk); };
            this.close = jasmine.createSpy('decoder close');
            decoders.push(this);
        };
        window.VideoDecoder.isConfigSupported = function supported(config) {
            return Promise.resolve({ supported: true, config: config });
        };
        window.EncodedVideoChunk = function Chunk(init) { Object.assign(this, init); };
        display = new Guacamole.Display();
        layer = { drawVideoFrame: jasmine.createSpy('video'), drawImage: jasmine.createSpy('image') };
        stream = { sendAck: jasmine.createSpy('ack') };
        player = new Guacamole.AVC420VideoPlayer(stream, layer, display);
    });
    afterEach(function() {
        player.dispose(false); display.cancel();
        window.VideoDecoder = originalDecoder; window.EncodedVideoChunk = originalChunk;
        Uint8Array.fromBase64 = originalFromBase64;
    });

    it('assembles arbitrarily split frames and acknowledges only after ordered canvas drawing', async function() {
        send(envelope(1, key), 3);
        display.flush();
        expect(stream.sendAck).not.toHaveBeenCalled();
        await settle();
        expect(chunks.length).toBe(1);
        expect(decoders[0].configure.calls.mostRecent().args[0].codec).toBe('avc1.42e01f');
        var decoded = frame(1, 32, 32); // macroblock padding is cropped
        decoders[0].callbacks.output(decoded);
        expect(layer.drawVideoFrame).toHaveBeenCalledOnceWith(decoded, 32, 18);
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:1', 0);
        expect(decoded.close).toHaveBeenCalledTimes(1);
    });
    // Exercise both branches even on browsers without the optional native API.
    // When present, the fast-path spy calls the actual browser implementation.
    ['native', 'legacy'].forEach(function(mode) {
        function configureBase64() {
            var convert = jasmine.createSpy('native Base64').and.callFake(function(base64) {
                if (originalFromBase64) return originalFromBase64(base64);
                return Uint8Array.from(window.atob(base64), function(byte) { return byte.charCodeAt(0); });
            });
            Uint8Array.fromBase64 = mode === 'native' ? convert : undefined;
            return convert;
        }
        it('preserves exact bytes across split and coalesced envelopes using ' + mode + ' Base64', async function() {
            var convert = configureBase64();
            var first = envelope(1, key), second = envelope(2, delta);
            var combined = new Uint8Array(first.length + second.length);
            combined.set(first); combined.set(second, first.length);
            send(combined, 23); await settle();
            expect(chunks.map(function(chunk) { return Array.from(chunk.data); })).toEqual([key, delta]);
            expect(chunks.map(function(chunk) { return chunk.timestamp; })).toEqual([1000, 2000]);
            expect(stream.sendAck).not.toHaveBeenCalled();
            expect(stream.onblob).not.toBeNull();
            if (mode === 'native') expect(convert).toHaveBeenCalled();
            else expect(convert).not.toHaveBeenCalled();
        });
        it('rejects malformed ' + mode + ' Base64 with one terminal fallback', function() {
            configureBase64();
            stream.onblob('%%%not-base64%%%');
            expect(stream.onblob).toBeNull();
            expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:invalid-stream', 0x0300);
            expect(chunks.length).toBe(0);
        });
        it('bounds ' + mode + ' Base64 before invoking either decoder', function() {
            var convert = configureBase64();
            var atob = spyOn(window, 'atob').and.callThrough();
            stream.onblob('A'.repeat(131073));
            expect(convert).not.toHaveBeenCalled(); expect(atob).not.toHaveBeenCalled();
            expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:invalid-stream', 0x0300);
            expect(chunks.length).toBe(0);
        });
    });
    it('preserves image/video order even when decoding completes ahead of an older task', async function() {
        var older = display.scheduleVideoFrame(layer, 32, 18, function() {});
        send(envelope(1, key));
        display.drawImage(layer, 4, 5, { width: 1, height: 1 });
        display.flush();
        await settle();
        decoders[0].callbacks.output(frame(1));
        expect(stream.sendAck).not.toHaveBeenCalled();
        expect(layer.drawImage).not.toHaveBeenCalled();
        older.complete(frame(0));
        expect(layer.drawVideoFrame).toHaveBeenCalledTimes(2);
        expect(layer.drawImage).toHaveBeenCalledTimes(1);
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:1', 0);
    });
    it('cancels pending video on end so it cannot overwrite an image fallback', async function() {
        send(envelope(1, key)); await settle();
        var output = decoders[0].callbacks.output;
        stream.onend();
        display.drawImage(layer, 0, 0, { width: 32, height: 18 });
        display.flush();
        var late = frame(1); output(late);
        expect(layer.drawVideoFrame).not.toHaveBeenCalled();
        expect(layer.drawImage).toHaveBeenCalledTimes(1);
        expect(late.close).toHaveBeenCalledTimes(1);
        expect(stream.sendAck).not.toHaveBeenCalled();
        expect(decoders[0].close).toHaveBeenCalledTimes(1);
    });
    it('bounds pending frames and sends one terminal failure', async function() {
        send(envelope(1, key));
        for (var i = 2; i <= 17; i++) send(envelope(i, delta));
        await settle();
        expect(stream.onblob).toBeNull();
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:backlog-limit', 0x0300);
        display.flush();
        expect(layer.drawVideoFrame).not.toHaveBeenCalled();
    });
    it('accepts normal batched delivery with only four submitted frames at once', async function() {
        send(envelope(1, key)); display.flush();
        for (var i = 2; i <= 12; i++) { send(envelope(i, delta)); display.flush(); }
        await settle();
        expect(chunks.length).toBe(4);
        for (var sequence = 1; sequence <= 12; sequence++) {
            decoders[0].callbacks.output(frame(sequence));
        }
        expect(chunks.length).toBe(12);
        expect(layer.drawVideoFrame).toHaveBeenCalledTimes(12);
        expect(stream.sendAck).toHaveBeenCalledTimes(12);
        expect(stream.onblob).not.toBeNull();
    });
    it('preserves every reference through a slow progressing encoded burst without aging queued frames', async function() {
        jasmine.clock().install();
        try {
            for (var i = 1; i <= 12; i++) { send(envelope(i, i === 1 ? key : delta)); display.flush(); }
            await settle();
            var pictures = [];
            for (var batch = 0; batch < 3; batch++) {
                jasmine.clock().tick(1500);
                for (var sequence = batch * 4 + 1; sequence <= batch * 4 + 4; sequence++) {
                    var decoded = frame(sequence); pictures.push(decoded);
                    decoders[0].callbacks.output(decoded);
                }
            }
            expect(chunks.map(function(chunk) { return chunk.timestamp; }))
                .toEqual(Array.from({ length: 12 }, function(_, i) { return (i + 1) * 1000; }));
            expect(stream.sendAck.calls.allArgs()).toEqual(Array.from({ length: 12 }, function(_, i) {
                return ['AVC420:' + (i + 1), 0];
            }));
            pictures.forEach(function(decoded) { expect(decoded.close).toHaveBeenCalledTimes(1); });
            expect(stream.onblob).not.toBeNull();
            jasmine.clock().tick(10000);
            expect(stream.sendAck).toHaveBeenCalledTimes(12);
        }
        finally { jasmine.clock().uninstall(); }
    });
    it('bounds a stalled submitted frame and cancels all queued work before image fallback', async function() {
        jasmine.clock().install();
        try {
            for (var i = 1; i <= 8; i++) { send(envelope(i, i === 1 ? key : delta)); display.flush(); }
            await settle();
            var held = frame(2); decoders[0].callbacks.output(held);
            display.drawImage(layer, 0, 0, { width: 32, height: 18 }); display.flush();
            jasmine.clock().tick(2000);
            expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:frame-timeout', 0x0300);
            expect(decoders[0].close).toHaveBeenCalledTimes(1);
            expect(held.close).toHaveBeenCalledTimes(1);
            expect(layer.drawVideoFrame).not.toHaveBeenCalled();
            display.flush();
            expect(layer.drawImage).toHaveBeenCalledTimes(1);
            var late = frame(1); decoders[0].callbacks.output(late);
            expect(late.close).toHaveBeenCalledTimes(1);
            expect(layer.drawVideoFrame).not.toHaveBeenCalled();
        }
        finally { jasmine.clock().uninstall(); }
    });
    it('bounds an unresolved configuration and ignores its answer after disposal', async function() {
        jasmine.clock().install();
        try {
            var answer;
            window.VideoDecoder.isConfigSupported = function() {
                return new Promise(function(resolve) { answer = resolve; });
            };
            send(envelope(1, key)); display.flush(); await settle();
            jasmine.clock().tick(2000);
            expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:unsupported-config', 0x0300);
            expect(display.getQueueStatistics().blocked).toBe(false);
            answer({ supported: true }); await settle();
            expect(decoders.length).toBe(0);
            expect(stream.sendAck).toHaveBeenCalledTimes(1);
        }
        finally { jasmine.clock().uninstall(); }
    });
    it('reports only allowlisted decoder causes without forwarding exception text', async function() {
        var states = []; player.onstatechange = function(state, reason) { states.push([state, reason]); };
        send(envelope(1, key)); await settle();
        decoders[0].callbacks.error(new Error('private native failure details'));
        expect(states).toEqual([['fallback', 'decoder-error']]);
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:decoder-error', 0x0300);
        player.dispose(true, 'private\nforged-cause');
        expect(stream.sendAck).toHaveBeenCalledTimes(1);
    });
    it('does not send a fabricated or arbitrary fallback reason', function() {
        var states = []; player.onstatechange = function(state, reason) { states.push([state, reason]); };
        player.dispose(true, 'private\nforged-cause');
        expect(states).toEqual([['fallback', null]]);
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback', 0x0300);
    });
    it('bounds advertised dimensions and rejects a delta before a keyframe', function() {
        send(envelope(1, key, { width: 8193 }));
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:invalid-stream', 0x0300);
        expect(decoders.length).toBe(0);
    });
    it('requires SPS/PPS and a consistent key flag', function() {
        send(envelope(1, delta));
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:invalid-stream', 0x0300);
        expect(decoders.length).toBe(0);
    });
    it('rejects duplicate frame sequences instead of ambiguously matching output', async function() {
        send(envelope(1, key)); await settle();
        send(envelope(1, delta));
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:invalid-stream', 0x0300);
    });
    it('times out partial envelopes and unblocks pending display work', function() {
        jasmine.clock().install();
        try {
            send(envelope(1, key).slice(0, 8));
            jasmine.clock().tick(2000);
            expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:assembly-timeout', 0x0300);
        }
        finally { jasmine.clock().uninstall(); }
    });
    it('fails safely when the actual SPS configuration is unsupported', async function() {
        window.VideoDecoder.isConfigSupported = function() { return Promise.resolve({ supported: false }); };
        send(envelope(1, key)); display.flush(); await settle();
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:unsupported-config', 0x0300);
        expect(decoders.length).toBe(0);
        expect(display.getQueueStatistics().blocked).toBe(false);
    });
    it('closes an incorrectly sized output frame and requests fallback', async function() {
        send(envelope(1, key)); await settle();
        var invalid = frame(1, 64, 64); decoders[0].callbacks.output(invalid);
        expect(invalid.close).toHaveBeenCalledTimes(1);
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:invalid-stream', 0x0300);
    });
    it('requests fallback when the canvas draw throws and still releases its frame', async function() {
        layer.drawVideoFrame.and.throwError('canvas unavailable');
        send(envelope(1, key)); display.flush(); await settle();
        var decoded = frame(1); decoders[0].callbacks.output(decoded);
        expect(decoded.close).toHaveBeenCalledTimes(1);
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC420:fallback:presentation-error', 0x0300);
    });
    it('notifies native fallback when Client resizes the video layer and releases the decoder', async function() {
        var originalSupport = Guacamole.AVC420VideoPlayer.supported;
        Guacamole.AVC420VideoPlayer.supported = true;
        var messages = [];
        var tunnel = new Guacamole.Tunnel();
        tunnel.connect = function() {}; tunnel.disconnect = function() {};
        tunnel.sendMessage = function() { messages.push(Array.from(arguments)); };
        var client = new Guacamole.Client(tunnel);
        client.setExperimentalAvc420Enabled(true);
        client.connect('synthetic');
        try {
            tunnel.oninstruction('video', ['1', '0', Guacamole.AVC420VideoPlayer.MIMETYPE]);
            var packet = envelope(1, key);
            tunnel.oninstruction('blob', ['1', window.btoa(String.fromCharCode.apply(null, packet))]);
            await settle();
            var decoder = decoders[0];
            tunnel.oninstruction('size', ['0', '640', '480']);
            expect(messages.some(function(message) {
                return message[0] === 'ack' && message[1] === 1 && message[2] === 'AVC420:fallback';
            })).toBe(true);
            expect(decoder.close).toHaveBeenCalledTimes(1);
            var late = frame(1); decoder.callbacks.output(late);
            expect(late.close).toHaveBeenCalledTimes(1);
            expect(client.getVideoStatistics().status).toBe('fallback');
        }
        finally {
            client.disconnect();
            Guacamole.AVC420VideoPlayer.supported = originalSupport;
        }
    });
    it('rejects unsolicited private video by default and isolates explicit permission per Client', function() {
        var originalSupport = Guacamole.AVC420VideoPlayer.supported;
        Guacamole.AVC420VideoPlayer.supported = true;
        var clients = [], messages = [[], []], tunnels = [];
        try {
            for (var i = 0; i < 2; i++) {
                var tunnel = new Guacamole.Tunnel();
                tunnel.connect = tunnel.disconnect = function() {};
                tunnel.sendMessage = function(index) { return function() { messages[index].push(Array.from(arguments)); }; }(i);
                var client = new Guacamole.Client(tunnel);
                client.connect('synthetic'); clients.push(client); tunnels.push(tunnel);
            }
            clients[0].setExperimentalAvc420Enabled(true);
            tunnels.forEach(function(tunnel) {
                tunnel.oninstruction('video', ['1', '0', Guacamole.AVC420VideoPlayer.MIMETYPE]);
            });
            expect(messages[0].some(function(message) {
                return message[0] === 'ack' && message[2] === 'AVC420:ready' && message[3] === 0;
            })).toBe(true);
            expect(messages[1].some(function(message) {
                return message[0] === 'ack' && message[2] === 'BAD TYPE' && message[3] === 0x030F;
            })).toBe(true);
            clients[0].setExperimentalAvc420Enabled(false);
            expect(messages[0].some(function(message) {
                return message[0] === 'ack' && message[2] === 'AVC420:fallback';
            })).toBe(true);
        }
        finally {
            clients.forEach(function(client) { client.disconnect(); });
            Guacamole.AVC420VideoPlayer.supported = originalSupport;
        }
    });
    it('does not advertise video through the generic default capability list', function() {
        expect(Guacamole.VideoPlayer.getSupportedTypes()).toEqual([]);
    });
});


describe('Guacamole AVC420 capability security', function() {
    var secure, decoder, chunk, supported;
    beforeEach(function() {
        secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
        decoder = window.VideoDecoder; chunk = window.EncodedVideoChunk;
        supported = Guacamole.AVC420VideoPlayer.supported;
        Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
        window.VideoDecoder = function() {};
        window.EncodedVideoChunk = function() {};
    });
    afterEach(function() {
        if (secure) Object.defineProperty(window, 'isSecureContext', secure);
        else delete window.isSecureContext;
        window.VideoDecoder = decoder; window.EncodedVideoChunk = chunk;
        Guacamole.AVC420VideoPlayer.supported = supported;
    });
    it('never advertises on insecure origins even when a decoder constructor exists', async function() {
        Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
        var probe = jasmine.createSpy('probe'); window.VideoDecoder.isConfigSupported = probe;
        Guacamole.AVC420VideoPlayer.supported = true;
        expect(await Guacamole.AVC420VideoPlayer.checkSupport()).toBe(false);
        expect(probe).not.toHaveBeenCalled();
        expect(Guacamole.AVC420VideoPlayer.supported).toBe(false);
    });
    it('waits for the asynchronous support answer and handles probe rejection', async function() {
        window.VideoDecoder.isConfigSupported = function() { return Promise.reject(new Error('No codec')); };
        expect(await Guacamole.AVC420VideoPlayer.checkSupport()).toBe(false);
        window.VideoDecoder.isConfigSupported = function() { return Promise.resolve({ supported: true }); };
        expect(await Guacamole.AVC420VideoPlayer.checkSupport()).toBe(true);
    });
    it('bounds connection setup when a platform capability probe never resolves', async function() {
        jasmine.clock().install();
        try {
            window.VideoDecoder.isConfigSupported = function() { return new Promise(function() {}); };
            var result = Guacamole.AVC420VideoPlayer.checkSupport();
            jasmine.clock().tick(2000);
            expect(await result).toBe(false);
        }
        finally { jasmine.clock().uninstall(); }
    });
});
