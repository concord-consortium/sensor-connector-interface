# Sensor Connector Interface
JavaScript interface for Concord Consortium's SensorConnector software
http://sensorconnector.concord.org/

## Installation and Usage

```
npm install @concord-consortium/sensor-connector-interface --save
```
or if using yarn
```
yarn add @concord-consortium/sensor-connector-interface
```

Then in your JavaScript code:
```
import SensorConnectorInterface from "@concord-consortium/sensor-connector-interface";

const sensorConnector = new SensorConnectorInterface();
```
or
```
var SensorConnectorInterface = require("@concord-consortium/sensor-connector-interface");

var sensorConnector = new SensorConnectorInterface();
```

## Development

Install local dependencies:
```
npm install
```

Build for distribution:
```
npm run build
```

Test locally:
```
npm run start
```

## Methods

### startPolling(addresses, clientId, clientName)

Initiates the connection to the SensorConnector application. `addresses` can be a single address or an array of addresses which are used to communicate with the SensorConnector. The SensorConnector application currently supports `http://127.0.0.1:11180` and `https://127.0.0.1:11181`.

### stopPolling()

Closes the connection to the SensorConnector.

### requestStart()

Starts data collection.

### requestStop()

Stops data collection.

### on(event, listener)

Adds a listener to be fired when the specified event is emitted. The listener is a function whose arguments are the arguments emitted along with the event.

### off(event, listener)

Removes a listener from the set of listeners for an event. Accepts `'*'` for `event`, which allows removal of a listener function from all events for which it is registered as a listener.

## Accessors

Internally, the SensorConnectorInterface is implemented as a finite state machine, so many of the accessors refer to properties of the underlying state machine, such as the current state.

### clientId/clientId(clientId)

Retrieve/set the client ID.

### clientName/clientName(clientName)

Retrieve/set the client name.

### hasAttachedInterface

True if there is a data collection interface attached.

### datasets

The currently collected datasets.

### isConnected

True if a data collection interface is attached, control of the data collection interface is enabled, and the data collection interface is not currently collecting data. (Note: it's not clear why collecting data is considered not connected, but that's the way it's coded.)

### isCollecting

True if the data collection interface is currently collecting data.

### inControl/canControl

True if control of the data collection interface is not currently disabled.

### launchTimedOut

True if the initial launch of the SensorConnectorInterface failed due to a connection timeout.

## Events

The SensorConnectorInterface uses the [EventEmitter2](https://www.npmjs.com/package/eventemitter2) library to emit events for client consumption.

### interfaceConnected: handler() [1]

Sent when a connected data collection interface (e.g. Vernier LabQuest, Go!Link, etc.) is detected. See [1] below for the current means of accessing the sensor configuration.

### interfaceRemoved: handler()

Sent when a connected data collection interface (e.g. Vernier LabQuest, Go!Link, etc.) is no longer detected.

### sessionChanged: handler() [1]

A change in session ID was detected internally. Client should probably stop/start polling. See [1] below for the current means of accessing the sensor configuration.

### collectionStarted: handler()

Sent when data collection has begun.

### collectionStopped: handler()

Sent when data collection has been stopped.

### datasetAdded: handler(datasetID) [1]

Denotes the addition of a new dataset. Not emitted until the second collection because the first dataset always exists. See [1] below for the current means of accessing the sensor configuration.

### data: handler(columnID) [2]

Sent when a column of data is available. See [2] below for the current means of accessing the data.

### columnAdded: handler(columnID) [1]

Sent when a new column of data is received. See [1] below for the current means of accessing the sensor configuration.

### columnMoved: handler(columnID) [1]

Sent when a column of data has changed its position. See [1] below for the current means of accessing the sensor configuration.

### columnRemoved: handler(columnID) [1]

Sent when a column of data is removed. See [1] below for the current means of accessing the sensor configuration.

### columnTypeChanged: handler(columnID) [1]

Sent when a change in the units of a column of data has been detected. See [1] below for the current means of accessing the sensor configuration.

### controlEnabled: handler()

Indicates that the data collection interface still exists and is communicating, and that the Sensor Connector Interface is able to control it at the moment.

### controlDisabled: handler()

Indicates that the data collection interface still exists and is communicating, but that the Sensor Connector Interface is not able to control it at the moment.

### launchTimedOut: handler()

Sent when a communication timeout occurs during launch.

### statusReceived: handler() [1]

Sent when a status update from the connected interface has been successfully processed. See [1] below for the current means of accessing the sensor configuration.

### statusErrored: handler()

Sent when an error occurs.

### [1] currentActionArgs:IStatusReceivedTuple

As an implementation detail, the events marked with a [1] are called from the status response handler of the SensorConnectorInterface. Currently, the contents of the status response can be retrieved with `sensorConnector.stateMachine.currentActionArgs`, i.e. by reaching into the internal state of the finite state machine directly. A better API should be provided for accessing this information and this method should be deprecated. In the meantime, the `currentActionArgs` is a two-element array in which the sensor configuration is in `currentActionArgs[1]`. The `currentActionArgs` have this form as a TypeScript definition:
```
interface ISensorConfigColumnInfo {
  id:string;
  setID:string;
  position:number;
  name:string;
  units:string;
  liveValue:string;
  liveValueTimeStamp:Date;
  valueCount:number;
  valuesTimeStamp:Date;
  data?:number[];
}

interface ISensorConfigSet {
  name:string;
  colIDs:number[];
}

interface ISensorConfig {
  collection:{ canControl:boolean; isCollecting:boolean; };
  columnListTimeStamp:Date;
  columns:{ [key:string]: ISensorConfigColumnInfo; };
  currentInterface:string;
  currentState:string;
  os:{ name:string; version:string; };
  requestTimeStamp:Date;
  server:{ arch:string; version:string; };
  sessionDesc:string;
  sessionID:string;
  sets:{ [key:string]: ISensorConfigSet; };
  setID?:string;
}

interface IMachinaAction {
  inputType:string;
  delegated:boolean;
  ticket:any;
}

interface IStatusReceivedTuple
  extends Array<IMachinaAction|ISensorConfig>
            {0:IMachinaAction, 1:ISensorConfig}
```

### [2] currentActionArgs:IColumnDataTuple

As an implementation detail, the events marked with a [2] are called from the 'columnData' response handler of the SensorConnectorInterface. Currently, the contents of the response can be retrieved with `sensorConnector.stateMachine.currentActionArgs`, i.e. by reaching into the internal state of the finite state machine directly. A better API should be provided for accessing this information and this method should be deprecated. In the meantime, `currentActionArgs` is a four-element array in which:
- `currentActionArgs[1]`: the column ID
- `currentActionArgs[2]`: the column data values
- `currentActionArgs[3]`: the timestamp of the data values

The column data values in `currentActionArgs[2]` are time values for dataset IDs that end in '0', and sensor data values for all other dataset IDs. The `currentActionArgs` have this form as a TypeScript definition:
```
interface IMachinaAction {
  inputType:string;
  delegated:boolean;
  ticket:any;
}

interface IColumnDataTuple
  extends Array<IMachinaAction|string|number[]|Date>
            {0:IMachinaAction, 1:string, 2:number[], 3:Date}
```

## License
Released under the [MIT License](LICENSE).