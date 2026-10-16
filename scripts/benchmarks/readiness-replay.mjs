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

// Serialized into an isolated browser document by benchmark-browser-render.mjs.
// Count-only source instrumentation never runs in the real decode timing page.
export async function readinessReplay() {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
    const opportunity = () => new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close(); channel.port2.close(); resolve();
        };
        channel.port2.postMessage(null);
    });
    const scenarios = [];

    if (window.__readinessCountOnly) {
        const originalImage = window.Image;
        try {
            for (const fixture of [
                { name: 'sequential-40', count: 40, multiplier: 1 },
                { name: 'sequential-128', count: 128, multiplier: 1 },
                { name: 'sequential-512', count: 512, multiplier: 1 },
                { name: 'shuffled-128', count: 128, multiplier: 37 },
                { name: 'reverse-128', count: 128, multiplier: -1 }
            ]) {
                const images = [], drawn = [], acknowledgements = [];
                window.Image = function Image() { this.width = this.height = 1; images.push(this); };
                const display = new Guacamole.Display();
                const layer = { drawImage: x => drawn.push(x) };
                window.__readinessChecks = 0;
                for (let i = 0; i < fixture.count; i++) display.draw(layer, i, 0, 'data:controlled');
                display.flush(() => acknowledgements.push(0));
                for (let i = 0; i < fixture.count; i++) {
                    // Separate microtasks model individually completed decoders.
                    await Promise.resolve();
                    const index = fixture.multiplier < 0 ? fixture.count - 1 - i : i * fixture.multiplier % fixture.count;
                    images[index].onload();
                    if (i + 1 < fixture.count) {
                        assert(!drawn.length && !acknowledgements.length, 'Controlled frame rendered before all images were ready');
                    }
                }
                assert(drawn.length === fixture.count && drawn.every((x, i) => x === i), 'Controlled image order changed');
                assert(acknowledgements.length === 1, 'Controlled frame acknowledgement duplicated/missing');
                scenarios.push({ scenario: fixture.name, images: fixture.count,
                    readiness_checks: window.__readinessChecks, acknowledgements: 1, ordered_draws_verified: true });
                display.cancel();
            }
        }
        finally { window.Image = originalImage; }
        return scenarios;
    }

    // Generate and independently decode a small fixed set of opaque source
    // tiles before timing. WebP's oracle is its decoded image, not uncompressed
    // source pixels: browser WebP encoding is lossy at the requested quality.
    const tileSize = 64;
    const source = document.createElement('canvas');
    source.width = source.height = tileSize;
    const context = source.getContext('2d');
    const encoded = {};
    for (const mimetype of ['image/png', 'image/webp']) {
        encoded[mimetype] = [];
        for (let variant = 0; variant < 8; variant++) {
            context.fillStyle = 'rgb(' + (variant * 29) + ',90,180)';
            context.fillRect(0, 0, tileSize, tileSize);
            for (let y = 0; y < tileSize; y += 8) {
                context.fillStyle = 'rgb(220,' + (variant * 23) + ',' + (y * 3) + ')';
                context.fillRect((y + variant * 7) % 48, y, 16, 5);
            }
            const uri = source.toDataURL(mimetype, 0.85);
            assert(uri.startsWith('data:' + mimetype + ';base64,'), 'Browser cannot encode required ' + mimetype);
            const image = new Image();
            await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = uri; });
            encoded[mimetype].push({ image, data: uri.split(',')[1] });
        }
    }

    for (const fixture of [
        { name: 'paced-png-40', mimetype: 'image/png', columns: 8, rows: 5 },
        { name: 'paced-webp-40', mimetype: 'image/webp', columns: 8, rows: 5 },
        { name: 'paced-png-128', mimetype: 'image/png', columns: 16, rows: 8 },
        { name: 'paced-webp-128', mimetype: 'image/webp', columns: 16, rows: 8 }
    ]) {
        const display = new Guacamole.Display();
        const layer = display.getDefaultLayer();
        const count = fixture.columns * fixture.rows;
        const width = fixture.columns * tileSize, height = fixture.rows * tileSize;
        const expected = document.createElement('canvas');
        expected.width = width; expected.height = height;
        const expectedContext = expected.getContext('2d', { willReadFrequently: true });
        display.resize(layer, width, height); display.flush();
        const originalDraw = layer.drawImage;
        let draws = 0, failures = 0;
        layer.drawImage = function(...args) { draws++; return originalDraw.apply(layer, args); };
        display.onimageerror = () => failures++;
        const durations = [], inputDelays = [], acknowledgements = [];
        const frameStarts = [];
        const warmup = 4, samples = 24;
        let verifiedPixels = 0, finalHash = 2166136261;
        const started = performance.now();
        try {
            for (let frame = -warmup; frame < samples; frame++) {
                const frameNumber = frame + warmup;
                const tiles = Array.from({ length: count }, (_, i) => encoded[fixture.mimetype][(i + frameNumber) % 8]);
                for (let i = 0; i < count; i++) {
                    expectedContext.drawImage(tiles[i].image, i % fixture.columns * tileSize,
                        Math.floor(i / fixture.columns) * tileSize);
                }
                const before = draws;
                const streams = [];
                const frameStarted = performance.now();
                if (frame >= 0) frameStarts.push(frameStarted);
                let acknowledge;
                const complete = new Promise(resolve => { acknowledge = resolve; });
                for (let i = 0; i < count; i++) {
                    const stream = new Guacamole.InputStream({}, i);
                    display.drawStream(layer, i % fixture.columns * tileSize,
                        Math.floor(i / fixture.columns) * tileSize, stream, fixture.mimetype);
                    streams.push(stream);
                }
                display.flush(() => {
                    if (frame >= 0) durations.push(performance.now() - frameStarted);
                    acknowledgements.push(frameNumber);
                    acknowledge();
                });
                const posted = performance.now();
                const input = opportunity().then(() => {
                    if (frame >= 0) inputDelays.push(performance.now() - posted);
                    assert(draws - before === 0 || draws - before === count, 'A browser task observed a partial frame');
                });
                const halves = tiles.map(tile => Math.floor(tile.data.length / 8) * 4);
                for (let i = 0; i < count; i++) streams[i].onblob(tiles[i].data.slice(0, halves[i]));
                await opportunity();
                for (let i = 0; i < count; i++) {
                    if (streams[i].onblob) streams[i].onblob(tiles[i].data.slice(halves[i]));
                    if (streams[i].onend) streams[i].onend();
                }
                await Promise.all([complete, input]);
                assert(!failures && draws - before === count, 'Native decode failed or draw count changed');
                assert(acknowledgements.length === frameNumber + 1 && acknowledgements[frameNumber] === frameNumber, 'Native ACK order/count changed');
                // Pixel readback and oracle checks are outside the frame timer.
                const actual = layer.getCanvas().getContext('2d').getImageData(0, 0, width, height).data;
                const oracle = expectedContext.getImageData(0, 0, width, height).data;
                assert(actual.length === oracle.length && actual.every((value, i) => value === oracle[i]), 'Native frame pixels differ');
                verifiedPixels += width * height;
                if (frame === samples - 1) for (const byte of actual) finalHash = Math.imul(finalHash ^ byte, 16777619) >>> 0;
                const delay = 16 - (performance.now() - frameStarted);
                if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
            }
            scenarios.push({ scenario: fixture.name, frames: samples, warmup_frames: warmup,
                checked_frames: samples + warmup, images_per_frame: count,
                mimetype: fixture.mimetype, decoder: window.ImageDecoder && window.ReadableStream ? 'ImageDecoder' : 'Image/data-URI',
                source_interval_target_ms: 16, overall_completion_including_warmup_and_validation_ms: performance.now() - started,
                observed_source_gap_p50_ms: percentile(frameStarts.slice(1).map((value, i) => value - frameStarts[i]), 0.5),
                observed_source_gap_p95_ms: percentile(frameStarts.slice(1).map((value, i) => value - frameStarts[i]), 0.95),
                frame_completion_p50_ms: percentile(durations, 0.5), frame_completion_p95_ms: percentile(durations, 0.95),
                input_task_delay_ms: percentile(inputDelays, 0.95),
                acknowledgements: acknowledgements.length,
                ordered_draws_verified: true, rgb_pixels_compared: verifiedPixels,
                final_pixel_hash: finalHash.toString(16).padStart(8, '0') });
        }
        finally { display.cancel(); }
    }
    return scenarios;
}

export const readinessReplaySource = 'window.__renderReplay = (' + readinessReplay.toString() + ')();';
