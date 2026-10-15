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

});
