/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to you under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with the
 * License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* global Guacamole, jasmine, expect */
describe('Guacamole.Client optional video timing integration', function() {
    var client, tunnel, players;

    function open(index, instrumented) {
        var collecting = false;
        var player = { dispose: jasmine.createSpy('dispose') };
        if (instrumented !== false) {
            player.setDiagnosticsEnabled = jasmine.createSpy('setDiagnosticsEnabled')
                .and.callFake(function(enabled) { collecting = enabled; return enabled; });
            player.getDiagnostics = jasmine.createSpy('getDiagnostics').and.callFake(function() {
                return collecting ? { assembledFrames: 2, assemblyCount: 2,
                    assemblySumMs: 20, assemblyMaxMs: 15 } : null;
            });
        }
        client.onvideo = function(stream) {
            stream.onend = function() { player.dispose(false); };
            return player;
        };
        tunnel.oninstruction('video', [String(index), '0', Guacamole.AVC420VideoPlayer.MIMETYPE]);
        players.push(player);
        return player;
    }

    beforeEach(function() {
        players = [];
        tunnel = new Guacamole.Tunnel();
        tunnel.sendMessage = jasmine.createSpy('sendMessage');
        tunnel.connect = function() { tunnel.setState(Guacamole.Tunnel.State.OPEN); };
        tunnel.disconnect = function() {};
        client = new Guacamole.Client(tunnel);
        client.setExperimentalAvc420Enabled(true);
        client.connect('');
        tunnel.sendMessage.calls.reset(); // Exclude the existing initial keep-alive nop.
    });
    afterEach(function() { client.disconnect(); });

    it('does not read a video snapshot by default or alter the existing ready ACK', function() {
        var player = open(1);
        expect(player.setDiagnosticsEnabled).toHaveBeenCalledOnceWith(false);
        expect(client.getVideoStatistics().timing).toBeNull();
        expect(player.getDiagnostics).not.toHaveBeenCalled();
        expect(tunnel.sendMessage).toHaveBeenCalledOnceWith('ack', 1, 'AVC420:ready', 0);
    });

    it('toggles current players and exposes timing only while the local opt-in is enabled', function() {
        var player = open(1);
        expect(client.setPipelineDiagnosticsEnabled(true)).toBe(true);
        expect(player.setDiagnosticsEnabled).toHaveBeenCalledWith(true);
        expect(client.getVideoStatistics().timing).toEqual({ assembledFrames: 2,
            assemblyCount: 2, assemblySumMs: 20, assemblyMaxMs: 15 });
        client.setPipelineDiagnosticsEnabled(false);
        player.getDiagnostics.calls.reset();
        expect(client.getVideoStatistics().timing).toBeNull();
        expect(player.setDiagnosticsEnabled).toHaveBeenCalledWith(false);
        expect(player.getDiagnostics).not.toHaveBeenCalled();
    });

    it('makes later streams inherit an enabled collector without changing protocol ACKs', function() {
        client.setPipelineDiagnosticsEnabled(true);
        var first = open(1);
        var second = open(2);
        expect(first.setDiagnosticsEnabled).toHaveBeenCalledOnceWith(true);
        expect(second.setDiagnosticsEnabled).toHaveBeenCalledOnceWith(true);
        expect(client.getVideoStatistics().timing.assemblyCount).toBe(2);
        expect(tunnel.sendMessage.calls.allArgs()).toEqual([
            ['ack', 1, 'AVC420:ready', 0], ['ack', 2, 'AVC420:ready', 0]
        ]);
    });

    it('retains only the latest ended stream snapshot and disables its collector on toggle', function() {
        client.setPipelineDiagnosticsEnabled(true);
        var player = open(1);
        tunnel.oninstruction('end', ['1']);
        expect(player.dispose).toHaveBeenCalledOnceWith(false);
        expect(client.getVideoStatistics().timing.assembledFrames).toBe(2);
        client.setPipelineDiagnosticsEnabled(false);
        expect(player.setDiagnosticsEnabled).toHaveBeenCalledWith(false);
        expect(client.getVideoStatistics().timing).toBeNull();
    });

    ['disconnect', 'connect', 'importState'].forEach(function(action) {
        it('releases previous video timing when ' + action + ' resets the connection', function() {
            client.setPipelineDiagnosticsEnabled(true);
            var player = open(1);
            if (action === 'importState')
                client.importState({ currentState: Guacamole.Client.State.IDLE,
                    currentTimestamp: 0, layers: {} });
            else client[action]('');
            expect(client.getVideoStatistics().timing).toBeNull();
            expect(player.setDiagnosticsEnabled).toHaveBeenCalledWith(false);
            var next = open(2);
            expect(next.setDiagnosticsEnabled).toHaveBeenCalledOnceWith(true);
            expect(client.getVideoStatistics().timing.assemblyCount).toBe(2);
        });
    });

    it('keeps custom players without diagnostic methods compatible', function() {
        open(1, false);
        expect(client.setPipelineDiagnosticsEnabled(true)).toBe(true);
        expect(client.getVideoStatistics().timing).toBeNull();
        expect(client.setPipelineDiagnosticsEnabled(false)).toBe(false);
        expect(tunnel.sendMessage).toHaveBeenCalledOnceWith('ack', 1, 'AVC420:ready', 0);
    });

    it('does not enable video collection when an old bundle omits the optional helper', function() {
        var helper = Guacamole.PipelineDiagnostics;
        Guacamole.PipelineDiagnostics = undefined;
        try {
            var player = open(1);
            expect(client.setPipelineDiagnosticsEnabled(true)).toBe(false);
            expect(player.setDiagnosticsEnabled).not.toHaveBeenCalledWith(true);
            expect(client.getVideoStatistics().timing).toBeNull();
        }
        finally { Guacamole.PipelineDiagnostics = helper; }
    });
});
