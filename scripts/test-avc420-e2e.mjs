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

// Only use a disposable guacd and the no-input synthetic macrdp fixture server.
// No production configuration, desktop, account or clipboard is read or changed.
// The fixture uses an ephemeral TLS certificate and the public test credentials
// synthetic-fixture / synthetic-fixture. They are not a real system account.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { createContext, runInContext } from 'node:vm';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptWebSocket, ClientInstructions, instruction } from './benchmarks/image-pipeline-transport.mjs';
import { trackBrowserProcess } from './benchmarks/browser-process.mjs';

const options = { guacdPort: 14822, rdpPort: 23989, browser: process.env.CHROME_BIN
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', mode: 'both', timeoutMs: 60000, rdpSecurity: 'tls', commonJs: null };
for (let i = 2; i < process.argv.length; i += 2) {
    const key = { '--guacd-port': 'guacdPort', '--rdp-port': 'rdpPort', '--browser': 'browser', '--mode': 'mode', '--timeout-ms': 'timeoutMs', '--rdp-security': 'rdpSecurity', '--common-js': 'commonJs' }[process.argv[i]];
    if (!key || !process.argv[i + 1]) throw new Error('Usage: test-avc420-e2e.mjs [--guacd-port 14822] [--rdp-port 23989] [--browser executable] [--mode both|avc|images] [--timeout-ms 60000] [--rdp-security tls|rdp] [--common-js packaged-all.min.js]');
    options[key] = ['guacdPort', 'rdpPort', 'timeoutMs'].includes(key) ? Number(process.argv[i + 1]) : process.argv[i + 1];
}
for (const key of ['guacdPort', 'rdpPort'])
    if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > 65535) throw new Error('Invalid port');
if (!['tls', 'rdp'].includes(options.rdpSecurity) || !['both', 'avc', 'images'].includes(options.mode) || !Number.isInteger(options.timeoutMs)
        || options.timeoutMs < 1000 || options.timeoutMs > 120000) throw new Error('Invalid mode or timeout');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = path.join(root, 'client/guacamole-common-js/src/main/webapp/modules');
const context = createContext({});
runInContext(await readFile(path.join(modules, 'Parser.js'), 'utf8'), context);
const Parser = context.Guacamole.Parser;
const token = randomBytes(24).toString('hex');
const reportPath = '/results/' + token;
const websocketPath = '/tunnel/' + token;
const connections = [];
const sockets = new Set();
let receiveReport;
const report = new Promise(resolve => { receiveReport = resolve; });

