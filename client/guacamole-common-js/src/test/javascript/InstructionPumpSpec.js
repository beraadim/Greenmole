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

describe('Guacamole.Parser incremental receive', function() {

    it('keeps the default receive API synchronous and resumes only at instruction boundaries', function() {
        var parser = new Guacamole.Parser();
        var received = [];
        parser.oninstruction = function(opcode) { received.push(opcode); };
        expect(parser.receive('1.a;1.b;')).toBeUndefined();
        expect(received).toEqual(['a', 'b']);
        expect(parser.receivePartial('1.c;1.d;', function() { return true; })).toBe(true);
        expect(received).toEqual(['a', 'b', 'c']);
        expect(parser.receivePartial('', function() { return true; })).toBe(false);
        expect(received).toEqual(['a', 'b', 'c', 'd']);
        parser.receive('1.e;');
        expect(received).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('retains fragmented instructions and Unicode across partial resumes', function() {
        var parser = new Guacamole.Parser();
        parser.oninstruction = jasmine.createSpy('instruction');
        expect(parser.receivePartial('1.a,2.\uD83D', function(complete) { return complete; })).toBe(false);
        expect(parser.oninstruction).not.toHaveBeenCalled();
        expect(parser.receivePartial('\uDE00x;1.b;', function(complete) { return complete; })).toBe(true);
        expect(parser.oninstruction).toHaveBeenCalledOnceWith('a', ['\uD83D\uDE00x']);
        expect(parser.receivePartial('', function() { return true; })).toBe(false);
        expect(parser.oninstruction).toHaveBeenCalledWith('b', []);
    });

    it('counts complete elements retained across source-buffer truncation', function() {
        var parser = new Guacamole.Parser();
        parser.receive('1.a,5000.' + 'x'.repeat(5000) + ',');
        parser.receive('1.b,');
        expect(parser.getBufferedLength()).toBeGreaterThanOrEqual(5002);
        parser.receive('1.c;');
        expect(parser.getBufferedLength()).toBe(0);
    });

});

describe('Guacamole.InstructionPump', function() {

    var pump;
    var received;
    var error;
    var now;
    var channels;
    var messages;
    var originalChannel;
    var originalMaxLength;
    var originalMaxPackets;
    var originalMaxElements;

    function deliver(message) {
        message = message || messages.shift();
        message.handler({ data: message.token });
    }

    beforeEach(function() {
        received = [];
        error = jasmine.createSpy('error');
        now = 0;
        channels = [];
        messages = [];
        originalChannel = window.MessageChannel;
        originalMaxLength = Guacamole.InstructionPump.MAX_BUFFER_LENGTH;
        originalMaxPackets = Guacamole.InstructionPump.MAX_QUEUED_PACKETS;
        originalMaxElements = Guacamole.InstructionPump.MAX_BUFFER_ELEMENTS;
        spyOn(window.performance, 'now').and.callFake(function() { return now; });
        window.MessageChannel = function() {
            var channel = this;
            channel.port1 = { onmessage: null, close: jasmine.createSpy('close input') };
            channel.port2 = {
                close: jasmine.createSpy('close output'),
                postMessage: function(token) {
                    messages.push({ token: token, handler: channel.port1.onmessage });
                }
            };
            channels.push(channel);
        };
        pump = new Guacamole.InstructionPump(function(opcode) {
            received.push(opcode);
            now += 3;
        }, error);
    });

    afterEach(function() {
        pump.cancel();
        window.MessageChannel = originalChannel;
        Guacamole.InstructionPump.MAX_BUFFER_LENGTH = originalMaxLength;
        Guacamole.InstructionPump.MAX_QUEUED_PACKETS = originalMaxPackets;
        Guacamole.InstructionPump.MAX_BUFFER_ELEMENTS = originalMaxElements;
    });

    it('immediately delivers an isolated instruction without a continuation', function() {
        pump.receive('1.a;');
        expect(received).toEqual(['a']);
        expect(messages.length).toBe(0);
        expect(channels.length).toBe(0);
    });

    it('yields after complete instructions and preserves packets and ACK ordering', function() {
        pump.receive('1.a;1.b;1.c;1.d;1.e;');
        expect(received).toEqual(['a', 'b', 'c']);
        pump.receive('1.f;1.g;');
        expect(messages.length).toBe(1);
        deliver();
        expect(received).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        expect(channels.length).toBe(1);
        expect(messages.length).toBe(1);
        deliver();
        expect(received).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
        expect(error).not.toHaveBeenCalled();
    });

    it('bounds instruction counts when the clock does not advance', function() {
        var count = 0;
        pump.cancel();
        pump = new Guacamole.InstructionPump(function() { count++; }, error);
        pump.receive('1.a;'.repeat(9000));
        expect(count).toBe(4096);
        deliver();
        expect(count).toBe(8192);
        deliver();
        expect(count).toBe(9000);
        expect(messages.length).toBe(0);
    });

    it('includes parser execution time when deciding whether to yield', function() {
        var original = Guacamole.Parser.prototype;
        // Advancing the clock while the parser checks Unicode length represents
        // parsing work rather than drawing or instruction callback work.
        spyOn(Guacamole.Parser, 'codePointCount').and.callFake(function(text, start, end) {
            now += 2;
            return end - start;
        });
        pump.cancel();
        pump = new Guacamole.InstructionPump(function(opcode) { received.push(opcode); }, error);
        pump.receive('1.a;1.b;1.c;1.d;1.e;1.f;');
        expect(received).toEqual(['a', 'b', 'c', 'd']);
        expect(messages.length).toBe(1);
        deliver();
        expect(received).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        expect(Guacamole.Parser.prototype).toBe(original);
    });

    it('waits for incomplete data without polling', function() {
        pump.receive('1.a,3.x');
        expect(received).toEqual([]);
        expect(messages.length).toBe(0);
        pump.receive('yz;1.b;');
        expect(received).toEqual(['a', 'b']);
        expect(messages.length).toBe(0);
    });

    it('can yield parsing within a large instruction without delivering it partially', function() {
        spyOn(Guacamole.Parser, 'codePointCount').and.callFake(function(text, start, end) {
            now += 3;
            return end - start;
        });
        pump.receive('1.a,' + '0.,'.repeat(100) + '0.;');
        expect(received).toEqual([]);
        expect(messages.length).toBe(1);
        deliver();
        expect(received).toEqual([]);
        deliver();
        expect(received).toEqual([]);
        deliver();
        expect(received).toEqual(['a']);
    });

    it('bounds empty-argument metadata across multiple source-buffer truncations', function() {
        pump.cancel();
        Guacamole.InstructionPump.MAX_BUFFER_ELEMENTS = 2048;
        pump = new Guacamole.InstructionPump(function(opcode) { received.push(opcode); }, error);
        pump.receive('0.,'.repeat(700) + '1.x');
        pump.receive(',' + '0.,'.repeat(700) + '1.y');
        expect(error).not.toHaveBeenCalled();
        pump.receive(',' + '0.,'.repeat(700));
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.calls.first().args[0].code).toBe(Guacamole.Status.Code.CLIENT_OVERRUN);
        expect(received).toEqual([]);
    });

    it('drains already received instructions before reporting natural EOF', function() {
        var ended = jasmine.createSpy('ended');
        pump.receive('1.a;1.b;1.c;1.d;1.e;1.f;1.g;');
        pump.end(ended);
        pump.receive('1.z;');
        expect(received).toEqual(['a', 'b', 'c']);
        expect(ended).not.toHaveBeenCalled();
        deliver();
        expect(ended).not.toHaveBeenCalled();
        deliver();
        expect(received).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
        expect(ended).toHaveBeenCalledTimes(1);
        expect(channels[0].port1.close).toHaveBeenCalledTimes(1);
    });

    it('reports EOF immediately for an idle parser with an incomplete final instruction', function() {
        var ended = jasmine.createSpy('ended');
        pump.receive('1.a,5.x');
        pump.end(ended);
        expect(received).toEqual([]);
        expect(ended).toHaveBeenCalledTimes(1);
    });

    it('suppresses pending EOF notification after manual cancellation', function() {
        var ended = jasmine.createSpy('ended');
        pump.receive('1.a;1.b;1.c;1.d;');
        pump.end(ended);
        var stale = messages.shift();
        pump.cancel();
        deliver(stale);
        expect(received).toEqual(['a', 'b', 'c']);
        expect(ended).not.toHaveBeenCalled();
    });

    it('can request EOF from within an instruction callback without dropping its received tail', function() {
        var ended = jasmine.createSpy('ended');
        pump.cancel();
        pump = new Guacamole.InstructionPump(function(opcode) {
            received.push(opcode);
            if (opcode === 'a') pump.end(ended);
        }, error);
        pump.receive('1.a;1.b;');
        expect(received).toEqual(['a', 'b']);
        expect(ended).toHaveBeenCalledTimes(1);
    });

    it('queues reentrant receive calls after already received data', function() {
        pump.cancel();
        pump = new Guacamole.InstructionPump(function(opcode) {
            received.push(opcode);
            if (opcode === 'a')
                pump.receive('1.c;');
        }, error);
        pump.receive('1.a;1.b;');
        expect(received).toEqual(['a', 'b', 'c']);
    });

    it('stops the current packet when cancelled reentrantly by an instruction', function() {
        pump.cancel();
        pump = new Guacamole.InstructionPump(function(opcode) {
            received.push(opcode);
            pump.cancel();
        }, error);
        pump.receive('1.a;1.b;');
        pump.receive('1.c;');
        expect(received).toEqual(['a']);
        expect(error).not.toHaveBeenCalled();
        expect(messages.length).toBe(0);
    });

    it('closes both ports and ignores saved or duplicate continuation handlers', function() {
        pump.receive('1.a;1.b;1.c;1.d;1.e;1.f;1.g;');
        var first = messages.shift();
        first.handler({ data: first.token + 1 });
        expect(received.length).toBe(3);
        deliver(first);
        expect(received.length).toBe(6);
        deliver(first);
        expect(received.length).toBe(6);
        var stale = messages.shift();
        pump.cancel();
        expect(channels[0].port1.close).toHaveBeenCalledTimes(1);
        expect(channels[0].port2.close).toHaveBeenCalledTimes(1);
        expect(channels[0].port1.onmessage).toBeNull();
        deliver(stale);
        expect(received.length).toBe(6);
    });

    it('cancels once on a malformed packet or a throwing instruction handler', function() {
        pump.receive('1.a!');
        pump.receive('1.b;');
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.calls.first().args[0].code).toBe(Guacamole.Status.Code.SERVER_ERROR);
        expect(received).toEqual([]);

        error.calls.reset();
        pump = new Guacamole.InstructionPump(function() { throw new Error('handler failed'); }, error);
        pump.receive('1.a;1.b;');
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.calls.first().args[0].message).toBe('handler failed');
    });

    it('rejects binary WebSocket packets cleanly', function() {
        pump.receive(new ArrayBuffer(4));
        expect(error).toHaveBeenCalledTimes(1);
        expect(received.length).toBe(0);
    });

    it('limits retained incomplete parser data as well as queued packets', function() {
        pump.cancel();
        Guacamole.InstructionPump.MAX_BUFFER_LENGTH = 60;
        pump = new Guacamole.InstructionPump(function(opcode) { received.push(opcode); }, error);
        pump.receive('1.a,100.' + 'x'.repeat(20));
        expect(error).not.toHaveBeenCalled();
        pump.receive('x'.repeat(20));
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.calls.first().args[0].code).toBe(Guacamole.Status.Code.CLIENT_OVERRUN);
        expect(received.length).toBe(0);
    });

    it('includes source-buffer and packet text together in its receive limit', function() {
        pump.cancel();
        Guacamole.InstructionPump.MAX_BUFFER_LENGTH = 40;
        pump = new Guacamole.InstructionPump(function(opcode) { received.push(opcode); now += 8; }, error);
        pump.receive('1.a;1.b;1.c;');
        expect(received).toEqual(['a']);
        pump.receive('1.d;'.repeat(6));
        expect(error).not.toHaveBeenCalled();
        pump.receive('1.e;1.f;');
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.calls.first().args[0].code).toBe(Guacamole.Status.Code.CLIENT_OVERRUN);
        expect(received).toEqual(['a']);
    });

    it('bounds packet-count overhead even for tiny queued messages', function() {
        pump.cancel();
        Guacamole.InstructionPump.MAX_QUEUED_PACKETS = 2;
        pump = new Guacamole.InstructionPump(function(opcode) { received.push(opcode); now += 8; }, error);
        pump.receive('1.a;1.b;');
        pump.receive('1.c;');
        pump.receive('1.d;');
        pump.receive('1.e;');
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.calls.first().args[0].code).toBe(Guacamole.Status.Code.CLIENT_OVERRUN);
        expect(received).toEqual(['a']);
    });

    it('uses and cancels timer fallback when a channel is unavailable', function() {
        var timers = [];
        window.MessageChannel = undefined;
        spyOn(window, 'setTimeout').and.callFake(function(callback) { timers.push(callback); return timers.length; });
        var clear = spyOn(window, 'clearTimeout');
        pump.receive('1.a;1.b;1.c;1.d;1.e;1.f;1.g;');
        expect(received.length).toBe(3);
        timers[0]();
        expect(received.length).toBe(6);
        pump.cancel();
        expect(clear).toHaveBeenCalledWith(2);
        timers[1]();
        expect(received.length).toBe(6);
    });

    it('falls back to a timer when channel construction or posting throws', function() {
        var timers = [];
        window.MessageChannel = function() { throw new Error('channel unavailable'); };
        spyOn(window, 'setTimeout').and.callFake(function(callback) { timers.push(callback); return timers.length; });
        pump.receive('1.a;1.b;1.c;1.d;');
        expect(timers.length).toBe(1);
        timers[0]();
        expect(received).toEqual(['a', 'b', 'c', 'd']);

        pump.cancel();
        var first = { onmessage: null, close: jasmine.createSpy('first close') };
        var second = { close: jasmine.createSpy('second close'), postMessage: function() { throw new Error('post failed'); } };
        window.MessageChannel = function() { this.port1 = first; this.port2 = second; };
        pump = new Guacamole.InstructionPump(function(opcode) { received.push(opcode); now += 8; }, error);
        pump.receive('1.e;1.f;');
        expect(first.close).toHaveBeenCalledTimes(1);
        expect(second.close).toHaveBeenCalledTimes(1);
        expect(first.onmessage).toBeNull();
        timers[1]();
        expect(received).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    });

});
