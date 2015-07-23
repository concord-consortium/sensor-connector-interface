/*globals XDomainRequest */

'use strict';

// datasets[]
//   columns[]
//     id
//     units
//     data[]
//     liveValue
//     requestedValuesTimeStamp
//     receivedValuesTimeStamp

var RSVP = require('rsvp');

var EventEmitter2 = require('eventemitter2').EventEmitter2;
var events = new EventEmitter2({
    wildcard: true
});

var urlPrefix = '';
var rawQueryParams = {};
var urlQueryParams = '';
var TIME_LIMIT_IN_MS = 5000;
var LAUNCH_TIME_LIMIT_IN_MS = 30000;
var POLLING_DELAY = 100;

var isPolling = false;

var datasets;
var datasetsById;
var columnsById;
var sessionChangedEmitted;
var currentSessionID;

function initializeSession() {
    datasets = [];
    datasetsById = Object.create(null);
    columnsById = Object.create(null);
    sessionChangedEmitted = false;
}

// see http://www.html5rocks.com/en/tutorials/cors/
function createCORSRequest(method, relativeUrl) {
    var url = urlPrefix + relativeUrl + urlQueryParams;
    var xhr = new XMLHttpRequest();

    if ('withCredentials' in xhr) {
        xhr.open(method, url, true);
        xhr.responseType = 'json';
        xhr.setRequestHeader('Accept', 'application/json');
    } else if (typeof XDomainRequest !== 'undefined') {
        // IE8/9's XMLHttpRequest object doesn't support CORS; instead, you have to use an
        // 'XDomainRequest' object
        xhr = new XDomainRequest();
        // we can't set custom headers in IE9
        // see http://blogs.msdn.com/b/ieinternals/archive/2010/05/13/xdomainrequest-restrictions-limitations-and-workarounds.aspx
        xhr.open(method, url);
    } else {
        return null;
    }

    return xhr;
}


function _setRawQueryParams(k, v) {
    if (v == null) {
        delete rawQueryParams[k];
    } else {
        rawQueryParams[k] = v;
    }
}

function _generateQueryParams() {
    var v;
    Object.keys(rawQueryParams).forEach(function(k,i) {
        v = rawQueryParams[k];
        if (i === 0) {
            urlQueryParams = '?'+k+'='+v;
        } else {
            urlQueryParams += '&'+k+'='+v;
        }

    });
}

var lastStatusTimeStamp = 0;
var isConnected = false;
var isCollecting = false;
var canControl = true;
var inControl = null;
var hasAttachedInterface = false;
var launchFrame = null;
var waitingOnLaunch = false;
var launchTimedOut = false;

var timeoutTimer = {
    start: function() {
        this.timerId = setTimeout(tryLaunchingTimeout, TIME_LIMIT_IN_MS);
    },

    reset: function() {
        this.stop();
        this.start();
    },

    stop: function() {
        clearTimeout(this.timerId);
    }
};

var launchTimer = {
    start: function() {
        this.timerId = setTimeout(function() { launchTimedOut = true; events.emit('launchTimedOut'); }, LAUNCH_TIME_LIMIT_IN_MS);
    },

    reset: function() {
        this.stop();
        this.start();
    },

    stop: function() {
        waitingOnLaunch = false;
        clearTimeout(this.timerId);
    }
};

var statusIntervalId;

function requestStatus() {
    var xhr = createCORSRequest('GET', '/status');
    // TODO set xhr timeout

    if (!xhr) {
        statusErrored();
        return;
    }

    xhr.onerror = statusErrored;
    xhr.onload = statusLoaded;
    xhr.send();
}

function statusErrored() {
    if (!waitingOnLaunch) {
        events.emit('statusErrored');
    }
}

function injectCcscFrame() {
    if (launchFrame !== null) {
        document.body.removeChild(launchFrame);
    }
    var obj = document.createElement('div');
    obj.id = 'sensor-connector-launch-frame-parent';
    obj.innerHTML = '<iframe id="sensor-connector-launch-frame" src="ccsc://sensorconnector.concord.org/"></iframe>';
    document.body.appendChild(obj);
    launchFrame = document.getElementById('sensor-connector-launch-frame-parent');
}

