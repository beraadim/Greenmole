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
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptWebSocket, ClientInstructions, distribution, fragmentProtocol, frameProtocol, instruction, profiles } from './benchmarks/image-pipeline-transport.mjs';
import { readFixture, sha256, validateFixture } from './benchmarks/image-pipeline-fixture.mjs';
import { imagePipelineReplay, syntheticImageFixture } from './benchmarks/image-pipeline-replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = 'client/guacamole-common-js/src/main/webapp/modules/';
const modules = ['Layer.js', 'ArrayBufferReader.js', 'DataURIReader.js', 'InputStream.js', 'Parser.js', 'Status.js',
    'Display.js', 'DisplayRecovery.js', 'IntegerPool.js', 'InstructionPump.js', 'DeadlineTimer.js', 'Tunnel.js', 'Client.js'];
const options = { samples: 2, frames: 8, warmup: 2, interval: 16, browser: process.env.CHROME_BIN,
    baseline: null, 'client-ref': null, fixture: null, 'candidate-fixture': null, output: null,
    profiles: Object.keys(profiles).join(','), cases: null, 'write-fixture': null };
for (let index = 2; index < process.argv.length; index++) {
    const option = process.argv[index];
    if (!option.startsWith('--') || !(option.slice(2) in options) || !process.argv[index + 1])
        throw new Error('Usage: benchmark-browser-image-pipeline.mjs [--fixture file] [--candidate-fixture file] [--baseline ref | --client-ref ref] [--samples1..20] [--frames1..60] [--warmup0..10] [--interval1..1000] [--profiles healthy,lan,constrained,jitter] [--cases id,...] [--browser executable] [--output file] [--write-fixture file]');
    options[option.slice(2)] = process.argv[++index];
}
for (const [name, minimum, maximum] of [['samples', 1, 20], ['frames', 1, 60], ['warmup', 0, 10], ['interval', 1, 1000]]) {
    options[name] = Number(options[name]);
    if (!Number.isSafeInteger(options[name]) || options[name] < minimum || options[name] > maximum)
        throw new Error('Invalid --' + name);
}
if (options.baseline && options['client-ref']) throw new Error('--baseline and --client-ref are mutually exclusive');
if (options['candidate-fixture'] && (!options.fixture || options.baseline))
    throw new Error('Payload comparison needs --fixture and a shared --client-ref (default HEAD), not --baseline');
const selectedProfiles = options.profiles.split(',');
if (!selectedProfiles.length || new Set(selectedProfiles).size !== selectedProfiles.length || selectedProfiles.some(name => !profiles[name]))
    throw new Error('Unknown/repeated profile');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const supportNames = ['image-pipeline-transport.mjs', 'image-pipeline-fixture.mjs', 'image-pipeline-replay.mjs'];
const hashHarness = async () => ({ driver_sha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    support_sha256: Object.fromEntries(await Promise.all(supportNames.map(async name =>
        [name, sha256(await readFile(path.join(root, 'scripts/benchmarks', name)))]))) });
