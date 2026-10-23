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

describe('Guacamole.ClientPerformance', function() {
    var time, display, tunnel, instruction, monitor;

    beforeEach(function() {
        time = 0;
        spyOn(window.performance, 'now').and.callFake(function() { return time; });
        display = {
            statisticWindow: 0,
            onstatistics: jasmine.createSpy('existingStatistics'),
            getWidth: function() { return 3840; },
            getHeight: function() { return 2160; }
        };
        tunnel = new Guacamole.Tunnel();
        instruction = tunnel.oninstruction = jasmine.createSpy('instruction');
        monitor = new Guacamole.ClientPerformance(display, tunnel);
    });

    afterEach(function() { monitor.stop(); });

    it('forwards instructions unchanged while collection is disabled', function() {
        tunnel.oninstruction('blob', ['1', 'AQID']);
        expect(instruction).toHaveBeenCalledWith('blob', ['1', 'AQID']);
        time = 1000;
        expect(monitor.sample().kibPerSecond).toBe(0);
        expect(display.statisticWindow).toBe(0);
    });

    it('counts protocol text without retaining or changing instructions', function() {
        monitor.start();
        tunnel.oninstruction('blob', ['1', 'AQID']);
        time = 1000;
        expect(monitor.sample().kibPerSecond).toBe('4.blob,1.1,4.AQID;'.length / 1024);
        expect(instruction).toHaveBeenCalledTimes(1);
        time = 2000;
        expect(monitor.sample().kibPerSecond).toBe(0);
    });

    it('counts Unicode protocol text as UTF-8 with codepoint length prefixes', function() {
        monitor.start();
        tunnel.oninstruction('name', ['é😀']);
        time = 1000;
        expect(monitor.sample().kibPerSecond).toBe(new TextEncoder().encode('4.name,2.é😀;').length / 1024);
    });

    it('samples rendering statistics without interfering with existing observers', function() {
        var observer = display.onstatistics;
        tunnel.setState(Guacamole.Tunnel.State.OPEN);
        monitor.start();
        var stats = {clientFps: 30, desktopFps: 60, processingLag: 4};
        display.onstatistics(stats);
        time = 1000;
        expect(observer).toHaveBeenCalledWith(stats);
        expect(monitor.sample()).toEqual(jasmine.objectContaining({
            clientFps: 30, desktopFps: 60, processingLag: 4, width: 3840, height: 2160
        }));
        time = 2000;
        expect(monitor.sample().clientFps).toBeNull();
    });

    it('restores collection settings and discards counters when disabled', function() {
        var observer = display.onstatistics;
        display.statisticWindow = 2500;
        monitor.start();
        tunnel.oninstruction('sync', ['1']);
        monitor.stop();
        expect(display.onstatistics).toBe(observer);
        expect(display.statisticWindow).toBe(2500);
        time = 1000;
        monitor.start();
        time = 2000;
        expect(monitor.sample().kibPerSecond).toBe(0);
    });

    it('samples queue and recovery counters only while enabled and connected', function() {
        display.getQueueStatistics = jasmine.createSpy('queue').and.returnValue({
            pendingFrames: 2, oldestFrameAge: 30, blocked: true
        });
        var recovery = jasmine.createSpy('recovery').and.returnValue({ imageFailures: 1, refreshRequests: 1 });
        monitor = new Guacamole.ClientPerformance(display, tunnel, recovery);
        monitor.sample();
        expect(display.getQueueStatistics).not.toHaveBeenCalled();
        expect(recovery).not.toHaveBeenCalled();
        tunnel.setState(Guacamole.Tunnel.State.OPEN);
        monitor.start();
        expect(monitor.sample()).toEqual(jasmine.objectContaining({
            pendingFrames: 2, oldestFrameAge: 30, blocked: true, imageFailures: 1, refreshRequests: 1
        }));
        expect(display.getQueueStatistics).toHaveBeenCalledTimes(1);
        monitor.stop(); monitor.sample();
        expect(display.getQueueStatistics).toHaveBeenCalledTimes(1);
        expect(recovery).toHaveBeenCalledTimes(1);
    });
    it('does not overwrite a statistics handler replaced by another consumer', function() {
        monitor.start();
        var replacement = display.onstatistics = jasmine.createSpy('replacement');
        monitor.stop();
        expect(display.onstatistics).toBe(replacement);
    });

    it('handles zero-duration samples and repeated start calls', function() {
        monitor.start();
        monitor.start();
        tunnel.oninstruction('sync', ['1']);
        expect(monitor.sample().kibPerSecond).toBe(0);
        time = 1000;
        expect(monitor.sample().kibPerSecond).toBe('4.sync,1.1;'.length / 1024);
        monitor.stop();
        expect(display.statisticWindow).toBe(0);
    });
    it('collects AVC stage averages only while the optional overlay is enabled and connected', function() {
        var diagnosticClient = {
            getPipelineStatistics: jasmine.createSpy('pipeline').and.returnValue(null),
            setPipelineDiagnosticsEnabled: jasmine.createSpy('enable').and.returnValue(true),
            getVideoStatistics: jasmine.createSpy('video').and.returnValue({ codec: 'avc420', timing: {
                assemblyCount: 2, assemblySumMs: 20, assemblyMaxMs: 15,
                encodedQueueCount: 2, encodedQueueSumMs: 60, encodedQueueMaxMs: 40,
                decodeOutputCount: 2, decodeOutputSumMs: 100, decodeOutputMaxMs: 70,
                orderedDisplayCount: 2, orderedDisplaySumMs: 10, orderedDisplayMaxMs: 6,
                unexpectedPrivateField: 'never copied'
            } })
        };
        monitor = new Guacamole.ClientPerformance(display, tunnel, null, diagnosticClient);
        expect(monitor.sample().videoTiming).toBeNull();
        expect(diagnosticClient.getVideoStatistics).not.toHaveBeenCalled();
        monitor.start(); monitor.start();
        expect(diagnosticClient.setPipelineDiagnosticsEnabled).toHaveBeenCalledOnceWith(true);
        expect(monitor.sample().videoTiming).toBeNull();
        tunnel.setState(Guacamole.Tunnel.State.OPEN);
        expect(monitor.sample().videoTiming).toEqual({
            assemblyAverageMs: 10, assemblyMaxMs: 15,
            encodedQueueAverageMs: 30, encodedQueueMaxMs: 40,
            decodeOutputAverageMs: 50, decodeOutputMaxMs: 70,
            orderedDisplayAverageMs: 5, orderedDisplayMaxMs: 6
        });
        monitor.stop(); monitor.stop();
        expect(diagnosticClient.setPipelineDiagnosticsEnabled.calls.allArgs()).toEqual([[true], [false]]);
        diagnosticClient.getVideoStatistics.calls.reset();
        expect(monitor.sample().videoTiming).toBeNull();
        expect(diagnosticClient.getVideoStatistics).not.toHaveBeenCalled();
    });
    it('preserves pipeline diagnostics independently enabled by an embedded application', function() {
        var diagnosticClient = {
            getPipelineStatistics: function() { return {}; },
            setPipelineDiagnosticsEnabled: jasmine.createSpy('enable')
        };
        monitor = new Guacamole.ClientPerformance(display, tunnel, null, diagnosticClient);
        monitor.start(); monitor.stop();
        expect(diagnosticClient.setPipelineDiagnosticsEnabled).not.toHaveBeenCalled();
    });
    it('ignores absent custom-bundle methods and unavailable or invalid stage samples', function() {
        var diagnosticClient = {};
        monitor = new Guacamole.ClientPerformance(display, tunnel, null, diagnosticClient);
        tunnel.setState(Guacamole.Tunnel.State.OPEN);
        monitor.start();
        expect(monitor.sample().videoTiming).toBeNull();
        diagnosticClient.getVideoStatistics = function() { return { codec: 'avc444', timing: {} }; };
        expect(monitor.sample().videoTiming).toBeNull();
        diagnosticClient.getVideoStatistics = function() { return { codec: 'avc420', timing: {
            assemblyCount: 0, assemblySumMs: 0, assemblyMaxMs: 0,
            encodedQueueCount: 1, encodedQueueSumMs: NaN, encodedQueueMaxMs: 1,
            decodeOutputCount: 1, decodeOutputSumMs: 1, decodeOutputMaxMs: Infinity,
            orderedDisplayCount: 1, orderedDisplaySumMs: -1, orderedDisplayMaxMs: 1
        } }; };
        var timing = monitor.sample().videoTiming;
        Object.keys(timing).forEach(function(key) { expect(timing[key]).toBeNull(); });
    });

});

