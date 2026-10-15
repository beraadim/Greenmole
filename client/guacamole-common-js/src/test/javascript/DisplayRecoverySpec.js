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

describe('Guacamole.DisplayRecovery', function() {
    var time, connected, tunnel, recovery;
    function advance(ms) { time += ms; jasmine.clock().tick(ms); }
    function ready() { recovery.handleInstruction(['1', 'ready']); }
    beforeEach(function() {
        time = 100;
        connected = true;
        jasmine.clock().install();
        spyOn(window.performance, 'now').and.callFake(function() { return time; });
        tunnel = { sendMessage: jasmine.createSpy('sendMessage') };
        recovery = new Guacamole.DisplayRecovery(tunnel, function() { return connected; });
    });
    afterEach(function() { recovery.reset(); jasmine.clock().uninstall(); });

    it('never sends extension requests to an older or unknown peer', function() {
        recovery.imageFailed(); advance(10000);
        expect(recovery.request()).toBe(false);
        expect(recovery.isSupported()).toBe(false);
        expect(tunnel.sendMessage).not.toHaveBeenCalled();
    });
    it('accepts only the supported capability version and exact arity', function() {
        recovery.handleInstruction(['2', 'ready']);
        recovery.handleInstruction(['1', 'ready', 'extra']);
        recovery.handleInstruction(['1', 'unknown']);
        expect(recovery.isSupported()).toBe(false);
        ready(); expect(recovery.isSupported()).toBe(true);
    });
    it('coalesces failed tiles and unwinds drawing before requesting a snapshot', function() {
        ready();
        for (var i = 0; i < 100; i++) recovery.imageFailed();
        expect(tunnel.sendMessage).not.toHaveBeenCalled();
        advance(1);
        expect(tunnel.sendMessage).toHaveBeenCalledOnceWith('x-resync', '1', 'request');
        expect(recovery.getStatistics().imageFailures).toBe(100);
    });
    it('recovers a failure received before capability advertisement', function() {
        recovery.imageFailed(); advance(1); ready(); advance(1);
        expect(tunnel.sendMessage).toHaveBeenCalledTimes(1);
    });
    it('rate-limits manual and automatic refreshes together', function() {
        ready(); expect(recovery.request()).toBe(true);
        expect(recovery.request()).toBe(false);
        recovery.imageFailed(); advance(5499);
        expect(tunnel.sendMessage).toHaveBeenCalledTimes(1);
        advance(1); expect(tunnel.sendMessage).toHaveBeenCalledTimes(2);
    });
    it('reschedules an early timer without losing the last failed image', function() {
        ready(); expect(recovery.request()).toBe(true);
        time += 0.2;
        recovery.imageFailed();
        time = 5599.9;
        jasmine.clock().tick(5500);
        expect(tunnel.sendMessage).toHaveBeenCalledTimes(1);
        time = 5600.1;
        jasmine.clock().tick(1);
        expect(tunnel.sendMessage).toHaveBeenCalledTimes(2);
    });
    it('limits persistent failures to three automatic requests per connection', function() {
        ready();
        for (var i = 0; i < 10; i++) { recovery.imageFailed(); advance(5500); }
        expect(tunnel.sendMessage).toHaveBeenCalledTimes(3);
        expect(recovery.getStatistics().automaticLimitReached).toBe(true);
        expect(recovery.request()).toBe(true);
        expect(tunnel.sendMessage).toHaveBeenCalledTimes(4);
    });
    it('retries a busy snapshot within the same automatic attempt limit', function() {
        ready(); recovery.imageFailed(); advance(1);
        recovery.handleInstruction(['1', 'busy']); advance(5500);
        expect(tunnel.sendMessage).toHaveBeenCalledTimes(2);
    });
    it('does not send while disconnected and cancels deferred work on reset', function() {
        ready(); recovery.imageFailed(); connected = false; advance(1);
        expect(tunnel.sendMessage).not.toHaveBeenCalled();
        connected = true; ready(); recovery.imageFailed(); recovery.reset(); advance(10000);
        expect(tunnel.sendMessage).not.toHaveBeenCalled();
        expect(recovery.isSupported()).toBe(false);
        expect(recovery.getStatistics().imageFailures).toBe(0);
    });
    it('keeps no pending automatic request after a successful manual refresh', function() {
        ready(); recovery.imageFailed(); expect(recovery.request()).toBe(true);
        advance(10000); expect(tunnel.sendMessage).toHaveBeenCalledTimes(1);
        expect(recovery.getStatistics().recoveryPending).toBe(false);
    });
    it('starts a reused connection with fresh capability and attempt limits', function() {
        ready(); recovery.imageFailed(); advance(1); recovery.reset(); ready();
        recovery.imageFailed(); advance(1);
        expect(tunnel.sendMessage).toHaveBeenCalledTimes(2);
        expect(recovery.getStatistics().automaticRefreshRequests).toBe(1);
    });
});