const harnessHashes = await hashHarness();
if (!options.browser) {
    const candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    for (const command of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
        try { candidates.push(execFileSync('which', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
        catch { /* Try another installed browser. */ }
    }
    for (const candidate of candidates) {
        try { await access(candidate); options.browser = candidate; break; }
        catch { /* Try the next candidate. */ }
    }
}
if (!options.browser) throw new Error('Set CHROME_BIN or --browser');
const sourceAt = async ref => {
    const revision = git('rev-parse', (ref || 'HEAD') + '^{}').trim();
    const source = ref ? modules.map(name => git('show', revision + ':' + modulePath + name)).join('\n')
        : (await Promise.all(modules.map(name => readFile(path.join(root, modulePath, name), 'utf8')))).join('\n');
    return { revision, ref: ref || 'working-tree',
        modified: ref ? false : git('diff', 'HEAD', '--', ...modules.map(name => modulePath + name)).length !== 0,
        source, bundle_sha256: sha256(source) };
};
const sharedRef = options['client-ref'] || (options['candidate-fixture'] ? 'HEAD' : null);
const versions = sharedRef
    ? [{ name: 'baseline', ...(await sourceAt(sharedRef)) }, { name: 'candidate', ...(await sourceAt(sharedRef)) }]
    : [{ name: 'baseline', ...(await sourceAt(options.baseline || '1.6.1-private.10')) }, { name: 'candidate', ...(await sourceAt(null)) }];
const temporary = await mkdtemp(path.join(tmpdir(), 'guacamole-image-pipeline-'));
const sessions = new Map(), sockets = new Set();
let browser, server;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
const withTimeout = async (promise, milliseconds, message) => {
    let timer;
    try { return await Promise.race([promise, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]); }
    finally { clearTimeout(timer); }
};
const jsonForScript = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const replayHash = sha256(imagePipelineReplay.toString());

/** Each run has a bounded fixed number of frames. The sender never drops a
 * dependent frame, waits for native socket backpressure, and does not pace
 * timing runs by ACKs. Verification runs are separately ACK-gated. */
function newSession(version, fixture, scenario, profileName, verify) {
    const token = randomUUID(), profile = profiles[profileName];
    const totalFrames = verify ? scenario.frames.length : options.frames + options.warmup;
    const assets = fixture.assets;
    const estimatedBytes = Array.from({ length: totalFrames }, (_, index) => scenario.frames[index % scenario.frames.length].images
        .reduce((sum, image) => sum + assets.get(image.asset).data_base64.length
            + Math.ceil(assets.get(image.asset).data_base64.length / 8192) * 128 + 512, 64))
        .reduce((sum, count) => sum + count, 0);
    if (estimatedBytes > 64 * 1024 * 1024) throw new Error('Replay protocol exceeds64MiB bounded storage; reduce --frames/--warmup');
    const frames = Array.from({ length: totalFrames }, (_, index) => frameProtocol(scenario.frames[index % scenario.frames.length], assets, 1001 + index));
    const used = new Set(scenario.frames.flatMap(frame => frame.images.map(image => image.asset)));
    let cumulative = 0;
    const config = { session: token, scenario, assets: [...used].map(id => assets.get(id)), verify,
        total_frames: totalFrames, warmup_frames: verify ? 0 : options.warmup,
        images_before_frame: Array.from({ length: totalFrames }, (_, index) => {
            const before = cumulative; cumulative += scenario.frames[index % scenario.frames.length].images.length; return before;
        }), websocket_url: null };
    let resolveDone, rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    done.catch(() => {}); // Browser and sender errors are joined by the driver.
    const state = { token, version, config, done, frames: [], failure: null, socket: null,
        send_bytes: 0, web_socket_frame_bytes: 0, fragments: [], send_gaps: [], release_errors: [],
        internal_ping_echoes: 0, deferred_ping_echoes: 0, control_reply_protocol_bytes: 0,
        source_schedule_delays: [], max_unacknowledged_frames: 0, acknowledgements: [], ackWaiters: new Map() };
    state.fail = error => { if (!state.failure) { state.failure = error; rejectDone(error); } };
    state.accept = (request, socket, head) => {
        state.socket = socket;
        let send, started = false, seed = 0x7642a193, previousSend = null, serialAvailable = 0;
        let protocolFragmentOpen = false;
        const deferredControls = [];
        const parser = new ClientInstructions(elements => {
            if (elements[0] === '' && elements[1] === 'ping') {
                const text = instruction(elements);
                state.internal_ping_echoes++; state.control_reply_protocol_bytes += Buffer.byteLength(text);
                if (protocolFragmentOpen) {
                    if (deferredControls.length >= 256) throw new Error('Too many deferred replay controls');
                    deferredControls.push(text);
                    state.deferred_ping_echoes++;
                }
                else send(text).catch(state.fail);
                return;
            }
            if (elements[0] === 'nop' || elements[0] === 'disconnect') return;
            if (elements[0] !== 'sync' || elements.length !== 2 || !/^\d+$/.test(elements[1]))
                throw new Error('Unexpected client control instruction');
            const timestamp = Number(elements[1]);
            if (timestamp === 1000) {
                if (started) throw new Error('Duplicate initialization ACK');
                started = true; replay().catch(state.fail); return;
            }
            const frame = state.acknowledgements.length, record = state.frames[frame];
            if (timestamp !== 1001 + frame || !record || !record.final_fragment_write_started)
                throw new Error('Server received duplicate/out-of-order/premature frame ACK');
            record.ack_received_ms = performance.now(); state.acknowledgements.push(timestamp);
            state.ackWaiters.get(frame)?.(); state.ackWaiters.delete(frame);
            if (frame + 1 === totalFrames) resolveDone();
        });
        send = acceptWebSocket(request, socket, head, text => parser.write(text), state.fail);
        socket.on('close', () => { if (state.acknowledgements.length !== totalFrames) state.fail(new Error('Replay socket closed before all ACKs')); });
        send(instruction(['', token]) + instruction(['size', 0, scenario.width, scenario.height]) + instruction(['sync', 1000])).catch(state.fail);
        async function replay() {
            // Initialization/oracle work and this settling delay are excluded.
            await sleep(20);
            const origin = performance.now(); serialAvailable = origin;
            let fragmentIndex = 0;
            for (let frame = 0; frame < totalFrames; frame++) {
                const scheduled = origin + frame * options.interval;
                const record = { frame, protocol_bytes: Buffer.byteLength(frames[frame]), first_send_ms: null,
                    last_send_ms: null, final_fragment_write_started: false, ack_received_ms: null, scheduled_ms: scheduled };
                state.frames.push(record);
                const fragments = fragmentProtocol(frames[frame]);
                protocolFragmentOpen = true;
                for (const [fragment, text] of fragments.entries()) {
                    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
                    const jitter = ((seed >>> 0) / 0x100000000 * 2 - 1) * profile.jitter_ms;
                    const serialization = profile.bytes_per_second ? Buffer.byteLength(text) / profile.bytes_per_second * 1000 : 0;
                    serialAvailable = Math.max(serialAvailable, scheduled + profile.release_delay_ms) + serialization;
                    const pause = profile.pause_every && ++fragmentIndex % profile.pause_every === 0 ? profile.pause_ms : 0;
                    const release = Math.max(scheduled + profile.release_delay_ms, serialAvailable + jitter) + pause;
                    if (release > performance.now() + 0.5) await sleep(release - performance.now());
                    if (state.failure) throw state.failure;
                    const now = performance.now();
                    if (record.first_send_ms === null) {
                        record.first_send_ms = now; state.source_schedule_delays.push(now - scheduled);
                        state.max_unacknowledged_frames = Math.max(state.max_unacknowledged_frames, frame + 1 - state.acknowledgements.length);
                    }
                    if (previousSend !== null) state.send_gaps.push(now - previousSend);
                    previousSend = now; state.release_errors.push(now - release); state.fragments.push(Buffer.byteLength(text));
                    state.send_bytes += Buffer.byteLength(text);
                    state.web_socket_frame_bytes += Buffer.byteLength(text) + (text.length < 126 ? 2 : text.length < 65536 ? 4 : 10);
                    // Set before write: loopback ACKs may arrive while waiting
                    // for socket backpressure after the final fragment.
                    record.last_send_ms = now;
                    if (fragment + 1 === fragments.length) record.final_fragment_write_started = true;
                    await send(text);
                }
                protocolFragmentOpen = false;
                // Internal ping echoes must never interrupt the length/payload
                // of a Guacamole instruction split across WebSocket messages.
                if (deferredControls.length) await send(deferredControls.splice(0).join(''));
                if (verify && !record.ack_received_ms) await new Promise(resolve => state.ackWaiters.set(frame, resolve));
            }
        }
    };
    state.summary = () => {
        if (state.failure) throw state.failure;
        const measured = state.frames.slice(config.warmup_frames), first = measured[0].first_send_ms, last = measured.at(-1).last_send_ms;
        return { acknowledgements: state.acknowledgements.length, ordered_exactly_once_sync_acks: true,
            protocol_bytes: state.send_bytes, data_websocket_bytes_including_frame_headers: state.web_socket_frame_bytes,
            internal_ping_echoes: state.internal_ping_echoes, deferred_ping_echoes: state.deferred_ping_echoes,
            control_reply_protocol_bytes: state.control_reply_protocol_bytes,
            achieved_protocol_bytes_per_second: last > first ? measured.reduce((sum, frame) => sum + frame.protocol_bytes, 0) / (last - first) * 1000 : null,
            note: 'Achieved rate includes source pacing/idle intervals; send timestamps are application writes, not kernel delivery timestamps. No browser/server clock subtraction.',
            transfer_span_ms: distribution(measured.map(frame => frame.last_send_ms - frame.first_send_ms)),
            final_write_to_ack_received_ms: distribution(measured.map(frame => frame.ack_received_ms - frame.last_send_ms)),
            source_due_to_ack_received_ms: distribution(measured.map(frame => frame.ack_received_ms - frame.scheduled_ms)),
            fragment_bytes: distribution(state.fragments), achieved_send_gaps_ms: distribution(state.send_gaps),
            release_schedule_error_ms: distribution(state.release_errors), source_schedule_delay_ms: distribution(state.source_schedule_delays),
            maximum_unacknowledged_frames: state.max_unacknowledged_frames, frames: state.frames };
    };
    sessions.set(token, state); return state;
}

async function connectCDP(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
        const value = JSON.parse(event.data), entry = pending.get(value.id);
        if (entry) { pending.delete(value.id); clearTimeout(entry.timer); entry.resolve(value); }
    });
    socket.addEventListener('close', () => {
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('CDP socket closed')); }
        pending.clear();
    });
    return { socket, call: (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' exceeded150s')); }, 150000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    }) };
}

