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

// Replays synthetic blocked-frame backlogs using the actual Display.js from
// private.3, private.4, and the working tree. Requires Node.js 22+ and Chrome.
// There is no live desktop, tunnel, clipboard, or remote connection involved.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { protocolReplay, timerReplay } from './benchmarks/protocol-replay.mjs';
import { readinessReplaySource } from './benchmarks/readiness-replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = 'client/guacamole-common-js/src/main/webapp/modules/';
const options = { samples: 4, browser: process.env.CHROME_BIN, output: null, scenario: 'render', baseline: null };
for (let i = 2; i < process.argv.length; i++) {
    const argument = process.argv[i];
    if (!['--samples', '--browser', '--output', '--scenario', '--baseline'].includes(argument) || !process.argv[i + 1])
        throw new Error('Usage: benchmark-browser-render.mjs [--samples 1..20] [--browser executable] [--output result.json] [--scenario render|protocol|timers|readiness] [--baseline ref]');
    options[argument.slice(2)] = process.argv[++i];
}
options.samples = Number(options.samples);
if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 20)
    throw new Error('--samples must be an integer from 1 through 20');
if (!['render', 'protocol', 'timers', 'readiness'].includes(options.scenario))
    throw new Error('--scenario must be render, protocol, timers, or readiness');

