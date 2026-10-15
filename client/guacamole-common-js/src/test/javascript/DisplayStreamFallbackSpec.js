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

describe('Guacamole.Display streamed image fallback', function() {

    var display, layer, images, originalImage, originalDecoder;

    function end(stream, data) {
        stream.onblob(data || 'AAAA');
        stream.onend();
    }

    beforeEach(function() {
        display = new Guacamole.Display();
        display.onimageerror = jasmine.createSpy('image error');
        layer = { drawImage: jasmine.createSpy('drawImage') };
        images = [];
        originalImage = window.Image;
        originalDecoder = window.ImageDecoder;
        window.ImageDecoder = undefined;
        window.Image = function() {
            var image = { width: 1, height: 1 };
            images.push(image);
            return image;
        };
    });

    afterEach(function() {
        display.cancel();
        window.Image = originalImage;
        window.ImageDecoder = originalDecoder;
    });

    it('blocks a frame until its stream and image load complete', function() {
        var stream = {};
        var flushed = jasmine.createSpy('flushed');
        display.drawStream(layer, 1, 2, stream, 'image/png');
        display.flush(flushed);
        expect(flushed).not.toHaveBeenCalled();
        end(stream);
        expect(flushed).not.toHaveBeenCalled();
        expect(stream.onblob).toBeNull();
        expect(stream.onend).toBeNull();
        images[0].onload();
        expect(layer.drawImage).toHaveBeenCalledOnceWith(1, 2, images[0]);
        expect(flushed).toHaveBeenCalledTimes(1);
        expect(images[0].onload).toBeNull();
        expect(images[0].onerror).toBeNull();
    });

    it('preserves drawing order when interleaved streams complete in reverse order', function() {
        var first = {}, second = {}, middle = {};
        var flushed = jasmine.createSpy('flushed');
        display.drawStream(layer, 1, 2, first, 'image/png');
        display.drawImage(layer, 3, 4, middle);
        display.drawStream(layer, 5, 6, second, 'image/png');
        display.flush(flushed);
        end(second);
        var secondImage = images[0];
        secondImage.onload();
        expect(layer.drawImage).not.toHaveBeenCalled();
        expect(flushed).not.toHaveBeenCalled();
        end(first);
        var firstImage = images[1];
        firstImage.onload();
        expect(layer.drawImage.calls.allArgs()).toEqual([
            [1, 2, firstImage], [3, 4, middle], [5, 6, secondImage]
        ]);
        expect(flushed).toHaveBeenCalledTimes(1);
    });

    it('cancels a stream before EOF and ignores late data and end callbacks', function() {
        var stream = {};
        var oldFlushed = jasmine.createSpy('old frame flushed');
        display.drawStream(layer, 1, 2, stream, 'image/png');
        var lateBlob = stream.onblob, lateEnd = stream.onend;
        display.flush(oldFlushed);
        display.cancel();
        expect(stream.onblob).toBeNull();
        expect(stream.onend).toBeNull();
        lateBlob('AAAA');
        lateEnd();
        expect(images.length).toBe(0);
        var fresh = {};
        var freshFlushed = jasmine.createSpy('fresh frame flushed');
        display.drawImage(layer, 3, 4, fresh);
        display.flush(freshFlushed);
        expect(layer.drawImage).toHaveBeenCalledOnceWith(3, 4, fresh);
        expect(oldFlushed).not.toHaveBeenCalled();
        expect(freshFlushed).toHaveBeenCalledTimes(1);
        expect(display.onimageerror).not.toHaveBeenCalled();
    });

    it('detaches loading images on cancellation and ignores late success or failure', function() {
        var stream = {};
        display.drawStream(layer, 1, 2, stream, 'image/png');
        end(stream);
        var image = images[0], lateLoad = image.onload, lateError = image.onerror;
        display.cancel();
        expect(image.onload).toBeNull();
        expect(image.onerror).toBeNull();
        lateLoad();
        lateError();
        display.flush();
        expect(layer.drawImage).not.toHaveBeenCalled();
        expect(display.onimageerror).not.toHaveBeenCalled();
    });

    it('unblocks later drawing and signals recovery when the final tile fails decoding', function() {
        var stream = {}, later = {};
        var flushed = jasmine.createSpy('flushed');
        display.drawStream(layer, 1, 2, stream, 'image/png');
        display.drawImage(layer, 3, 4, later);
        display.flush(flushed);
        end(stream);
        images[0].width = images[0].height = 0;
        images[0].onerror();
        expect(flushed).toHaveBeenCalledTimes(1);
        expect(layer.drawImage).toHaveBeenCalledOnceWith(3, 4, later);
        expect(display.onimageerror).toHaveBeenCalledTimes(1);
        expect(images[0].onload).toBeNull();
        expect(images[0].onerror).toBeNull();
    });

    it('unblocks the frame and signals recovery if creating an image throws', function() {
        var stream = {};
        var flushed = jasmine.createSpy('flushed');
        window.Image = function() { throw new Error('Cannot create image'); };
        display.drawStream(layer, 1, 2, stream, 'image/png');
        display.flush(flushed);
        end(stream);
        expect(flushed).toHaveBeenCalledTimes(1);
        expect(layer.drawImage).not.toHaveBeenCalled();
        expect(display.onimageerror).toHaveBeenCalledTimes(1);
        expect(stream.onblob).toBeNull();
        expect(stream.onend).toBeNull();
    });

});
