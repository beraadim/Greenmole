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

/* global Guacamole, jasmine, expect, spyOn */

describe('Guacamole.WebSocketTunnel receive scheduling', function() {

    var tunnel;
    var client;
    var http;
    var sockets;
    var channels;
    var messages;
    var received;
    var now;
    var originalSocket;
    var originalChannel;
    var originalXHR;
    var originalTimeout;
    var originalClearTimeout;
    var originalInterval;
    var originalClearInterval;
    var timers;
    var nextTimer;
    var wallTime;

    function packet(elements) { return Guacamole.Parser.toInstruction(elements); }
    function send(data, socket) { (socket || sockets[sockets.length - 1]).onmessage({ data: data }); }
    function deliver() {
        var message = messages.shift();
        message.handler({ data: message.token });
    }

    function advanceClock(duration) {
        var target = wallTime + duration;
        while (true) {
            var ready = Object.keys(timers).filter(function(id) { return timers[id].due <= target; })
                .sort(function(a, b) { return timers[a].due - timers[b].due; });
            if (!ready.length)
                break;
            var id = ready[0];
            var timer = timers[id];
            wallTime = timer.due;
            if (timer.interval)
                timer.due += timer.interval;
            else
                delete timers[id];
            timer.callback();
        }
        wallTime = target;
    }

    beforeEach(function() {
        wallTime = 10000;
        timers = {};
        nextTimer = 0;
        originalTimeout = window.setTimeout;
        originalClearTimeout = window.clearTimeout;
        originalInterval = window.setInterval;
        originalClearInterval = window.clearInterval;
        window.setTimeout = function(callback, delay) {
            var id = ++nextTimer;
            timers[id] = { callback: callback, due: wallTime + delay };
            return id;
        };
        window.clearTimeout = window.clearInterval = function(id) { delete timers[id]; };
        window.setInterval = function(callback, delay) {
            var id = window.setTimeout(callback, delay);
            timers[id].interval = delay;
            return id;
        };
        spyOn(Date.prototype, 'getTime').and.callFake(function() { return wallTime; });
        now = 0;
        sockets = [];
        channels = [];
        messages = [];
        received = [];
        client = http = null;
        originalSocket = window.WebSocket;
        originalChannel = window.MessageChannel;
        originalXHR = window.XMLHttpRequest;
        spyOn(window.performance, 'now').and.callFake(function() { return now; });
        window.WebSocket = function(url, protocol) {
            this.url = url;
            this.protocol = protocol;
            this.sent = [];
            this.send = function(message) { this.sent.push(message); };
            this.close = jasmine.createSpy('close socket');
            sockets.push(this);
        };
        window.MessageChannel = function() {
            var channel = this;
            channel.port1 = { onmessage: null, close: jasmine.createSpy('close receiving port') };
            channel.port2 = {
                close: jasmine.createSpy('close sending port'),
                postMessage: function(token) {
                    messages.push({ handler: channel.port1.onmessage, token: token });
                }
            };
            channels.push(channel);
        };
        tunnel = new Guacamole.WebSocketTunnel('ws://localhost/test');
        tunnel.onerror = jasmine.createSpy('tunnel error');
        tunnel.oninstruction = function(opcode) { received.push(opcode); now += 3; };
        tunnel.connect('synthetic');
    });

    afterEach(function() {
        if (client) client.disconnect();
        if (http) http.disconnect();
        tunnel.disconnect();
        window.WebSocket = originalSocket;
        window.MessageChannel = originalChannel;
        window.XMLHttpRequest = originalXHR;
        window.setTimeout = originalTimeout;
        window.clearTimeout = originalClearTimeout;
        window.setInterval = originalInterval;
        window.clearInterval = originalClearInterval;
    });

    it('opens from its UUID and keeps an isolated instruction synchronous', function() {
        send(packet(['', 'synthetic-uuid']));
        expect(tunnel.uuid).toBe('synthetic-uuid');
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.OPEN);
        send('1.a;');
        expect(received).toEqual(['a']);
        expect(messages.length).toBe(0);
    });

    it('yields a burst while preserving newly arriving packet order', function() {
        send('1.a;1.b;1.c;1.d;1.e;');
        send('1.f;1.g;');
        expect(received).toEqual(['a', 'b', 'c']);
        expect(messages.length).toBe(1);
        deliver();
        expect(received).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        deliver();
        expect(received).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    });

    it('preserves actual Client drawing and sync acknowledgement order across slices', function() {
        tunnel.disconnect();
        client = new Guacamole.Client(tunnel);
        client.connect('synthetic');
        var drawn = [];
        client.getDisplay().getDefaultLayer().copy = function(source, x) {
            drawn.push(x);
            now += 3;
        };
        send(packet(['', 'synthetic-uuid']) + packet(['size', 0, 16, 16]) + packet(['sync', 100]));
        var burst = '';
        for (var i = 1; i <= 7; i++)
            burst += packet(['copy', 0, i, 0, 1, 1, 12, 0, 0, 0]) + packet(['sync', 100 + i]);
        send(burst);
        expect(drawn).toEqual([1, 2, 3]);
        expect(sockets[1].sent).toEqual([packet(['sync', 100]), packet(['sync', 101]), packet(['sync', 102]), packet(['sync', 103])]);
        while (messages.length) deliver();
        expect(drawn).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(sockets[1].sent).toEqual(Array.from({ length: 8 }, function(value, index) { return packet(['sync', 100 + index]); }));
    });

    it('cancels remaining instructions when disconnected inside an instruction callback', function() {
        tunnel.oninstruction = function(opcode) {
            received.push(opcode);
            tunnel.disconnect();
        };
        send('1.a;1.b;');
        expect(received).toEqual(['a']);
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.CLOSED);
        expect(sockets[0].close).toHaveBeenCalledTimes(1);
    });

    it('drains complete received instructions before reporting server close', function() {
        var order = [];
        tunnel.oninstruction = function(opcode) { received.push(opcode); order.push(opcode); now += 3; };
        tunnel.onerror = function() { order.push('closed'); };
        send('1.a;1.b;1.c;1.d;1.e;');
        sockets[0].onclose({ code: 1006 });
        expect(order).toEqual(['a', 'b', 'c']);
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.OPEN);
        tunnel.sendMessage('sync', 1);
        expect(sockets[0].sent).toEqual([]);
        while (messages.length) deliver();
        expect(order).toEqual(['a', 'b', 'c', 'd', 'e', 'closed']);
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.CLOSED);
    });

    it('cancels natural-EOF draining immediately on manual disconnect', function() {
        send('1.a;1.b;1.c;1.d;');
        sockets[0].onclose({ code: 1006 });
        var stale = messages.shift();
        tunnel.disconnect();
        stale.handler({ data: stale.token });
        expect(received).toEqual(['a', 'b', 'c']);
        expect(tunnel.onerror).not.toHaveBeenCalled();
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.CLOSED);
    });

    it('applies the final real Client frame before processing natural EOF', function() {
        tunnel.disconnect();
        client = new Guacamole.Client(tunnel);
        client.connect('synthetic');
        var drawn = [];
        client.getDisplay().getDefaultLayer().copy = function(source, x) {
            drawn.push(x);
            now += 3;
        };
        send(packet(['', 'synthetic-uuid']) + packet(['size', 0, 16, 16]) + packet(['sync', 100]));
        var burst = '';
        for (var i = 1; i <= 7; i++)
            burst += packet(['copy', 0, i, 0, 1, 1, 12, 0, 0, 0]) + packet(['sync', 100 + i]);
        send(burst);
        sockets[1].onclose({ code: 1006 });
        expect(drawn).toEqual([1, 2, 3]);
        while (messages.length) deliver();
        expect(drawn).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.CLOSED);
        expect(sockets[1].sent.length).toBe(4);
    });

    it('reports a malformed deferred instruction once when EOF is also pending', function() {
        send('1.a;1.b;1.c;1.d!');
        sockets[0].onclose({ code: 1006 });
        deliver();
        expect(tunnel.onerror).toHaveBeenCalledTimes(1);
        expect(tunnel.onerror.calls.first().args[0].code).toBe(Guacamole.Status.Code.SERVER_ERROR);
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.CLOSED);
    });

    it('rejects old socket events and old continuations after reconnect', function() {
        send('1.a;1.b;1.c;1.d;');
        var oldSocket = sockets[0];
        var oldMessage = oldSocket.onmessage;
        var oldOpen = oldSocket.onopen;
        var oldClose = oldSocket.onclose;
        var oldContinuation = messages.shift();
        tunnel.connect('replacement');
        expect(channels[0].port1.close).toHaveBeenCalledTimes(1);
        expect(channels[0].port2.close).toHaveBeenCalledTimes(1);
        expect(oldSocket.onmessage).toBeNull();
        expect(oldSocket.close).toHaveBeenCalledTimes(1);
        oldMessage({ data: '1.z;' });
        oldOpen({});
        oldClose({ code: 1006 });
        oldContinuation.handler({ data: oldContinuation.token });
        expect(received).toEqual(['a', 'b', 'c']);
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.CONNECTING);
        send(packet(['', 'new-uuid']) + '1.e;');
        expect(tunnel.uuid).toBe('new-uuid');
        expect(received).toEqual(['a', 'b', 'c', 'e']);
        expect(tunnel.onerror).not.toHaveBeenCalled();
    });

    it('does not let cleared timeout callbacks alter a replacement connection', function() {
        var timers = [];
        var timeout = window.setTimeout;
        window.setTimeout = function(callback, delay) {
            timers.push({ callback: callback, delay: delay });
            return timeout(callback, delay);
        };
        sockets[0].onopen({});
        var old = timers.slice();
        tunnel.connect('replacement');
        old.forEach(function(timer) { timer.callback(); });
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.CONNECTING);
        expect(tunnel.onerror).not.toHaveBeenCalled();
        expect(sockets[1].sent).toEqual([]);
    });

    it('counts arriving keepalive data as network activity before deferred parsing', function() {
        send('1.a;1.b;1.c;1.d;');
        advanceClock(1501);
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.UNSTABLE);
        send(packet(['', 'ping', 10000]));
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.OPEN);
        expect(received).toEqual(['a', 'b', 'c']);
        deliver();
        expect(received).toEqual(['a', 'b', 'c', 'd']);
        expect(tunnel.onerror).not.toHaveBeenCalled();
    });

    it('closes cleanly on malformed data or a throwing instruction callback', function() {
        tunnel.oninstruction = function() { throw new Error('drawing failed'); };
        send('1.a;1.b;');
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.CLOSED);
        expect(tunnel.onerror).toHaveBeenCalledTimes(1);
        expect(tunnel.onerror.calls.first().args[0].message).toBe('drawing failed');
        expect(sockets[0].onmessage).toBeNull();
    });

    it('allows reconnecting from an error callback without closing the replacement', function() {
        tunnel.onerror = function() { tunnel.connect('replacement'); };
        send('1.a!');
        expect(sockets.length).toBe(2);
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.CONNECTING);
        expect(sockets[1].close).not.toHaveBeenCalled();
        send(packet(['', 'new-uuid']) + '1.b;');
        expect(received).toEqual(['b']);
    });

    it('completes cleanup even if an error callback throws', function() {
        tunnel.onerror = function() { throw new Error('error callback failed'); };
        expect(function() { send('1.a!'); }).toThrowError('error callback failed');
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.CLOSED);
        expect(sockets[0].close).toHaveBeenCalledTimes(1);
    });

    it('does not create a socket if disconnected from the connecting-state callback', function() {
        tunnel.disconnect();
        tunnel.onstatechange = function(state) {
            if (state === Guacamole.Tunnel.State.CONNECTING)
                tunnel.disconnect();
        };
        tunnel.connect('cancelled');
        expect(sockets.length).toBe(1);
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.CLOSED);
    });

    it('does not restart old timers if reconnecting while clearing unstable state', function() {
        send('1.a;');
        advanceClock(1501);
        tunnel.onstatechange = function(state) {
            if (state === Guacamole.Tunnel.State.OPEN)
                tunnel.connect('replacement');
        };
        var oldMessage = sockets[0].onmessage;
        oldMessage({ data: '1.b;' });
        expect(received).toEqual(['a']);
        expect(tunnel.state).toBe(Guacamole.Tunnel.State.CONNECTING);
        expect(sockets.length).toBe(2);
    });

    it('keeps HTTP streaming responses synchronous and independent of the pump', function() {
        var requests = [];
        window.XMLHttpRequest = function() {
            this.readyState = 0;
            this.open = function(method, url) { this.url = url; };
            this.send = function() {};
            this.abort = function() {};
            this.setRequestHeader = function() {};
            this.getResponseHeader = function() { return 'synthetic-token'; };
            requests.push(this);
        };
        spyOn(Guacamole, 'InstructionPump').and.throwError('HTTP must remain synchronous');
        http = new Guacamole.HTTPTunnel('/test');
        http.oninstruction = function(opcode) { received.push(opcode); };
        http.connect('synthetic');
        Object.assign(requests[0], { readyState: 4, status: 200, responseText: 'synthetic-uuid' });
        requests[0].onreadystatechange();
        Object.assign(requests[1], { readyState: 3, status: 200, responseText: '1.a;1.b;' });
        requests[1].onreadystatechange();
        expect(received).toEqual(['a', 'b']);
        expect(messages.length).toBe(0);
    });

});
