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

describe('Guacamole.PipelineDiagnostics', function() {
    var time, diagnostics;
    beforeEach(function() {
        time = 100;
        spyOn(window.performance, 'now').and.callFake(function() { return time; });
        diagnostics = new Guacamole.PipelineDiagnostics();
    });
    it('keeps only numeric cumulative timings and bounded backlog gauges', function() {
        var token = diagnostics.begin({pendingFrames: 2, oldestFrameAge: 15, blocked: true});
        time = 125;
        diagnostics.complete(token, true, {pendingFrames: 0, oldestFrameAge: 0, blocked: false});
        diagnostics.complete(token, true);
        expect(diagnostics.getStatistics()).toEqual(jasmine.objectContaining({
            syncReceived: 1, completedSync: 1, ackAttempted: 1, syncToAckSumMs: 25,
            syncToAckMaxMs: 25, inFlightMax: 1, inFlight: 0, pendingFramesMax: 2,
            oldestFrameAgeMaxMs: 15, blockedSamples: 1
        }));
        var snapshot = diagnostics.getStatistics();
        snapshot.ackAttempted = 99;
        expect(diagnostics.getStatistics().ackAttempted).toBe(1);
        Object.keys(diagnostics.getStatistics()).forEach(function(name) {
            expect(typeof diagnostics.getStatistics()[name]).toBe('number');
        });
    });
    it('ignores canceled callbacks and records duplicate sync completion', function() {
        var token = diagnostics.begin();
        diagnostics.cancel();
        time = 200;
        diagnostics.complete(token, true);
        var current = diagnostics.begin();
        diagnostics.complete(current, false);
        expect(diagnostics.getStatistics()).toEqual(jasmine.objectContaining({
            syncReceived: 2, canceledSync: 1, completedSync: 1, duplicateSync: 1,
            ackAttempted: 0, inFlight: 0, syncGapMaxMs: 0
        }));
    });
    it('clips invalid queues, backwards clocks and oversized numeric gauges', function() {
        var token = diagnostics.begin({pendingFrames: Infinity, oldestFrameAge: -1, blocked: 'true'});
        time = 99;
        diagnostics.complete(token, true);
        token = diagnostics.begin({pendingFrames: 1e100, oldestFrameAge: NaN, blocked: true});
        time = 1e100;
        diagnostics.complete(token, true);
        expect(diagnostics.getStatistics()).toEqual(jasmine.objectContaining({
            syncToAckSumMs: 9007199254740991, syncToAckMaxMs: 9007199254740991,
            pendingFramesMax: 9007199254740991, oldestFrameAgeMaxMs: 0, blockedSamples: 1
        }));
    });
});

describe('Guacamole.Client optional pipeline diagnostics', function() {
    var client, tunnel, display, callbacks, time;
    beforeEach(function() {
        time = 100;
        spyOn(window.performance, 'now').and.callFake(function() { return time; });
        callbacks = [];
        display = {
            flush: function(callback) { callbacks.push(callback); },
            cancel: jasmine.createSpy('cancel'),
            getQueueStatistics: jasmine.createSpy('queue').and.returnValue({
                pendingFrames: 1, oldestFrameAge: 5, blocked: true
            })
        };
        spyOn(Guacamole, 'Display').and.returnValue(display);
        tunnel = new Guacamole.Tunnel();
        tunnel.sendMessage = jasmine.createSpy('sendMessage');
        client = new Guacamole.Client(tunnel);
    });
    it('collects nothing and reads no diagnostic clock or queue on default path', function() {
        tunnel.oninstruction('sync', ['123', '1']);
        callbacks.shift()();
        expect(client.getPipelineStatistics()).toBeNull();
        expect(display.getQueueStatistics).not.toHaveBeenCalled();
        expect(window.performance.now).not.toHaveBeenCalled();
        expect(tunnel.sendMessage).toHaveBeenCalledWith('sync', 123);
    });
    it('retains ACK order and cancels pending samples when disabled', function() {
        expect(client.setPipelineDiagnosticsEnabled(true)).toBe(true);
        tunnel.oninstruction('sync', ['123', '1']);
        time = 130;
        callbacks.shift()();
        expect(client.getPipelineStatistics()).toEqual(jasmine.objectContaining({
            syncReceived: 1, ackAttempted: 1, syncToAckSumMs: 30, inFlight: 0
        }));
        tunnel.oninstruction('sync', ['124', '1']);
        expect(client.setPipelineDiagnosticsEnabled(false)).toBe(false);
        callbacks.shift()();
        expect(client.getPipelineStatistics()).toBeNull();
        expect(tunnel.sendMessage.calls.allArgs()).toEqual([['sync', 123], ['sync', 124]]);
        client.setPipelineDiagnosticsEnabled(true);
        expect(client.getPipelineStatistics().syncReceived).toBe(0);
    });
    it('cancels pending timing when imported state replaces queued display frames', function() {
        client.setPipelineDiagnosticsEnabled(true);
        tunnel.oninstruction('sync', ['123', '1']);
        expect(client.getPipelineStatistics().inFlight).toBe(1);
        client.importState({currentState: Guacamole.Client.State.IDLE,
            currentTimestamp: 0, layers: {}});
        callbacks = []; // Real Display.cancel discards these old frame callbacks.
        expect(display.cancel).toHaveBeenCalled();
        expect(client.getPipelineStatistics()).toEqual(jasmine.objectContaining({
            canceledSync: 1, inFlight: 0, completedSync: 0
        }));
        time = 200;
        tunnel.oninstruction('sync', ['124', '1']);
        time = 210;
        callbacks.shift()();
        expect(client.getPipelineStatistics()).toEqual(jasmine.objectContaining({
            syncReceived: 2, canceledSync: 1, completedSync: 1, ackAttempted: 1,
            syncToAckSumMs: 10, syncGapMaxMs: 0, inFlight: 0
        }));
    });
    it('works with custom bundles which omit the optional helper', function() {
        var original = Guacamole.PipelineDiagnostics;
        Guacamole.PipelineDiagnostics = undefined;
        try {
            expect(client.setPipelineDiagnosticsEnabled(true)).toBe(false);
            tunnel.oninstruction('sync', ['123', '1']);
            callbacks.shift()();
            expect(tunnel.sendMessage).toHaveBeenCalledWith('sync', 123);
        }
        finally { Guacamole.PipelineDiagnostics = original; }
    });
});
