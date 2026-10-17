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
 * Experimental private AVC420 stream player. GAV1 envelopes carry a sequence,
 * dimensions, key flag and Annex B access unit, all integers in network order.
 * Blobs may split envelopes at arbitrary boundaries. No MP4/container parser or
 * codec negotiation is implied by the private versioned MIME capability.
 *
 * @constructor
 * @param {!Guacamole.InputStream} stream The video stream.
 * @param {!Guacamole.Layer} layer The destination layer.
 * @param {!Guacamole.Display} display The ordered display scheduler.
 */
Guacamole.AVC420VideoPlayer = function AVC420VideoPlayer(stream, layer, display) {
    var player = this;
    this.onstatechange = null;
    var closed = false;
    var decoder = null;
    var decoderReady = null;
    var codec = null;
    var streamWidth = 0, streamHeight = 0;
    var lastSequence = 0;
    var pending = {};
    var pendingCount = 0;
    var pendingBytes = 0;
    var decodeQueue = [];
    var activeFrames = 0;
    var header = new Uint8Array(20);
    var headerUsed = 0;
    var payload = null;
    var payloadUsed = 0;
    var metadata = null;
    var assemblyTimer = null;
    var MAX_BYTES = 8 * 1024 * 1024;
    var MAX_PENDING_BYTES = 16 * 1024 * 1024;
    var TIMEOUT = 2000;

    // Disposing must become terminal before cancelling tasks: cancellation can
    // synchronously flush the display and invoke task completion callbacks.
    this.dispose = function dispose(notify) {
        if (closed) return;
        closed = true;
        if (player.onstatechange) player.onstatechange('fallback');
        stream.onblob = stream.onend = null;
        if (assemblyTimer !== null) window.clearTimeout(assemblyTimer);
        assemblyTimer = null;
        payload = null;
        Object.keys(pending).forEach(function cancel(sequence) {
            var item = pending[sequence];
            window.clearTimeout(item.timer);
            // Invalidate the entire stream before another display flush can
            // execute a different, already-decoded task from this stream.
            item.task.cancel(true);
        });
        pending = {};
        decodeQueue = [];
        pendingCount = pendingBytes = activeFrames = 0;
        if (decoder) {
            try { decoder.close(); }
            catch (ignore) {}
            decoder = null;
        }
        if (notify) stream.sendAck('AVC420:fallback', 0x0300);
    };

    function fail() { player.dispose(true); }

    function output(frame) {
        var sequence = frame.timestamp / 1000;
        var item = pending[sequence];
        if (closed || !item) {
            frame.close();
            return;
        }
        if (frame.displayWidth < item.width || frame.displayHeight < item.height
                || frame.displayWidth > item.width + 15 || frame.displayHeight > item.height + 15) {
            frame.close();
            fail();
            return;
        }
        item.task.complete(frame);
    }

    // Parse only NAL boundaries and the SPS profile triplet, leaving bitstream
    // validation to WebCodecs. Require parameter sets together with each IDR so
    // reconnect/resize never depends on another stream's decoder state.
    function inspect(data) {
        var profile = null, pps = false, idr = false;
        for (var i = 0; i + 3 < data.length; i++) {
            if (data[i] !== 0 || data[i + 1] !== 0) continue;
            var start = data[i + 2] === 1 ? i + 3
                    : data[i + 2] === 0 && data[i + 3] === 1 ? i + 4 : 0;
            if (!start || start >= data.length) continue;
            var type = data[start] & 0x1F;
            if (type === 7 && start + 3 < data.length) {
                profile = 'avc1.';
                for (var j = 1; j <= 3; j++)
                    profile += ('0' + data[start + j].toString(16)).slice(-2);
            }
            if (type === 8) pps = true;
            if (type === 5) idr = true;
            i = start;
        }
        return { codec: profile, pps: pps, idr: idr };
    }

    // Retain a bounded encoded FIFO for normal WebSocket bursts. A submitted
    // frame occupies a slot until ordered presentation releases its VideoFrame,
    // bounding both decoder work and retained decoded pictures.
    function pump() {
        if (closed || !decoder) return;
        while (!closed && decodeQueue.length && activeFrames < 4) {
            var item = decodeQueue.shift();
            activeFrames++;
            try {
                decoder.decode(new window.EncodedVideoChunk({ type: item.key ? 'key' : 'delta',
                    timestamp: item.sequence * 1000, data: item.data }));
                item.data = null;
            }
            catch (ignore) { fail(); }
        }
    }

    function decode(data, info) {
        var nal = inspect(data);
        var key = !!(info.flags & 1);
        if (nal.idr !== key || (key && (!nal.codec || !nal.pps))) return fail();
        if (!decoderReady) {
            if (!key) return fail();
            codec = nal.codec;
            streamWidth = info.width;
            streamHeight = info.height;
            var config = { codec: codec, optimizeForLatency: true,
                codedWidth: info.width, codedHeight: info.height };
            // Probe the actual SPS profile/level as well as the initial general
            // H.264 capability. Tasks reserve order while this query is pending.
            decoderReady = Promise.resolve().then(function supportedConfig() {
                return window.VideoDecoder.isConfigSupported(config);
            }).then(function configure(result) {
                if (closed) return;
                if (!result.supported) throw new Error('Unsupported AVC configuration');
                decoder = new window.VideoDecoder({ output: output, error: fail });
                decoder.configure(config);
                pump();
            }).catch(fail);
        }
        // Configuration/dimensions require a new stream and clean keyframe.
        if ((nal.codec && nal.codec !== codec) || info.width !== streamWidth
                || info.height !== streamHeight) return fail();
        if (pendingCount >= 16 || pendingBytes + data.length > MAX_PENDING_BYTES) return fail();
        var item = { width: info.width, height: info.height, bytes: data.length,
            data: data, key: key, sequence: info.sequence };
        pending[info.sequence] = item;
        pendingCount++;
        pendingBytes += data.length;
        item.timer = window.setTimeout(fail, TIMEOUT);
        item.task = display.scheduleVideoFrame(layer, info.width, info.height, function presented(success) {
            if (closed || !pending[info.sequence]) return;
            window.clearTimeout(item.timer);
            delete pending[info.sequence];
            pendingCount--;
            pendingBytes -= item.bytes;
            activeFrames--;
            if (!success) return fail();
            if (player.onstatechange) player.onstatechange('playing');
            stream.sendAck('AVC420:' + info.sequence, 0);
            pump();
        });
        decodeQueue.push(item);
        pump();
    }

    function beginPayload() {
        var view = new DataView(header.buffer);
        var sequence = view.getUint32(4);
        var width = view.getUint16(8), height = view.getUint16(10);
        var flags = view.getUint32(12), length = view.getUint32(16);
        if (view.getUint32(0) !== 0x47415631 || sequence <= lastSequence
                || !width || !height || width > 8192 || height > 8192
                || width * height > 33554432 || (flags & ~1)
                || !length || length > MAX_BYTES
                || pendingBytes + length > MAX_PENDING_BYTES) return fail();
        lastSequence = sequence;
        metadata = { sequence: sequence, width: width, height: height, flags: flags };
        payload = new Uint8Array(length);
        payloadUsed = 0;
    }

    stream.onblob = function receiveBlob(base64) {
        if (closed) return;
        // Bound the allocation before atob(), including hostile custom servers.
        if (typeof base64 !== 'string' || base64.length > 131072) return fail();
        var data;
        try {
            // Native byte decoding avoids a binary string and JavaScript work
            // for every compressed byte. Older browsers retain the same path.
            data = typeof Uint8Array.fromBase64 === 'function'
                ? Uint8Array.fromBase64(base64) : window.atob(base64);
        }
        catch (ignore) { return fail(); }
        var offset = 0;
        while (!closed && offset < data.length) {
            if (assemblyTimer === null) assemblyTimer = window.setTimeout(fail, TIMEOUT);
            var target = payload || header;
            var used = payload ? payloadUsed : headerUsed;
            var count = Math.min(target.length - used, data.length - offset);
            if (typeof data === 'string') {
                for (var i = 0; i < count; i++) target[used + i] = data.charCodeAt(offset + i);
            }
            else target.set(data.subarray(offset, offset + count), used);
            offset += count;
            if (!payload) {
                headerUsed += count;
                if (headerUsed === header.length) beginPayload();
            }
            else {
                payloadUsed += count;
                if (payloadUsed === payload.length) {
                    var complete = payload, info = metadata;
                    payload = metadata = null;
                    headerUsed = payloadUsed = 0;
                    window.clearTimeout(assemblyTimer);
                    assemblyTimer = null;
                    decode(complete, info);
                }
            }
        }
    };
    stream.onend = function end() { player.dispose(false); };
};

