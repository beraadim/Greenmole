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

var Guacamole = Guacamole || {};

/**
 * Optional local-only, fixed-size AVC presentation timing aggregates. Durations
 * use one local clock; neither remote clocks, image data nor timestamp histories
 * are retained. Construct only when explicitly enabled by the local client.
 *
 * @constructor
 */
Guacamole.VideoPipelineDiagnostics = function VideoPipelineDiagnostics() {
    var generation = {};
    var limit = 9007199254740991;
    var stages = ['assembly', 'encodedQueue', 'decodeOutput', 'orderedDisplay'];
    var gauges = ['pendingFrames', 'pendingBytes', 'encodedQueueFrames', 'submittedFrames'];
    var values = { assembledFrames: 0, presentedFrames: 0 };
    stages.forEach(function(stage) {
        values[stage + 'Count'] = values[stage + 'SumMs'] = values[stage + 'MaxMs'] = 0;
    });
    gauges.forEach(function(name) { values[name] = values[name + 'Max'] = 0; });

    function number(value) {
        return typeof value === 'number' && isFinite(value) && value > 0
                ? Math.min(limit, value) : 0;
    }
    function now() {
        return window.performance && typeof window.performance.now === 'function'
                ? window.performance.now() : new Date().getTime();
    }
    function add(name, value) { values[name] = Math.min(limit, values[name] + number(value)); }

    /** Begins a measurement belonging only to this collection generation. */
    this.begin = function begin() { return { generation: generation, start: now() }; };

    /** Finishes a known stage once, clamping invalid or backwards elapsed time. */
    this.complete = function complete(stage, sample) {
        if (stages.indexOf(stage) === -1 || !sample || sample.complete
                || sample.generation !== generation) return;
        sample.complete = true;
        var duration = number(now() - sample.start);
        add(stage + 'Count', 1);
        add(stage + 'SumMs', duration);
        values[stage + 'MaxMs'] = Math.max(values[stage + 'MaxMs'], duration);
        if (stage === 'assembly') add('assembledFrames', 1);
        if (stage === 'orderedDisplay') add('presentedFrames', 1);
    };

    /** Updates fixed queue gauges without reading a clock or retaining a queue. */
    this.sampleQueue = function sampleQueue(pendingFrames, pendingBytes, encodedQueueFrames, submittedFrames) {
        var input = [pendingFrames, pendingBytes, encodedQueueFrames, submittedFrames];
        gauges.forEach(function(name, index) {
            values[name] = number(input[index]);
            values[name + 'Max'] = Math.max(values[name + 'Max'], values[name]);
        });
    };

    /** Invalidates unfinished samples while retaining totals for failure diagnosis. */
    this.cancel = function cancel() { generation = {}; };

    /** Returns a new numeric-only snapshot; callers cannot mutate retained state. */
    this.getStatistics = function getStatistics() {
        var result = {};
        Object.keys(values).forEach(function(name) { result[name] = values[name]; });
        return result;
    };
};
