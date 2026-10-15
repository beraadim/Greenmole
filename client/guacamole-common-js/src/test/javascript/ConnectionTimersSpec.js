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

(function() {

    function Clock() {
        var clock = this;
        var timeout = window.setTimeout;
        var clear = window.clearTimeout;
        var timers = {};
        this.now = 0;
        this.wall = 100000;
        this.allocated = 0;
        this.history = [];
        spyOn(window.performance, 'now').and.callFake(function() { return clock.now; });
        spyOn(Date.prototype, 'getTime').and.callFake(function() { return clock.wall; });
        window.setTimeout = function(callback, delay) {
            var id = ++clock.allocated;
            var timer = { id: id, due: clock.now + delay, callback: callback };
            timers[id] = timer;
            clock.history.push(timer);
            return id;
        };
        window.clearTimeout = function(id) { delete timers[id]; };
        this.pending = function() { return Object.keys(timers).map(function(id) { return timers[id]; }); };
        this.advance = function(duration) {
            var target = clock.now + duration;
            while (true) {
                var ready = clock.pending().filter(function(timer) { return timer.due <= target; })
                    .sort(function(a, b) { return a.due - b.due; });
                if (!ready.length) break;
                var timer = ready[0];
                clock.wall += timer.due - clock.now;
                clock.now = timer.due;
                delete timers[timer.id];
                timer.callback();
            }
            clock.wall += target - clock.now;
            clock.now = target;
        };
        this.suspend = function(duration) { clock.now += duration; clock.wall += duration; };
        this.restore = function() { window.setTimeout = timeout; window.clearTimeout = clear; };
    }

    describe('Guacamole.DeadlineTimer', function() {
        var clock;
        var timer;
        var fired;
        beforeEach(function() {
            clock = new Clock();
            fired = jasmine.createSpy('deadline fired');
            timer = new Guacamole.DeadlineTimer(Guacamole.DeadlineTimer.now, fired);
        });
        afterEach(function() { timer.cancel(); clock.restore(); });

        it('retains one timeout when the deadline stays the same or moves later', function() {
            timer.schedule(1000);
            for (var i = 0; i < 1000; i++) timer.schedule(1000 + i);
            expect(clock.allocated).toBe(1);
            clock.advance(1000);
            expect(fired).not.toHaveBeenCalled();
            expect(clock.allocated).toBe(2);
            clock.advance(998);
            expect(fired).not.toHaveBeenCalled();
            clock.advance(1);
            expect(fired).toHaveBeenCalledTimes(1);
            expect(clock.pending().length).toBe(0);
        });

        it('handles a later deadline followed by earlier deadlines without firing early', function() {
            timer.schedule(1000);
            timer.schedule(2500);
            timer.schedule(1200);
            expect(clock.allocated).toBe(1);
            clock.advance(500);
            timer.schedule(700);
            expect(clock.allocated).toBe(2);
            clock.advance(199);
            expect(fired).not.toHaveBeenCalled();
            clock.advance(1);
            expect(fired).toHaveBeenCalledTimes(1);
        });

        it('rejects a saved callback after cancellation and reuse', function() {
            timer.schedule(1000);
            var old = clock.history[0].callback;
            timer.cancel();
            timer.schedule(2000);
            old();
            expect(fired).not.toHaveBeenCalled();
            expect(clock.pending().length).toBe(1);
            clock.advance(2000);
            expect(fired).toHaveBeenCalledTimes(1);
        });

        it('permits a callback to schedule its next one-shot deadline reentrantly', function() {
            timer.cancel();
            timer = new Guacamole.DeadlineTimer(Guacamole.DeadlineTimer.now, function() {
                fired();
                if (clock.now === 1000) timer.schedule(1500);
            });
            timer.schedule(1000);
            clock.advance(1500);
            expect(fired).toHaveBeenCalledTimes(2);
            expect(clock.pending().length).toBe(0);
        });

        it('bounds browser timeout delays for long deadlines', function() {
            timer.schedule(0x80000000 + 100);
            expect(clock.history[0].due).toBe(0x7FFFFFFF);
            clock.advance(0x7FFFFFFF);
            expect(fired).not.toHaveBeenCalled();
            clock.advance(101);
            expect(fired).toHaveBeenCalledTimes(1);
        });
    });

    describe('Guacamole.Client keepalive deadlines', function() {
        var clock;
        var client;
        var tunnel;
        var sent;
        beforeEach(function() {
            clock = new Clock();
            sent = [];
            tunnel = new Guacamole.Tunnel();
            tunnel.connect = jasmine.createSpy('connect');
            tunnel.disconnect = jasmine.createSpy('disconnect');
            tunnel.isConnected = function() { return true; };
            tunnel.sendMessage = function() { sent.push({ args: Array.from(arguments), time: clock.now }); };
            client = new Guacamole.Client(tunnel);
            client.connect('synthetic');
        });
        afterEach(function() { client.disconnect(); clock.restore(); });
        function nops() { return sent.filter(function(message) { return message.args[0] === 'nop'; }); }
        function activity() { tunnel.oninstruction('nop', []); }

        it('uses one timer for an instruction burst and preserves the five-second deadline', function() {
            for (var i = 0; i < 1000; i++) activity();
            expect(clock.allocated).toBe(1);
            expect(clock.pending().length).toBe(1);
            expect(nops().map(function(message) { return message.time; })).toEqual([0]);
            clock.advance(4999);
            expect(nops().length).toBe(1);
            clock.advance(1);
            expect(nops().map(function(message) { return message.time; })).toEqual([0, 5000]);
            clock.advance(10000);
            expect(nops().length).toBe(2);
            activity();
            expect(nops().map(function(message) { return message.time; })).toEqual([0, 5000, 15000]);
        });

        it('catches an overdue throttled timer on activity without duplicate sends', function() {
            activity();
            var old = clock.history[0].callback;
            clock.suspend(6000);
            activity();
            expect(nops().map(function(message) { return message.time; })).toEqual([0, 6000]);
            old();
            expect(nops().length).toBe(2);
            activity();
            clock.advance(5000);
            expect(nops().map(function(message) { return message.time; })).toEqual([0, 6000, 11000]);
        });

        it('keeps interval deadlines stable across wall-clock changes', function() {
            activity();
            clock.wall += 3600000;
            activity();
            clock.advance(1000);
            clock.wall -= 7200000;
            activity();
            clock.advance(4000);
            expect(nops().map(function(message) { return message.time; })).toEqual([0, 5000]);
            expect(clock.allocated).toBe(1);
        });

        it('does not schedule after an instruction handler disconnects', function() {
            activity();
            var stale = clock.history[0].callback;
            client.onname = function() { client.disconnect(); };
            tunnel.oninstruction('name', ['synthetic']);
            expect(clock.pending().length).toBe(0);
            var allocated = clock.allocated;
            activity();
            stale();
            expect(clock.allocated).toBe(allocated);
            expect(nops().length).toBe(1);
        });

        it('keeps a replacement connection timer when an instruction handler reconnects', function() {
            activity();
            var stale = clock.history[0].callback;
            clock.advance(1000);
            client.onname = function() { client.connect('replacement'); };
            tunnel.oninstruction('name', ['synthetic']);
            expect(tunnel.connect).toHaveBeenCalledTimes(2);
            expect(clock.pending().length).toBe(1);
            stale();
            expect(clock.pending().length).toBe(1);
            clock.advance(4000);
            expect(nops().map(function(message) { return message.time; })).toEqual([0, 5000]);
        });

        it('does not create a connection after cancellation from its connecting-state callback', function() {
            client.disconnect();
            client.onstatechange = function(state) {
                if (state === Guacamole.Client.State.CONNECTING) client.disconnect();
            };
            client.connect('cancelled');
            expect(tunnel.connect).toHaveBeenCalledTimes(1);
            expect(clock.pending().length).toBe(0);
        });

        it('does not disconnect a replacement opened from its disconnecting-state callback', function() {
            var state;
            client.onstatechange = function(value) {
                state = value;
                if (value === Guacamole.Client.State.DISCONNECTING) client.connect('replacement');
            };
            client.disconnect();
            expect(tunnel.connect).toHaveBeenCalledTimes(2);
            expect(tunnel.disconnect).not.toHaveBeenCalled();
            expect(state).toBe(Guacamole.Client.State.WAITING);
            client.onstatechange = null;
        });

        it('cleans up when connect throws and suppresses saved callbacks', function() {
            activity();
            var stale = clock.history[0].callback;
            tunnel.connect.and.throwError('synthetic failure');
            expect(function() { client.connect('failed'); }).toThrowError('synthetic failure');
            expect(clock.pending().length).toBe(0);
            stale();
            activity();
            expect(nops().length).toBe(1);
        });

        it('handles instructions delivered synchronously while sending a due keepalive', function() {
            activity();
            var send = tunnel.sendMessage;
            tunnel.sendMessage = function() { send.apply(tunnel, arguments); activity(); };
            clock.advance(5000);
            expect(nops().map(function(message) { return message.time; })).toEqual([0, 5000]);
            expect(clock.pending().length).toBe(1);
            tunnel.sendMessage = send;
        });
    });

    describe('Guacamole.WebSocketTunnel activity deadlines', function() {
        var clock;
        var tunnel;
        var sockets;
        var originalSocket;
        var sentHook;
        beforeEach(function() {
            clock = new Clock();
            sockets = [];
            sentHook = null;
            originalSocket = window.WebSocket;
            window.WebSocket = function() {
                this.sent = [];
                this.send = function(text) {
                    this.sent.push({ text: text, time: clock.now });
                    if (sentHook) sentHook();
                };
                this.close = jasmine.createSpy('close socket');
                sockets.push(this);
            };
            tunnel = new Guacamole.WebSocketTunnel('ws://localhost/synthetic');
            tunnel.onerror = jasmine.createSpy('error');
            tunnel.connect('synthetic');
            sockets[0].onmessage({ data: '0.,4.uuid;' });
        });
        afterEach(function() { tunnel.disconnect(); window.WebSocket = originalSocket; clock.restore(); });
        function activity() { sockets[sockets.length - 1].onmessage({ data: '0.,4.ping,1.0;' }); }
        function pings(socket) { return (socket || sockets[0]).sent.filter(function(message) { return message.text.indexOf('4.ping,') !== -1; }); }

        it('retains three timer roles across a burst instead of allocating per packet', function() {
            expect(clock.allocated).toBe(3);
            for (var i = 0; i < 1000; i++) { clock.advance(1); activity(); }
            expect(clock.allocated).toBe(5);
            expect(clock.pending().length).toBe(3);
            expect(pings().map(function(message) { return message.time; })).toEqual([500, 1000]);
        });

        it('extends receive and unstable deadlines from the last raw packet', function() {
            clock.advance(1000);
            activity();
            clock.advance(1499);
            expect(tunnel.state).toBe(Guacamole.Tunnel.State.OPEN);
            clock.advance(1);
            expect(tunnel.state).toBe(Guacamole.Tunnel.State.UNSTABLE);
            clock.advance(13499);
            expect(tunnel.onerror).not.toHaveBeenCalled();
            clock.advance(1);
            expect(tunnel.onerror.calls.first().args[0].code).toBe(Guacamole.Status.Code.UPSTREAM_TIMEOUT);
            expect(tunnel.state).toBe(Guacamole.Tunnel.State.CLOSED);
        });

        it('recovers immediately from unstable on raw activity and retains one-shot ping behavior', function() {
            clock.advance(1600);
            expect(tunnel.state).toBe(Guacamole.Tunnel.State.UNSTABLE);
            expect(pings().map(function(message) { return message.time; })).toEqual([500]);
            activity();
            expect(tunnel.state).toBe(Guacamole.Tunnel.State.OPEN);
            expect(pings().map(function(message) { return message.time; })).toEqual([500, 1600]);
        });

        it('catches overdue ping timers on incoming activity without a duplicate callback send', function() {
            var old = clock.history.filter(function(timer) { return timer.due === 500; })[0].callback;
            clock.suspend(600);
            activity();
            expect(pings().map(function(message) { return message.time; })).toEqual([600]);
            old();
            expect(pings().length).toBe(1);
            activity();
            clock.advance(500);
            expect(pings().map(function(message) { return message.time; })).toEqual([600, 1100]);
        });

        it('keeps intervals monotonic while protocol ping timestamps use the wall clock', function() {
            clock.wall += 3600000;
            activity();
            clock.advance(500);
            expect(pings()[0].text).toBe(Guacamole.Parser.toInstruction(['', 'ping', clock.wall]));
            clock.wall -= 7200000;
            activity();
            clock.advance(500);
            expect(pings()[1].time).toBe(1000);
            expect(pings()[1].text).toBe(Guacamole.Parser.toInstruction(['', 'ping', clock.wall]));
            expect(tunnel.state).toBe(Guacamole.Tunnel.State.OPEN);
        });

        it('rearms only affected roles when configured deadlines become earlier', function() {
            clock.advance(300);
            tunnel.receiveTimeout = 1000;
            tunnel.unstableThreshold = 100;
            activity();
            expect(clock.allocated).toBe(5);
            clock.advance(100);
            expect(tunnel.state).toBe(Guacamole.Tunnel.State.UNSTABLE);
            clock.advance(900);
            expect(tunnel.state).toBe(Guacamole.Tunnel.State.CLOSED);
        });

        it('ignores saved activity callbacks after EOF and reconnect', function() {
            var old = clock.history.slice();
            sockets[0].onclose({ code: 1006 });
            expect(clock.pending().length).toBe(0);
            tunnel.connect('replacement');
            old.forEach(function(timer) { timer.callback(); });
            expect(tunnel.state).toBe(Guacamole.Tunnel.State.CONNECTING);
            expect(clock.pending().length).toBe(3);
            expect(sockets[1].sent.length).toBe(0);
        });

        it('preserves replacement timers when sending a ping reconnects reentrantly', function() {
            sentHook = function() { sentHook = null; tunnel.connect('replacement'); };
            clock.advance(500);
            expect(sockets.length).toBe(2);
            expect(tunnel.state).toBe(Guacamole.Tunnel.State.CONNECTING);
            expect(clock.pending().length).toBe(3);
            sockets[1].onmessage({ data: '0.,4.uuid;' });
            clock.advance(500);
            expect(pings(sockets[1]).map(function(message) { return message.time; })).toEqual([1000]);
        });
    });

})();
