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

/** Browser-side deterministic fallback fixture generation, outside all replay
 * timings. Production-generated payload manifests are preferred for encoder
 * comparisons. No fonts, screen contents, credentials or external resources. */
export async function syntheticImageFixture() {
    const assets = [], scenarios = [];
    for (const mimetype of ['image/png', 'image/webp']) {
        const codec = mimetype.split('/')[1];
        for (const kind of ['tile', 'window']) {
            const width = kind === 'tile' ? 64 : 1920, height = kind === 'tile' ? 64 : 944;
            for (let variant = 0; variant < 2; variant++) {
                const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
                const context = canvas.getContext('2d');
                context.fillStyle = variant ? '#24394b' : '#182b3c'; context.fillRect(0, 0, width, height);
                for (let y = 0; y < height; y += 13) {
                    context.fillStyle = ['#c0c8d0', '#59708f', '#b4a370', '#708f60'][(y + variant) % 4];
                    for (let x = 0; x < width; x += 71)
                        context.fillRect(x + (y + variant * 9) % 23, y, 15 + (x + y) % 43, 5);
                }
                const uri = canvas.toDataURL(mimetype, 0.85);
                if (!uri.startsWith('data:' + mimetype + ';base64,')) throw new Error('Required browser encoder unavailable: ' + mimetype);
                assets.push({ id: `${codec}-${kind}-${variant}`, mimetype, width, height,
                    data_base64: uri.split(',')[1], encode_ms: null });
            }
        }
        for (const [name, columns, rows, kind] of [['window', 1, 1, 'window'], ['40', 8, 5, 'tile'], ['128', 16, 8, 'tile']]) {
            scenarios.push({ id: `${codec}-${name}`, width: kind === 'window' ? 1920 : columns * 64,
                height: kind === 'window' ? 944 : rows * 64,
                frames: [0, 1].map(frame => ({ images: Array.from({ length: columns * rows }, (_, index) => ({
                    asset: `${codec}-${kind}-${(index + frame) % 2}`, x: index % columns * 64,
                    y: Math.floor(index / columns) * 64 })) })) });
        }
    }
    return { schema: 'guacamole-image-pipeline-fixture-v1', provenance: {
        generator: 'syntheticImageFixture/browser-canvas', encoder_note: 'Pre-encoded browser fixtures; no native server/capture/encoder timing.'
    }, assets, scenarios };
}

/** All instrumentation is confined to the benchmark document. Production
 * modules are unmodified, real WebSocket/Tunnel/Parser/Client execute normally. */
