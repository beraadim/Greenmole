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

describe('Guacamole local video timing aggregates', function() {
    it('clamps bad clocks, bounds numeric totals and ignores stale or repeated samples', function() {
        var time = 0;
        var clock = spyOn(window.performance, 'now').and.callFake(function() { return time; });
        var diagnostics = new Guacamole.VideoPipelineDiagnostics();
        expect(clock).not.toHaveBeenCalled();
        var sample = diagnostics.begin();
        time = -100; diagnostics.complete('assembly', sample);
        diagnostics.complete('assembly', sample);
        time = NaN; sample = diagnostics.begin();
        time = Infinity; diagnostics.complete('decodeOutput', sample);
        time = 0; sample = diagnostics.begin();
        time = 1e100; diagnostics.complete('encodedQueue', sample);
        time = 0; sample = diagnostics.begin();
        time = 20; diagnostics.complete('encodedQueue', sample);
        sample = diagnostics.begin(); diagnostics.cancel();
        time = 40; diagnostics.complete('orderedDisplay', sample);
        diagnostics.complete('untrusted-stage', diagnostics.begin());
        diagnostics.sampleQueue(-1, Infinity, 1e100, NaN);
        var stats = diagnostics.getStatistics();
        expect(stats).toEqual(jasmine.objectContaining({
            assemblyCount: 1, assemblySumMs: 0, assemblyMaxMs: 0,
            decodeOutputCount: 1, decodeOutputSumMs: 0, decodeOutputMaxMs: 0,
            encodedQueueCount: 2, encodedQueueSumMs: 9007199254740991,
            encodedQueueMaxMs: 9007199254740991,
            orderedDisplayCount: 0, pendingFrames: 0, pendingBytes: 0,
            encodedQueueFrames: 9007199254740991, submittedFrames: 0
        }));
        expect(Object.keys(stats).length).toBe(22);
        Object.keys(stats).forEach(function(name) {
            expect(typeof stats[name]).toBe('number');
            expect(isFinite(stats[name])).toBe(true);
            expect(stats[name]).toBeGreaterThanOrEqual(0);
        });
        stats.encodedQueueCount = 999;
        expect(diagnostics.getStatistics().encodedQueueCount).toBe(2);
    });
});
