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

import { createHash } from 'node:crypto';

export const profiles = {
    healthy: { bytes_per_second: 0, release_delay_ms: 0, jitter_ms: 0, pause_every: 0, pause_ms: 0 },
    lan: { bytes_per_second: 12500000, release_delay_ms: 1, jitter_ms: 0, pause_every: 0, pause_ms: 0 },
    constrained: { bytes_per_second: 1250000, release_delay_ms: 20, jitter_ms: 3, pause_every: 0, pause_ms: 0 },
    jitter: { bytes_per_second: 2500000, release_delay_ms: 8, jitter_ms: 8, pause_every: 17, pause_ms: 25 }
};

export const instruction = elements => elements.map(value => {
    const text = String(value);
    return [...text].length + '.' + text;
}).join(',') + ';';

/** Strict bounded ASCII parser for client ACK/control messages, not a replacement
 * for the production browser parser being measured. */
export class ClientInstructions {
    constructor(receive) { this.receive = receive; this.buffer = ''; this.elements = []; this.elementBytes = 0; }
    write(text) {
        if (/[^\x01-\x7F]/.test(text) || this.buffer.length + this.elementBytes + text.length > 1048576)
            throw new Error('Invalid/oversized benchmark client instruction');
        this.buffer += text;
        while (this.buffer.length) {
            const dot = this.buffer.indexOf('.');
            if (dot < 0) {
                if (this.buffer.length > 8) throw new Error('Invalid client instruction length');
                return;
            }
            const header = this.buffer.slice(0, dot);
            if (!/^\d{1,8}$/.test(header)) throw new Error('Invalid client instruction length');
            const end = dot + 1 + Number(header);
            if (end >= this.buffer.length) return;
            const terminator = this.buffer[end];
            if (terminator !== ',' && terminator !== ';') throw new Error('Invalid client instruction terminator');
            this.elements.push(this.buffer.slice(dot + 1, end)); this.elementBytes += Number(header) + 16;
            this.buffer = this.buffer.slice(end + 1);
            if (this.elements.length > 64) throw new Error('Oversized client instruction');
            if (terminator === ';') {
                const elements = this.elements; this.elements = []; this.elementBytes = 0;
                this.receive(elements);
            }
        }
    }
}

export function webSocketFrame(text, opcode = 1) {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10);
    header[0] = 0x80 | opcode;
    if (header.length === 2) header[1] = payload.length;
    else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
    else { header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    return Buffer.concat([header, payload]);
}

/** Small loopback-only RFC6455 endpoint. Actual browser WebSocket/Tunnel code is
 * used; only the replay endpoint is synthetic. Client input is capped at1MiB. */
export function acceptWebSocket(request, socket, head, onText, onError) {
    const key = request.headers['sec-websocket-key'];
    if (request.headers.upgrade?.toLowerCase() !== 'websocket'
            || request.headers['sec-websocket-version'] !== '13'
            || !key || !request.headers['sec-websocket-protocol']?.split(/,\s*/).includes('guacamole')) {
        socket.destroy(); throw new Error('Invalid replay WebSocket upgrade');
    }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: guacamole\r\n\r\n');
    socket.setNoDelay(true);
    let buffered = Buffer.alloc(0), fragments = [], fragmentBytes = 0;
    const consume = bytes => {
        try {
            if (buffered.length + bytes.length > 1048590) throw new Error('Oversized client WebSocket input');
            buffered = Buffer.concat([buffered, bytes]);
            while (buffered.length >= 2) {
                const first = buffered[0], second = buffered[1], opcode = first & 15;
                if (first & 0x70 || !(second & 0x80)) throw new Error('Invalid client WebSocket flags');
                let length = second & 127, offset = 2;
                if (length === 126) {
                    if (buffered.length < 4) return;
                    length = buffered.readUInt16BE(2); offset = 4;
                }
                else if (length === 127) {
                    if (buffered.length < 10) return;
                    const large = buffered.readBigUInt64BE(2);
                    if (large > 1048576n) throw new Error('Oversized client WebSocket frame');
                    length = Number(large); offset = 10;
                }
                if (length > 1048576 || (opcode >= 8 && (!(first & 128) || length > 125)))
                    throw new Error('Invalid client WebSocket frame size');
                if (buffered.length < offset + 4 + length) return;
                const mask = buffered.subarray(offset, offset + 4);
                const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
                for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
                buffered = buffered.subarray(offset + 4 + length);
                if (opcode === 8) { socket.end(webSocketFrame(payload, 8)); return; }
                if (opcode === 9) { socket.write(webSocketFrame(payload, 10)); continue; }
                if (opcode === 10) continue;
                if ((opcode !== 1 && opcode !== 0) || (opcode === 1 && fragments.length)
                        || (opcode === 0 && !fragments.length)) throw new Error('Invalid client message continuation');
                if (fragments.length >= 1024) throw new Error('Excessive client WebSocket continuation count');
                fragments.push(payload); fragmentBytes += payload.length;
                if (fragmentBytes > 1048576) throw new Error('Oversized client WebSocket message');
                if (first & 128) {
                    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(fragments));
                    fragments = []; fragmentBytes = 0; onText(text);
                }
            }
        }
        catch (error) { onError(error); socket.destroy(); }
    };
    socket.on('data', consume);
    socket.on('error', onError);
    if (head.length) consume(head);
    return async text => {
        if (socket.destroyed) throw new Error('Replay WebSocket closed during send');
        if (!socket.write(webSocketFrame(text))) await new Promise((resolve, reject) => {
            const cleanup = () => { socket.removeListener('drain', drained); socket.removeListener('close', closed); socket.removeListener('error', errored); };
            const drained = () => { cleanup(); resolve(); };
            const closed = () => { cleanup(); reject(new Error('Replay WebSocket closed during backpressure')); };
            const errored = error => { cleanup(); reject(error); };
            socket.once('drain', drained); socket.once('close', closed); socket.once('error', errored);
            if (socket.destroyed) closed();
        });
    };
}

/** Split a protocol stream at intentionally awkward byte positions: element
 * lengths and Base64 strings cross complete WebSocket message boundaries. */
export function fragmentProtocol(text) {
    const sizes = [1, 7, 257, 4093, 16381];
    const result = [];
    for (let offset = 0, index = 0; offset < text.length; index++) {
        const length = Math.min(sizes[index % sizes.length], text.length - offset);
        result.push(text.slice(offset, offset + length)); offset += length;
    }
    return result;
}

export function frameProtocol(frame, assets, timestamp) {
    let text = '';
    frame.images.forEach((image, index) => {
        const asset = assets.get(image.asset);
        text += instruction(['img', index, 14, 0, asset.mimetype, image.x, image.y]);
        // At least two independent Base64 blobs/image, aligned to complete
        // quartets. Protocol fragmentation additionally crosses blob elements.
        const chunk = Math.max(4, Math.min(8192, Math.ceil(asset.data_base64.length / 8) * 4));
        for (let offset = 0; offset < asset.data_base64.length; offset += chunk)
            text += instruction(['blob', index, asset.data_base64.slice(offset, offset + chunk)]);
        text += instruction(['end', index]);
    });
    return text + instruction(['sync', timestamp]);
}

export const distribution = values => {
    if (!values.length) return { count: 0, min: null, p50: null, p95: null, max: null, mean: null };
    const sorted = [...values].sort((a, b) => a - b);
    return { count: sorted.length, min: sorted[0], p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1),
        mean: values.reduce((sum, value) => sum + value, 0) / values.length };
};