describe('Guacamole.Tunnel transport diagnostics', function() {
    it('identifies concrete transports', function() {
        expect(new Guacamole.Tunnel().getTransport()).toBeNull();
        expect(new Guacamole.HTTPTunnel('tunnel').getTransport()).toBe('http');
        expect(new Guacamole.WebSocketTunnel('websocket-tunnel').getTransport()).toBe('websocket');
    });

    it('reports the committed HTTP fallback rather than the failed WebSocket', function() {
        var first = new Guacamole.Tunnel();
        first.getTransport = function() { return 'websocket'; };
        first.connect = function() {
            first.onerror(new Guacamole.Status(Guacamole.Status.Code.SERVER_ERROR));
        };
        var fallback = new Guacamole.Tunnel();
        fallback.getTransport = function() { return 'http'; };
        fallback.connect = function() {
            fallback.setState(Guacamole.Tunnel.State.OPEN);
            fallback.oninstruction('sync', ['1']);
        };
        var chained = new Guacamole.ChainedTunnel(first, fallback);
        chained.oninstruction = jasmine.createSpy('instruction');
        expect(chained.getTransport()).toBeNull();
        expect(chained.isConnected()).toBe(false);
        chained.connect('');
        expect(chained.getTransport()).toBe('http');
        expect(chained.isConnected()).toBe(true);
        expect(chained.oninstruction).toHaveBeenCalledWith('sync', ['1']);
        fallback.setState(Guacamole.Tunnel.State.CLOSED);
        expect(chained.isConnected()).toBe(false);
    });

});