if (!options.browser) {
    const candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    for (const command of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
        try { candidates.push(execFileSync('which', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
        catch { /* Try another locally installed browser. */ }
    }
    for (const candidate of candidates) {
        try { await access(candidate); options.browser = candidate; break; }
        catch { /* Try another locally installed browser. */ }
    }
}
if (!options.browser)
    throw new Error('Set CHROME_BIN or pass --browser with an installed Chrome/Chromium executable');

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const layer = await readFile(path.join(root, modulePath, 'Layer.js'), 'utf8');
const versions = [];
const readiness = options.scenario === 'readiness';
const protocol = ['protocol', 'timers'].includes(options.scenario);
const bundle = protocol || readiness;
const modules = readiness ? ['ArrayBufferReader.js', 'DataURIReader.js', 'InputStream.js', 'Display.js'] : protocol
    ? ['Parser.js', 'Status.js', 'Display.js', 'DisplayRecovery.js', 'IntegerPool.js', 'InstructionPump.js', 'DeadlineTimer.js', 'Tunnel.js', 'Client.js']
    : ['Display.js'];
const tags = options.baseline ? [options.baseline] : readiness ? ['1.6.1-private.9'] : options.scenario === 'timers'
    ? ['1.6.1-private.6'] : protocol ? ['1.6.1-private.5'] : ['1.6.1-private.3', '1.6.1-private.4'];
for (const tag of tags) {
    const available = new Set(git('ls-tree', '--name-only', tag, '--',
        ...modules.map(name => modulePath + name)).trim().split('\n'));
    const present = modules.filter(name => available.has(modulePath + name));
    if (modules.some(name => !present.includes(name) && !['InstructionPump.js', 'DeadlineTimer.js'].includes(name)))
        throw new Error('Baseline is missing a required replay module');
    versions.push({ name: tag, revision: git('rev-parse', tag + '^{}').trim(),
        modules: present,
        source: present.map(name => git('show', tag + ':' + modulePath + name)).join('\n') });
}
versions.push({ name: 'working-tree', revision: git('rev-parse', 'HEAD').trim(),
    modified: git('diff', 'HEAD', '--', ...modules.map(name => modulePath + name)).length !== 0,
    source: (await Promise.all(modules.map(name => readFile(path.join(root, modulePath, name), 'utf8')))).join('\n') });

const renderReplay = `
window.__renderReplay = (async function() {
    const originalImage = window.Image;
    const scenarios = [];
    for (const scenario of [
        { name: '180-cheap-frames', count: 180, cost: 0.25 },
        { name: '40-medium-frames', count: 40, cost: 2 },
        { name: '16-expensive-frames', count: 16, cost: 9 }
    ]) {
        const images = [];
        window.Image = function() { this.width = this.height = 1; images.push(this); };
        const display = new Guacamole.Display();
        let drawn = 0;
        const acknowledgements = [];
        const layer = { drawImage: function() {
            const start = performance.now();
            while (performance.now() - start < scenario.cost) { /* Controlled drawing cost. */ }
            drawn++;
        } };
        let finish;
        const complete = new Promise(resolve => { finish = resolve; });
        display.draw(layer, 0, 0, 'data:synthetic-blocker');
        display.flush(() => acknowledgements.push(performance.now()));
        for (let i = 1; i < scenario.count; i++) {
            display.drawImage(layer, i, 0, {});
            display.flush(() => {
                acknowledgements.push(performance.now());
                if (i === scenario.count - 1) finish();
            });
        }
        const inputChannel = new MessageChannel();
        let inputTask;
        const inputComplete = new Promise(resolve => {
            inputChannel.port1.onmessage = () => {
                inputTask = { delay_ms: performance.now() - started, completed_frames: drawn };
                inputChannel.port1.close(); inputChannel.port2.close(); resolve();
            };
        });
        const started = performance.now();
        inputChannel.port2.postMessage(null);
        images[0].onload();
        await Promise.all([complete, inputComplete]);
        scenarios.push({
            scenario: scenario.name, frames: drawn, synthetic_work_per_frame_ms: scenario.cost,
            completion_ms: acknowledgements[acknowledgements.length - 1] - started,
            input_task_delay_ms: inputTask.delay_ms, input_task_completed_frames: inputTask.completed_frames,
            maximum_ack_gap_ms: Math.max(...acknowledgements.slice(1).map((time, i) => time - acknowledgements[i]))
        });
        display.cancel();
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    window.Image = originalImage;
    return scenarios;
})();`;

const replay = readiness ? readinessReplaySource : options.scenario === 'timers' ? timerReplay : protocol ? protocolReplay : renderReplay;

const temporary = await mkdtemp(path.join(tmpdir(), 'guacamole-browser-render-'));
let browser;
try {
    for (const [index, version] of versions.entries()) {
        version.file = path.join(temporary, index + '.html');
        await writeFile(version.file, '<!doctype html><body><script>'
            + (layer + '\n' + version.source + '\n' + replay).replaceAll('</script', '<\\/script')
            + '</script>');
        if (readiness) {
            // Only a separate count-only page changes the source predicate.
            // Real decoding/frame timings always use the unmodified module.
            const predicate = /if \((tasks\[[^\]]+\]\.blocked)\)/g;
            const matches = [...version.source.matchAll(predicate)];
            if (matches.length !== 1) throw new Error('Expected exactly one frame-readiness predicate in ' + version.name);
            version.countSource = version.source.replace(predicate, 'if ((window.__readinessChecks++, $1))');
            version.countFile = path.join(temporary, index + '-count.html');
            await writeFile(version.countFile, '<!doctype html><body><script>'
                + ('window.__readinessCountOnly=true;window.__readinessChecks=0;\n' + layer + '\n'
                    + version.countSource + '\n' + replay).replaceAll('</script', '<\\/script') + '</script>');
        }
    }
    browser = spawn(options.browser, ['--headless', '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0', '--user-data-dir=' + path.join(temporary, 'profile'),
        '--disable-background-networking', '--disable-component-update', '--disable-extensions',
        '--no-first-run', '--no-default-browser-check', 'about:blank'],
        { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Chrome did not start')), 10000);
        let stderr = '';
        browser.stderr.on('data', bytes => {
            stderr += bytes;
            const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (match) { clearTimeout(timeout); resolve(match[1]); }
        });
        browser.once('error', error => { clearTimeout(timeout); reject(error); });
        browser.once('exit', code => { clearTimeout(timeout); reject(new Error('Chrome exited: ' + code)); });
    });
    const address = 'http://127.0.0.1:' + new URL(endpoint).port;
    const browserVersion = await (await fetch(address + '/json/version')).json();
    const samples = [];
    for (let iteration = 0; iteration < options.samples; iteration++) {
        const ordered = iteration % 2 ? [...versions].reverse() : versions;
        const variants = ordered.flatMap(version => (readiness ? ['timing', 'count-only'] : ['timing'])
            .map(kind => ({ version, kind })));
        for (const { version, kind } of variants) {
            const target = await (await fetch(address + '/json/new?about:blank', { method: 'PUT' })).json();
            const socket = new WebSocket(target.webSocketDebuggerUrl);
            await new Promise((resolve, reject) => {
                socket.addEventListener('open', resolve, { once: true });
                socket.addEventListener('error', reject, { once: true });
            });
            let sequence = 0;
            const pending = new Map();
            socket.addEventListener('message', event => {
                const message = JSON.parse(event.data);
                const waiting = pending.get(message.id);
                if (waiting) { pending.delete(message.id); clearTimeout(waiting.timeout); waiting.resolve(message); }
            });
            const call = (method, params = {}) => new Promise((resolve, reject) => {
                const id = ++sequence;
                const timeout = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 20000);
                pending.set(id, { resolve, timeout });
                socket.send(JSON.stringify({ id, method, params }));
            });
            try {
                await call('Page.navigate', { url: pathToFileURL(kind === 'count-only' ? version.countFile : version.file).href });
                let response;
                for (let attempt = 0; attempt < 20; attempt++) {
                    response = await call('Runtime.evaluate', {
                        expression: 'new Promise(resolve => { const wait = () => window.__renderReplay ? resolve(window.__renderReplay) : setTimeout(wait, 10); wait(); })',
                        awaitPromise: true, returnByValue: true
                    });
                    if (!response.error) break;
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                if (response.error || response.result.exceptionDetails)
                    throw new Error('Replay failed: ' + JSON.stringify(response));
                samples.push({ version: version.name, iteration, ...(readiness ? { kind } : {}), scenarios: response.result.result.value });
            }
            finally {
                socket.close();
                await fetch(address + '/json/close/' + target.id);
            }
        }
    }
    const median = values => {
        values.sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    };
    const summary = readiness ? versions.flatMap(version => {
        const native = samples.filter(sample => sample.version === version.name && sample.kind === 'timing');
        return native[0].scenarios.map(scenario => {
            const cases = native.flatMap(sample => sample.scenarios.filter(value => value.scenario === scenario.scenario));
            return { version: version.name, scenario: scenario.scenario,
                frame_completion_p50_median_ms: median(cases.map(value => value.frame_completion_p50_ms)),
                frame_completion_p95_median_ms: median(cases.map(value => value.frame_completion_p95_ms)),
                input_task_delay_p95_median_ms: median(cases.map(value => value.input_task_delay_ms)) };
        });
    }) : versions.flatMap(version => samples[0].scenarios.map(scenario => {
        const cases = samples.filter(sample => sample.version === version.name)
            .flatMap(sample => sample.scenarios.filter(value => value.scenario === scenario.scenario));
        return { version: version.name, scenario: scenario.scenario,
            completion_median_ms: median(cases.map(value => value.completion_ms)),
            input_task_delay_median_ms: median(cases.map(value => value.input_task_delay_ms)),
            maximum_ack_gap_median_ms: median(cases.map(value => value.maximum_ack_gap_ms)),
            ...(options.scenario === 'timers' ? {
                timeouts_created_median: median(cases.map(value => value.timeouts_created)),
                timeouts_cleared_median: median(cases.map(value => value.timeouts_cleared)),
                peak_pending_timeouts_median: median(cases.map(value => value.peak_pending_timeouts))
            } : {}) };
    }));
    if (readiness) {
        // Fail closed if a version/sample did different decoded work or pixels.
        const native = samples.filter(sample => sample.kind === 'timing');
        for (const sample of native) {
            if (sample.scenarios.length !== 4) throw new Error('Missing native readiness scenarios');
            for (const scenario of sample.scenarios) {
                const reference = native[0].scenarios.find(value => value.scenario === scenario.scenario);
                if (!reference) throw new Error('Unexpected native readiness scenario');
                if (![scenario.frame_completion_p50_ms, scenario.frame_completion_p95_ms, scenario.input_task_delay_ms]
                    .every(value => Number.isFinite(value) && value >= 0)
                    || scenario.frame_completion_p50_ms > scenario.frame_completion_p95_ms)
                    throw new Error('Invalid native readiness timing');
                for (const key of ['frames', 'warmup_frames', 'checked_frames', 'images_per_frame', 'mimetype', 'decoder', 'acknowledgements', 'rgb_pixels_compared', 'final_pixel_hash'])
                    if (scenario[key] !== reference[key]) throw new Error('Readiness decode work differs: ' + key);
            }
        }
        for (const sample of samples.filter(value => value.kind === 'count-only')) {
            if (sample.scenarios.length !== 5 || sample.scenarios.some(value => !Number.isSafeInteger(value.readiness_checks)
                || value.readiness_checks < value.images || value.acknowledgements !== 1 || !value.ordered_draws_verified))
                throw new Error('Invalid count-only readiness observations');
        }
    }
    const result = {
        method: readiness ? 'Actual Display/InputStream with native streamed PNG/WebP decode, real canvas draws, 40/128-image atomic frames and a 16ms minimum source interval. Separate count-only pages use controlled deferred-image callbacks and one instrumented readiness predicate.' : protocol
            ? 'Actual WebSocketTunnel, Parser, Client and Display with synchronous ready-frame protocol bursts and real canvas copies/fills. WebSocket delivery is simulated locally; ACK order and final canvas pixels are checked.'
            : 'Actual Display.js with synthetic per-frame drawing cost and one initial asynchronous blocker; real browser event loop, no virtual time.',
        limitations: readiness ? 'Foreground headless Chrome decode-to-ACK-callback and browser-task opportunity; not physical paint/FPS/input, wire ACKs, transport, capture, Wi-Fi or background throttling. Pixel readback and pacing are outside per-frame timers. Count-only pages add predicate increments and provide structural work counts only, never speed evidence.' : protocol
            ? 'Foreground headless Chrome API/ACK completion and synthetic browser-task opportunity; not physical paint/FPS, physical input latency, live networking, Wi-Fi, image decoding, or background throttling.'
            : 'Synthetic tasks and ACK callbacks, not physical input latency, canvas throughput, a live RDP connection, Wi-Fi, or background-tab throttling.',
        browser: browserVersion.Browser, platform: process.platform + '-' + process.arch,
        samples_per_version: options.samples,
        ...(readiness ? {
            scenario: 'readiness', replay_sha256: createHash('sha256').update(replay).digest('hex'),
            count_instrumentation: 'A separate document increments one counter at each tasks[index].blocked predicate read in Frame.isReady. Both sources receive the identical transformation; timing pages use unmodified sources. No production diagnostic/API is added.',
            count_summary: versions.flatMap(version => {
                const counted = samples.filter(sample => sample.version === version.name && sample.kind === 'count-only');
                return counted[0].scenarios.map(scenario => ({ version: version.name, scenario: scenario.scenario,
                    images: scenario.images,
                    readiness_checks: counted.map(sample => sample.scenarios.find(value => value.scenario === scenario.scenario).readiness_checks) }));
            })
        } : {}),
        ...(options.scenario === 'timers' ? { timer_instrumentation:
            'Both versions wrap native setTimeout/clearTimeout to count allocations/cancellations during each burst. These wrappers add overhead, especially to versions creating many timers.' } : {}),
        sources: versions.map(version => ({ version: version.name, revision: version.revision,
            working_tree_modified: !!version.modified,
            ...(bundle ? { modules: version.modules || modules } : {}),
            [bundle ? 'module_bundle_sha256' : 'display_sha256']:
                createHash('sha256').update(version.source).digest('hex'),
            ...(readiness ? { count_bundle_sha256: createHash('sha256').update(version.countSource).digest('hex') } : {}) })),
        ...(bundle ? { modules: modules, layer_sha256: createHash('sha256').update(layer).digest('hex') } : {}),
        summary, samples
    };
    const output = JSON.stringify(result, null, 2) + '\n';
    if (options.output) await writeFile(options.output, output);
    else process.stdout.write(output);
}
finally {
    if (browser && browser.exitCode === null) {
        browser.kill('SIGTERM');
        await new Promise(resolve => {
            const timeout = setTimeout(() => { browser.kill('SIGKILL'); resolve(); }, 2000);
            browser.once('exit', () => { clearTimeout(timeout); resolve(); });
        });
    }
    await rm(temporary, { recursive: true, force: true });
}