/** The exact versioned downstream capability, never advertised by default. */
Guacamole.AVC420VideoPlayer.MIMETYPE = 'video/x-guacamole-avc420;v=1';
Guacamole.AVC420VideoPlayer.supported = false;

/**
 * Resolves browser capability after an asynchronous WebCodecs check. Secure
 * contexts are mandatory; unsupported browsers retain the image path. The
 * timeout also protects connection setup from a broken platform codec query.
 * @returns {!Promise<boolean>} Whether H.264 decoding is supported.
 */
Guacamole.AVC420VideoPlayer.checkSupport = function checkSupport() {
    var Player = Guacamole.AVC420VideoPlayer;
    if (!window.isSecureContext || !window.VideoDecoder || !window.EncodedVideoChunk
            || typeof window.VideoDecoder.isConfigSupported !== 'function') {
        Player.supported = false;
        return Promise.resolve(false);
    }
    return new Promise(function probe(resolve) {
        var complete = false;
        var timer = window.setTimeout(function unsupported() { finish(false); }, 2000);
        function finish(supported) {
            if (complete) return;
            complete = true;
            window.clearTimeout(timer);
            Player.supported = supported;
            resolve(supported);
        }
        Promise.all(['avc1.42E01F', 'avc1.4D001F', 'avc1.64001F'].map(function check(codec) {
            return Promise.resolve().then(function query() {
                return window.VideoDecoder.isConfigSupported({ codec: codec, optimizeForLatency: true });
            }).then(function result(config) { return !!config && config.supported === true; }, function unsupported() { return false; });
        })).then(function checked(results) { finish(results.some(function supported(value) { return value; })); });
    });
};
