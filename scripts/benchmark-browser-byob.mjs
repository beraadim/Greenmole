#!/usr/bin/env node
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
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackBrowserProcess } from './benchmarks/browser-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { baseline: '1.6.1-private.11', candidate: '6046fa964', samples: 4,
    browser: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', output: null };
for (let index = 2; index < process.argv.length; index++) {
    const name = process.argv[index].slice(2);
    if (!process.argv[index].startsWith('--') || !(name in options) || !process.argv[index + 1])
        throw new Error('Usage: benchmark-browser-byob.mjs [--baseline ref] [--candidate ref] [--samples 2..20] [--browser executable] [--output file]');
    options[name] = process.argv[++index];
}
options.samples = Number(options.samples);
if (!Number.isSafeInteger(options.samples) || options.samples < 2 || options.samples > 20)
    throw new Error('--samples must be an integer from2through20');
await access(options.browser);
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
const versions = ['baseline', 'candidate'].map(name => {
    const revision = git('rev-parse', options[name] + '^{}').trim();
    const modules = ['ArrayBufferReader.js', 'InputStream.js'].map(file => {
        const source = git('show', revision + ':client/guacamole-common-js/src/main/webapp/modules/' + file);
        return { file, source, sha256: hash(source) };
    });
    const source = modules.map(module => module.source).join('\n');
    return { name, ref: options[name], revision, source, bundle_sha256: hash(source),
        modules_sha256: Object.fromEntries(modules.map(module => [module.file, module.sha256])) };
});
const driverPath = fileURLToPath(import.meta.url), driverHash = hash(await readFile(driverPath));
const processHelperPath = path.join(root, 'scripts/benchmarks/browser-process.mjs');
const processHelperHash = hash(await readFile(processHelperPath));

/** Only a real native BYOB byte stream is measured. No image decoder, timers,
 * JavaScript Base64 polyfill or instrumentation substitutes for that stream. */
