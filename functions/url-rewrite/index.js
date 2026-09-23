// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

function handler(event) {
    var request = event.request;
    var originalImagePath = request.uri;
    // Default resize applies only to these path prefixes. CloudFront Functions
    // cannot load external config at runtime, so the list and caps live here.
    var DEFAULT_RESIZE_PATH_PREFIXES = ['/instagram-comment-webhook-images/'];
    var DEFAULT_WIDTH = '1080';
    var MAX_WIDTH = 1600;
    var MAX_HEIGHT = 1600;
    var DEFAULT_QUALITY = '70';
    var MAX_QUALITY = 80;
    var applyDefaultResize = false;
    for (var i = 0; i < DEFAULT_RESIZE_PATH_PREFIXES.length; i++) {
        if (originalImagePath.indexOf(DEFAULT_RESIZE_PATH_PREFIXES[i]) !== -1) {
            applyDefaultResize = true;
            break;
        }
    }
    //  validate, process and normalize the requested operations in query parameters
    var normalizedOperations = {};
    if (request.querystring) {
        Object.keys(request.querystring).forEach(operation => {
            switch (operation.toLowerCase()) {
                case 'format': 
                    var SUPPORTED_FORMATS = ['auto', 'jpeg', 'jpg','webp', 'avif', 'png', 'svg', 'gif','webm'];
                    if (request.querystring[operation]['value'] && SUPPORTED_FORMATS.includes(request.querystring[operation]['value'].toLowerCase())) {
                        var format = request.querystring[operation]['value'].toLowerCase(); // normalize to lowercase
                        if (format === 'auto') {
                            format = 'jpeg';
                            if (request.headers['accept']) {
                                if (request.headers['accept'].value.includes("avif")) {
                                    format = 'avif';
                                } else if (request.headers['accept'].value.includes("webp")) {
                                    format = 'webp';
                                } 
                            }
                        }
                        normalizedOperations['format'] = format;
                    }
                    break;
                case 'width':
                    if (request.querystring[operation]['value']) {
                        var width = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(width) && (width > 0)) {
                            // you can protect the Lambda function by setting a max value, e.g. if (width > 4000) width = 4000;
                            if (applyDefaultResize && width > MAX_WIDTH) width = MAX_WIDTH;
                            normalizedOperations['width'] = width.toString();
                        }
                    }
                    break;
                case 'height':
                    if (request.querystring[operation]['value']) {
                        var height = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(height) && (height > 0)) {
                            // you can protect the Lambda function by setting a max value, e.g. if (height > 4000) height = 4000;
                            if (applyDefaultResize && height > MAX_HEIGHT) height = MAX_HEIGHT;
                            normalizedOperations['height'] = height.toString();
                        }
                    }
                    break;
                case 'quality':
                    if (request.querystring[operation]['value']) {
                        var quality = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(quality) && (quality > 0)) {
                            if (quality > 100) quality = 100;
                            if (applyDefaultResize && quality > MAX_QUALITY) quality = MAX_QUALITY;
                            normalizedOperations['quality'] = quality.toString();
                        }
                    }
                    break;
                case 'cdnurl':
                        if (request.querystring[operation]['value']) {
                            var cdnurl = request.querystring[operation]['value'];
                            normalizedOperations['cdnurl'] = cdnurl.toString();
                        } 
                        break;
                case 'encoding':
                        if (request.querystring[operation]['value']) {
                            var cdnurl = request.querystring[operation]['value'];
                            normalizedOperations['encoding'] = cdnurl.toString();
                        } 
                        break;
                // case 'urlNew':
                //     if (request.querystring[operation]['value']) {
                //         const urlNew = request.querystring[operation]['value'].toLowerCase();
                //         normalizedOperations['urlNew'] = urlNew;
                //     }
                //     break;
                default: break;
            }
        });
    }
    // Scoped paths always get a resize so empty or op-less queries do not hit /original.
    if (applyDefaultResize) {
        if (!normalizedOperations.width) normalizedOperations['width'] = DEFAULT_WIDTH;
        if (!normalizedOperations.quality) normalizedOperations['quality'] = DEFAULT_QUALITY;
    }
    //rewrite the path to normalized version if valid operations are found
    if (Object.keys(normalizedOperations).length > 0) {
        // put them in order
        var normalizedOperationsArray = [];
        if (normalizedOperations.format) normalizedOperationsArray.push('format='+normalizedOperations.format);
        if (normalizedOperations.quality) normalizedOperationsArray.push('quality='+normalizedOperations.quality);
        if (normalizedOperations.width) normalizedOperationsArray.push('width='+normalizedOperations.width);
        if (normalizedOperations.height) normalizedOperationsArray.push('height='+normalizedOperations.height);
        if (normalizedOperations.cdnurl) normalizedOperationsArray.push('cdnurl='+normalizedOperations.cdnurl);
        if (normalizedOperations.encoding) normalizedOperationsArray.push('encoding='+normalizedOperations.encoding);
        request.uri = originalImagePath + '/' + normalizedOperationsArray.join(',');
    } else {
        // If no valid operation is found, flag the request with /original path suffix
        request.uri = originalImagePath + '/original';
    }
    // remove query strings
    request['querystring'] = {};
    return request;
}