async function browserTest(config) {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    async function waitFor(condition, message, errors) {
        const start = performance.now();
        while (!condition()) {
            if (errors?.length) throw new Error(errors.join('; '));
            if (performance.now() - start > 20000) throw new Error(message);
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    function quarters(display) {
        const canvas = display.flatten();
        assert(canvas.width === 320 && canvas.height === 180, 'Wrong visible desktop size/cropping: ' + canvas.width + 'x' + canvas.height);
        const context = canvas.getContext('2d');
        const points = [[5, 5, [220, 16, 16]], [315, 5, [16, 220, 16]], [5, 175, [16, 16, 220]], [315, 175, [28, 28, 28]]];
        const pixels = points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
        window.avc420TestContext.quarterPixels = pixels;
        points.forEach(([x, y, expected], index) => {
            const actual = pixels[index];
            assert(actual[3] === 255 && expected.every((value, i) => Math.abs(actual[i] - value) < 12),
                'Unexpected synthetic quarter pixel at ' + x + ',' + y + ': ' + actual);
        });
        return pixels;
    }
    const available = await Guacamole.AVC420VideoPlayer.checkSupport();
    if (config.mode !== 'images') assert(available, 'Secure H.264 WebCodecs is required for the AVC test');
    const results = [];
    for (const video of config.mode === 'both' ? [true, false] : [config.mode === 'avc']) {
        const tunnel = new Guacamole.WebSocketTunnel(config.websocketPath);
        const client = new Guacamole.Client(tunnel), display = client.getDisplay();
        document.body.appendChild(display.getElement());
        const errors = [], protocol = { videos: 0, images: 0, ends: 0, syncs: 0 };
        const paint = { images: 0, completedImages: 0 };
        const observeLayer = layer => {
            const draw = layer.drawImage;
            layer.drawImage = function() { const result = draw.apply(layer, arguments); paint.images++; return result; };
            return layer;
        };
        observeLayer(display.getDefaultLayer());
        for (const name of ['createBuffer', 'createLayer']) {
            const create = display[name];
            display[name] = function() { return observeLayer(create.apply(display, arguments)); };
        }
        const flush = display.flush;
        display.flush = function(callback, timestamp, frames) {
            return flush.call(display, function completed() {
                paint.completedImages = paint.images;
                if (callback) callback();
            }, timestamp, frames);
        };
        client.onerror = status => errors.push('Client error ' + status.code + ': ' + status.message);
        tunnel.onerror = status => errors.push('Tunnel error ' + status.code + ': ' + status.message);
        const handler = tunnel.oninstruction;
        tunnel.oninstruction = (opcode, args) => {
            if (opcode === 'video') protocol.videos++;
            if (['img', 'png', 'jpeg'].includes(opcode)) protocol.images++;
            if (opcode === 'end') protocol.ends++;
            if (opcode === 'sync') protocol.syncs++;
            handler(opcode, args);
        };
        const item = { videoRequested: video, protocol, phase: 'connecting' };
        window.avc420TestContext = item;
        const originalDecode = window.VideoDecoder?.prototype.decode;
        try {
            client.setExperimentalAvc420Enabled(video);
            client.connect('video=' + Number(video));
            if (video) {
                await waitFor(() => client.getVideoStatistics().presentedFrames >= 12,
                    'No twelve real AVC420 frames presented: ' + JSON.stringify(client.getVideoStatistics()), errors);
                item.phase = 'active-video-pixels';
                item.active = client.getVideoStatistics(); item.videoPixels = quarters(display);
                assert(item.active.status === 'playing' && protocol.videos > 0, 'AVC420 was not active');
                const beforeImages = protocol.images, beforePaintedImages = paint.completedImages;
                window.VideoDecoder.prototype.decode = function injectedFailure() { throw new Error('Synthetic decoder failure'); };
                await waitFor(() => client.getVideoStatistics().status === 'fallback', 'Decoder failure did not trigger fallback', errors);
                // The native fallback must send new image data, not merely leave
                // the last successful video picture on the client canvas.
                await waitFor(() => protocol.images > beforeImages && paint.completedImages > beforePaintedImages
                    && !display.getQueueStatistics().pendingFrames,
                    'No complete image repaint after decoder failure', errors);
                item.phase = 'image-fallback-pixels';
                item.fallback = client.getVideoStatistics(); item.fallbackPixels = quarters(display);
                item.newFallbackImages = protocol.images - beforeImages;
                item.newFallbackDraws = paint.completedImages - beforePaintedImages;
            }
            else {
                await waitFor(() => protocol.images > 0 && paint.completedImages > 0 && display.getWidth() === 320
                    && !display.getQueueStatistics().pendingFrames, 'No ordinary image frame', errors);
                item.phase = 'ordinary-image-pixels';
                item.imagePixels = quarters(display);
                assert(protocol.videos === 0 && client.getVideoStatistics().presentedFrames === 0,
                    'Video was sent to an image-only client');
            }
            assert(errors.length === 0, errors.join('; '));
            item.phase = 'passed';
            results.push(item);
        }
        finally {
            if (originalDecode) window.VideoDecoder.prototype.decode = originalDecode;
            client.disconnect(); display.getElement().remove();
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { browser: navigator.userAgent, secure: window.isSecureContext, h264Supported: available, cases: results };
}
const script = source => '<script>' + source.replaceAll('</script', '<\\/script') + '</script>';
const clientSource = options.commonJs ? await readFile(path.resolve(options.commonJs), 'utf8')
    : (await Promise.all((await readdir(modules)).filter(name => name.endsWith('.js')).sort()
        .map(name => readFile(path.join(modules, name), 'utf8')))).join('\n');
const clientProvenance = { packagedBundle: options.commonJs ? path.basename(options.commonJs) : null,
    sha256: createHash('sha256').update(clientSource).digest('hex') };
const moduleSources = script(clientSource);
const html = '<!doctype html><meta charset="utf-8"><body>' + moduleSources
    + script('(' + browserTest.toString() + ')(' + JSON.stringify({ websocketPath, mode: options.mode }) + ')'
        + '.then(result=>fetch(' + JSON.stringify(reportPath) + ',{method:"POST",body:JSON.stringify({passed:true,...result})}))'
        + '.catch(error=>fetch(' + JSON.stringify(reportPath) + ',{method:"POST",body:JSON.stringify({passed:false,error:error.stack,context:window.avc420TestContext})}));');
const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') response.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    else if (request.method === 'POST' && request.url === reportPath) {
        let body = '', size = 0;
        request.on('data', data => { size += data.length; if (size > 1048576) request.destroy(); else body += data; });
        request.on('end', () => {
            try { receiveReport(JSON.parse(body)); response.writeHead(204).end(); }
            catch { response.writeHead(400).end(); }
        });
    }
    else response.writeHead(404).end();
});
server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== websocketPath || !['0', '1'].includes(url.searchParams.get('video'))) return socket.destroy();
    const video = url.searchParams.get('video') === '1';
    const tcp = createConnection({ host: '127.0.0.1', port: options.guacdPort });
    const entry = { videoRequested: video, ready: false, images: 0, videos: 0, frameAcks: 0, failureAcks: 0, errors: [] };
    connections.push(entry); sockets.add(socket); sockets.add(tcp);
    let send, output = Promise.resolve();
    const fail = error => { entry.errors.push(error.message); tcp.destroy(); socket.destroy(); };
    const enqueue = text => {
        output = output.then(() => send(text)).catch(fail);
        return output;
    };
    const clientParser = new ClientInstructions(elements => {
        if (elements[0] === '') { enqueue(instruction(elements)); return; }
        if (elements[0] === 'ack' && elements[2]?.startsWith('AVC420:')) {
            if (elements[3] === '0' && elements[2] !== 'AVC420:ready') entry.frameAcks++;
            else if (elements[3] !== '0') entry.failureAcks++;
        }
        tcp.write(instruction(elements));
    });
    try { send = acceptWebSocket(request, socket, head, text => clientParser.write(text), fail); }
    catch (error) { fail(error); return; }
    const parser = new Parser();
    parser.oninstruction = (opcode, args) => {
        if (opcode === 'args') {
            const values = { hostname: '127.0.0.1', port: String(options.rdpPort), username: 'synthetic-fixture',
                password: 'synthetic-fixture', security: options.rdpSecurity, 'disable-auth': 'false', width: '320', height: '180', dpi: '96',
                'disable-audio': 'true', 'disable-gfx': 'false', 'color-depth': '32', 'ignore-cert': 'true', 'resize-method': 'display-update', 'force-lossless': 'true' };
            tcp.write(instruction(['size', 320, 180, 96]) + instruction(['audio'])
                + instruction(video ? ['video', 'video/x-guacamole-avc420;v=1'] : ['video'])
                + instruction(['image', 'image/png']) + instruction(['timezone', 'UTC'])
                + instruction(['connect', args[0], ...args.slice(1).map(name => values[name] || '')]));
        }
        else if (opcode === 'ready') {
            entry.ready = true;
            enqueue(instruction(['', args[0]]));
        }
        else {
            if (opcode === 'img' || opcode === 'png' || opcode === 'jpeg') entry.images++;
            if (opcode === 'video') entry.videos++;
            if (opcode === 'error') entry.errors.push(args.join(' '));
            enqueue(instruction([opcode, ...args]));
        }
    };
    const decoder = new StringDecoder('utf8');
    tcp.on('connect', () => { tcp.setNoDelay(true); tcp.write(instruction(['select', 'rdp'])); });
    tcp.on('data', data => { try { parser.receive(decoder.write(data)); } catch (error) { fail(error); } });
    tcp.on('error', fail);
    tcp.on('end', () => { output.finally(() => socket.end()); });
    tcp.on('close', () => sockets.delete(tcp));
    socket.on('close', () => { sockets.delete(socket); tcp.destroy(); });
});
let temporary, stop, deadline;
try {
    temporary = await mkdtemp(path.join(tmpdir(), 'guacamole-avc420-e2e-'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    console.error('Synthetic AVC420 relay ready on 127.0.0.1:' + server.address().port + '; guacd forward 127.0.0.1:' + options.guacdPort);
    const browser = spawn(options.browser, ['--headless', '--disable-background-networking', '--disable-component-update',
        '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + temporary,
        'http://127.0.0.1:' + server.address().port + '/'], { stdio: ['ignore', 'ignore', 'pipe'] });
    stop = trackBrowserProcess(browser); browser.stderr.resume();
    const failed = new Promise((resolve, reject) => {
        browser.once('error', reject); browser.once('exit', code => reject(new Error('Browser exited before reporting: ' + code)));
        deadline = setTimeout(() => reject(new Error('Synthetic AVC420 integration timed out')), options.timeoutMs);
    });
    const result = await Promise.race([report, failed]);
    console.log(JSON.stringify({ ...result, clientProvenance, relay: connections }, null, 2));
    if (!result.passed || connections.some(connection => connection.errors.length)) process.exitCode = 1;
}
finally {
    clearTimeout(deadline);
    for (const socket of sockets) socket.destroy();
    if (stop) await stop();
    await new Promise(resolve => server.close(resolve));
    if (temporary) await rm(temporary, { recursive: true, force: true });
}
