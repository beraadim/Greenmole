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

describe("Guacamole.Display image decoding", function() {

    var display;
    var layer;
    var originalBitmap;
    var originalDecoder;
    var pending;

    function deferred() {
        var result = {};
        result.promise = new Promise(function(resolve, reject) {
            result.resolve = resolve;
            result.reject = reject;
        });
        return result;
    }

    function image() {
        return { close: jasmine.createSpy('close image') };
    }

    function drawAfterFailure() {
        var laterImage = {};
        var flushed = jasmine.createSpy('flushed');
        display.drawImage(layer, 4, 5, laterImage);
        display.flush(flushed);
        return function verify() {
            expect(flushed).toHaveBeenCalledTimes(1);
            expect(layer.drawImage).toHaveBeenCalledOnceWith(4, 5, laterImage);
        };
    }

    beforeEach(function() {
        display = new Guacamole.Display();
        layer = { drawImage: jasmine.createSpy('drawImage') };
        originalBitmap = window.createImageBitmap;
        originalDecoder = window.ImageDecoder;
        pending = deferred();
        window.createImageBitmap = jasmine.createSpy('createImageBitmap').and.returnValue(pending.promise);
    });

    afterEach(function() {
        display.cancel();
        window.createImageBitmap = originalBitmap;
        window.ImageDecoder = originalDecoder;
    });

    describe("createImageBitmap", function() {

        it("closes its image after drawing while retaining it until the frame is flushed", function() {
            var decoded = image();
            display.drawBlob(layer, 1, 2, new Blob());
            pending.resolve(decoded);
            return pending.promise.then(function() {
                expect(decoded.close).not.toHaveBeenCalled();
                display.flush();
                expect(layer.drawImage).toHaveBeenCalledOnceWith(1, 2, decoded);
                expect(decoded.close).toHaveBeenCalledTimes(1);
            });
        });

        it("unblocks following drawing and frame acknowledgements after rejection", function() {
            display.drawBlob(layer, 1, 2, new Blob());
            var verify = drawAfterFailure();
            pending.reject(new Error('invalid bitmap'));
            return pending.promise.catch(verify);
        });

        it("unblocks following drawing after a synchronous decode failure", function() {
            window.createImageBitmap.and.throwError('unsupported bitmap');
            display.drawBlob(layer, 1, 2, new Blob());
            drawAfterFailure()();
        });

        it("closes an image that arrives after cancellation without drawing or acknowledging it", function() {
            var decoded = image();
            var flushed = jasmine.createSpy('flushed');
            display.drawBlob(layer, 1, 2, new Blob());
            display.flush(flushed);
            display.cancel();
            pending.resolve(decoded);
            return pending.promise.then(function() {
                expect(decoded.close).toHaveBeenCalledTimes(1);
                expect(layer.drawImage).not.toHaveBeenCalled();
                expect(flushed).not.toHaveBeenCalled();
            });
        });

        it("closes an already decoded but unflushed image on cancellation", function() {
            var decoded = image();
            display.drawBlob(layer, 1, 2, new Blob());
            pending.resolve(decoded);
            return pending.promise.then(function() {
                display.cancel();
                display.cancel();
                expect(decoded.close).toHaveBeenCalledTimes(1);
                expect(layer.drawImage).not.toHaveBeenCalled();
            });
        });

        it("still closes an image if drawing fails", function() {
            var decoded = image();
            layer.drawImage.and.throwError('canvas failure');
            display.drawBlob(layer, 1, 2, new Blob());
            pending.resolve(decoded);
            return pending.promise.then(function() {
                expect(function() { display.flush(); }).toThrowError('canvas failure');
                expect(decoded.close).toHaveBeenCalledTimes(1);
            });
        });

    });

    describe("ImageDecoder", function() {

        var decoder;
        var stream;
        var readable;
        var completed;

        beforeEach(function() {
            completed = deferred();
            decoder = {
                completed: completed.promise,
                tracks: { ready: Promise.resolve() },
                decode: jasmine.createSpy('decode').and.returnValue(pending.promise),
                close: jasmine.createSpy('close decoder')
            };
            readable = new ReadableStream();
            stream = { toReadableStream: function() { return readable; } };
            window.ImageDecoder = jasmine.createSpy('ImageDecoder').and.returnValue(decoder);
        });

        it("closes the decoder on success and its frame after drawing", function() {
            var decoded = image();
            display.drawStream(layer, 1, 2, stream, 'image/png');
            pending.resolve({ image: decoded });
            return pending.promise.then(function() {
                expect(decoder.decode).toHaveBeenCalledOnceWith({ completeFramesOnly: true });
                expect(decoder.close).toHaveBeenCalledTimes(1);
                expect(decoded.close).not.toHaveBeenCalled();
                display.flush();
                expect(layer.drawImage).toHaveBeenCalledOnceWith(1, 2, decoded);
                expect(decoded.close).toHaveBeenCalledTimes(1);
            });
        });

        it("closes a rejected decoder and unblocks later drawing", function() {
            display.drawStream(layer, 1, 2, stream, 'image/png');
            var verify = drawAfterFailure();
            pending.reject(new Error('invalid image'));
            completed.reject(new Error('invalid image'));
            return pending.promise.catch(function() {
                verify();
                expect(decoder.close).toHaveBeenCalledTimes(1);
            });
        });

        it("cancels pending decoding and releases frames that complete late", function() {
            var decoded = image();
            var flushed = jasmine.createSpy('flushed');
            display.drawStream(layer, 1, 2, stream, 'image/png');
            display.flush(flushed);
            display.cancel();
            expect(decoder.close).toHaveBeenCalledTimes(1);
            pending.resolve({ image: decoded });
            return pending.promise.then(function() {
                expect(decoder.close).toHaveBeenCalledTimes(1);
                expect(decoded.close).toHaveBeenCalledTimes(1);
                expect(layer.drawImage).not.toHaveBeenCalled();
                expect(flushed).not.toHaveBeenCalled();
            });
        });

        it("releases a decoded frame cancelled before flushing", function() {
            var decoded = image();
            display.drawStream(layer, 1, 2, stream, 'image/png');
            pending.resolve({ image: decoded });
            return pending.promise.then(function() {
                display.cancel();
                expect(decoder.close).toHaveBeenCalledTimes(1);
                expect(decoded.close).toHaveBeenCalledTimes(1);
            });
        });

        it("unblocks later drawing and cancels the input if construction fails", function() {
            var cancelled = jasmine.createSpy('cancel input');
            readable = new ReadableStream({ cancel: cancelled });
            window.ImageDecoder.and.throwError('unsupported image');
            display.drawStream(layer, 1, 2, stream, 'image/unsupported');
            drawAfterFailure()();
            expect(cancelled).toHaveBeenCalledTimes(1);
        });

        it("closes the decoder and unblocks later drawing if decode throws", function() {
            decoder.decode.and.throwError('decode failure');
            display.drawStream(layer, 1, 2, stream, 'image/png');
            drawAfterFailure()();
            expect(decoder.close).toHaveBeenCalledTimes(1);
        });

    });

    describe("native ImageDecoder", function() {

        beforeEach(function() {
            window.ImageDecoder = originalDecoder;
        });

        it("draws a streamed PNG before releasing its native frame", function() {
            if (!originalDecoder) {
                window.pending('ImageDecoder is unavailable in this browser');
                return;
            }

            var source = document.createElement('canvas');
            source.width = source.height = 1;
            var context = source.getContext('2d');
            context.fillStyle = 'red';
            context.fillRect(0, 0, 1, 1);
            var png = source.toDataURL('image/png').split(',')[1];
            context.clearRect(0, 0, 1, 1);

            layer.drawImage.and.callFake(function(x, y, decoded) {
                context.drawImage(decoded, 0, 0);
            });
            var stream = new Guacamole.InputStream({}, 1);
            display.drawStream(layer, 0, 0, stream, 'image/png');
            stream.onblob(png);
            stream.onend();
            return new Promise(function(resolve) {
                display.flush(resolve);
            }).then(function() {
                expect(Array.from(context.getImageData(0, 0, 1, 1).data))
                        .toEqual([255, 0, 0, 255]);
            });
        });

        it("unblocks the next frame after native decoding of corrupt image data fails", function() {
            if (!originalDecoder) {
                window.pending('ImageDecoder is unavailable in this browser');
                return;
            }

            var stream = new Guacamole.InputStream({}, 1);
            display.drawStream(layer, 0, 0, stream, 'image/png');
            var verify = drawAfterFailure();
            stream.onblob(window.btoa('invalid image data'));
            stream.onend();
            return new Promise(function(resolve) {
                display.flush(resolve);
            }).then(verify);
        });

        it("handles native cancellation before tracks or image bytes are available", function() {
            if (!originalDecoder) {
                window.pending('ImageDecoder is unavailable in this browser');
                return;
            }

            var stream = new Guacamole.InputStream({}, 1);
            display.drawStream(layer, 0, 0, stream, 'image/png');
            display.cancel();
            if (stream.onend)
                stream.onend();
            return Promise.resolve().then(function() {
                expect(layer.drawImage).not.toHaveBeenCalled();
            });
        });

    });

    describe("blob URL fallback", function() {

        var blobImage;
        var originalImage;

        beforeEach(function() {
            window.createImageBitmap = undefined;
            originalImage = window.Image;
            blobImage = { width: 0, height: 0 };
            window.Image = function() { return blobImage; };
            spyOn(URL, 'createObjectURL').and.returnValue('blob:test');
            spyOn(URL, 'revokeObjectURL');
        });

        afterEach(function() {
            display.cancel();
            window.Image = originalImage;
        });

        it("revokes the URL after drawing and clears image callbacks", function() {
            display.drawBlob(layer, 1, 2, new Blob());
            blobImage.width = blobImage.height = 1;
            blobImage.onload();
            display.flush();
            expect(layer.drawImage).toHaveBeenCalledOnceWith(1, 2, blobImage);
            expect(URL.revokeObjectURL).toHaveBeenCalledOnceWith('blob:test');
            expect(blobImage.onload).toBeNull();
            expect(blobImage.onerror).toBeNull();
        });

        it("revokes a cancelled URL once and prevents late loading callbacks", function() {
            display.drawBlob(layer, 1, 2, new Blob());
            display.cancel();
            display.cancel();
            expect(URL.revokeObjectURL).toHaveBeenCalledOnceWith('blob:test');
            expect(blobImage.onload).toBeNull();
            expect(blobImage.onerror).toBeNull();
            expect(layer.drawImage).not.toHaveBeenCalled();
        });

        it("releases a failed URL and allows later drawing", function() {
            display.drawBlob(layer, 1, 2, new Blob());
            var verify = drawAfterFailure();
            blobImage.onerror();
            verify();
            expect(URL.revokeObjectURL).toHaveBeenCalledOnceWith('blob:test');
        });

    });

});
