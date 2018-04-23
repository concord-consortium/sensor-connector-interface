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

require('es6-promise').polyfill();
var _ = require('lodash');
var Machina = require('machina');

var EventEmitter2 = require('eventemitter2').EventEmitter2;
var events = new EventEmitter2({
  wildcard: true
});

var SensorConnectorState = Machina.Fsm.extend({
  urlQueryParams: '',
  urlPrefix: '',
  datasets: null,

  _TIME_LIMIT_IN_MS: 5000,
  _LAUNCH_TIME_LIMIT_IN_MS: 20000,
  _POLLING_DELAY: 500,
  _COLLECTING_DELAY: 100,

  _timer: null,
  _hostCycler: null,
  _rawQueryParams: {},
  _statusIntervalId: 0,
  _lastStatusTimeStamp: 0,
  _datasetsById: {},
  _columnsById: {},
  _sessionChangedEmitted: false,
  _currentSessionID: undefined,
  _launchFrame: null,

  initialize: function() {
    var fsm = this;
    this._timer = {
      timerId: 0,
      start: function(timeLimit) {
        this._timerId = setTimeout(function() { fsm.handle('timeout'); }, timeLimit);
      },

      reset: function() {
        this.stop();
        this.start();
      },

      stop: function() {
        clearTimeout(this._timerId);
      }
    };

    this._hostCycler = {
      get moreHosts() {
        return fsm._currentHostIdx + 1 < fsm._availableHosts.length;
      },

      nextHost: function() {
        fsm._currentHostIdx++;
        fsm.urlPrefix = fsm._availableHosts[fsm._currentHostIdx];
      },

      reset: function() {
        fsm._currentHostIdx = 0;
        fsm.urlPrefix = fsm._availableHosts[fsm._currentHostIdx];
      }
    };

    this._initializeSession();
  },

  initialState: 'disconnected',
  states: {
    disconnected: {
      _onEnter: function() {
        this._currentSessionID = undefined;
        if (this._launchFrame !== null) {
          document.body.removeChild(this._launchFrame);
          this._launchFrame = null;
        }
      }
    },
    connecting: {
      _onEnter: function() {
        this._hostCycler.reset();
        this._requestStatus();
        this._timer.start(this._TIME_LIMIT_IN_MS);
      },
      statusReceived: function() {
        this._timer.stop();
        this.transition('polling');
      },
      statusErrored: function() {
        if (this._hostCycler.moreHosts) {
          this._hostCycler.nextHost();
          this._requestStatus();
        } else {
          this._hostCycler.reset();
          this._timer.stop();
          this.transition('launching');
        }
      },
      timeout: function() {
        this.transition('launching');
      }
    },
    launching: {
      _onEnter: function() {
        this._injectCcscFrame();
        this._timer.start(this._LAUNCH_TIME_LIMIT_IN_MS);
        this._requestStatus();
      },
      statusReceived: function() {
        this._timer.stop();
        this.transition('polling');
      },
      statusErrored: function() {
        // keep polling until the launch timeout time limit passes, but poll all of the available hosts
        if (this._hostCycler.moreHosts) {
          this._hostCycler.nextHost();
          this._requestStatus();
        } else {
          this._hostCycler.reset();
          setTimeout(function(){
            this._requestStatus();
          }.bind(this), this._POLLING_DELAY);
        }
      },
      timeout: function() {
        this.transition('launchTimedOut');
      }
    },
    polling: {
      _onEnter: function() {
        this._requestStatus();
      },
      _onExit: function() {
        this._timer.stop();
      },
      statusReceived: function(response) {
        this._timer.stop();
        this._processStatus(response);

        if (response.collection.isCollecting) {
          this.transition('collecting');
          return;
        }

        if (! response.collection.canControl) {
          this.transition('controlDisabled');
          return;
        }

        var currentlyAttached = typeof(response.currentInterface) === "undefined" || response.currentInterface === null || response.currentInterface !== "None Found";
        if (!currentlyAttached) {
          this.transition('interfaceMissing');
          return;
        }

        // Schedule the next poll request
        setTimeout(function() { this._requestStatus(); }.bind(this), this._POLLING_DELAY);
        this._timer.start(this._TIME_LIMIT_IN_MS);
      },
      statusErrored: function() {
        // TODO
        this._timer.stop();
        this.transition('errored');
      },
      timeout: function() {
        // TODO
        this.transition('errored');
      }

    },
    collecting: {
      _onEnter: function() {
        events.emit('collectionStarted');
        this._requestStatus();
        this._timer.start(this._TIME_LIMIT_IN_MS);
      },
      _onExit: function() {
        events.emit('collectionStopped');
      },
      statusReceived: function(response) {
        this._timer.stop();

        this._processStatus(response);

        if (! response.collection.isCollecting) {
          this.transition('polling');
          return;
        }

        if (! response.collection.canControl) {
          // Somehow we lost control while collecting. This _shouldn't_ ever happen...
          this.transition('controlDisabled');
          return;
        }

        var currentlyAttached = typeof(response.currentInterface) === "undefined" || response.currentInterface === null || response.currentInterface !== "None Found";
        if (!currentlyAttached) {
          this.transition('interfaceMissing');
          return;
        }

        // Schedule the next poll request
        setTimeout(function() { this._requestStatus(); }.bind(this), this._COLLECTING_DELAY);
        this._timer.start(this._TIME_LIMIT_IN_MS);
      },
      columnData: function(colId, values, timeStamp){
        var column = this._columnsById[colId];
        if (timeStamp > column.receivedValuesTimeStamp) {
          column.data.length = 0;
          [].push.apply(column.data, values);
          column.receivedValuesTimeStamp = timeStamp;
          events.emit('data', colId);
        }
      },
      statusErrored: function() {
        this._timer.stop();
        this.transition('errored');
      },
      timeout: function() {
        this.transition('errored');
      }
    },
    controlDisabled: {
      _onEnter: function() {
        events.emit('controlDisabled');
        this._requestStatus();
        this._timer.start(this._TIME_LIMIT_IN_MS);
      },
      _onExit: function() {
        events.emit('controlEnabled');
      },
      statusReceived: function(response) {
        this._timer.stop();

        this._processStatus(response);

        if (response.collection.canControl) {
          this.transition('polling');
          return;
        }

        var currentlyAttached = typeof(response.currentInterface) === "undefined" || response.currentInterface === null || response.currentInterface !== "None Found";
        if (!currentlyAttached) {
          this.transition('interfaceMissing');
          return;
        }

        // Schedule the next poll request
        setTimeout(function() { this._requestStatus(); }.bind(this), this._POLLING_DELAY);
        this._timer.start(this._TIME_LIMIT_IN_MS);
      },
      statusErrored: function() {
        this._timer.stop();
        this.transition('errored');
      },
      timeout: function() {
        this.transition('errored');
      }
    },
    interfaceMissing: {
      _onEnter: function() {
        events.emit('interfaceRemoved');
        this._requestStatus();
        this._timer.start(this._TIME_LIMIT_IN_MS);
      },
      _onExit: function() {
        events.emit('interfaceConnected');
      },
      statusReceived: function(response) {
        this._timer.stop();

        this._processStatus(response);

        var currentlyAttached = typeof(response.currentInterface) === "undefined" || response.currentInterface === null || response.currentInterface !== "None Found";
        if (currentlyAttached) {
          if (response.collection.canControl) {
            this.transition('polling');
          } else {
            this.transition('controlDisabled');
          }
          return;
        }

        // Schedule the next poll request
        setTimeout(function() { this._requestStatus(); }.bind(this), this._POLLING_DELAY);
        this._timer.start(this._TIME_LIMIT_IN_MS);
      },
      statusErrored: function() {
        this._timer.stop();
        this.transition('errored');
      },
      timeout: function() {
        this.transition('errored');
      }
    },
    errored: {
      _onEnter: function() {
        events.emit('statusErrored');
      }
    },
    launchTimedOut: {
      _onEnter: function() {
        events.emit('launchTimedOut');
      }
    },
    unsupported: {
      _onEnter: function() {
        events.emit('statusErrored'); // FIXME
      }
    }
  },

  setHosts: function(hosts) {
    this._availableHosts = _.isArray(hosts) ? hosts : [hosts];
    this._hostCycler.reset();
  },

  getParam: function(param) {
    return this._rawQueryParams[param];
  },

  setParam: function(param, value) {
    this._setRawQueryParams(param, value);
    this._updateQueryParams();
  },

  _setRawQueryParams: function(k, v) {
    if (v == null) {
      delete this._rawQueryParams[k];
    } else {
      this._rawQueryParams[k] = v;
    }
  },

  _updateQueryParams: function() {
    var v;
    Object.keys(this._rawQueryParams).forEach(function(k,i) {
      v = this._rawQueryParams[k];
      if (i === 0) {
        this.urlQueryParams = '?'+k+'='+v;
      } else {
        this.urlQueryParams += '&'+k+'='+v;
      }

    }.bind(this));
  },

  _requestStatus: function() {
    var xhr = this._createCORSRequest('GET', '/status'),
      fsm = this;
    // TODO set xhr timeout

    if (!xhr) {
      this.transition('unsupported');
      return;
    }

    xhr.onerror = function() {
      fsm.handle('statusErrored');
    };
    xhr.onload = function() {
      var response = this.response || JSON.parse(this.responseText); // jshint ignore:line
      if (typeof(response) === "string") { response = JSON.parse(response); }

      fsm.handle('statusReceived', response);
    };
    xhr.send();
  },



  _initializeSession: function() {
    this.datasets = [];
    this._datasetsById = Object.create(null);
    this._columnsById = Object.create(null);
    this._sessionChangedEmitted = false;
  },

  // Return false to abort further processing.
  _processStatus: function(response) {
    if (response.requestTimeStamp < this._lastStatusTimeStamp) {
      // stale out-of-order response; drop it like we never got it.
      return false;
    }

    this._lastStatusTimeStamp = response.requestTimeStamp;

    if ( ! this._currentSessionID ) {
      this._currentSessionID = response.sessionID;
      this._initializeSession();
    } else if (this._currentSessionID !== response.sessionID) {
      // Session ID changed on us unexpectedly. Client should probably stop polling, start polling.
      if ( ! this._sessionChangedEmitted) {
        events.emit('sessionChanged');
        this._sessionChangedEmitted = true;
      }
      this._currentSessionID = response.sessionID;
    }
    else {
      // reset flag after we've returned to the same session
      this._sessionChangedEmitted = false;
    }
    this._processDatasets(response.sets);
    this._processColumns(response.columns);

    // TODO liveValue

    this.inControl = response.collection.inControl;

    events.emit('statusReceived');

    return true;
  },

  // Handle 'datasets' and 'columns' in the response
  _processDatasets: function(sets) {
    Object.keys(sets).forEach(function(setId) {
      if ( ! this._datasetsById[setId] ) {
        // mind, no datasetAdded is emitted until the second collection because the first
        // dataset always exists
        events.emit('datasetAdded', setId);
        this._datasetsById[setId] = {
          columns: [],
          id: setId
        };
        this.datasets.unshift(this._datasetsById[setId]);
      }
      // Set the columns array length so that it's the correct size if a column was removed
      this._datasetsById[setId].columns.length = sets[setId].colIDs.length;
    }.bind(this));
    // make sure the highest-numbered dataset is always datasets[0]
    this.datasets.sort(function(d1, d2) { return d2.setId-d1.setId; });
  },

  _processColumns: function(cols) {
    // looks familiar
    var eventsToEmit = [];
    Object.keys(cols).forEach(function(colId) {
      var columnFromResponse = cols[colId];
      var dataset = this._datasetsById[columnFromResponse.setID];
      var column = this._columnsById[colId];

      if ( ! column ) {
        eventsToEmit.push(['columnAdded',colId]);
        // Remember, the column information can change
        // HOWEVER, assume a column is never removed from one dataset and added to another
        column = this._columnsById[colId] = {
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
        this._requestData(colId, columnFromResponse.valuesTimeStamp);
        column.requestedValuesTimeStamp = columnFromResponse.valuesTimeStamp;
      }
    }.bind(this));

    // Find columns that were removed.
    Object.keys(this._columnsById).forEach(function(colId) {
      if ( ! cols[colId] ) {
        eventsToEmit.push(['columnRemoved', colId]);
        delete this._columnsById[colId];
      }
    }.bind(this));

    eventsToEmit.forEach(function(arr) {
      events.emit(arr[0], arr[1]);
    });
  },

  // Request data if status indicates there's more data
  _requestData: function(colId, timeStamp) {
    var xhr = this._createCORSRequest('GET', '/columns/' + colId),
      fsm = this;
    // look, we wouldn't have got here if we didn't support CORS
    xhr.send();

    xhr.onload = function() {
      var response = this.response || JSON.parse(this.responseText);
      if (typeof(response) === "string") { response = JSON.parse(response); }
      var values = response.values;
      fsm.handle('columnData', colId, values, timeStamp);
    };
  },

  // see http://www.html5rocks.com/en/tutorials/cors/
  _createCORSRequest: function(method, relativeUrl) {
    // ignore requests before we've connected
    if (!this.urlPrefix) return null;

    var url = this.urlPrefix + relativeUrl + this.urlQueryParams;
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
  },

  promisifyRequest: function(url) {
    var fsm = this;
    return new Promise(function(resolve, reject) {
      var xhr = fsm._createCORSRequest('GET', url);
      if ( ! xhr ) {
        reject(new Error("Must connect to SensorConnector first."));
      }
      xhr.send();

      // Simply emitting errors isn't quite right because there's no way for the consumer
      // to tie the error to the particular start request
      xhr.onerror = function() {
        reject(this);
      };
      xhr.onload = resolve;
    });
  },

  _injectCcscFrame: function() {
    if (this._launchFrame !== null) {
      document.body.removeChild(this._launchFrame);
    }
    var obj = document.createElement('div');
    obj.id = 'sensor-connector-launch-frame-parent';
    obj.style.visibility = 'hidden';
    obj.innerHTML = '<iframe id="sensor-connector-launch-frame" src="ccsc://sensorconnector.concord.org/"></iframe>';
    document.body.appendChild(obj);
    this._launchFrame = document.getElementById('sensor-connector-launch-frame-parent');
  }

});

/**
 * @constructor
 */
var SensorConnectorInterface = function(){
  return {
    stateMachine: new SensorConnectorState(),

    startPolling: function(addresses, clientId, clientName) {
      this.stateMachine.setHosts(addresses);
      this.stateMachine.setParam('client', clientId);
      this.stateMachine.setParam('clientName', clientName);

      this.stateMachine.transition('connecting');
    },

    stopPolling: function() {
      this.stateMachine.transition('disconnected');
    },

    requestStart: function() { return this.stateMachine.promisifyRequest('/control/start'); },

    requestStop: function() { return this.stateMachine.promisifyRequest('/control/stop'); },

    requestExit: function() {
      return this.stateMachine.promisifyRequest('/exit');
    },

    // Returns true if the SensorConnector is already running,
    // false if launch was actually required/attempted (in which
    // case client may need to delay further communication for a bit).
    requestLaunch: function() {
      if (this.isConnected) {
        // already running/connected
        return true;
      }
      else {
        // attempt to launch
        this.stateMachine.transition('launching');
        return false;
      }
    },

    on: function() {
      events.on.apply(events, arguments);
    },

    off: function() {
      if (arguments.length)
        events.off.apply(events, arguments);
      else
        events.removeAllListeners();
    },

    get clientId() {
      return this.stateMachine.getParam('client');
    },

    set clientId(id) {
      this.stateMachine.setParam('client', id);
    },

    get clientName() {
      return this.stateMachine.getParam('clientName');
    },

    set clientName(name) {
      this.stateMachine.setParam('clientName', name);
    },

    get hasAttachedInterface() {
      return this.stateMachine.state !== 'interfaceMissing';
    },

    get datasets() {
      return this.stateMachine.datasets;
    },

    get currentActionArgs() {
      return this.stateMachine.currentActionArgs;
    },

    get isConnected() {
      return ['polling','collecting','controlDisabled','interfaceMissing'].indexOf(this.stateMachine.state) !== -1;
    },

    get isCollecting() {
      return this.stateMachine.state === 'collecting';
    },

    get inControl() {
      return this.stateMachine.state !== 'controlDisabled';
    },

    get canControl() {
      return this.stateMachine.state !== 'controlDisabled';
    },

    get launchTimedOut() {
      return this.stateMachine.state === 'launchTimedOut';
    }
  };
}

module.exports = SensorConnectorInterface;
