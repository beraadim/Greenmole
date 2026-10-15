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
 * An ordered, bounded receive pump for one WebSocket connection. The first
 * available instructions run synchronously. Further work yields after eight
 * milliseconds or 4096 instructions, with additional checkpoints every 32
 * elements within a large instruction. Instructions are delivered atomically;
 * a single element or instruction callback may exceed the time budget.
 *
 * @constructor
 * @param {!function(string, string[])} oninstruction Receives complete instructions.
 * @param {!function(Guacamole.Status)} onerror Receives a terminal receive error.
 */
Guacamole.InstructionPump = function InstructionPump(oninstruction, onerror) {

    var pump = this;
    var parser = new Guacamole.Parser();
    var packets = [];
    var packetIndex = 0;
    var queuedLength = 0;
    var parserPending = false;
    var processing = false;
    var cancelled = false;
    var ending = false;
    var onend = null;
    var channel = null;
    var timer = null;
    var generation = 0;
    var pending = null;

    var maxLength = Guacamole.InstructionPump.MAX_BUFFER_LENGTH;
    var maxPackets = Guacamole.InstructionPump.MAX_QUEUED_PACKETS;
    var maxElements = Guacamole.InstructionPump.MAX_BUFFER_ELEMENTS;

    var timestamp = function timestamp() {
        return window.performance && window.performance.now
                ? window.performance.now() : new Date().getTime();
    };

    var closeChannel = function closeChannel() {
        if (channel) {
            channel.port1.onmessage = null;
            channel.port1.close();
            channel.port2.close();
            channel = null;
        }
    };

    /** Cancels this connection's pending data and all continuation resources. */
    this.cancel = function cancel() {
        cancelled = true;
        pending = null;
        if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
        }
        closeChannel();
        packets = [];
        onend = null;
        packetIndex = queuedLength = 0;
        if (parser)
            parser.oninstruction = null;
        parser = null;
    };

    var fail = function fail(status) {
        if (!cancelled) {
            pump.cancel();
            onerror(status);
        }
    };

    var overflow = function overflow() {
        fail(new Guacamole.Status(Guacamole.Status.Code.CLIENT_OVERRUN,
                'Guacamole protocol receive buffer limit exceeded.'));
    };

    var schedule = function schedule() {
        if (cancelled || pending !== null)
            return;

        var token = pending = ++generation;
        if (window.MessageChannel) {
            try {
                if (!channel) {
                    var current = channel = new window.MessageChannel();
                    current.port1.onmessage = function continueChannel(event) {
                        if (channel === current && pending === event.data) {
                            pending = null;
                            drain();
                        }
                    };
                }
                channel.port2.postMessage(token);
                return;
            }
            catch (e) {
                closeChannel();
            }
        }

        timer = window.setTimeout(function continueTimer() {
            if (pending === token) {
                pending = timer = null;
                drain();
            }
        }, 0);
    };

    // The pump prevents a reentrant receive() from entering this parser while
    // an instruction handler is running. Cancellation can stop the remaining
    // instructions even when invoked from within that handler.
    parser.oninstruction = function instructionReceived(opcode, args) {
        if (!cancelled)
            oninstruction(opcode, args);
    };

    function drain() {
        if (cancelled || processing)
            return;

        var started = timestamp();
        var count = 0;
        var shouldYield = function shouldYield(instructionComplete) {
            if (cancelled)
                return true;
            if (parser.getBufferedElementCount() >= maxElements) {
                overflow();
                return true;
            }
            if (instructionComplete)
                count++;
            return count >= 4096 || timestamp() - started >= 8;
        };

        processing = true;
        try {
            while (!cancelled && (parserPending || packetIndex < packets.length)) {
                var packet = '';
                if (!parserPending) {
                    packet = packets[packetIndex];
                    packets[packetIndex++] = null;
                    queuedLength -= packet.length;
                }

                parserPending = parser.receivePartial(packet, shouldYield);
                if (cancelled)
                    return;

                if (queuedLength + parser.getBufferedLength() > maxLength) {
                    overflow();
                    return;
                }

                if (count >= 4096 || timestamp() - started >= 8)
                    break;
            }
        }
        catch (e) {
            fail(new Guacamole.Status(Guacamole.Status.Code.SERVER_ERROR, e.message));
        }
        finally {
            processing = false;
            if (!cancelled) {
                // Release consumed packet references without shifting the queue
                // for every packet. The retained array is bounded by the cap.
                if (packetIndex) {
                    packets.splice(0, packetIndex);
                    packetIndex = 0;
                }
                if (parserPending || packets.length)
                    schedule();
                else if (ending) {
                    var callback = onend;
                    pump.cancel();
                    callback();
                }
            }
        }
    }

    /**
     * Receives ordered WebSocket text. Overflow terminates this pump rather
     * than discarding any instruction or continuing with incomplete state.
     *
     * @param {!string} packet New protocol text.
     */
    this.receive = function receive(packet) {
        if (cancelled || ending)
            return;
        if (typeof packet !== 'string') {
            fail(new Guacamole.Status(Guacamole.Status.Code.SERVER_ERROR,
                    'Guacamole WebSocket protocol requires text messages.'));
            return;
        }
        if (!packet.length)
            return;

        if (queuedLength + parser.getBufferedLength() + packet.length > maxLength
                || packets.length - packetIndex >= maxPackets) {
            overflow();
            return;
        }

        packets.push(packet);
        queuedLength += packet.length;
        if (!processing && pending === null)
            drain();
    };

    /**
     * Drains text already received before a natural transport EOF, then calls
     * callback. New packets are ignored. A manual cancel suppresses callback.
     * Any incomplete final instruction is discarded, as with synchronous
     * parsing when the transport closes before its terminator arrives.
     *
     * @param {!function()} callback Called after received instructions drain.
     */
    this.end = function end(callback) {
        if (cancelled || ending)
            return;
        ending = true;
        onend = callback;
        if (!processing && pending === null && !parserPending && packetIndex === packets.length) {
            pump.cancel();
            callback();
        }
    };

};

/**
 * Maximum retained source text and completed elements, in UTF-16 code units.
 * The parser count is conservative and may count shared substrings twice.
 * This limits application receive buffering, not browser-owned network buffers
 * or already-decoded display images.
 * @constant
 * @type {!number}
 */
Guacamole.InstructionPump.MAX_BUFFER_LENGTH = 64 * 1024 * 1024;

/**
 * Maximum packets waiting for parsing, independently of their text size.
 * @constant
 * @type {!number}
 */
Guacamole.InstructionPump.MAX_QUEUED_PACKETS = 4096;

/**
 * Maximum retained elements within one incomplete instruction, independently
 * of text length. Normal image, graphics and control instructions use far
 * fewer elements; this prevents unbounded metadata from empty arguments.
 * @constant
 * @type {!number}
 */
Guacamole.InstructionPump.MAX_BUFFER_ELEMENTS = 16384;
