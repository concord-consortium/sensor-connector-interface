// Type definitions for SensorConnectorInterface 0.1.2
// Project: https://github.com/concord-consortium/sensor-connector-interface
// Definitions by: The Concord Consortium <https://concord.org>

/*~ Note that ES6 modules cannot directly export class objects.
 *~ This file should be imported using the CommonJS-style:
 *~   import x = require('someLibrary');
 *~
 *~ Refer to the documentation to understand common
 *~ workarounds for this limitation of ES6 modules.
 */

/*~ This declaration specifies that the class constructor function
 *~ is the exported object from the file
 *~ You may need to set the "allowSyntheticDefaultImports" property in tsconfig.json
 */
export = SensorConnectorInterface;

declare interface ISensorConnectorState {
    // private implementation details
}

declare interface ISensorDefinition {
    sensorName:string|null;
    measurementName:string;
    measurementType:string;
    tareable:boolean;
    minReading:number;
    maxReading:number;
}

declare interface ISensorConnectorDataset {
    id:string;
    columns:ISensorConfigColumnInfo[];
}

declare interface ISensorConfigColumnInfo {
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
type SensorConfigColumnInfo = ISensorConfigColumnInfo;

declare interface ISensorConfigSet {
    name:string;
    colIDs:number[];
}

declare interface ISensorConfig {
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

declare interface IMachinaAction {
    inputType:string;
    delegated:boolean;
    ticket:any;
}

declare interface IStatusReceivedTuple
          extends Array<IMachinaAction|ISensorConfig>
                    {0:IMachinaAction; 1:ISensorConfig;}

declare interface IColumnDataTuple
          extends Array<IMachinaAction|string|number[]|Date>
                    {0:IMachinaAction; 1:string; 2:number[]; 3:Date;}

/*~ Write your module's methods and properties in this class */
declare class SensorConnectorInterface {
    constructor();

    stateMachine: ISensorConnectorState;

    startPolling(addresses: string | string[], clientId?: string, clientName?: string) : void;
    stopPolling(): void;

    requestStart(measurementPeriod?:number): Promise<string>;
    requestStop(): Promise<string>;

    requestExit(): Promise<string>;
    requestLaunch(): boolean;

    on(event: string, handler: Function): void;
    off(): void;

    clientId: string;
    clientName: string;

    readonly hasAttachedInterface: boolean;

    readonly datasets: ISensorConnectorDataset[];
    readonly currentActionArgs: IStatusReceivedTuple;

    readonly isConnected: boolean;
    readonly isCollecting: boolean;
    readonly inControl: boolean;
    readonly canControl: boolean;
    readonly launchTimedOut: boolean;
}

/*~ If you want to expose types from your module as well, you can
 *~ place them in this block.
 */
declare namespace SensorConnectorInterface {
    export type SensorDefinition = ISensorDefinition;
    export type SensorConnectorDataset = ISensorConnectorDataset
    export type SensorConfigColumnInfo = ISensorConfigColumnInfo
    export type SensorConfig = ISensorConfig
    export type StatusReceivedTuple = IStatusReceivedTuple
    export type ColumnDataTuple = IColumnDataTuple
}