describe('Guacamole.Client display refresh integration', function() {
    var tunnel, client;
    beforeEach(function() {
        tunnel = new Guacamole.Tunnel();
        tunnel.connect = function() { tunnel.setState(Guacamole.Tunnel.State.OPEN); };
        tunnel.disconnect = function() {};
        tunnel.sendMessage = jasmine.createSpy('sendMessage');
        client = new Guacamole.Client(tunnel);
        client.connect('');
    });
    afterEach(function() { client.disconnect(); });

    it('exposes manual refresh only after the peer advertises its capability', function() {
        expect(client.isDisplayRefreshSupported()).toBe(false);
        expect(client.requestDisplayRefresh()).toBe(false);
        tunnel.oninstruction('x-resync', ['1', 'ready']);
        expect(client.isDisplayRefreshSupported()).toBe(true);
        expect(client.requestDisplayRefresh()).toBe(true);
        expect(tunnel.sendMessage).toHaveBeenCalledWith('x-resync', '1', 'request');
    });
    it('resets recovery and cancels queued drawing when disconnected', function() {
        tunnel.oninstruction('x-resync', ['1', 'ready']);
        spyOn(client.getDisplay(), 'cancel').and.callThrough();
        client.getDisplay().onimageerror();
        client.disconnect();
        expect(client.getDisplay().cancel).toHaveBeenCalledTimes(1);
        expect(client.isDisplayRefreshSupported()).toBe(false);
        expect(client.getDisplayRecoveryStatistics().imageFailures).toBe(0);
    });
    it('does not refresh after the underlying transport closes unexpectedly', function(done) {
        tunnel.oninstruction('x-resync', ['1', 'ready']);
        client.getDisplay().onimageerror();
        tunnel.setState(Guacamole.Tunnel.State.CLOSED);
        expect(client.isDisplayRefreshSupported()).toBe(false);
        expect(client.requestDisplayRefresh()).toBe(false);
        window.setTimeout(function() {
            expect(tunnel.sendMessage.calls.allArgs().filter(function(args) {
                return args[0] === 'x-resync';
            }).length).toBe(0);
            done();
        }, 20);
    });
    it('repairs a corrupt final tile from a snapshot without another source frame', function(done) {
        tunnel.oninstruction('x-resync', ['1', 'ready']);
        tunnel.oninstruction('size', ['0', '2', '1']);
        tunnel.oninstruction('sync', ['10', '1']);
        var canvas = client.getDisplay().getDefaultLayer().getCanvas();
        var context = canvas.getContext('2d');
        context.fillStyle = 'blue'; context.fillRect(0, 0, 2, 1);
        var source = document.createElement('canvas');
        source.width = 2; source.height = 1;
        source.getContext('2d').fillStyle = 'red';
        source.getContext('2d').fillRect(1, 0, 1, 1);
        var png = source.toDataURL('image/png').split(',')[1];
        var requests = 0;
        tunnel.sendMessage.and.callFake(function(opcode) {
            if (opcode !== 'x-resync') return;
            requests++;
            tunnel.oninstruction('img', ['2', String(Guacamole.Layer.SRC), '0', 'image/png', '0', '0']);
            tunnel.oninstruction('blob', ['2', png]);
            tunnel.oninstruction('end', ['2']);
            tunnel.oninstruction('sync', ['12', '0']);
            client.getDisplay().flush(function() {
                expect(Array.from(context.getImageData(0, 0, 2, 1).data))
                    .toEqual([0, 0, 0, 0, 255, 0, 0, 255]);
                expect(requests).toBe(1);
                expect(client.getDisplayRecoveryStatistics().imageFailures).toBe(1);
                done();
            });
        });
        tunnel.oninstruction('img', ['1', String(Guacamole.Layer.SRC), '0', 'image/png', '0', '0']);
        tunnel.oninstruction('blob', ['1', window.btoa('corrupt final tile')]);
        tunnel.oninstruction('end', ['1']);
        tunnel.oninstruction('sync', ['11', '1']);
    });
    it('requests a snapshot after a real failed bitmap task without blocking later drawing', function(done) {
        tunnel.oninstruction('x-resync', ['1', 'ready']);
        var bitmap = window.createImageBitmap;
        window.createImageBitmap = function() { return Promise.reject(new Error('corrupt image')); };
        var display = client.getDisplay();
        display.drawBlob({ drawImage: function() {} }, 0, 0, new Blob());
        display.flush(function() {
            window.setTimeout(function() {
                try {
                    expect(tunnel.sendMessage).toHaveBeenCalledWith('x-resync', '1', 'request');
                    expect(client.getDisplayRecoveryStatistics().imageFailures).toBe(1);
                    done();
                }
                catch (error) { done.fail(error); }
                finally { window.createImageBitmap = bitmap; }
            }, 20);
        });
    });
});
