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

/**
 * An ordered input gate for a single client view. Clipboard synchronization
 * pauses this gate until the updated clipboard has been sent. Adjacent free
 * pointer movements may replace each other while waiting; all other input is
 * an ordering barrier, including held-button movement and keyboard events.
 */
angular.module('client').factory('ClientInputQueue', [function ClientInputQueueFactory() {

    const ClientInputQueue = function ClientInputQueue() {

        let blocked = false;
        let disposed = false;
        let draining = false;
        let pending = [];
        let head = 0;

        const drain = function drain() {
            if (draining || disposed)
                return;

            draining = true;
            try {
                while (!blocked && !disposed && head < pending.length) {
                    const input = pending[head];
                    pending[head++] = null;
                    input.send();
                }
            }
            finally {
                // Release closures even if an input handler tears down this
                // view or starts another clipboard synchronization while sent.
                pending = pending.slice(head);
                head = 0;
                draining = false;
            }
        };

        /**
         * Appends input, replacing only an adjacent queued movement that the
         * caller explicitly identifies as safe to coalesce.
         */
        this.enqueue = function enqueue(send, coalesce) {
            if (disposed)
                return;

            const last = pending.length > head ? pending[pending.length - 1] : null;
            const input = { send, coalesce: !!coalesce };
            if (coalesce && last && last.coalesce)
                pending[pending.length - 1] = input;
            else
                pending.push(input);

            drain();
        };

        /** Pauses or resumes input without polling or per-event promises. */
        this.setBlocked = function setBlocked(value) {
            blocked = !!value;
            drain();
        };

        /** Drops all input belonging to a detached client. */
        this.clear = function clear() {
            pending = [];
            head = 0;
        };

        /** Permanently cancels input when the owning view is destroyed. */
        this.dispose = function dispose() {
            disposed = true;
            this.clear();
        };

    };

    return ClientInputQueue;

}]);