function launchSensorConnector() {
    if (!waitingOnLaunch) {
        injectCcscFrame();
        launchTimer.start();
        waitingOnLaunch = true;
    }
}

function tryLaunching() {
    launchSensorConnector();
}

function tryLaunchingTimeout() {
    tryLaunching();
    requestStatus();
}

function statusLoaded() {
    var response = this.response || JSON.parse(this.responseText); // jshint ignore:line

    if (typeof(response) === "string") { response = JSON.parse(response); }

    if ( ! isPolling ) {
        return;
    }

    if (response.requestTimeStamp < lastStatusTimeStamp) {
        // stale out-of-order response; drop it like we never got it.
        return;
    }

    if ( ! currentSessionID ) {
        currentSessionID = response.sessionID;
        initializeSession();
    } else if (currentSessionID !== response.sessionID) {
        // Session ID changed on us unexpectedly. Client should probably stop polling, start polling.
        if ( ! sessionChangedEmitted) {
            events.emit('sessionChanged');
            sessionChangedEmitted = true;
        }
        return;
    }

    lastStatusTimeStamp = response.requestTimeStamp;

    timeoutTimer.reset();
    launchTimer.stop();
    processDatasets(response.sets);
    processColumns(response.columns);

    // TODO liveValue

    isConnected = true;

    events.emit('statusReceived');

    if (isCollecting && ! response.collection.isCollecting) {
        isCollecting = false;
        events.emit('collectionStopped');
    } else if (! isCollecting && response.collection.isCollecting) {
        isCollecting = true;
        events.emit('collectionStarted');
    }

    inControl = response.collection.inControl;

    if (canControl && ! response.collection.canControl) {
        canControl = false;
        events.emit('controlDisabled');
    } else if (! canControl && response.collection.canControl) {
        canControl = true;
        events.emit('controlEnabled');
    }

    var currentlyAttached = typeof(response.currentInterface) === "undefined" || response.currentInterface === null || response.currentInterface !== "None Found";
    if (hasAttachedInterface && !currentlyAttached) {
        hasAttachedInterface = false;
        events.emit('interfaceRemoved');
    } else if (!hasAttachedInterface && currentlyAttached) {
        hasAttachedInterface = true;
        events.emit('interfaceConnected');
    }
}

// Handle 'datasets' and 'columns' in the response
function processDatasets(sets) {
    Object.keys(sets).forEach(function(setId) {
        if ( ! datasetsById[setId] ) {
            // mind, no datasetAdded is emitted until the second collection because the first
            // dataset always exists
            events.emit('datasetAdded', setId);
            datasetsById[setId] = {
                columns: [],
                id: setId
            };
            datasets.unshift(datasetsById[setId]);
        }
        // Set the columns array length so that it's the correct size if a column was removed
        datasetsById[setId].columns.length = sets[setId].colIDs.length;
    });
    // make sure the highest-numbered dataset is always datasets[0]
    datasets.sort(function(d1, d2) { return d2.setId-d1.setId; });
}

