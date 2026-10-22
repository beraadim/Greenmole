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
 * Private GAV2 AVC444v1 player. Each envelope contains full main/auxiliary
 * views, decoded in that order by ONE H.264 decoder, as required by RDPEGFX.
 * Cross-view reference pictures make separate decoders incorrect. Partial
 * region/LC updates and AVC444v2 are deliberately rejected into image fallback
 * until a retained-plane implementation can preserve their exact semantics.
 *
 * @constructor
 * @param {!Guacamole.InputStream} stream The video stream.
 * @param {!Guacamole.Layer} layer The destination layer.
 * @param {!Guacamole.Display} display The ordered display scheduler.
 */
Guacamole.AVC444VideoPlayer = function AVC444VideoPlayer(stream, layer, display) {
    var player = this;
    this.onstatechange = null;
    var closed = false, decoder = null, decoderReady = null, renderer = null, codec = null;
    var streamWidth = 0, streamHeight = 0, lastSequence = 0;
    var pending = {}, pendingCount = 0, pendingBytes = 0, decodeQueue = [], activePairs = 0;
    var header = new Uint8Array(32), headerUsed = 0, payload = null, payloadUsed = 0, metadata = null;
    var assemblyTimer = null;
    var configurationTimer = null;
    var MAX_BYTES = 8 * 1024 * 1024, MAX_PENDING_BYTES = 16 * 1024 * 1024, TIMEOUT = 2000;

    this.dispose = function dispose(notify, reason) {
        if (closed) return;
        closed = true;
        reason = Guacamole.AVC444VideoPlayer.isFailureReason(reason) ? reason : null;
        if (player.onstatechange) player.onstatechange('fallback', reason);
        stream.onblob = stream.onend = null;
        if (assemblyTimer !== null) window.clearTimeout(assemblyTimer);
        if (configurationTimer !== null) window.clearTimeout(configurationTimer);
        assemblyTimer = configurationTimer = null; payload = metadata = null;
        Object.keys(pending).forEach(function cancel(sequence) {
            var item = pending[sequence];
            window.clearTimeout(item.timer);
            item.frames.forEach(function release(frame, side) {
                if (frame) { frame.close(); item.frames[side] = null; }
            });
            item.planes = null; item.data = null;
            item.task.cancel(true);
        });
        pending = {}; decodeQueue = []; pendingCount = pendingBytes = activePairs = 0;
        if (decoder) { try { decoder.close(); } catch (ignore) {} decoder = null; }
        if (renderer) { renderer.dispose(); renderer = null; }
        if (notify) stream.sendAck('AVC444:fallback' + (reason ? ':' + reason : ''), 0x0300);
    };
    function fail(reason) { player.dispose(true, reason || 'invalid-stream'); }
    function failed(reason) { return function failure() { fail(reason); }; }
    function output(frame) {
        var sequence = Math.floor(frame.timestamp / 2000), remainder = frame.timestamp % 2000;
        var side = remainder === 0 ? 0 : remainder === 1000 ? 1 : -1;
        var item = pending[sequence];
        if (closed || !item) { frame.close(); return; }
        if (side < 0 || item.received[side]) { frame.close(); return fail('invalid-stream'); }
        item.received[side] = true; item.frames[side] = frame;
        Guacamole.AVC444Renderer.copyFrame(frame, item.width, item.height).then(function copied(planes) {
            if (closed || !pending[sequence]) return;
            item.planes[side] = planes;
            if (!item.planes[0] || !item.planes[1]) return;
            var picture;
            try { picture = renderer.render(item.planes[0], item.planes[1], item.width, item.height, sequence * 2000); }
            catch (error) { return fail('renderer-error'); }
            item.planes = null;
            item.task.complete(picture);
        }).catch(function copyFailed(error) {
            fail(error && error.avc444Reason === 'native-layout' ? 'native-layout' : 'native-copy');
        }).then(function release() {
            // dispose() may already have closed an in-flight native copy.
            if (item.frames[side]) { item.frames[side].close(); item.frames[side] = null; }
        });
    }
    function inspect(data) {
        var profile = null, pps = false, idr = false;
        for (var i = 0; i + 3 < data.length; i++) {
            if (data[i] !== 0 || data[i + 1] !== 0) continue;
            var start = data[i + 2] === 1 ? i + 3 : data[i + 2] === 0 && data[i + 3] === 1 ? i + 4 : 0;
            if (!start || start >= data.length) continue;
            var type = data[start] & 0x1F;
            if (type === 7 && start + 3 < data.length) {
                profile = 'avc1.';
                for (var j = 1; j <= 3; j++) profile += ('0' + data[start + j].toString(16)).slice(-2);
            }
            if (type === 8) pps = true;
            if (type === 5) idr = true;
            i = start;
        }
        return { codec: profile, pps: pps, idr: idr };
    }
    function pump() {
        if (closed || !decoder) return;
        // A pair occupies a slot through ordered presentation. At most four
        // native frames/copies and two reconstructed pictures can be retained.
        while (!closed && decodeQueue.length && activePairs < 2) {
            var item = decodeQueue.shift(); activePairs++;
            // Encoded FIFO time precedes this pair's native/copy/presentation
            // budget. Keep healthy ordered progress through a bounded burst.
            item.timer = window.setTimeout(failed('frame-timeout'), TIMEOUT);
            try {
                for (var side = 0; side < 2; side++)
                    decoder.decode(new window.EncodedVideoChunk({ type: item.keys[side] ? 'key' : 'delta',
                        timestamp: item.sequence * 2000 + side * 1000, data: item.data[side] }));
                item.data = null;
            }
            catch (ignore) { fail('decoder-error'); }
        }
    }
    function decode(data, info) {
        var view = new DataView(data.buffer, data.byteOffset, 16);
        for (var r = 0; r < 2; r++)
            if (view.getUint16(r * 8) || view.getUint16(r * 8 + 2)
                    || view.getUint16(r * 8 + 4) !== info.width || view.getUint16(r * 8 + 6) !== info.height) return fail('invalid-stream');
        var frames = [data.subarray(16, 16 + info.mainLength), data.subarray(16 + info.mainLength)];
        var nals = frames.map(inspect), keys = [!!(info.flags & 1), !!(info.flags & 2)];
        for (var side = 0; side < 2; side++)
            if (nals[side].idr !== keys[side] || (keys[side] && (!nals[side].codec || !nals[side].pps))) return fail('invalid-stream');
        if (!decoderReady) {
            if (!keys[0]) return fail('invalid-stream');
            codec = nals[0].codec; streamWidth = info.width; streamHeight = info.height;
            // Some hardware decoders buffer this interleaved pair stream beyond
            // the bounded output slots or remap native chroma samples. The
            // tiny capability probe can silently select software while the
            // desktop-sized stream selects that incompatible hardware path.
            // Use the same sample-preserving software policy at both sizes;
            // reconstruction remains on the GPU and AVC420 is unchanged.
            var config = { codec: codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-software',
                codedWidth: Math.ceil(info.width / 16) * 16, codedHeight: Math.ceil(info.height / 16) * 16 };
            configurationTimer = window.setTimeout(failed('unsupported-config'), TIMEOUT);
            decoderReady = Promise.resolve().then(function supportedConfig() {
                return window.VideoDecoder.isConfigSupported(config);
            }).then(function configure(result) {
                if (closed) return;
                if (!result.supported) return fail('unsupported-config');
                try { renderer = new Guacamole.AVC444Renderer(failed('context-lost')); }
                catch (error) { return fail('renderer-error'); }
                decoder = new window.VideoDecoder({ output: output, error: failed('decoder-error') }); decoder.configure(config);
                window.clearTimeout(configurationTimer); configurationTimer = null; pump();
            }).catch(failed('decoder-error'));
        }
        if (info.width !== streamWidth || info.height !== streamHeight || nals.some(function changed(nal) {
            return nal.codec && nal.codec !== codec;
        })) return fail('invalid-stream');
        if (pendingCount >= 16 || pendingBytes + data.length > MAX_PENDING_BYTES) return fail('backlog-limit');
        var item = { width: info.width, height: info.height, sequence: info.sequence,
            bytes: data.length, data: frames, keys: keys, frames: [null, null], received: [false, false], planes: [null, null] };
        pending[info.sequence] = item; pendingCount++; pendingBytes += item.bytes;
        item.task = display.scheduleVideoFrame(layer, info.width, info.height, function presented(success) {
            if (closed || !pending[info.sequence]) return;
            window.clearTimeout(item.timer); delete pending[info.sequence];
            pendingCount--; pendingBytes -= item.bytes; activePairs--;
            if (!success) return fail('presentation-error');
            if (player.onstatechange) player.onstatechange('playing');
            stream.sendAck('AVC444:' + info.sequence, 0); pump();
        });
        decodeQueue.push(item); pump();
    }
    function beginPayload() {
        var view = new DataView(header.buffer), sequence = view.getUint32(4);
        var width = view.getUint16(8), height = view.getUint16(10), flags = view.getUint32(12);
        var mainLength = view.getUint32(16), auxLength = view.getUint32(20), length = mainLength + auxLength + 16;
        if (view.getUint32(0) !== 0x47415632 || sequence <= lastSequence || !width || !height
                || width > 8192 || height > 8192 || Math.ceil(width / 16) * 16 * Math.ceil(height / 16) * 16 > 16777216
                || (flags & ~3) !== 0x10000 || view.getUint16(24) !== 1 || view.getUint16(26) !== 1
                || view.getUint32(28) !== 0 || !mainLength || !auxLength || length > MAX_BYTES) return fail('invalid-stream');
        if (pendingBytes + length > MAX_PENDING_BYTES) return fail('backlog-limit');
        lastSequence = sequence;
        metadata = { sequence: sequence, width: width, height: height, flags: flags, mainLength: mainLength };
        payload = new Uint8Array(length); payloadUsed = 0;
    }
    stream.onblob = function receiveBlob(base64) {
        if (closed) return;
        if (typeof base64 !== 'string' || base64.length > 131072) return fail('invalid-stream');
        var data;
        try {
            // Native byte decoding avoids a binary string and JavaScript work
            // for every compressed byte. Older browsers retain the same path.
            data = typeof Uint8Array.fromBase64 === 'function'
                ? Uint8Array.fromBase64(base64) : window.atob(base64);
        } catch (ignore) { return fail('invalid-stream'); }
        var offset = 0;
        while (!closed && offset < data.length) {
            if (assemblyTimer === null) assemblyTimer = window.setTimeout(failed('assembly-timeout'), TIMEOUT);
            var target = payload || header, used = payload ? payloadUsed : headerUsed;
            var count = Math.min(target.length - used, data.length - offset);
            if (typeof data === 'string') {
                for (var i = 0; i < count; i++) target[used + i] = data.charCodeAt(offset + i);
            }
            else target.set(data.subarray(offset, offset + count), used);
            offset += count;
            if (!payload) { headerUsed += count; if (headerUsed === header.length) beginPayload(); }
            else {
                payloadUsed += count;
                if (payloadUsed === payload.length) {
                    var complete = payload, info = metadata;
                    payload = metadata = null; headerUsed = payloadUsed = 0;
                    window.clearTimeout(assemblyTimer); assemblyTimer = null; decode(complete, info);
                }
            }
        }
    };
    stream.onend = function end() { player.dispose(false); };
};
Guacamole.AVC444VideoPlayer.MIMETYPE = 'video/x-guacamole-avc444;v=1';
Guacamole.AVC444VideoPlayer.supported = false;

