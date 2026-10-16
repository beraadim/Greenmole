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
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { acceptWebSocket, ClientInstructions, distribution, fragmentProtocol, frameProtocol, instruction } from './benchmarks/image-pipeline-transport.mjs';
import { validateFixture } from './benchmarks/image-pipeline-fixture.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const fixture = () => ({ schema: 'guacamole-image-pipeline-fixture-v1', provenance: { generator: 'unit fixture' },
    assets: [{ id: 'pixel', mimetype: 'image/png', width: 1, height: 1, data_base64: png, encode_ms: null }],
    scenarios: [{ id: 'one', width: 1, height: 1, frames: [{ images: [{ asset: 'pixel', x: 0, y: 0 }] }] }] });

test('instruction lengths are Unicode codepoints; actual parser input remains intact across fragments', () => {
    assert.equal(instruction(['name', 'a😀b']), '4.name,3.a😀b;');
    const output = [], parser = new ClientInstructions(elements => output.push(elements));
    const text = instruction(['sync', 1001]) + instruction(['', 'ping', 123456]);
    for (const character of text) parser.write(character);
    assert.deepEqual(output, [['sync', '1001'], ['', 'ping', '123456']]);
    assert.equal(parser.buffer, ''); assert.equal(parser.elementBytes, 0);
});

test('ACK parser rejects bad framing, non-ASCII and accumulated retained elements', () => {
    for (const input of ['x.a;', '1.a!', '1.\0;', '1.é;', '123456789'])
        assert.throws(() => new ClientInstructions(() => {}).write(input));
    const parser = new ClientInstructions(() => {}), big = 'a'.repeat(600000);
    parser.write(big.length + '.' + big + ',');
    assert.throws(() => parser.write(big.length + '.' + big + ','), /oversized/);
});

test('image protocol uses complete independently decoded Base64 blobs and OVER compositing', () => {
    const item = validateFixture(fixture()), received = [];
    const text = frameProtocol(item.fixture.scenarios[0].frames[0], item.assets, 1001);
    const parser = new ClientInstructions(elements => received.push(elements));
    for (const fragment of fragmentProtocol(text)) parser.write(fragment);
    assert.deepEqual(received[0], ['img', '0', '14', '0', 'image/png', '0', '0']);
    const blobs = received.filter(elements => elements[0] === 'blob');
    assert.ok(blobs.length >= 2); assert.equal(blobs.map(elements => elements[2]).join(''), png);
    for (const blob of blobs) assert.equal(Buffer.from(blob[2], 'base64').toString('base64'), blob[2]);
    assert.deepEqual(received.slice(-2), [['end', '0'], ['sync', '1001']]);
    assert.equal(fragmentProtocol('a'.repeat(50000)).join(''), 'a'.repeat(50000));
});

test('fixture validates payload signature/hash and exact full-cover geometry', () => {
    assert.equal(validateFixture(fixture()).asset_summary[0].encoded_bytes, Buffer.from(png, 'base64').length);
    for (const change of [
        value => { value.assets[0].data_base64 += '='; },
        value => { value.assets[0].encoded_sha256 = '0'.repeat(64); },
        value => { value.assets[0].mimetype = 'image/webp'; },
        value => { value.scenarios[0].width = 2; },
        value => { value.scenarios[0].frames[0].images.push({ asset: 'pixel', x: 0, y: 0 }); },
        value => { value.scenarios[0].frames[0].images[0].asset = 'missing'; },
        value => { value.assets[0].width = value.assets[0].height = 8192; }
    ]) { const value = fixture(); change(value); assert.throws(() => validateFixture(value)); }
});

test('geometry provenance excludes compressed bytes but binds MIME/dimensions and image layout', () => {
    const first = fixture(), second = fixture();
    second.assets[0].encode_ms = 999;
    assert.equal(validateFixture(first).geometry_sha256, validateFixture(second).geometry_sha256);
    second.scenarios[0].id = 'other';
    assert.notEqual(validateFixture(first).geometry_sha256, validateFixture(second).geometry_sha256);
});

