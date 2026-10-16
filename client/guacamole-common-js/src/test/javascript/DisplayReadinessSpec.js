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

/* global Guacamole, expect, jasmine */

describe('Guacamole.Display multi-image frame readiness', function() {

    var display, layer, images, drawn, acknowledged, originalImage;

    function queueImages(frame, count) {
        var queued = [];
        for (var i = 0; i < count; i++) {
            display.draw(layer, i, frame, 'data:deferred');
            queued.push(images[images.length - 1]);
        }
        return queued;
    }

    function flush(frame) {
        display.flush(function() { acknowledged.push(frame); });
    }

    function expected(frame, count) {
        return Array.from({ length: count }, function(value, index) {
            return [index, frame];
        });
    }

    beforeEach(function() {
        originalImage = window.Image;
        images = [];
        drawn = [];
        acknowledged = [];
        window.Image = function Image() {
            this.width = this.height = 1;
            images.push(this);
        };
        display = new Guacamole.Display();
        layer = { drawImage: function(x, y) { drawn.push([x, y]); } };
    });

    afterEach(function() {
        display.cancel();
        window.Image = originalImage;
    });

    it('waits for every sequential image and acknowledges the complete frame once', function() {
        var queued = queueImages(0, 256);
        var callbacks = queued.map(function(image) { return image.onload; });
        flush(0);
        for (var i = 0; i < queued.length - 1; i++) {
            callbacks[i]();
            expect(display.getQueueStatistics().blocked).toBe(true);
        }
        expect(drawn).toEqual([]);
        expect(acknowledged).toEqual([]);
        callbacks[255]();
        expect(drawn).toEqual(expected(0, 256));
        expect(acknowledged).toEqual([0]);
        callbacks.forEach(function(callback) { callback(); });
        expect(acknowledged).toEqual([0]);
        expect(drawn.length).toBe(256);
    });

    it('keeps later completed frames behind an earlier unresolved image', function() {
        var first = queueImages(0, 64);
        flush(0);
        var later = queueImages(1, 32);
        flush(1);
        later.forEach(function(image) { image.onload(); });
        // An odd multiplier visits every index exactly once modulo 64.
        for (var i = 0; i < 64; i++) {
            var index = i * 29 % 64;
            if (index !== 23)
                first[index].onload();
        }
        expect(drawn).toEqual([]);
        expect(acknowledged).toEqual([]);
        expect(display.getQueueStatistics().blocked).toBe(true);
        first[23].onload();
        expect(drawn).toEqual(expected(0, 64).concat(expected(1, 32)));
        expect(acknowledged).toEqual([0, 1]);
    });

    it('accepts images unblocked before flush and resumes after a ready prefix', function() {
        var queued = queueImages(0, 48);
        for (var i = 0; i < 30; i++)
            queued[i].onload();
        flush(0);
        for (var j = 47; j > 30; j--)
            queued[j].onload();
        expect(drawn).toEqual([]);
        expect(acknowledged).toEqual([]);
        queued[30].onload();
        expect(drawn).toEqual(expected(0, 48));
        expect(acknowledged).toEqual([0]);
    });

    it('does not reuse a cancelled prefix when late callbacks reach a fresh display queue', function() {
        var old = queueImages(0, 32);
        var stale = old.map(function(image) { return image.onload; });
        flush(0);
        for (var i = 0; i < 20; i++)
            stale[i]();
        display.cancel();
        var current = queueImages(1, 32);
        flush(1);
        for (var j = 0; j < 8; j++)
            current[j].onload();
        stale.forEach(function(callback) { callback(); });
        expect(drawn).toEqual([]);
        expect(acknowledged).toEqual([]);
        for (var k = 31; k >= 8; k--)
            current[k].onload();
        expect(drawn).toEqual(expected(1, 32));
        expect(acknowledged).toEqual([1]);
    });

    it('releases one failed image without skipping another unresolved task', function() {
        display.onimageerror = jasmine.createSpy('image error');
        var queued = queueImages(0, 32);
        flush(0);
        for (var i = 0; i < 32; i++) {
            if (i !== 9 && i !== 21)
                queued[i].onload();
        }
        queued[9].width = queued[9].height = 0;
        queued[9].onerror();
        expect(display.onimageerror).toHaveBeenCalledTimes(1);
        expect(acknowledged).toEqual([]);
        expect(drawn).toEqual([]);
        queued[21].onload();
        expect(drawn).toEqual(expected(0, 32).filter(function(value) { return value[0] !== 9; }));
        expect(acknowledged).toEqual([0]);
    });

    it('preserves cancellation during an atomic multi-image flush', function() {
        var queued = queueImages(0, 32);
        var callbacks = queued.map(function(image) { return image.onload; });
        flush(0);
        layer.drawImage = function(x, y) {
            drawn.push([x, y]);
            if (x === 11)
                display.cancel();
        };
        callbacks.forEach(function(callback) { callback(); });
        expect(drawn).toEqual(expected(0, 12));
        expect(acknowledged).toEqual([]);
        expect(display.getQueueStatistics().pendingFrames).toBe(0);
        layer.drawImage = function(x, y) { drawn.push([x, y]); };
        display.drawImage(layer, 0, 1, {});
        flush(1);
        expect(acknowledged).toEqual([1]);
        expect(drawn[drawn.length - 1]).toEqual([0, 1]);
    });

});