function processColumns(cols) {
    // looks familiar
    var eventsToEmit = [];
    Object.keys(cols).forEach(function(colId) {
        var columnFromResponse = cols[colId];
        var dataset = datasetsById[columnFromResponse.setID];
        var column = columnsById[colId];

        if ( ! column ) {
            eventsToEmit.push(['columnAdded',colId]);
            // Remember, the column information can change
            // HOWEVER, assume a column is never removed from one dataset and added to another
            column = columnsById[colId] = {
                id: null,
                name: null,
                units: null,
                receivedValuesTimeStamp: 0,
                requestedValuesTimeStamp: 0,
                liveValueTimeStamp: 0,
                liveValue: null,
                data: []
            };
        } else if (column !== dataset.columns[columnFromResponse.position]) {
            eventsToEmit.push(['columnMoved',colId]);
        }

        dataset.columns[columnFromResponse.position] = column;

        if (column.units !== null && column.units !== columnFromResponse.units) {
            eventsToEmit.push(['columnTypeChanged',colId]);
        }

        column.units = columnFromResponse.units;
        column.name = columnFromResponse.name;
        column.id = colId;
        column.liveValue = parseFloat(columnFromResponse.liveValue || 0);
        column.liveValueTimeStamp = columnFromResponse.liveValueTimeStamp;

        if (column.requestedValuesTimeStamp < columnFromResponse.valuesTimeStamp) {
            requestData(colId, columnFromResponse.valuesTimeStamp);
            column.requestedValuesTimeStamp = columnFromResponse.valuesTimeStamp;
        }
    });

    // Find columns that were removed.
    Object.keys(columnsById).forEach(function(colId) {
        if ( ! cols[colId] ) {
            eventsToEmit.push(['columnRemoved', colId]);
            delete columnsById[colId];
        }
    });

    eventsToEmit.forEach(function(arr) {
        events.emit(arr[0], arr[1]);
    });
}

// Request data if status indicates there's more data
function requestData(colId, timeStamp) {
    var xhr = createCORSRequest('GET', '/columns/' + colId);
    // look, we wouldn't have got here if we didn't support CORS
    xhr.send();

    xhr.onload = function() {
        if ( ! isPolling ) {
            return;
        }
        var response = this.response || JSON.parse(this.responseText);
        if (typeof(response) === "string") { response = JSON.parse(response); }
        var values = response.values;
        var column = columnsById[colId];
        if (timeStamp > column.receivedValuesTimeStamp) {
            column.data.length = 0;
            [].push.apply(column.data, values);
            column.receivedValuesTimeStamp = timeStamp;
            events.emit('data', colId);
        }
    };
}

function promisifyRequest(url) {
    return function() {
        return new RSVP.Promise(function(resolve, reject) {
            var xhr = createCORSRequest('GET', url);
            if ( ! xhr ) {
                reject(new Error("This browser does not appear to support Cross-Origin Resource Sharing"));
            }
            xhr.send();

            // Simply emitting errors isn't quite right because there's no way for the consumer
            // to tie the error to the particular start request
            xhr.onerror = function() {
                reject(this);
            };
            xhr.onload = resolve;
        });
    };
}

module.exports = {

    startPolling: function(address, clientId, clientName) {
        urlPrefix = address;
        _setRawQueryParams('client', clientId);
        _setRawQueryParams('clientName', clientName);
        _generateQueryParams();

        requestStatus();
        isPolling = true;
        isConnected = false;
        launchTimedOut = false;
        timeoutTimer.start();
        statusIntervalId = setInterval(requestStatus, POLLING_DELAY);
    },

    stopPolling: function() {
        timeoutTimer.stop();
        clearInterval(statusIntervalId);
        currentSessionID = undefined;
        isPolling = false;
        if (launchFrame !== null) {
            document.body.removeChild(launchFrame);
            launchFrame = null;
        }
    },

    requestStart: promisifyRequest('/control/start'),

    requestStop: promisifyRequest('/control/stop'),

    on: function() {
        events.on.apply(events, arguments);
    },

    off: function() {
        events.off.apply(events, arguments);
    },

    get clientId() {
        return rawQueryParams.client;
    },

    set clientId(id) {
        _setRawQueryParams('client', id);
        _generateQueryParams();
    },

    get clientName() {
        return rawQueryParams.clientName;
    },

    set clientName(name) {
        _setRawQueryParams('clientName', name);
        _generateQueryParams();
    },

    get hasAttachedInterface() {
        return hasAttachedInterface;
    },

    get datasets() {
        return datasets;
    },

    get isConnected() {
        return isPolling && isConnected;
    },

    get isCollecting() {
        return isPolling && isConnected && isCollecting;
    },

    get inControl() {
        return inControl;
    },

    get launchTimedOut() {
        return launchTimedOut;
    },

    get canControl() {
        return canControl;
    }
};