test('quantiles have defined nearest-rank meaning and empty data stays unavailable', () => {
    assert.deepEqual(distribution([]), { count: 0, min: null, p50: null, p95: null, max: null, mean: null });
    assert.deepEqual(distribution([5, 1, 3, 2, 4]), { count: 5, min: 1, p50: 3, p95: 5, max: 5, mean: 3 });
});

class FakeSocket extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.output = []; this.backpressure = false; }
    write(bytes) { this.output.push(bytes); return !this.backpressure; }
    setNoDelay() {}
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
    end(bytes) { this.write(bytes); this.destroy(); }
}
const request = { headers: { upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-protocol': 'guacamole' } };
function masked(text, opcode = 1, final = true) {
    const bytes = Buffer.from(text), mask = Buffer.from([1, 2, 3, 4]);
    assert.ok(bytes.length < 126);
    return Buffer.concat([Buffer.from([(final ? 128 : 0) | opcode, 128 | bytes.length]), mask,
        Buffer.from(bytes.map((byte, index) => byte ^ mask[index % 4]))]);
}

test('WebSocket accepts arbitrary TCP splits and proper masked continuation frames', () => {
    const socket = new FakeSocket(), received = [], errors = [];
    acceptWebSocket(request, socket, Buffer.alloc(0), text => received.push(text), error => errors.push(error));
    const bytes = Buffer.concat([masked('hel', 1, false), masked('lo', 0), masked('next')]);
    for (const byte of bytes) socket.emit('data', Buffer.from([byte]));
    assert.deepEqual(received, ['hello', 'next']); assert.deepEqual(errors, []);
});

test('WebSocket bounds empty continuation metadata and rejects unmasked/non-UTF8 frames', () => {
    for (const makeInput of [
        () => Buffer.from([129, 1, 65]),
        () => Buffer.concat([masked('', 1, false), ...Array.from({ length: 1024 }, () => masked('', 0, false))]),
        () => Buffer.from([129, 129, 0, 0, 0, 0, 255])
    ]) {
        const socket = new FakeSocket(), errors = [];
        acceptWebSocket(request, socket, Buffer.alloc(0), () => assert.fail('Unexpected text'), error => errors.push(error));
        socket.emit('data', makeInput()); assert.equal(errors.length, 1); assert.ok(socket.destroyed);
    }
});

test('clean close while backpressured rejects and removes temporary listeners', async () => {
    const socket = new FakeSocket(), errors = [];
    const send = acceptWebSocket(request, socket, Buffer.alloc(0), () => {}, error => errors.push(error));
    socket.backpressure = true;
    const pending = send('hello'); socket.destroy();
    await assert.rejects(pending, /closed during backpressure/);
    assert.equal(socket.listenerCount('drain'), 0); assert.equal(socket.listenerCount('close'), 0);
    assert.equal(socket.listenerCount('error'), 1); assert.deepEqual(errors, []);
});

test('actual loopback WebSocket negotiates guacamole and exchanges text through the endpoint', async () => {
    let peer, resolveReceived;
    const received = new Promise(resolve => { resolveReceived = resolve; });
    const server = createServer();
    server.on('upgrade', (req, socket, head) => {
        peer = socket;
        const send = acceptWebSocket(req, socket, head, text => { resolveReceived(text); send('reply').catch(() => {}); }, error => { throw error; });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const ws = new WebSocket('ws://127.0.0.1:' + server.address().port, 'guacamole');
    try {
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        const reply = new Promise(resolve => { ws.onmessage = event => resolve(event.data); });
        ws.send('request'); assert.equal(await received, 'request'); assert.equal(await reply, 'reply');
        assert.equal(ws.protocol, 'guacamole');
    }
    finally { ws.close(); peer?.destroy(); await new Promise(resolve => server.close(resolve)); }
});
