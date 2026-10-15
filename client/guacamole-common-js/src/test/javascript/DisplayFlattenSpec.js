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

/* global Guacamole, expect, spyOn */

describe("Guacamole.Display flattened thumbnails", function() {

    var display;
    var root;

    function paint(layer, color) {
        var context = layer.getCanvas().getContext("2d");
        context.fillStyle = color;
        context.fillRect(0, 0, layer.width, layer.height);
    }

    function layer(width, height, parent, x, y, z, color) {
        var child = new Guacamole.Display.VisibleLayer(width, height);
        child.move(parent, x, y, z);
        paint(child, color);
        return child;
    }

    function pixel(canvas, x, y) {
        return Array.prototype.slice.call(canvas.getContext("2d")
                .getImageData(x, y, 1, 1).data);
    }

    beforeEach(function() {
        display = new Guacamole.Display();
        root = display.getDefaultLayer();
        root.resize(40, 40);
        paint(root, "black");
    });

    it("retains full resolution when no scale is supplied", function() {
        paint(root, "red");
        var canvas = display.flatten();
        expect(canvas.width).toBe(40);
        expect(canvas.height).toBe(40);
        expect(pixel(canvas, 30, 30)).toEqual([255, 0, 0, 255]);
    });

    it("composites directly into the requested canvas size", function() {
        root.resize(1920, 1080);
        paint(root, "red");
        var created = [];
        var createElement = document.createElement.bind(document);
        spyOn(document, "createElement").and.callFake(function(tag) {
            var element = createElement(tag);
            if (tag === "canvas")
                created.push(element);
            return element;
        });

        var canvas = display.flatten(1 / 6);
        expect(canvas.width).toBe(320);
        expect(canvas.height).toBe(180);
        expect(created.length).toBe(1);
        expect(pixel(canvas, 100, 100)).toEqual([255, 0, 0, 255]);
    });

    it("retains nested CSS transforms while downscaling", function() {
        var parent = layer(10, 10, root, 10, 10, 0, "red");
        parent.distort(2, 0, 0, 2, 0, 0);
        layer(4, 4, parent, 3, 3, 0, "blue");

        var canvas = display.flatten(0.5);
        expect(pixel(canvas, 3, 3)).toEqual([255, 0, 0, 255]);
        expect(pixel(canvas, 6, 6)).toEqual([0, 0, 255, 255]);
        expect(pixel(canvas, 13, 13)).toEqual([0, 0, 0, 255]);
    });

    it("clips child layers to their parent's visible bounds", function() {
        var parent = layer(8, 8, root, 4, 4, 0, "red");
        layer(8, 8, parent, 6, 0, 0, "blue");

        var canvas = display.flatten(0.5);
        expect(pixel(canvas, 3, 3)).toEqual([255, 0, 0, 255]);
        expect(pixel(canvas, 5, 3)).toEqual([0, 0, 255, 255]);
        expect(pixel(canvas, 6, 3)).toEqual([0, 0, 0, 255]);
    });

    it("applies parent opacity once to overlapping descendants", function() {
        paint(root, "white");
        var parent = layer(16, 16, root, 4, 4, 0, "red");
        parent.shade(128);
        layer(8, 8, parent, 4, 4, 0, "blue");

        var canvas = display.flatten(0.5);
        // Canvas implementations may round the 128/255 opacity differently.
        [[3, 3, [255, 127, 127, 255]], [5, 5, [127, 127, 255, 255]]]
            .forEach(function(sample) {
                var actual = pixel(canvas, sample[0], sample[1]);
                sample[2].forEach(function(expected, channel) {
                    expect(Math.abs(actual[channel] - expected))
                            .toBeLessThanOrEqual(1);
                });
            });
    });

    it("bounds opacity group allocations to thumbnail resolution", function() {
        root.resize(1920, 1080);
        var parent = layer(1920, 1080, root, 0, 0, 0, "red");
        parent.shade(128);
        layer(100, 100, parent, 0, 0, 0, "blue");

        var created = [];
        var createElement = document.createElement.bind(document);
        spyOn(document, "createElement").and.callFake(function(tag) {
            var element = createElement(tag);
            if (tag === "canvas")
                created.push(element);
            return element;
        });

        display.flatten(1 / 6);
        expect(created.length).toBe(2);
        created.forEach(function(canvas) {
            expect(canvas.width).toBe(320);
            expect(canvas.height).toBe(180);
        });
    });

    it("preserves negative Z order and DOM order for equal Z", function() {
        paint(root, "red");
        layer(40, 40, root, 0, 0, -1, "blue");
        layer(20, 20, root, 0, 0, 0, "green");
        layer(10, 10, root, 0, 0, 0, "yellow");

        var canvas = display.flatten(0.5);
        expect(pixel(canvas, 15, 15)).toEqual([255, 0, 0, 255]);
        expect(pixel(canvas, 7, 7)).toEqual([0, 128, 0, 255]);
        expect(pixel(canvas, 2, 2)).toEqual([255, 255, 0, 255]);
    });

    it("keeps extremely narrow thumbnails at least one pixel wide", function() {
        root.resize(1, 1000);
        var canvas = display.flatten(0.24);
        expect(canvas.width).toBe(1);
        expect(canvas.height).toBe(240);
    });

    it("allows an empty display without drawing zero-size images", function() {
        root.resize(0, 0);
        var canvas = display.flatten(0.5);
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
    });

    it("rejects invalid scales", function() {
        [0, -1, Infinity, NaN].forEach(function(scale) {
            expect(function() {
                display.flatten(scale);
            }).toThrowError(RangeError);
        });
    });

});
