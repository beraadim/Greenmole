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
 * An input stream abstraction used by the Guacamole client to facilitate
 * transfer of files or other binary data.
 * 
 * @constructor
 * @param {!Guacamole.Client} client
 *     The client owning this stream.
 *
 * @param {!number} index
 *     The index of this stream.
 */
Guacamole.InputStream = function(client, index) {

    /**
     * Reference to this stream.
     *
     * @private
     * @type {!Guacamole.InputStream}
     */
    var guac_stream = this;

    /**
     * The index of this stream.
     *
     * @type {!number}
     */
    this.index = index;

    /**
     * Called when a blob of data is received.
     * 
     * @event
     * @param {!string} data
     *     The received base64 data.
     */
    this.onblob = null;

    /**
     * Called when this stream is closed.
     * 
     * @event
     */
    this.onend = null;

    /**
     * Acknowledges the receipt of a blob.
     * 
     * @param {!string} message
     *     A human-readable message describing the error or status.
     *
     * @param {!number} code
     *     The error code, if any, or 0 for success.
     */
    this.sendAck = function(message, code) {
        client.sendAck(guac_stream.index, message, code);
    };

    /**
     * Creates a new ReadableStream that receives the data sent to this stream
     * by the Guacamole server. This function may be invoked at most once per
     * stream, and invoking this function will overwrite any installed event
     * handlers on this stream.
     * 
     * A ReadableStream is a JavaScript object defined by the "Streams"
     * standard. It is supported by most browsers, but not necessarily all
     * browsers. The caller should verify this support is present before
     * invoking this function. The behavior of this function when the browser
     * does not support ReadableStream is not defined.
     *
     * @see {@link https://streams.spec.whatwg.org/#rs-class}
     *
     * @returns {!ReadableStream}
     *     A new ReadableStream that receives the bytes sent along this stream
     *     by the Guacamole server.
     */
    this.toReadableStream = function toReadableStream() {

        // Cancelling a decoder must discard further protocol blobs instead
        // of attempting to enqueue into a closed ReadableStream.
        var active = true;

        return new ReadableStream({
            type: 'bytes',
            start: function startStream(controller) {

                var reader = new Guacamole.ArrayBufferReader(guac_stream);

                // Keep the existing decoder for normal reads, oversized blobs,
                // older browsers and noncanonical input. A malformed blob must
                // never partly overwrite a consumer's outstanding BYOB view:
                // setFromBase64() may write bytes before reporting an error.
                var receiveBlob = guac_stream.onblob;
                var decodeInto = Uint8Array.prototype.setFromBase64;
                if (typeof decodeInto === 'function') {
                    // Require the true end of the string. A JavaScript "$"
                    // anchor would also match before a trailing line break.
                    var canonicalBase64 = /^[A-Za-z0-9+/]*={0,2}(?![\s\S])/;
                    guac_stream.onblob = function dataReceivedBlob(data) {

                        if (!active)
                            return;

                        var request = controller.byobRequest;

                        if (request && data.length && data.length % 4 === 0) {

                            var padding = data.charAt(data.length - 2) === '=' ? 2
                                    : data.charAt(data.length - 1) === '=' ? 1 : 0;
                            var length = data.length / 4 * 3 - padding;

                            // Validate the entire independent blob before writing.
                            // Nonzero unused bits, missing padding and whitespace
                            // retain the existing decoder's acceptance behavior.
                            if (length <= request.view.byteLength
                                    && canonicalBase64.test(data)
                                    && (!padding || ('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
                                        .indexOf(data.charAt(data.length - padding - 1))
                                            & (padding === 2 ? 15 : 3)) === 0)) {

                                var view = request.view;
                                decodeInto.call(new Uint8Array(view.buffer,
                                        view.byteOffset, view.byteLength), data);
                                request.respond(length);
                                return;

                            }

                        }

                        receiveBlob(data);

                    };
                }

                // Provide any received blocks of data to the ReadableStream
                // controller, such that they will be read by whatever is
                // consuming the ReadableStream
                reader.ondata = function dataReceived(data) {

                    if (!active || !data.byteLength)
                        return;

                    if (controller.byobRequest) {

                        var view = controller.byobRequest.view;
                        var length = Math.min(view.byteLength, data.byteLength);
                        var byobBlock = new Uint8Array(data, 0, length);

                        new Uint8Array(view.buffer, view.byteOffset, length).set(byobBlock);
                        controller.byobRequest.respond(length);

                        if (length < data.byteLength) {
                            controller.enqueue(new Uint8Array(data, length));
                        }

                    }

                    else {
                        controller.enqueue(new Uint8Array(data));
                    }

                };

                // Notify the ReadableStream when the end of the stream is
                // reached
                reader.onend = function dataComplete() {
                    if (!active)
                        return;

                    active = false;
                    var pendingRequest = controller.byobRequest;
                    controller.close();

                    // A BYOB read remains pending at EOF unless its request
                    // is explicitly completed after closing the controller.
                    if (pendingRequest)
                        pendingRequest.respond(0);
                };

            },
            cancel: function cancelStream() {
                active = false;
                guac_stream.onblob = guac_stream.onend = null;
            }
        });

    };

};