try {
    server = createServer((request, response) => {
        const token = new URL(request.url, 'http://localhost').pathname.slice(1), state = sessions.get(token);
        if (!state) { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        state.config.websocket_url = 'ws://127.0.0.1:' + server.address().port + '/socket';
        const script = state.version.source + '\nwindow.__pipelineResult=(' + imagePipelineReplay.toString() + ')('
            + jsonForScript(state.config) + ');window.__pipelineResult.catch(()=>{});';
        response.end('<!doctype html><body><script>' + script.replaceAll('</script', '<\\/script') + '</script>');
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (request, socket, head) => {
        const token = new URL(request.url, 'http://localhost').searchParams.get('session'), state = sessions.get(token);
        if (!state || state.socket) { socket.destroy(); return; }
        try { state.accept(request, socket, head); }
        catch (error) { state.fail(error); socket.destroy(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = spawn(options.browser, ['--headless', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        '--user-data-dir=' + path.join(temporary, 'profile'), '--disable-background-networking', '--disable-component-update',
        '--disable-extensions', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Chrome did not start')), 10000);
        let log = '';
        browser.stderr.on('data', bytes => { log = (log + bytes).slice(-32768); const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); } });
        browser.once('error', error => { clearTimeout(timer); reject(error); });
        browser.once('exit', code => { clearTimeout(timer); reject(new Error('Chrome exited: ' + code)); });
    });
    const debugAddress = 'http://127.0.0.1:' + new URL(endpoint).port;
    const browserVersion = await (await fetch(debugAddress + '/json/version')).json();
    async function inPage(url, expression) {
        const target = await (await fetch(debugAddress + '/json/new?about:blank', { method: 'PUT' })).json();
        const cdp = await connectCDP(target.webSocketDebuggerUrl);
        try {
            await cdp.call('Page.enable');
            if (url) {
                await cdp.call('Page.navigate', { url });
                // The old blank execution context can disappear during navigation.
                for (let attempt = 0; attempt < 100; attempt++) {
                    const ready = await cdp.call('Runtime.evaluate', { expression: 'Boolean(window.__pipelineResult)', returnByValue: true });
                    if (ready.result?.result?.value) break;
                    if (attempt === 99) throw new Error('Replay document failed to initialize');
                    await sleep(10);
                }
            }
            const response = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (response.error || response.result.exceptionDetails) throw new Error('Browser replay failed: ' + JSON.stringify(response));
            return response.result.result.value;
        }
        finally { cdp.socket.close(); await fetch(debugAddress + '/json/close/' + target.id); }
    }
    const baselineFixture = options.fixture ? await readFixture(options.fixture)
        : validateFixture(await inPage(null, '(' + syntheticImageFixture.toString() + ')()'));
    if (options['write-fixture']) await writeFile(options['write-fixture'], JSON.stringify(baselineFixture.fixture, null, 2) + '\n');
    const candidateFixture = options['candidate-fixture'] ? await readFixture(options['candidate-fixture']) : baselineFixture;
    if (baselineFixture.geometry_sha256 !== candidateFixture.geometry_sha256) throw new Error('Payload variants have different scenario geometry/asset placement');
    const selectedCases = options.cases ? options.cases.split(',') : baselineFixture.fixture.scenarios.map(scenario => scenario.id);
    if (!selectedCases.length || new Set(selectedCases).size !== selectedCases.length
            || selectedCases.some(id => !baselineFixture.fixture.scenarios.some(scenario => scenario.id === id))) throw new Error('Unknown/repeated case');
    const runCount = selectedCases.length * selectedProfiles.length * options.samples * 2;
    const observedFrames = runCount * (options.frames + options.warmup);
    const observedDraws = selectedCases.reduce((sum, id) => {
        const scenario = baselineFixture.fixture.scenarios.find(value => value.id === id);
        return sum + Array.from({ length: options.frames + options.warmup }, (_, frame) => scenario.frames[frame % scenario.frames.length].images.length)
            .reduce((total, count) => total + count, 0);
    }, 0) * selectedProfiles.length * options.samples * 2;
    if (runCount > 512 || observedFrames > 20000 || observedDraws > 2000000)
        throw new Error('Requested measurement exceeds bounded result storage; reduce samples/cases/frames');
    const samples = [], verification = [];
    async function run(version, variant, scenario, profileName, verify, iteration) {
        const state = newSession(version, variant, scenario, profileName, verify);
        try {
            const result = await inPage('http://127.0.0.1:' + server.address().port + '/' + state.token, 'window.__pipelineResult');
            await withTimeout(state.done, 10000, 'Missing server ACK observations');
            const serverResult = state.summary();
            if (result.frames !== serverResult.acknowledgements || !result.ordered_exactly_once_sync_acks || !result.pixel_check.exact_rgba)
                throw new Error('Browser/server correctness observations disagree');
            const record = { iteration, version: version.name, fixture_sha256: variant.sha256, scenario: scenario.id,
                profile: profileName, requested_profile: profiles[profileName], source_interval_ms: options.interval,
                browser: result, sender: serverResult };
            (verify ? verification : samples).push(record);
            process.stderr.write(`${verify ? 'verified' : 'measured'} ${version.name} ${scenario.id} ${profileName} ${iteration}\n`);
        }
        finally { sessions.delete(state.token); state.socket?.destroy(); }
    }
    // Exact per-frame RGBA readback uses a separate untimed healthy run, for
    // both source/payload versions. Every timing run also verifies final RGBA.
    for (const version of versions) {
        const fixture = version.name === 'baseline' ? baselineFixture : candidateFixture;
        for (const id of selectedCases) await run(version, fixture, fixture.fixture.scenarios.find(scenario => scenario.id === id), 'healthy', true, -1);
    }
    for (const id of selectedCases) {
        const expected = verification.filter(record => record.scenario === id).map(record => record.browser.expected_frame_rgba_sha256);
        if (JSON.stringify(expected[0]) !== JSON.stringify(expected[1]))
            throw new Error('Baseline/candidate decoded frame pixels differ: ' + id);
    }
    for (let iteration = 0; iteration < options.samples; iteration++) {
        const ordered = iteration % 2 ? [...versions].reverse() : versions;
        for (const id of selectedCases) for (const profileName of selectedProfiles) for (const version of ordered) {
            const fixture = version.name === 'baseline' ? baselineFixture : candidateFixture;
            await run(version, fixture, fixture.fixture.scenarios.find(scenario => scenario.id === id), profileName, false, iteration);
        }
    }
    const sourceSummary = versions.map(({ source, ...metadata }) => metadata);
    const fixtureSummary = fixture => ({ sha256: fixture.sha256, geometry_sha256: fixture.geometry_sha256,
        encoded_bytes: fixture.encoded_bytes, provenance: fixture.fixture.provenance, assets: fixture.asset_summary });
    if (JSON.stringify(await hashHarness()) !== JSON.stringify(harnessHashes))
        throw new Error('Benchmark source changed during measurement; discard and rerun the frozen harness');
    const summary = [];
    for (const scenario of selectedCases) for (const profile of selectedProfiles) {
        const values = {};
        for (const version of versions) {
            const rows = samples.filter(record => record.scenario === scenario && record.profile === profile && record.version === version.name);
            const mean = select => {
                const data = rows.map(select).filter(value => value !== null);
                return data.length ? data.reduce((sum, value) => sum + value, 0) / data.length : null;
            };
            values[version.name] = { runs: rows.length,
                mean_per_run_p95_browser_image_dispatch_to_ack_ms: mean(row => row.browser.browser_image_dispatch_to_ack_ms.p95),
                mean_per_run_p95_source_due_to_ack_received_ms: mean(row => row.sender.source_due_to_ack_received_ms.p95),
                mean_per_run_p95_input_opportunity_task_delay_ms: mean(row => row.browser.input_opportunity_task_delay_ms.p95),
                mean_per_run_max_pending_display_frames: mean(row => row.browser.queue.maximum_pending_frames),
                mean_achieved_protocol_bytes_per_second: mean(row => row.sender.achieved_protocol_bytes_per_second) };
        }
        summary.push({ scenario, profile, ...values });
    }
    const result = { schema: 'guacamole-browser-image-pipeline-v1', created_at: new Date().toISOString(),
        method: 'Real loopback WebSocket → unmodified WebSocketTunnel/InstructionPump/Parser/Client → img/blob/end/sync → actual image decode/canvas draw → real WebSocket sync ACK. Fixed bounded frame count, no dependent frame dropping.',
        comparison: options['candidate-fixture'] ? 'Identical client bundle, baseline/candidate production payloads' : 'Identical encoded payloads, baseline/candidate client bundles',
        limitations: [
            'Application-level downstream release/byte pacing and seeded jitter, not TCP/Wi-Fi loss, RTT or congestion emulation. ACKs travel unshaped on loopback.',
            'No capture, physical display paint/FPS or physical input latency. MessageChannel probes measure browser-task opportunity only.',
            'Pre-encoded payloads: native generation/encoder times are separate informational fixture metadata and excluded from all browser/sender timings.',
            'Browser first-img→sync combines data arrival/parser/handlers; sync→ACK combines remaining decode/frame wait/draw. Decode can overlap transfer; these are not independent additive decoder timings.',
            'Sender and browser clocks are separate; no timestamps are subtracted across domains. Writes do not prove immediate kernel delivery.',
            'Instrumentation is test-only and identical for both versions. Per-frame pixels verified in separate ACK-gated runs; timing runs check final pixels, ordered draw coordinates/counts and exact ordered ACKs.',
            'PNG reference uses Image/data-URI. WebP can produce I420 or BGRX depending on streamed timing, with1channel RGB conversion differences. Precomputed Image/RGB and complete-buffer native references are selected strictly by each actual VideoFrame.format, not pixel similarity or tolerance. Canonical RGB and native canvas hashes must both match across fixture versions. Native WebP reference is not an independent decoder algorithm; original lossy source pixels are not claimed.'
        ], browser: browserVersion.Browser, platform: process.platform + '-' + process.arch,
        ...harnessHashes, replay_sha256: replayHash,
        versions: sourceSummary, fixtures: { baseline: fixtureSummary(baselineFixture), candidate: fixtureSummary(candidateFixture) },
        requested: { samples_per_version: options.samples, measured_frames: options.frames, warmup_frames: options.warmup,
            source_interval_ms: options.interval, profiles: selectedProfiles, scenarios: selectedCases, order: 'A/B, then B/A alternating per sample' },
        cross_fixture_canonical_frame_hashes_equal: true,
        summary_method: 'Arithmetic means of per-run nearest-rank p95/max/rate values, not pooled-frame percentiles. Raw observations retained.',
        summary, verification, samples };
    const serialized = JSON.stringify(result, null, 2) + '\n';
    if (options.output) await writeFile(options.output, serialized);
    else process.stdout.write(serialized);
}
finally {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    if (browser && browser.exitCode === null) {
        const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill('SIGTERM');
        try { await withTimeout(exited, 3000, 'Chrome shutdown timed out'); }
        catch { browser.kill('SIGKILL'); await exited; }
    }
    await rm(temporary, { recursive: true, force: true });
}