export async function imagePipelineReplay(config) {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const distribution = values => {
        if (!values.length) return { count: 0, min: null, p50: null, p95: null, max: null, mean: null };
        const sorted = [...values].sort((a, b) => a - b);
        return { count: values.length, min: sorted[0], p50: sorted[Math.ceil(sorted.length * .5) - 1],
            p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1),
            mean: values.reduce((sum, value) => sum + value, 0) / values.length };
    };
    const references = new Map(), oracleFormats = [];
    const nativeWebP = Boolean(window.ImageDecoder && window.ReadableStream);
    const readReference = (image, width, height, rgbCanvas = false) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d', rgbCanvas ? { willReadFrequently: true } : undefined); context.drawImage(image, 0, 0);
        const rgba = context.getImageData(0, 0, width, height).data;
        for (let i = 3; i < rgba.length; i += 4) assert(rgba[i] === 255, 'Only opaque full-cover fixtures are supported');
        return rgba;
    };
    for (const asset of config.assets) {
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve; image.onerror = () => reject(new Error('Oracle decode failed: ' + asset.id));
            image.src = 'data:' + asset.mimetype + ';base64,' + asset.data_base64;
        });
        assert(image.naturalWidth === asset.width && image.naturalHeight === asset.height, 'Asset dimensions differ');
        const reference = { width: asset.width, height: asset.height,
            rgb: readReference(image, asset.width, asset.height, true), native: null, native_format: null };
        if (nativeWebP && asset.mimetype === 'image/webp') {
            // Complete-buffer native decode and Image provide exact references
            // for the two decoder representations Chrome may choose according
            // to streaming timing (I420 vs BGRX). Select by observed format,
            // never by permitting a pixel difference or matching either image.
            const data = Uint8Array.fromBase64 ? Uint8Array.fromBase64(asset.data_base64)
                : Uint8Array.from(atob(asset.data_base64), character => character.charCodeAt(0));
            const decoder = new ImageDecoder({ type: asset.mimetype, data });
            decoder.completed.catch(() => {}); decoder.tracks.ready.catch(() => {});
            let frame;
            try {
                frame = (await decoder.decode({ completeFramesOnly: true })).image;
                assert(frame.displayWidth === asset.width && frame.displayHeight === asset.height, 'Asset dimensions differ');
                reference.native = readReference(frame, asset.width, asset.height); reference.native_format = frame.format;
                oracleFormats.push({ asset: asset.id, format: frame.format, colorSpace: frame.colorSpace.toJSON() });
            }
            finally { frame?.close(); decoder.close(); }
        }
        references.set(asset.id, reference);
    }
    const composeReference = (frame, formats) => {
        const rgba = new Uint8ClampedArray(config.scenario.width * config.scenario.height * 4);
        frame.images.forEach((image, index) => {
            const reference = references.get(image.asset), format = Array.isArray(formats) ? formats[index] : formats;
            const native = reference.native && (format === 'native' || format === reference.native_format);
            assert(!reference.native || native || [null, 'rgb', 'BGRX', 'RGBX', 'BGRA', 'RGBA'].includes(format), 'Unsupported reference decoder format: ' + format);
            const source = native ? reference.native : reference.rgb;
            for (let y = 0; y < reference.height; y++) rgba.set(source.subarray(y * reference.width * 4, (y + 1) * reference.width * 4),
                ((image.y + y) * config.scenario.width + image.x) * 4);
        });
        return rgba;
    };
    const expectedHashes = {};
    for (const representation of ['rgb', 'native']) expectedHashes[representation] = await Promise.all(config.scenario.frames.map(async frame =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', composeReference(frame, representation))), byte => byte.toString(16).padStart(2, '0')).join('')));

    // Structural observations only: never install allocation/copy probes in a
    // timing run. They run after oracle construction and are restored on exit.
    assert(!config.count_base64_reads || config.verify, 'Base64 counters require untimed verification');
    const base64Capabilities = { setFromBase64: typeof Uint8Array.prototype.setFromBase64 === 'function',
        fromBase64: typeof Uint8Array.fromBase64 === 'function' };
    let base64Reads = null, restoreBase64Reads = () => {};
    if (config.count_base64_reads) {
        base64Reads = { direct_decode_calls: 0, direct_decoded_bytes: 0,
            fallback_payload_buffers: 0, fallback_decoded_bytes: 0,
            fallback_payload_copy_calls: 0, fallback_payload_copy_bytes: 0,
            byob_request_queries: 0, unique_byob_requests_observed: 0,
            observed_byob_capacity_bytes: 0, maximum_byob_capacity_bytes: 0 };
        const buffers = new WeakSet(), OriginalReader = Guacamole.ArrayBufferReader;
        const originalSet = Uint8Array.prototype.set, originalDecode = Uint8Array.prototype.setFromBase64;
        const controllerPrototype = window.ReadableByteStreamController?.prototype;
        const byobDescriptor = controllerPrototype && Object.getOwnPropertyDescriptor(controllerPrototype, 'byobRequest');
        base64Reads.byob_request_observer_available = Boolean(byobDescriptor?.get);
        const requests = new WeakSet();
        if (byobDescriptor?.get) Object.defineProperty(controllerPrototype, 'byobRequest', {
            ...byobDescriptor, get() {
                const request = byobDescriptor.get.call(this);
                base64Reads.byob_request_queries++;
                if (request && !requests.has(request)) {
                    requests.add(request); base64Reads.unique_byob_requests_observed++;
                    base64Reads.observed_byob_capacity_bytes += request.view.byteLength;
                    base64Reads.maximum_byob_capacity_bytes = Math.max(base64Reads.maximum_byob_capacity_bytes, request.view.byteLength);
                }
                return request;
            }
        });
        Guacamole.ArrayBufferReader = function(...args) {
            const reader = new OriginalReader(...args);
            let callback = reader.ondata;
            Object.defineProperty(reader, 'ondata', {
                configurable: true, get: () => callback,
                set: value => { callback = value && (buffer => {
                    buffers.add(buffer); base64Reads.fallback_payload_buffers++;
                    base64Reads.fallback_decoded_bytes += buffer.byteLength;
                    return value(buffer);
                }); }
            });
            return reader;
        };
        Uint8Array.prototype.set = function(source, ...args) {
            if (source && buffers.has(source.buffer)) {
                base64Reads.fallback_payload_copy_calls++;
                base64Reads.fallback_payload_copy_bytes += source.byteLength;
            }
            return originalSet.call(this, source, ...args);
        };
        if (base64Capabilities.setFromBase64) Uint8Array.prototype.setFromBase64 = function(...args) {
            const result = originalDecode.apply(this, args);
            base64Reads.direct_decode_calls++; base64Reads.direct_decoded_bytes += result.written;
            return result;
        };
        restoreBase64Reads = () => {
            Guacamole.ArrayBufferReader = OriginalReader; Uint8Array.prototype.set = originalSet;
            if (base64Capabilities.setFromBase64) Uint8Array.prototype.setFromBase64 = originalDecode;
            if (byobDescriptor?.get) Object.defineProperty(controllerPrototype, 'byobRequest', byobDescriptor);
        };
    }
    const tunnel = new Guacamole.WebSocketTunnel(config.websocket_url);
    const client = new Guacamole.Client(tunnel), display = client.getDisplay();
    if (config.pipeline_diagnostics)
        assert(client.setPipelineDiagnosticsEnabled?.(true), 'Pipeline diagnostics unavailable in selected client bundle');
    const layer = display.getDefaultLayer();
    document.body.appendChild(display.getElement());
    const records = [], drawQueue = [], acknowledgements = [], queueAtAck = [];
    const probeDelay = [], probeLateness = [];
    let drawIndex = 0, incomingFrame = 0, failed = null, verifiedPixels = 0;
    let pollTimer = null, probeTimer = null, probePending = false, probePosted = 0, probeDue = 0, active = true;
    const queue = { samples: 0, maximum_pending_frames: 0, maximum_oldest_age_ms: 0, blocked_samples: 0,
        first_pending_frames: null, last_pending_frames: null, sum_pending_frames: 0 };
    const inputChannel = new MessageChannel();
    let resolveComplete, rejectComplete;
    const complete = new Promise((resolve, reject) => { resolveComplete = resolve; rejectComplete = reject; });
    const fail = error => { if (!failed) { failed = error instanceof Error ? error : new Error(String(error)); rejectComplete(failed); } };
    const sampleQueue = () => {
        const stats = display.getQueueStatistics();
        queue.samples++; queue.maximum_pending_frames = Math.max(queue.maximum_pending_frames, stats.pendingFrames);
        queue.maximum_oldest_age_ms = Math.max(queue.maximum_oldest_age_ms, stats.oldestFrameAge);
        queue.blocked_samples += Number(stats.blocked); queue.sum_pending_frames += stats.pendingFrames;
        if (queue.first_pending_frames === null) queue.first_pending_frames = stats.pendingFrames;
        queue.last_pending_frames = stats.pendingFrames;
    };
    inputChannel.port1.onmessage = () => {
        if (!active || !probePending) return;
        probeDelay.push(performance.now() - probePosted); probePending = false;
    };
    const postProbe = () => {
        if (!probePending) { probePending = true; probePosted = performance.now(); inputChannel.port2.postMessage(null); }
    };
    const probe = () => {
        if (!active) return;
        if (probeLateness.length >= 10000) { fail(new Error('Bounded probe sample limit exceeded')); return; }
        if (records[config.warmup_frames]) {
            probeLateness.push(Math.max(0, performance.now() - probeDue));
            postProbe();
        }
        probeDue = performance.now() + 8; probeTimer = setTimeout(probe, 8);
    };
    const comparePixels = frame => {
        const actual = layer.getCanvas().getContext('2d').getImageData(0, 0, config.scenario.width, config.scenario.height).data;
        const oracle = composeReference(config.scenario.frames[frame % config.scenario.frames.length], records[frame].formats);
        assert(actual.length === oracle.length, 'Canvas dimensions differ from oracle');
        for (let i = 0; i < actual.length; i++) if (actual[i] !== oracle[i])
            throw new Error('Decoded pixels differ at frame ' + frame + ', RGBA byte ' + i + ': ' + actual[i] + ' != ' + oracle[i]
                + ', decoder formats=' + JSON.stringify(records[frame].formats));
        verifiedPixels += config.scenario.width * config.scenario.height;
    };
    const originalDraw = layer.drawImage;
    layer.drawImage = function(x, y, image) {
        const expectedDraw = drawQueue[drawIndex++];
        assert(expectedDraw && x === expectedDraw.x && y === expectedDraw.y, 'Image draw order/coordinates changed');
        const record = records[expectedDraw.frame];
        record.formats.push(image.format || null);
        const start = performance.now();
        if (record.first_draw_ms === null) record.first_draw_ms = start;
        const result = originalDraw.call(layer, x, y, image);
        record.last_draw_ms = performance.now(); record.draw_call_ms += record.last_draw_ms - start; record.draws++;
        return result;
    };
    const originalInstruction = tunnel.oninstruction;
    tunnel.oninstruction = function(opcode, args) {
        try {
            if (opcode === 'img') {
                const template = config.scenario.frames[incomingFrame % config.scenario.frames.length];
                if (!records[incomingFrame]) {
                    records[incomingFrame] = { first_image_ms: performance.now(), last_end_ms: null,
                        sync_ms: null, first_draw_ms: null, last_draw_ms: null, draw_call_ms: 0, draws: 0, handler_ms: 0, formats: [] };
                    if (incomingFrame >= config.warmup_frames) postProbe();
                }
                const expectedImage = template.images[drawQueue.length - config.images_before_frame[incomingFrame]];
                assert(expectedImage && Number(args[4]) === expectedImage.x && Number(args[5]) === expectedImage.y, 'Unexpected image instruction');
                drawQueue.push({ ...expectedImage, frame: incomingFrame });
            }
            else if (opcode === 'end' && records[incomingFrame]) records[incomingFrame].last_end_ms = performance.now();
            else if (opcode === 'sync' && Number(args[0]) !== 1000) {
                assert(Number(args[0]) === 1001 + incomingFrame, 'Incoming sync order changed');
                assert(records[incomingFrame], 'Frame contains no images');
                records[incomingFrame].sync_ms = performance.now(); incomingFrame++;
            }
            const record = records[opcode === 'sync' ? incomingFrame - 1 : incomingFrame];
            const started = performance.now();
            originalInstruction(opcode, args);
            if (record) record.handler_ms += performance.now() - started;
        }
        catch (error) { fail(error); }
    };
    const originalSend = tunnel.sendMessage;
    tunnel.sendMessage = function(...args) {
        const now = performance.now();
        const result = originalSend.apply(tunnel, args);
        if (args[0] === 'sync') {
            try {
                const timestamp = Number(args[1]);
                if (timestamp === 1000) {
                    sampleQueue(); pollTimer = setInterval(sampleQueue, 8);
                    probeDue = performance.now(); probe();
                }
                else {
                    const frame = acknowledgements.length;
                    assert(timestamp === 1001 + frame, 'Duplicate/out-of-order sync ACK');
                    const record = records[frame];
                    const template = config.scenario.frames[frame % config.scenario.frames.length];
                    assert(record && record.draws === template.images.length, 'ACK before all image draws');
                    record.ack_ms = now; acknowledgements.push(timestamp);
                    const stats = display.getQueueStatistics();
                    queueAtAck.push({ frame, pending_frames: stats.pendingFrames, oldest_age_ms: stats.oldestFrameAge, blocked: stats.blocked });
                    // Per-frame readback is only in a separate untimed,
                    // ACK-gated verification run. Timing pages check final RGB.
                    if (config.verify) comparePixels(frame);
                    if (frame + 1 === config.total_frames) {
                        sampleQueue(); clearInterval(pollTimer); clearTimeout(probeTimer); resolveComplete();
                    }
                }
            }
            catch (error) { fail(error); }
        }
        return result;
    };
    client.onerror = status => fail(new Error('Client: ' + status.code + ' ' + status.message));
    tunnel.onerror = status => fail(new Error('Tunnel: ' + status.code + ' ' + status.message));
    const timeout = setTimeout(() => fail(new Error('Browser replay exceeded120s')), 120000);
    try {
        client.connect('session=' + encodeURIComponent(config.session));
        await complete;
        // Catch late duplicate ACKs before disposal; excluded from all timings.
        await new Promise(resolve => setTimeout(resolve, 30));
        if (failed) throw failed;
        const finalQueue = display.getQueueStatistics();
        if (!config.verify) comparePixels(config.total_frames - 1);
        assert(acknowledgements.length === config.total_frames && incomingFrame === config.total_frames,
            'Missing/extra complete frames');
        assert(drawIndex === drawQueue.length && finalQueue.pendingFrames === 0, 'Undrained image/display queue');
        const measured = records.slice(config.warmup_frames);
        const intervals = records.slice(1).map((record, index) => record.first_image_ms - records[index].first_image_ms);
        return { verification_run: config.verify, frames: config.total_frames, measured_frames: measured.length,
            ordered_draws_verified: true, ordered_exactly_once_sync_acks: true,
            pixel_check: { reference_decode: nativeWebP ? 'Image/data-URI RGB plus complete-buffer ImageDecoder native reference; chosen strictly by actual VideoFrame.format' : 'Image/data-URI',
                independent_webp_decoder_algorithm: false, per_frame: config.verify, exact_rgba: true, verified_pixels: verifiedPixels },
            reference_webp_formats: oracleFormats,
            expected_frame_rgba_sha256: expectedHashes,
            decoder: window.ImageDecoder && window.ReadableStream ? 'ImageDecoder/ReadableStream' : 'Image/data-URI',
            base64_capabilities: base64Capabilities,
            base64_read_counts: base64Reads,
            pipeline_diagnostics: config.pipeline_diagnostics ? client.getPipelineStatistics() : null,
            browser_image_dispatch_to_sync_ms: distribution(measured.map(record => record.sync_ms - record.first_image_ms)),
            browser_sync_dispatch_to_ack_ms: distribution(measured.map(record => record.ack_ms - record.sync_ms)),
            browser_last_end_to_first_draw_ms: distribution(measured.map(record => Math.max(0, record.first_draw_ms - record.last_end_ms))),
            browser_draw_calls_ms: distribution(measured.map(record => record.draw_call_ms)),
            browser_image_dispatch_to_ack_ms: distribution(measured.map(record => record.ack_ms - record.first_image_ms)),
            instruction_handler_ms: distribution(measured.map(record => record.handler_ms)),
            received_frame_intervals_ms: distribution(intervals),
            input_opportunity_task_delay_ms: distribution(probeDelay), probe_timer_lateness_ms: distribution(probeLateness),
            queue: { ...queue, mean_pending_frames: queue.sum_pending_frames / queue.samples,
                net_sampled_growth_frames: queue.last_pending_frames - queue.first_pending_frames, at_ack: queueAtAck },
            frame_observations: records.map((record, frame) => ({ frame, first_image_ms: record.first_image_ms,
                sync_ms: record.sync_ms, first_draw_ms: record.first_draw_ms, last_draw_ms: record.last_draw_ms,
                ack_ms: record.ack_ms, draws: record.draws,
                decoder_formats_by_image: record.formats,
                decoder_formats: Object.fromEntries([...new Set(record.formats)].map(format => [format || 'Image', record.formats.filter(value => value === format).length])) })) };
    }
    finally {
        active = false; clearTimeout(timeout); clearInterval(pollTimer); clearTimeout(probeTimer);
        inputChannel.port1.close(); inputChannel.port2.close(); client.disconnect(); display.getElement().remove();
        restoreBase64Reads();
    }
}
