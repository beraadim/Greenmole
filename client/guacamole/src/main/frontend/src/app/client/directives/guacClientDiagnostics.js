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

angular.module('client').directive('guacClientDiagnostics', [function guacClientDiagnostics() {
    return {
        restrict: 'E',
        scope: { client: '=' },
        templateUrl: 'app/client/templates/guacClientDiagnostics.html',
        controller: ['$scope', '$interval', function diagnosticsController($scope, $interval) {
            let monitor = null;
            let timer = null;

            const stop = function stop() {
                if (timer)
                    $interval.cancel(timer);
                if (monitor)
                    monitor.stop();
                timer = null;
                monitor = null;
                $scope.sample = null;
            };

            $scope.number = function number(value) {
                return typeof value === 'number' && isFinite(value) ? value.toFixed(1) : '\u2014';
            };

            $scope.$watchGroup(['client', 'client.clientProperties.showStatistics'], function changed() {
                stop();
                if (!$scope.client || !$scope.client.clientProperties.showStatistics)
                    return;
                monitor = $scope.client.performance;
                if (!monitor)
                    return;
                monitor.start();
                $scope.sample = monitor.sample();
                timer = $interval(function update() { $scope.sample = monitor.sample(); }, 1000);
            });
            $scope.$on('$destroy', stop);
        }]
    };
}]);
