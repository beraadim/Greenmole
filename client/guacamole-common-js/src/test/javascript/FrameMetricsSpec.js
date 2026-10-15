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

describe('Guacamole.FrameMetrics', function() {
    var metrics;
    beforeEach(function() { metrics = new Guacamole.FrameMetrics(); });

    it('counts image streams separately from file and audio payloads', function() {
        metrics.receive('img', ['1', '14', '0', 'image/png', '0', '0'], 40, 0);
        metrics.receive('blob', ['1', 'AQID'], 18, 1);
        metrics.receive('blob', ['9', 'AQIDBA=='], 22, 2);
        metrics.receive('end', ['1'], 10, 3);
        metrics.receive('blob', ['1', 'AQID'], 18, 4);
        metrics.receive('sync', ['10', '2'], 17, 10);
        var value = metrics.sample(10);
        expect(value.tilesPerFrame).toBe(1);
        expect(value.imageKiBPerFrame).toBe(3 / 1024);
        expect(value.protocolKiBPerFrame).toBe(125 / 1024);
        expect(value.sourceFramesPerFrame).toBe(2);
    });

    it('counts base64 padding and legacy inline images', function() {
        metrics.receive('png', ['14', '0', '0', '0', 'AQ=='], 25, 0);
        metrics.receive('jpeg', ['14', '0', '0', '0', 'AQI='], 26, 1);
        metrics.receive('sync', ['1'], 10, 2);
        var value = metrics.sample(2);
        expect(value.tilesPerFrame).toBe(2);
        expect(value.imageKiBPerFrame).toBe(3 / 1024);
        expect(value.sourceFramesPerFrame).toBeNull();
    });

    it('keeps per-frame counts across sampling intervals', function() {
        metrics.receive('img', ['1'], 10, 0);
        metrics.sample(1);
        metrics.receive('blob', ['1', 'AQID'], 18, 2);
        metrics.receive('sync', ['1'], 10, 3);
        expect(metrics.sample(3).imageKiBPerFrame).toBe(3 / 1024);
        expect(metrics.sample(3).protocolKiBPerFrame).toBe(38 / 1024);
    });

    it('calculates frame-gap percentiles from monotonic arrivals', function() {
        [0, 10, 30, 60, 160].forEach(function(time) {
            metrics.receive('sync', ['1'], 10, time);
        });
        var value = metrics.sample(160);
        expect(value.syncGapP50).toBe(20);
        expect(value.syncGapP95).toBe(100);
    });

    it('bounds history to256 observations and five seconds', function() {
        for (var i = 0; i < 1000; i++)
            metrics.receive('sync', [String(i)], 10, i);
        expect(metrics.sample(1000).frameSamples).toBe(256);
        expect(metrics.sample(7000).frameSamples).toBe(0);
        expect(metrics.sample(7000).tilesPerFrame).toBeNull();
    });

    it('bounds tracked image streams even before their end instructions', function() {
        for (var i = 0; i < 300; i++)
            metrics.receive('img', [String(i)], 10, 0);
        metrics.receive('blob', ['299', 'AQID'], 18, 1);
        metrics.receive('blob', ['0', 'AQID'], 18, 2);
        metrics.receive('sync', ['1'], 10, 3);
        expect(metrics.sample(3).imageKiBPerFrame).toBe(3 / 1024);
    });

    it('reports processing p95 without retaining invalid or stale samples', function() {
        [1, 2, 3, 20].forEach(function(lag, i) { metrics.rendered(lag, i); });
        metrics.rendered(NaN, 5);
        metrics.rendered(Infinity, 5);
        metrics.rendered(-1, 5);
        expect(metrics.sample(10).processingP95).toBe(20);
        expect(metrics.sample(6000).processingP95).toBeNull();
    });

    it('reset discards frame and stream measurements', function() {
        metrics.receive('img', ['1'], 10, 0);
        metrics.receive('sync', ['1', '3'], 10, 1);
        metrics.rendered(10, 2);
        metrics.reset();
        metrics.receive('blob', ['1', 'AQID'], 18, 3);
        metrics.receive('sync', ['2'], 10, 4);
        var value = metrics.sample(4);
        expect(value.tilesPerFrame).toBe(0);
        expect(value.imageKiBPerFrame).toBe(0);
        expect(value.syncGapP95).toBeNull();
        expect(value.processingP95).toBeNull();
        expect(value.sourceFramesPerFrame).toBeNull();
    });
});
