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

/* global Guacamole, jasmine, expect */
describe('Guacamole experimental AVC444 video', function() {
    var display, layer, stream, player, oldDecoder, oldChunk, oldRenderer, decoders, chunks, rendered, rendererFailures;
    var key = [0, 0, 0, 1, 0x67, 0x42, 0xE0, 0x1F, 0, 0, 1, 0x68, 1, 0, 0, 1, 0x65, 1];
    var delta = [0, 0, 1, 0x41, 1];
    async function settle() { for (var i = 0; i < 20; i++) await Promise.resolve(); }
    function envelope(sequence, options) {
        options = options || {};
        var main = options.main || key, aux = options.aux || delta, data = new Uint8Array(48 + main.length + aux.length);
        var v = new DataView(data.buffer); v.setUint32(0, 0x47415632); v.setUint32(4, sequence);
        v.setUint16(8, 32); v.setUint16(10, 18); v.setUint32(12, options.flags === undefined ? 0x10001 : options.flags);
        v.setUint32(16, main.length); v.setUint32(20, aux.length); v.setUint16(24, 1); v.setUint16(26, 1);
        v.setUint16(36, 32); v.setUint16(38, 18); v.setUint16(44, 32); v.setUint16(46, 18);
        data.set(main, 48); data.set(aux, 48 + main.length); return data;
    }
    function send(data, step) {
        step = step || 4096;
        for (var i = 0; i < data.length && stream.onblob; i += step)
            stream.onblob(window.btoa(String.fromCharCode.apply(null, data.slice(i, i + step))));
    }
    function frame(sequence, side) { return { timestamp: sequence * 2000 + side * 1000, close: jasmine.createSpy('close') }; }
    beforeEach(function() {
        oldDecoder = window.VideoDecoder; oldChunk = window.EncodedVideoChunk; oldRenderer = Guacamole.AVC444Renderer;
        decoders = []; chunks = []; rendered = []; rendererFailures = [];
        window.VideoDecoder = function Decoder(callbacks) {
            this.callbacks = callbacks; this.configure = jasmine.createSpy('configure'); this.close = jasmine.createSpy('decoder close');
            this.decode = function(chunk) { chunks.push(chunk); }; decoders.push(this);
        };
        window.VideoDecoder.isConfigSupported = function(config) { return Promise.resolve({ supported: true, config: config }); };
        window.EncodedVideoChunk = function Chunk(init) { Object.assign(this, init); };
        Guacamole.AVC444Renderer = function Renderer(onerror) {
            rendererFailures.push(onerror);
            this.dispose = jasmine.createSpy('dispose');
            this.render = function(main, aux, width, height, timestamp) {
                var picture = { timestamp: timestamp, close: jasmine.createSpy('picture close') };
                rendered.push(picture); return picture;
            };
        };
        Guacamole.AVC444Renderer.copyFrame = function() { return Promise.resolve({ planes: [] }); };
        display = new Guacamole.Display(); layer = { drawVideoFrame: jasmine.createSpy('video'), drawImage: jasmine.createSpy('image') };
        stream = { sendAck: jasmine.createSpy('ack') }; player = new Guacamole.AVC444VideoPlayer(stream, layer, display);
    });
    afterEach(function() {
        player.dispose(false); display.cancel(); window.VideoDecoder = oldDecoder; window.EncodedVideoChunk = oldChunk;
        Guacamole.AVC444Renderer = oldRenderer;
    });
    it('assembles split GAV2 and decodes ordered main IDR + auxiliary delta in ONE decoder, ACK after drawing', async function() {
        send(envelope(1), 3); display.flush(); await settle();
        expect(decoders.length).toBe(1); expect(chunks.map(function(c) { return [c.type, c.timestamp]; })).toEqual([['key', 2000], ['delta', 3000]]);
        var main = frame(1, 0), aux = frame(1, 1);
        decoders[0].callbacks.output(main); await settle(); expect(layer.drawVideoFrame).not.toHaveBeenCalled();
        expect(stream.sendAck).not.toHaveBeenCalled();
        decoders[0].callbacks.output(aux); await settle();
        expect(layer.drawVideoFrame).toHaveBeenCalledOnceWith(rendered[0], 32, 18);
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC444:1', 0);
        expect(main.close).toHaveBeenCalledTimes(1); expect(aux.close).toHaveBeenCalledTimes(1); expect(rendered[0].close).toHaveBeenCalledTimes(1);
    });
    it('preserves ordered image/video tasks and presentation ACK behind an earlier frame', async function() {
        var older = display.scheduleVideoFrame(layer, 32, 18, function() {});
        send(envelope(1)); display.drawImage(layer, 0, 0, { width: 1, height: 1 }); display.flush(); await settle();
        decoders[0].callbacks.output(frame(1, 0)); decoders[0].callbacks.output(frame(1, 1)); await settle();
        expect(stream.sendAck).not.toHaveBeenCalled(); expect(layer.drawImage).not.toHaveBeenCalled();
        older.complete(frame(0, 0));
        expect(layer.drawVideoFrame).toHaveBeenCalledTimes(2); expect(layer.drawImage).toHaveBeenCalledTimes(1);
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC444:1', 0);
    });
    it('bounds submitted pairs while retaining a bounded encoded FIFO', async function() {
        for (var i = 1; i <= 6; i++) { send(envelope(i)); display.flush(); } await settle();
        expect(chunks.length).toBe(4);
        decoders[0].callbacks.output(frame(1, 0)); decoders[0].callbacks.output(frame(1, 1)); await settle();
        expect(chunks.length).toBe(6);
    });
    it('closes copied native frames on disposal and suppresses late promise completion', async function() {
        var finish;
        Guacamole.AVC444Renderer.copyFrame = function() { return new Promise(function(resolve) { finish = resolve; }); };
        send(envelope(1)); display.flush(); await settle();
        var main = frame(1, 0); decoders[0].callbacks.output(main); player.dispose(false);
        expect(main.close).toHaveBeenCalledTimes(1); finish({ planes: [] }); await settle();
        expect(rendered.length).toBe(0); expect(main.close).toHaveBeenCalledTimes(1); expect(stream.sendAck).not.toHaveBeenCalled();
        var late = frame(1, 1); decoders[0].callbacks.output(late); expect(late.close).toHaveBeenCalledTimes(1);
    });
    it('falls back once on an incomplete pair and clears all native/display ownership', async function() {
        jasmine.clock().install();
        try {
            send(envelope(1)); display.flush(); await settle();
            var main = frame(1, 0); decoders[0].callbacks.output(main); await settle();
            jasmine.clock().tick(2001); await settle();
            expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC444:fallback', 0x0300);
            expect(decoders[0].close).toHaveBeenCalledTimes(1); expect(main.close).toHaveBeenCalledTimes(1);
            expect(layer.drawVideoFrame).not.toHaveBeenCalled();
        }
        finally { jasmine.clock().uninstall(); }
    });
    it('rejects duplicate decoded subframes and a failed native sample copy', async function() {
        send(envelope(1)); display.flush(); await settle();
        decoders[0].callbacks.output(frame(1, 0)); decoders[0].callbacks.output(frame(1, 0)); await settle();
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC444:fallback', 0x0300);
    });
    it('falls back once if a native copy rejects, closing both pending subframes', async function() {
        Guacamole.AVC444Renderer.copyFrame = function() { return Promise.reject(new Error('native unavailable')); };
        send(envelope(1)); display.flush(); await settle();
        var main=frame(1,0),aux=frame(1,1);
        decoders[0].callbacks.output(main); decoders[0].callbacks.output(aux); await settle();
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC444:fallback',0x0300);
        expect(main.close).toHaveBeenCalledTimes(1);expect(aux.close).toHaveBeenCalledTimes(1);
    });
    it('cancels pending presentation on context loss and never acknowledges it successfully', async function() {
        send(envelope(1)); display.flush(); await settle();
        rendererFailures[0](); await settle();
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC444:fallback',0x0300);
        expect(layer.drawVideoFrame).not.toHaveBeenCalled();
    });
    it('bounds an incomplete envelope assembly deadline', async function() {
        jasmine.clock().install();
        try {
            send(envelope(1).slice(0,7));jasmine.clock().tick(2001);await settle();
            expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC444:fallback',0x0300);
            expect(chunks.length).toBe(0);
        }
        finally {jasmine.clock().uninstall();}
    });
    it('bounds queued envelopes without discarding reference pictures and continuing', async function() {
        for(var i=1;i<=17;i++)send(envelope(i));await settle();
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC444:fallback',0x0300);
        expect(chunks.length).toBe(0);
    });
    [
        ['version 2', function(v) { v.setUint32(12, 0x20001); }],
        ['partial LC', function(v) { v.setUint32(12, 0x10101); }],
        ['reserved flags', function(v) { v.setUint32(12, 0x10005); }],
        ['reserved header', function(v) { v.setUint32(28, 1); }],
        ['region count', function(v) { v.setUint16(24, 2); }],
        ['partial rectangle', function(v) { v.setUint16(32, 1); }],
        ['empty main', function(v) { v.setUint32(16, 0); }],
        ['oversize pair', function(v) { v.setUint32(20, 8 * 1024 * 1024); }],
        ['oversize picture', function(v) { v.setUint16(8, 8192); v.setUint16(10, 8192); }]
    ].forEach(function(test) {
        it('rejects ' + test[0] + ' into image fallback before native decode', async function() {
            var packet = envelope(1); test[1](new DataView(packet.buffer)); send(packet); await settle();
            expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC444:fallback', 0x0300); expect(chunks.length).toBe(0);
        });
    });
    it('requires an initial main keyframe and rejects replayed sequence numbers', async function() {
        send(envelope(1)); await settle(); send(envelope(1)); await settle();
        expect(stream.sendAck).toHaveBeenCalledOnceWith('AVC444:fallback', 0x0300);
    });
    it('does not permit a peer to enable AVC444 without the explicit application opt-in', function() {
        var original = Guacamole.AVC444VideoPlayer.supported; Guacamole.AVC444VideoPlayer.supported = true;
        var sent = [], tunnel = new Guacamole.Tunnel(); tunnel.connect = function() {}; tunnel.disconnect = function() {};
        tunnel.sendMessage = function() { sent.push(Array.from(arguments)); };
        var client = new Guacamole.Client(tunnel);
        try {
            client.connect('synthetic'); tunnel.oninstruction('video', ['7', '0', Guacamole.AVC444VideoPlayer.MIMETYPE]);
            expect(sent.some(function(a) { return a[0] === 'ack' && a[1] === 7 && a[2] === 'BAD TYPE'; })).toBe(true);
        }
        finally { client.disconnect(); Guacamole.AVC444VideoPlayer.supported = original; }
    });
});
