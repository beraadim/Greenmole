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

describe("Guacamole.InputStream ReadableStream", function() {

    var stream;

    function send(bytes) {
        stream.onblob(window.btoa(String.fromCharCode.apply(null, bytes)));
    }

    beforeEach(function() {
        stream = new Guacamole.InputStream({}, 1);
    });

    it("supplies bytes to a normal reader and ignores empty blobs", function() {
        var reader = stream.toReadableStream().getReader();
        var pending = reader.read();
        send([]);
        send([ 1, 2, 3 ]);
        stream.onend();
        return pending.then(function(result) {
            expect(Array.from(result.value)).toEqual([ 1, 2, 3 ]);
            expect(result.done).toBe(false);
            return reader.read();
        }).then(function(result) {
            expect(result.done).toBe(true);
        });
    });

    it("honors a BYOB view offset and queues excess bytes as a typed array", function() {
        var reader = stream.toReadableStream().getReader({ mode: 'byob' });
        var pending = reader.read(new Uint8Array(new ArrayBuffer(12), 3, 4));
        send([ 1, 2, 3, 4, 5, 6 ]);
        stream.onend();
        return pending.then(function(result) {
            expect(result.value.byteOffset).toBe(3);
            expect(Array.from(result.value)).toEqual([ 1, 2, 3, 4 ]);
            return reader.read(new Uint8Array(4));
        }).then(function(result) {
            expect(Array.from(result.value)).toEqual([ 5, 6 ]);
            return reader.read(new Uint8Array(4));
        }).then(function(result) {
            expect(result.done).toBe(true);
        });
    });

    it("completes an outstanding BYOB request at EOF", function() {
        var reader = stream.toReadableStream().getReader({ mode: 'byob' });
        var pending = reader.read(new Uint8Array(4));
        stream.onend();
        return pending.then(function(result) {
            expect(result.done).toBe(true);
            expect(result.value.byteLength).toBe(0);
        });
    });

    it("accepts multiple BYOB reads as data arrives", function() {
        var reader = stream.toReadableStream().getReader({ mode: 'byob' });
        var pending = reader.read(new Uint8Array(4));
        send([ 1, 2 ]);
        return pending.then(function(result) {
            expect(Array.from(result.value)).toEqual([ 1, 2 ]);
            var next = reader.read(new Uint8Array(4));
            send([ 3, 4 ]);
            return next;
        }).then(function(result) {
            expect(Array.from(result.value)).toEqual([ 3, 4 ]);
            var next = reader.read(new Uint8Array(4));
            stream.onend();
            return next;
        }).then(function(result) {
            expect(result.done).toBe(true);
        });
    });

    it("discards arriving data after cancellation without retaining stream handlers", function() {
        var reader = stream.toReadableStream().getReader();
        var onblob = stream.onblob;
        var onend = stream.onend;
        return reader.cancel().then(function() {
            expect(stream.onblob).toBeNull();
            expect(stream.onend).toBeNull();
            expect(function() {
                onblob(window.btoa('discarded'));
                onend();
            }).not.toThrow();
        });
    });

    describe("direct Base64 BYOB decoding", function() {

        var decodeDescriptor;
        var fromDescriptor;

        function setDecoder(decoder) {
            Object.defineProperty(Uint8Array.prototype, 'setFromBase64', {
                configurable: true, writable: true, value: decoder
            });
        }

        function deterministicDecoder() {
            var decoder = jasmine.createSpy('setFromBase64').and.callFake(function(data) {
                var binary = window.atob(data);
                for (var i = 0; i < binary.length; i++)
                    this[i] = binary.charCodeAt(i);
                return { read: data.length, written: binary.length };
            });
            setDecoder(decoder);
            return decoder;
        }

        function collect(data, size, offset) {
            var reader = stream.toReadableStream().getReader({ mode: 'byob' });
            var pending = reader.read(new Uint8Array(new ArrayBuffer(size + offset + 2), offset, size));
            stream.onblob(data);
            stream.onend();
            return pending;
        }

        beforeEach(function() {
            decodeDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'setFromBase64');
            fromDescriptor = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
        });

        afterEach(function() {
            if (decodeDescriptor)
                Object.defineProperty(Uint8Array.prototype, 'setFromBase64', decodeDescriptor);
            else
                delete Uint8Array.prototype.setFromBase64;

            if (fromDescriptor)
                Object.defineProperty(Uint8Array, 'fromBase64', fromDescriptor);
            else
                delete Uint8Array.fromBase64;
        });

        [ [ 'AQID', [ 1, 2, 3 ] ], [ 'AQI=', [ 1, 2 ] ], [ 'AQ==', [ 1 ] ],
            [ '+/8=', [ 251, 255 ] ] ].forEach(function(fixture) {
            it("decodes canonical " + fixture[0] + " directly into an offset view", function() {
                var decoder = deterministicDecoder();
                var allocate = jasmine.createSpy('allocating Base64 decoder').and.throwError('Unexpected payload allocation');
                Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, writable: true, value: allocate });
                return collect(fixture[0], fixture[1].length, 3).then(function(result) {
                    expect(Array.from(result.value)).toEqual(fixture[1]);
                    expect(result.value.byteOffset).toBe(3);
                    expect(decoder).toHaveBeenCalledTimes(1);
                    expect(allocate).not.toHaveBeenCalled();
                    expect(Array.from(new Uint8Array(result.value.buffer, 0, 3))).toEqual([ 0, 0, 0 ]);
                    expect(Array.from(new Uint8Array(result.value.buffer, 3 + fixture[1].length))).toEqual([ 0, 0 ]);
                });
            });
        });

        it("uses the real native method when the browser supplies it", function() {
            if (!decodeDescriptor || typeof decodeDescriptor.value !== 'function') {
                pending('Browser has no native setFromBase64');
                return;
            }
            var nativeDecoder = decodeDescriptor.value;
            var decoder = jasmine.createSpy('native setFromBase64').and.callFake(function(data) {
                return nativeDecoder.call(this, data);
            });
            setDecoder(decoder);
            var bytes = Array.from({ length: 6144 }, function(_, index) { return index % 256; });
            return collect(window.btoa(String.fromCharCode.apply(null, bytes)), bytes.length + 7, 2).then(function(result) {
                expect(Array.from(result.value)).toEqual(bytes);
                expect(decoder).toHaveBeenCalledTimes(1);
                expect(result.value.byteOffset).toBe(2);
            });
        });

        it("retains normal reader and oversized BYOB fallback behavior", function() {
            var decoder = deterministicDecoder();
            var normal = stream.toReadableStream().getReader();
            var pendingRead = normal.read();
            send([ 1, 2 ]);
            stream.onend();
            return pendingRead.then(function(result) {
                expect(Array.from(result.value)).toEqual([ 1, 2 ]);
                stream = new Guacamole.InputStream({}, 2);
                return collect('AQID', 2, 1);
            }).then(function(result) {
                expect(Array.from(result.value)).toEqual([ 1, 2 ]);
                expect(decoder).not.toHaveBeenCalled();
            });
        });

        it("retains legacy atob decoding when native methods are unavailable", function() {
            setDecoder(undefined);
            Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, writable: true, value: undefined });
            return collect('AQI=', 4, 2).then(function(result) {
                expect(Array.from(result.value)).toEqual([ 1, 2 ]);
            });
        });

        [ 'AQ', 'AQI', ' A\tQ==\n', 'AR==', 'AQJ=', 'AQIDBAU\n', 'AQIDBAU\r' ].forEach(function(data) {
            it("preserves noncanonical input accepted by the existing decoder: " + JSON.stringify(data), function() {
                var decoder = deterministicDecoder();
                var expected = Array.from(window.atob(data), function(character) { return character.charCodeAt(0); });
                return collect(data, 8, 0).then(function(result) {
                    expect(Array.from(result.value)).toEqual(expected);
                    expect(decoder).not.toHaveBeenCalled();
                });
            });
        });

        [ 'AQIDBAU?', 'AQIDBAU=AQID', 'AQID===', 'A===', 'A', '____', 'AQIDBAU\u2028' ].forEach(function(data) {
            it("rejects malformed input before modifying the pending view: " + data, function() {
                var decoder = deterministicDecoder();
                var reader = stream.toReadableStream().getReader({ mode: 'byob' });
                var bytes = new Uint8Array(12);
                bytes.fill(0xA5);
                var pendingRead = reader.read(new Uint8Array(bytes.buffer, 2, 8));
                expect(function() { stream.onblob(data); }).toThrow();
                expect(decoder).not.toHaveBeenCalled();
                send([ 1, 2 ]);
                stream.onend();
                return pendingRead.then(function(result) {
                    expect(Array.from(result.value)).toEqual([ 1, 2 ]);
                    expect(Array.from(new Uint8Array(result.value.buffer))).toEqual([
                        0xA5, 0xA5, 1, 2, 0xA5, 0xA5, 0xA5, 0xA5, 0xA5, 0xA5, 0xA5, 0xA5
                    ]);
                    expect(decoder).toHaveBeenCalledTimes(1);
                });
            });
        });

        it("ignores empty and stale blobs after cancellation", function() {
            var decoder = deterministicDecoder();
            var reader = stream.toReadableStream().getReader({ mode: 'byob' });
            var pendingRead = reader.read(new Uint8Array(8));
            var onblob = stream.onblob;
            onblob('');
            expect(decoder).not.toHaveBeenCalled();
            return reader.cancel().then(function() {
                onblob('AQ==');
                onblob('invalid!');
                expect(decoder).not.toHaveBeenCalled();
                expect(stream.onblob).toBeNull();
                return pendingRead;
            }).then(function(result) {
                expect(result.done).toBe(true);
            });
        });

        it("supplies bytes to a BYOB DataView without changing its offset", function() {
            var decoder = deterministicDecoder();
            var reader = stream.toReadableStream().getReader({ mode: 'byob' });
            var pendingRead = reader.read(new DataView(new ArrayBuffer(12), 3, 6));
            send([ 1, 2, 3 ]);
            stream.onend();
            return pendingRead.then(function(result) {
                expect(result.value instanceof DataView).toBe(true);
                expect(result.value.byteOffset).toBe(3);
                expect(Array.from(new Uint8Array(result.value.buffer, 3, 3))).toEqual([ 1, 2, 3 ]);
                expect(decoder).toHaveBeenCalledTimes(1);
            });
        });

    });

});
