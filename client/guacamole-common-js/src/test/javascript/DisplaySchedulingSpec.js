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

describe("Guacamole.Display catch-up scheduling", function() {

    var display;
    var layer;
    var images;
    var originalImage;
    var originalMessageChannel;
    var drawn;
    var acknowledged;

    function queueFrame(index, callback) {
        display.drawImage(layer, index, 0, {});
        display.flush(function acknowledge() {
            acknowledged.push(index);
            if (callback)
                callback();
        });
    }

    function queueBlockedFrames(count) {
        display.draw(layer, 0, 0, 'data:test');
        display.flush(function acknowledgeFirst() {
            acknowledged.push(0);
        });
        for (var i = 1; i < count; i++)
            queueFrame(i);
    }

    function indices(count) {
        return Array.from({ length: count }, function(value, index) {
            return index;
        });
    }

    beforeEach(function() {
        originalImage = window.Image;
        originalMessageChannel = window.MessageChannel;
        images = [];
        window.Image = function Image() {
            this.width = this.height = 1;
            images.push(this);
        };
        display = new Guacamole.Display();
        drawn = [];
        acknowledged = [];
        layer = { drawImage: function(x) { drawn.push(x); } };
    });

    afterEach(function() {
        display.cancel();
        window.Image = originalImage;
        window.MessageChannel = originalMessageChannel;
    });

    describe("with controlled clocks and continuations", function() {

        var originalTimeout;
        var originalClearTimeout;
        var timers;
        var nextTimer;
        var now;
        var wallTime;

        function continuations() {
            return Object.keys(timers).filter(function(id) {
                return timers[id].delay === 0;
            });
        }

        function continueRendering() {
            var id = continuations()[0];
            expect(id).toBeDefined();
            var callback = timers[id].callback;
            delete timers[id];
            callback();
        }

        beforeEach(function() {
            // Exercise the fallback independently of MessageChannel support.
            window.MessageChannel = undefined;
            originalTimeout = window.setTimeout;
            originalClearTimeout = window.clearTimeout;
            timers = {};
            nextTimer = 0;
            now = 0;
            wallTime = 1000;
            window.setTimeout = function(callback, delay) {
                var id = ++nextTimer;
                timers[id] = { callback: callback, delay: delay };
                return id;
            };
            window.clearTimeout = function(id) {
                delete timers[id];
            };
            spyOn(window.performance, 'now').and.callFake(function() { return now; });
            spyOn(Date.prototype, 'getTime').and.callFake(function() { return wallTime; });
        });

        afterEach(function() {
            display.cancel();
            window.setTimeout = originalTimeout;
            window.clearTimeout = originalClearTimeout;
        });

        it("renders an isolated ready frame immediately without scheduling a timer", function() {
            queueFrame(0);
            expect(drawn).toEqual([0]);
            expect(acknowledged).toEqual([0]);
            expect(continuations().length).toBe(0);
            expect(display.getQueueStatistics()).toEqual({
                pendingFrames: 0, oldestFrameAge: 0, blocked: false
            });
        });

        it("bounds work with a coarse clock and eventually draws and acknowledges every frame", function() {
            queueBlockedFrames(40);
            wallTime += 23;
            expect(display.getQueueStatistics()).toEqual({
                pendingFrames: 40, oldestFrameAge: 23, blocked: true
            });

            images[0].onload();
            expect(drawn).toEqual(indices(16));
            expect(acknowledged).toEqual(indices(16));
            expect(continuations().length).toBe(1);
            expect(display.getQueueStatistics()).toEqual({
                pendingFrames: 24, oldestFrameAge: 23, blocked: false
            });

            continueRendering();
            expect(drawn).toEqual(indices(32));
            expect(acknowledged).toEqual(indices(32));
            expect(continuations().length).toBe(1);
            continueRendering();
            expect(drawn).toEqual(indices(40));
            expect(acknowledged).toEqual(indices(40));
            expect(continuations().length).toBe(0);
        });

        it("yields after the time budget before the frame-count cap is reached", function() {
            layer.drawImage = function(x) {
                drawn.push(x);
                now += 3;
            };
            queueBlockedFrames(6);
            images[0].onload();
            expect(drawn).toEqual([0, 1, 2]);
            expect(acknowledged).toEqual([0, 1, 2]);
            expect(continuations().length).toBe(1);
            continueRendering();
            expect(drawn).toEqual(indices(6));
            expect(acknowledged).toEqual(indices(6));
        });

        it("finishes an atomic frame even when that frame alone exceeds the budget", function() {
            layer.drawImage = function(x) {
                drawn.push(x);
                now++;
            };
            display.draw(layer, 0, 0, 'data:test');
            for (var i = 1; i < 20; i++)
                display.drawImage(layer, i, 0, {});
            display.flush(function() { acknowledged.push('atomic'); });
            queueFrame(20);
            images[0].onload();
            expect(drawn).toEqual(indices(20));
            expect(acknowledged).toEqual(['atomic']);
            expect(continuations().length).toBe(1);
            continueRendering();
            expect(drawn).toEqual(indices(21));
            expect(acknowledged).toEqual(['atomic', 20]);
        });

        it("keeps new frames behind a scheduled continuation without adding duplicate timers", function() {
            queueBlockedFrames(20);
            images[0].onload();
            queueFrame(20);
            queueFrame(21);
            expect(drawn).toEqual(indices(16));
            expect(continuations().length).toBe(1);
            continueRendering();
            expect(drawn).toEqual(indices(22));
            expect(acknowledged).toEqual(indices(22));
        });

        it("does not replay or double-acknowledge frames when a callback flushes reentrantly", function() {
            queueFrame(0, function() {
                queueFrame(1);
                expect(drawn).toEqual([0]);
            });
            expect(drawn).toEqual([0, 1]);
            expect(acknowledged).toEqual([0, 1]);
            expect(continuations().length).toBe(0);
        });

        it("preserves order when rendering one frame unblocks a later decoder", function() {
            display.draw(layer, 0, 0, 'data:first');
            display.flush(function() { acknowledged.push(0); });
            display.draw(layer, 1, 0, 'data:second');
            display.flush(function() { acknowledged.push(1); });
            layer.drawImage = function(x) {
                drawn.push(x);
                if (x === 0)
                    images[1].onload();
            };
            images[0].onload();
            expect(drawn).toEqual([0, 1]);
            expect(acknowledged).toEqual([0, 1]);
        });

        it("waits for a later blocked frame without polling or reordering following frames", function() {
            display.draw(layer, 0, 0, 'data:first');
            display.flush(function() { acknowledged.push(0); });
            display.draw(layer, 1, 0, 'data:second');
            display.flush(function() { acknowledged.push(1); });
            queueFrame(2);
            images[0].onload();
            expect(drawn).toEqual([0]);
            expect(acknowledged).toEqual([0]);
            expect(continuations().length).toBe(0);
            expect(display.getQueueStatistics().blocked).toBe(true);
            images[1].onload();
            expect(drawn).toEqual([0, 1, 2]);
            expect(acknowledged).toEqual([0, 1, 2]);
        });

        it("cancels deferred rendering and acknowledgements and permits a fresh frame", function() {
            queueBlockedFrames(20);
            images[0].onload();
            display.cancel();
            expect(continuations().length).toBe(0);
            expect(drawn).toEqual(indices(16));
            expect(acknowledged).toEqual(indices(16));
            queueFrame(100);
            expect(drawn).toEqual(indices(16).concat([100]));
            expect(acknowledged).toEqual(indices(16).concat([100]));
        });

        it("ignores a stale timer after cancellation and keeps the new continuation", function() {
            queueBlockedFrames(20);
            images[0].onload();
            var stale = timers[continuations()[0]].callback;
            display.cancel();

            queueBlockedFrames(20);
            images[1].onload();
            expect(drawn.length).toBe(32);
            stale();
            expect(drawn.length).toBe(32);
            expect(continuations().length).toBe(1);
            continueRendering();
            expect(drawn.length).toBe(36);
            expect(acknowledged.length).toBe(36);
        });

        it("cancels remaining operations and the acknowledgement of an active frame", function() {
            display.drawImage(layer, 0, 0, {});
            display.drawImage(layer, 1, 0, {});
            layer.drawImage = function(x) {
                drawn.push(x);
                display.cancel();
            };
            display.flush(function() { acknowledged.push(0); });
            expect(drawn).toEqual([0]);
            expect(acknowledged).toEqual([]);
            expect(display.getQueueStatistics().pendingFrames).toBe(0);
        });

        it("does not replay partially executed frames after a drawing callback throws", function() {
            queueBlockedFrames(3);
            layer.drawImage = function(x) {
                drawn.push(x);
                if (x === 0)
                    throw new Error('drawing failed');
            };
            expect(function() { images[0].onload(); }).toThrowError('drawing failed');
            expect(drawn).toEqual([0]);
            expect(acknowledged).toEqual([]);
            expect(continuations().length).toBe(1);
            continueRendering();
            expect(drawn).toEqual([0, 1, 2]);
            expect(acknowledged).toEqual([1, 2]);
        });

        it("releases decoded images in the unexecuted tail of a failed frame", function() {
            var originalBitmap = window.createImageBitmap;
            var decoded = { close: jasmine.createSpy('close bitmap') };
            window.createImageBitmap = function() { return Promise.resolve(decoded); };
            display.drawImage(layer, 0, 0, {});
            display.drawBlob(layer, 1, 0, new Blob());
            layer.drawImage = function() { throw new Error('drawing failed'); };
            return Promise.resolve().then(function() {
                expect(function() { display.flush(); }).toThrowError('drawing failed');
                expect(decoded.close).toHaveBeenCalledTimes(1);
            }).finally(function() {
                window.createImageBitmap = originalBitmap;
            });
        });

        it("never reports a negative queue age after a wall-clock adjustment", function() {
            queueBlockedFrames(2);
            wallTime -= 100;
            expect(display.getQueueStatistics().oldestFrameAge).toBe(0);
        });

    });

    describe("with channel continuations", function() {

        var channels;
        var messages;

        function deliver(message) {
            message = message || messages.shift();
            message.handler({ data: message.token });
        }

        beforeEach(function() {
            channels = [];
            messages = [];
            spyOn(window.performance, 'now').and.returnValue(0);
            window.MessageChannel = function MessageChannel() {
                var channel = this;
                channel.port1 = {
                    onmessage: null,
                    close: jasmine.createSpy('close receiving port')
                };
                channel.port2 = {
                    postMessage: function(token) {
                        messages.push({
                            handler: channel.port1.onmessage,
                            token: token
                        });
                    },
                    close: jasmine.createSpy('close sending port')
                };
                channels.push(channel);
            };
        });

        it("uses one pending message and reuses one channel across catch-up slices", function() {
            spyOn(window, 'setTimeout').and.throwError('must use channel tasks');
            queueBlockedFrames(40);
            images[0].onload();
            queueFrame(40);
            expect(drawn).toEqual(indices(16));
            expect(channels.length).toBe(1);
            expect(messages.length).toBe(1);
            deliver();
            expect(drawn).toEqual(indices(32));
            expect(channels.length).toBe(1);
            expect(messages.length).toBe(1);
            deliver();
            expect(drawn).toEqual(indices(41));
            expect(acknowledged).toEqual(indices(41));
            expect(messages.length).toBe(0);
        });

        it("ignores duplicate or mismatched messages without releasing pending work", function() {
            queueBlockedFrames(40);
            images[0].onload();
            var first = messages.shift();
            first.handler({ data: first.token + 1 });
            expect(drawn.length).toBe(16);
            deliver(first);
            expect(drawn.length).toBe(32);
            deliver(first);
            expect(drawn.length).toBe(32);
            deliver();
            expect(drawn).toEqual(indices(40));
            expect(acknowledged).toEqual(indices(40));
        });

        it("closes both ports and ignores stale messages after reinitialization", function() {
            queueBlockedFrames(20);
            images[0].onload();
            var stale = messages.shift();
            var firstChannel = channels[0];
            display.cancel();
            expect(firstChannel.port1.close).toHaveBeenCalledTimes(1);
            expect(firstChannel.port2.close).toHaveBeenCalledTimes(1);
            expect(firstChannel.port1.onmessage).toBeNull();

            queueBlockedFrames(20);
            images[1].onload();
            expect(channels.length).toBe(2);
            expect(drawn.length).toBe(32);
            deliver(stale);
            expect(drawn.length).toBe(32);
            deliver();
            expect(drawn.length).toBe(36);
            expect(acknowledged.length).toBe(36);
        });

        it("falls back to a timer if channel construction fails", function() {
            var timers = [];
            window.MessageChannel = function() { throw new Error('unavailable'); };
            spyOn(window, 'setTimeout').and.callFake(function(callback, delay) {
                expect(delay).toBe(0);
                timers.push(callback);
                return timers.length;
            });
            queueBlockedFrames(20);
            images[0].onload();
            expect(drawn.length).toBe(16);
            expect(timers.length).toBe(1);
            timers.shift()();
            expect(drawn).toEqual(indices(20));
            expect(acknowledged).toEqual(indices(20));
        });

        it("closes failed channel ports before falling back to a timer", function() {
            var timers = [];
            var Channel = window.MessageChannel;
            window.MessageChannel = function() {
                var channel = new Channel();
                channel.port2.postMessage = function() { throw new Error('cannot post'); };
                return channel;
            };
            spyOn(window, 'setTimeout').and.callFake(function(callback) {
                timers.push(callback);
                return timers.length;
            });
            queueBlockedFrames(20);
            images[0].onload();
            expect(channels[0].port1.close).toHaveBeenCalledTimes(1);
            expect(channels[0].port2.close).toHaveBeenCalledTimes(1);
            expect(channels[0].port1.onmessage).toBeNull();
            expect(timers.length).toBe(1);
            timers.shift()();
            expect(drawn).toEqual(indices(20));
            expect(acknowledged).toEqual(indices(20));
        });

    });

    it("lets another browser task run between catch-up slices without animation frames", function() {
        spyOn(window, 'requestAnimationFrame').and.throwError('must not require animation frames');
        var framesSeenByInput = null;
        return new Promise(function(resolve) {
            queueBlockedFrames(39);
            queueFrame(39, resolve);
            window.setTimeout(function handleInput() {
                framesSeenByInput = drawn.length;
            }, 0);
            images[0].onload();
            expect(drawn.length).toBeLessThan(40);
        }).then(function() {
            expect(framesSeenByInput).toBeGreaterThan(0);
            expect(framesSeenByInput).toBeLessThan(40);
            expect(drawn).toEqual(indices(40));
            expect(acknowledged).toEqual(indices(40));
        });
    });

});
