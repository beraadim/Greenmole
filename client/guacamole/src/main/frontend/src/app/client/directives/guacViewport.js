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

// Modified for Greenmole by its maintainers.

/**
 * A fullscreen environment which follows the visible browser viewport.
 */
angular.module('client').directive('guacViewport', [function guacViewport() {
    return {
        restrict: 'E',
        scope: {},
        transclude: true,
        templateUrl: 'app/client/templates/guacViewport.html',
        controller: ['$scope', '$injector', '$element',
            function guacViewportController($scope, $injector, $element) {

            var $window = $injector.get('$window');
            var viewportService = $injector.get('guacViewportService');
            var element = $element.find('.viewport')[0];

            var unsubscribe = viewportService.subscribe(function(state) {
                element.style.width = state.width + 'px';
                element.style.height = state.height + 'px';
                element.style.left = state.left === null ? '' : state.left + 'px';
                element.style.top = state.top === null ? '' : state.top + 'px';
                element.style.right = state.left === null ? '' : 'auto';
                element.style.bottom = state.top === null ? '' : 'auto';

                // Preserve the original scroll correction outside native
                // keyboard mode. Native mode follows VisualViewport directly.
                if (state.left === null && (element.scrollLeft || element.scrollTop))
                    $window.scrollTo($window.pageXOffset + element.scrollLeft,
                        $window.pageYOffset + element.scrollTop);
            });

            // Event-driven viewport tracking replaces the former 10ms poll.
            $scope.$on('$destroy', unsubscribe);
        }]
    };
}]);