async function probe(config) {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const capabilities = { fromBase64: typeof Uint8Array.fromBase64 === 'function',
        setFromBase64: typeof Uint8Array.prototype.setFromBase64 === 'function',
        toBase64: typeof Uint8Array.prototype.toBase64 === 'function', ReadableStream: typeof ReadableStream === 'function' };
    assert(Object.values(capabilities).every(Boolean), 'Real native Base64 and ReadableStream APIs are required');
    const constructors = Object.fromEntries(config.versions.map(version =>
        [version.name, new Function(version.source + '; return Guacamole.InputStream;')()]));
    const verification = [], observations = [];
    for (const [size, frames] of [[6144, 4000], [65535, 400], [1048576, 32]]) {
        const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251), encoded = bytes.toBase64();
        async function trial(name, count, counted) {
            const counts = { allocating_decode_calls: 0, allocated_payload_bytes: 0,
                direct_decode_calls: 0, direct_payload_bytes: 0, payload_copy_calls: 0, payload_copy_bytes: 0 };
            const from = Uint8Array.fromBase64, into = Uint8Array.prototype.setFromBase64, set = Uint8Array.prototype.set;
            if (counted) {
                const buffers = new WeakSet();
                Uint8Array.fromBase64 = function(...args) {
                    const result = from.apply(this, args); buffers.add(result.buffer);
                    counts.allocating_decode_calls++; counts.allocated_payload_bytes += result.byteLength; return result;
                };
                Uint8Array.prototype.setFromBase64 = function(...args) {
                    const result = into.apply(this, args);
                    counts.direct_decode_calls++; counts.direct_payload_bytes += result.written; return result;
                };
                Uint8Array.prototype.set = function(source, ...args) {
                    if (source && buffers.has(source.buffer)) {
                        counts.payload_copy_calls++; counts.payload_copy_bytes += source.byteLength;
                    }
                    return set.call(this, source, ...args);
                };
            }
            let reader;
            try {
                const stream = new constructors[name]({}, 1);
                reader = stream.toReadableStream().getReader({ mode: 'byob' });
                let buffer = new ArrayBuffer(size + 8), value;
                const begin = performance.now();
                for (let frame = 0; frame < count; frame++) {
                    const pending = reader.read(new Uint8Array(buffer, 3, size));
                    stream.onblob(encoded); value = (await pending).value; buffer = value.buffer;
                }
                const elapsed = performance.now() - begin;
                // Full final bytes, offset, outside-view sentinels and EOF are
                // checked after timing, not on each measured blob.
                assert(value.byteOffset === 3 && value.byteLength === size, 'Read geometry changed');
                for (let i = 0; i < size; i++) assert(value[i] === bytes[i], 'Decoded byte differs: ' + i);
                const complete = new Uint8Array(buffer);
                for (let i = 0; i < 3; i++) assert(complete[i] === 0, 'Prefix bytes changed');
                for (let i = size + 3; i < complete.length; i++) assert(complete[i] === 0, 'Suffix bytes changed');
                stream.onend();
                const eof = await reader.read(new Uint8Array(buffer, 3, size));
                assert(eof.done && eof.value.byteLength === 0, 'EOF not completed');
                if (counted) {
                    assert(counts.allocating_decode_calls + counts.direct_decode_calls === count, 'Decode call count changed');
                    assert(counts.allocated_payload_bytes + counts.direct_payload_bytes === count * size, 'Decode byte count changed');
                }
                return { size, frames: count, version: name, elapsed_ms: elapsed,
                    exact_final_bytes_verified: true, outside_view_bytes_verified: true, eof_verified: true,
                    counts: counted ? counts : null };
            }
            finally {
                try { if (reader) await reader.cancel(); }
                finally {
                    if (counted) {
                        Uint8Array.fromBase64 = from; Uint8Array.prototype.setFromBase64 = into;
                        Uint8Array.prototype.set = set;
                    }
                }
            }
        }
        for (const name of ['baseline', 'candidate']) {
            verification.push(await trial(name, 2, true));
            await trial(name, 128, false);
        }
        for (let iteration = 0; iteration < config.samples; iteration++)
            for (const name of (iteration % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']))
                observations.push({ iteration, ...await trial(name, frames, false) });
    }
    return { capabilities, verification, observations };
}

const temporary = await mkdtemp(path.join(tmpdir(), 'guacamole-byob-study-'));
let browser, socket, stopBrowser;
try {
    browser = spawn(options.browser, ['--headless', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        '--user-data-dir=' + path.join(temporary, 'profile'), '--disable-background-networking', '--disable-component-update',
        '--disable-extensions', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    stopBrowser = trackBrowserProcess(browser);
    const endpoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Chrome did not start')), 10000);
        let output = '';
        browser.stderr.on('data', data => {
            output = (output + data).slice(-32768); const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        browser.once('error', error => { clearTimeout(timer); reject(error); });
        browser.once('exit', code => { clearTimeout(timer); reject(new Error('Chrome exited: ' + code)); });
    });
    const address = 'http://127.0.0.1:' + new URL(endpoint).port;
    const browserVersion = await (await fetch(address + '/json/version')).json();
    const target = await (await fetch(address + '/json/new?about:blank', { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP connection exceeded10s')), 10000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); });
        socket.addEventListener('error', error => { clearTimeout(timer); reject(error); });
    });
    const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('BYOB study exceeded60s')), 60000);
        socket.addEventListener('message', event => {
            const response = JSON.parse(event.data);
            if (response.id !== 1) return;
            clearTimeout(timer);
            if (response.error || response.result?.exceptionDetails)
                reject(new Error('Browser study failed: ' + JSON.stringify(response)));
            else resolve(response.result.result.value);
        });
        socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('CDP closed')); });
        socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
            expression: '(' + probe.toString() + ')(' + JSON.stringify({ samples: options.samples, versions }) + ')',
            awaitPromise: true, returnByValue: true } }));
    });
    if (hash(await readFile(driverPath)) !== driverHash) throw new Error('Study driver changed while measuring');
    if (hash(await readFile(processHelperPath)) !== processHelperHash) throw new Error('Browser lifecycle helper changed while measuring');
    const summary = [...new Set(result.observations.map(row => row.size))].map(size => {
        const means = Object.fromEntries(['baseline', 'candidate'].map(name => {
            const values = result.observations.filter(row => row.size === size && row.version === name);
            return [name + '_mean_ms', values.reduce((sum, row) => sum + row.elapsed_ms, 0) / values.length];
        }));
        return { size, ...means, candidate_over_baseline_ratio: means.candidate_mean_ms / means.baseline_mean_ms };
    });
    const report = { schema: 'guacamole-explicit-byob-study-v1', created_at: new Date().toISOString(),
        browser: browserVersion.Browser, platform: process.platform + '-' + process.arch,
        driver_sha256: driverHash, browser_probe_sha256: hash(probe.toString()),
        process_helper_sha256: processHelperHash,
        versions: versions.map(({ source, ...version }) => version), samples_per_version: options.samples,
        method: 'Actual native BYOB ReadableStream, canonical independent blob, offset3, reused returned backing buffer; 2countedverificationreads and128uncountedwarmupreads per version/size; alternating A/B and B/A order.',
        limitations: ['Synthetic generic BYOB consumer, not ImageDecoder or network performance.',
            'Canonical validation scan, stream delivery, buffer transfers and Promise continuation overhead are included in timings; this does not isolate Base64 CPU.',
            'Counters run only in separate untimed verification; timed counts are null. Final full bytes/geometry/EOF checked after timing, not each timed blob.',
            'Means of complete fixed-count trials, not frame percentiles; no garbage collection or heap-size measurement.'],
        ...result, summary };
    const serialized = JSON.stringify(report, null, 2) + '\n';
    if (options.output) await writeFile(options.output, serialized); else process.stdout.write(serialized);
}
finally {
    socket?.close();
    try {
        if (stopBrowser && !await stopBrowser()) throw new Error('Browser did not stop within the bounded cleanup deadline');
    }
    finally {
        await rm(temporary, { recursive: true, force: true });
    }
}