/** Bounded, content-free causes shared with the gateway ACK allowlist. */
Guacamole.AVC444VideoPlayer.isFailureReason = function isFailureReason(reason) {
    return ['invalid-stream', 'unsupported-config', 'decoder-error', 'native-layout',
        'native-copy', 'renderer-error', 'context-lost', 'frame-timeout',
        'assembly-timeout', 'backlog-limit', 'presentation-error'].indexOf(reason) !== -1;
};

/**
 * Prove the actual decode -> native-plane copy -> GPU -> canvas path before
 * advertising GAV2. A codec-query success alone does not imply that a browser
 * exposes native samples (some platforms return an opaque/RGB VideoFrame).
 * The public, neutral 16x16 IDR was generated by macrdp's synthetic encoder;
 * this probe reads no desktop, account or user media.
 * @returns {!Promise<boolean>} Whether exact-plane AVC444 playback is available.
 */
Guacamole.AVC444VideoPlayer.checkSupport = function checkSupport() {
    var Player = Guacamole.AVC444VideoPlayer;
    if (Player.probe) return Player.probe;
    if (!window.isSecureContext || !window.VideoDecoder || !window.EncodedVideoChunk
            || !window.VideoFrame || typeof window.VideoFrame.prototype.copyTo !== 'function') {
        Player.supported = false; return Promise.resolve(false);
    }
    Player.probe = new Promise(function probe(resolve) {
        var complete = false, decoder = null, renderer = null, frames = [null, null], planes = [null, null];
        var timer = window.setTimeout(function timedOut() { finish(false); }, 2000);
        function release(side) {
            if (frames[side]) { frames[side].close(); frames[side] = null; }
        }
        function finish(supported) {
            if (complete) return;
            complete = true; window.clearTimeout(timer);
            release(0); release(1);
            if (decoder) { try { decoder.close(); } catch (ignore) {} }
            if (renderer) renderer.dispose();
            Player.supported = supported; resolve(supported);
        }
        try {
            renderer = new Guacamole.AVC444Renderer(function lost() { finish(false); });
            decoder = new window.VideoDecoder({ error: function failed() { finish(false); }, output: function output(frame) {
                var side = frame.timestamp / 1000;
                if (complete) { frame.close(); return; }
                if ((side !== 0 && side !== 1) || frames[side] || planes[side]) { frame.close(); return finish(false); }
                frames[side] = frame;
                Guacamole.AVC444Renderer.copyFrame(frame, 16, 16).then(function copied(plane) {
                    if (complete) return;
                    planes[side] = plane;
                    if (planes[0] && planes[1]) {
                        var picture = renderer.render(planes[0], planes[1], 16, 16, 0);
                        try {
                            var canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
                            var context = canvas.getContext('2d'); context.drawImage(picture, 0, 0);
                            finish(context.getImageData(0, 0, 1, 1).data[3] === 255);
                        }
                        finally { picture.close(); }
                    }
                }).catch(function failed() { finish(false); }).then(function copiedOrFailed() { release(side); });
            }});
            decoder.configure({ codec: 'avc1.42d00b', optimizeForLatency: true,
                hardwareAcceleration: 'prefer-software', codedWidth: 16, codedHeight: 16 });
            var data = Uint8Array.from(window.atob('AAAAAWdC0AuMacm4CAgIPCIRqAAAAAFozjyAAAAAAWW4AAQJ5PA='), function byte(value) { return value.charCodeAt(0); });
            decoder.decode(new window.EncodedVideoChunk({ type: 'key', timestamp: 0, data: data }));
            decoder.decode(new window.EncodedVideoChunk({ type: 'key', timestamp: 1000, data: data }));
            decoder.flush().catch(function failed() { finish(false); });
        }
        catch (ignore) { finish(false); }
    });
    Player.probe.then(function completed() { Player.probe = null; });
    return Player.probe;
};
