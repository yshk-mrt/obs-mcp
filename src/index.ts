// OBS MCP Server (TypeScript)

// Redirect console logging to stderr to keep stdout clean for MCP communication
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = (...args: any[]) => {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    const formatted = `[LOG] ${new Date().toISOString()} ${message}\n`;
    process.stderr.write(formatted);
    try {
        fs.appendFileSync(path.join(os.homedir(), 'obs_mcp_debug.log'), formatted);
    } catch (_) {}
};
console.warn = (...args: any[]) => {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    const formatted = `[WARN] ${new Date().toISOString()} ${message}\n`;
    process.stderr.write(formatted);
    try { fs.appendFileSync(path.join(os.homedir(), 'obs_mcp_debug.log'), formatted); } catch (_) {}
};
console.error = (...args: any[]) => {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    const formatted = `[ERR] ${new Date().toISOString()} ${message}\n`;
    process.stderr.write(formatted);
    try { fs.appendFileSync(path.join(os.homedir(), 'obs_mcp_debug.log'), formatted); } catch (_) {}
};

console.log("OBS MCP Server starting... (logging to stderr)"); 

// import { McpServer, ReadResourceRequestSchema, ReadResourceResponse } from "@modelcontextprotocol/sdk/server/mcp.js";
// Temporary: Use any for potentially missing types
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// type ReadResourceRequestSchema = any; // Placeholder, was type
const ReadResourceRequestSchema = "resources/read"; // Attempting to use a string identifier
type ReadResourceResponse = any;      // Placeholder

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, ZodType } from "zod";
import WebSocket from "ws";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

// --- Configuration ---
const OBS_WEBSOCKET_URL = process.env.OBS_WEBSOCKET_URL || "ws://localhost:4455";
const OBS_PASSWORD = process.env.OBS_PASSWORD || "xCxyDXkMEOWGGXwt"; // Keep this secure or use env vars
const SCREENSHOTS_DIR_NAME = "screenshots";
const WORKSPACE_ROOT = path.resolve(__dirname, "..", ".."); // Assuming src is one level down from obs-mcp-server-ts
const SCREENSHOTS_DIR_ABS = path.join(WORKSPACE_ROOT, "obs-mcp-server-ts", SCREENSHOTS_DIR_NAME);

interface ObsRequest {
    op: number;
    d: {
        requestType: string;
        requestId: string;
        requestData?: any;
        rpcVersion?: number;
        authentication?: string;
    };
}

interface ObsResponse {
    op: number;
    d: {
        requestId?: string;
        requestType?: string;
        requestStatus?: {
            code: number;
            result: boolean;
            comment?: string;
        };
        responseData?: any;
        eventData?: any;
        eventType?: string;
        authentication?: {
            challenge: string;
            salt: string;
        };
    };
}

// --- Globals ---
let obsClient: WebSocket | null = null;
let obsRequestIdCounter = 0;
const pendingObsRequests: Map<string, { resolve: (data: any) => void; reject: (error: any) => void, mcpContext?: any, actionName: string }> = new Map();
let obsConnectionPromise: Promise<void> | null = null;
let isObsConnecting = false;
let reconnectInterval = 5000; // 5 seconds

// --- Load tool definitions ---
const TOOL_DEF_FILE = path.join(__dirname, "obs_mcp_tool_def.json");
let toolDefinitions: { name: string, version: string, description: string, actions: any[] } = { name: 'obs-mcp-default', version: '0.0.1', description: 'OBS MCP Default', actions: []};
try {
    const toolDefContent = fs.readFileSync(TOOL_DEF_FILE, "utf-8");
    toolDefinitions = JSON.parse(toolDefContent);
} catch (error) {
    console.error(`Error loading tool definitions from ${TOOL_DEF_FILE}:`, error);
    // Proceed with empty actions or default
}

function zodSchemaFromMcpSchema(mcpSchema: any): ZodType | undefined {
    if (!mcpSchema || !mcpSchema.type) {
        return undefined;
    }

    switch (mcpSchema.type) {
        case "object":
            const shape: Record<string, ZodType> = {};
            if (mcpSchema.properties) {
                for (const key in mcpSchema.properties) {
                    const propSchema = zodSchemaFromMcpSchema(mcpSchema.properties[key]);
                    if (propSchema) {
                        shape[key] = propSchema;
                    }
                }
            }
            let zodObject = z.object(shape);
            // Zod doesn't have a direct equivalent for making only specific fields optional easily from schema alone
            // MCP's "required" array means fields NOT in it are optional. Zod by default makes all fields in an object required.
            // We would need to iterate 'properties' and if a key is not in 'mcpSchema.required', apply .optional()
            // For now, this simplified version assumes all defined properties are required unless explicitly made optional in a more complex mapping
            if (mcpSchema.required && Array.isArray(mcpSchema.required)) {
                // This part is tricky with Zod's builder pattern.
                // A more robust solution might involve constructing the object then iterating properties to add .optional()
                // For simplicity, we'll rely on Zod's default behavior (all fields required unless .optional() is called)
                // and users should define schemas carefully.
            }
            return zodObject;
        case "string":
            let zodString = z.string();
            if (mcpSchema.description) zodString = zodString.describe(mcpSchema.description);
            // Handle enums if present
            if (mcpSchema.enum && Array.isArray(mcpSchema.enum)) {
                 // z.enum requires at least one value, and TypeScript needs it to be const or string literal array
                 // This dynamic creation is a bit tricky. For simplicity, assuming string enums.
                 if (mcpSchema.enum.length > 0) {
                    // Cast to [string, ...string[]] to satisfy z.enum type
                    return z.enum(mcpSchema.enum as [string, ...string[]]);
                 }
            }
            return zodString;
        case "boolean":
            let zodBoolean = z.boolean();
            if (mcpSchema.description) zodBoolean = zodBoolean.describe(mcpSchema.description);
            return zodBoolean;
        case "integer":
            let zodInteger = z.number().int();
            if (mcpSchema.description) zodInteger = zodInteger.describe(mcpSchema.description);
            return zodInteger;
        case "number":
            let zodNumber = z.number();
            if (mcpSchema.description) zodNumber = zodNumber.describe(mcpSchema.description);
            return zodNumber;
        // Add other type mappings as needed (array, etc.)
        default:
            console.warn(`Unsupported MCP schema type: ${mcpSchema.type}`);
            return undefined;
    }
}


async function generateRequestId(): Promise<string> {
    return crypto.randomUUID();
}

async function connectToObs(): Promise<void> {
    if (obsClient && obsClient.readyState === WebSocket.OPEN) {
        return Promise.resolve();
    }
    if (isObsConnecting && obsConnectionPromise) {
        return obsConnectionPromise;
    }
    isObsConnecting = true;

    console.log(`Attempting to connect to OBS at ${OBS_WEBSOCKET_URL}...`);

    obsConnectionPromise = new Promise((resolve, reject) => {
        const ws = new WebSocket(OBS_WEBSOCKET_URL);
        obsClient = ws; // Assign early for listener setup

        ws.onopen = () => {
            console.log("OBS WebSocket connection established. Waiting for Hello.");
            // No immediate resolve here, wait for identify sequence
        };

        ws.onmessage = async (event) => {
            try {
                const message = JSON.parse(event.data.toString()) as ObsResponse;
                // console.log("OBS RX:", JSON.stringify(message, null, 2));

                if (message.op === 0) { // Hello
                    console.log("OBS Hello received.");
                    const identifyPayload: ObsRequest = {
                        op: 1,
                        d: {
                            rpcVersion: 1,
                            requestType: "Identify", // Not standard but for clarity
                            requestId: await generateRequestId(),
                        },
                    };
                    if (OBS_PASSWORD && message.d.authentication) {
                        const auth = message.d.authentication;
                        const secret = crypto.createHash('sha256').update(OBS_PASSWORD + auth.salt).digest();
                        const authResponse = crypto.createHash('sha256').update(secret.toString('base64') + auth.challenge).digest().toString('base64');
                        identifyPayload.d.authentication = authResponse;
                    } else if (message.d.authentication && !OBS_PASSWORD) {
                        console.warn("OBS requires authentication, but no password provided in config.");
                        // Potentially reject or close here if strict auth is needed.
                    }
                    ws.send(JSON.stringify(identifyPayload));
                    console.log("OBS Identify sent.");
                } else if (message.op === 2) { // Identified
                    console.log("Successfully connected and identified with OBS.");
                    isObsConnecting = false;
                    resolve(); // Connection is fully established
                } else if (message.op === 7) { // RequestResponse
                    const reqId = message.d.requestId;
                    if (reqId && pendingObsRequests.has(reqId)) {
                        const pending = pendingObsRequests.get(reqId)!;
                        if (message.d.requestStatus?.code === 100) { // Success code for obs-websocket v5
                            pending.resolve(message.d.responseData || {});
                        } else {
                            const errorDetail = message.d.requestStatus?.comment || `OBS Error Code: ${message.d.requestStatus?.code}`;
                            console.error(`OBS request '${message.d.requestType}' failed for MCP action '${pending.actionName}':`, errorDetail);
                            pending.reject(new Error(errorDetail));
                        }
                        pendingObsRequests.delete(reqId);
                    }
                } else if (message.op === 5) { // Event
                    // console.log(`OBS Event: ${message.d.eventType}`, message.d.eventData);
                    // TODO: Translate OBS events to MCP events and broadcast
                    // Example:
                    // if (message.d.eventType === "CurrentProgramSceneChanged") {
                    //     server.emitEvent("SceneChanged", { to: message.d.eventData?.sceneName });
                    // }
                } else {
                    // console.log("OBS Unhandled Op:", message.op, message.d);
                }
            } catch (e) {
                console.error("Error processing OBS message:", e);
            }
        };

        ws.onerror = (error) => {
            console.error("OBS WebSocket error:", error.message);
            if (isObsConnecting) { // Only reject original promise if this is the initial connection attempt
                reject(error);
            }
            // Don't reset obsClient here if onclose will handle it
        };

        ws.onclose = (event) => {
            console.log(`OBS WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}`);
            obsClient = null; // Critical to mark as disconnected
            if (isObsConnecting) { // If it was still in the connecting phase
                 reject(new Error(`OBS connection closed during setup. Code: ${event.code}`));
            }
            isObsConnecting = false;
            obsConnectionPromise = null; // Clear the promise so next call attempts to reconnect

            // Clean up pending requests on disconnect
            pendingObsRequests.forEach(pending => {
                pending.reject(new Error("OBS WebSocket disconnected"));
            });
            pendingObsRequests.clear();

            console.log(`Attempting to reconnect to OBS in ${reconnectInterval / 1000}s...`);
            setTimeout(() => {
                 connectToObs().catch(err => console.error("Reconnect attempt failed:", err)); // Start a new connection attempt
            }, reconnectInterval);
        };
    });
    return obsConnectionPromise;
}


async function sendToObs<T = any>(requestType: string, requestData?: any, mcpContext?: any, actionName?: string): Promise<T> {
    if (!obsClient || obsClient.readyState !== WebSocket.OPEN) {
        if (!isObsConnecting) { // Avoid multiple concurrent connection attempts from sendToObs
            console.log("OBS not connected. Attempting to connect before sending.");
            try {
                await connectToObs(); // Attempt to connect first
                if (!obsClient || obsClient.readyState !== WebSocket.OPEN) { // Check again after attempt
                     throw new Error("OBS WebSocket is not connected after attempt.");
                }
            } catch (connectError) {
                 console.error("Failed to connect to OBS for sendToObs:", connectError);
                 throw new Error(`OBS Connection Error: ${(connectError as Error).message}`);
            }
        } else {
             // If it's already connecting, we should ideally wait for obsConnectionPromise
             // For now, throwing an error or queuing the request might be options.
             // Let's throw, as the logic to queue and wait can get complex quickly here.
             console.warn("OBS is currently connecting. Request will likely fail or be delayed.");
             // Fall through to try sending, but it might fail if connection isn't ready.
        }
    }
    
    // Re-check after potential connectToObs call
    if (!obsClient || obsClient.readyState !== WebSocket.OPEN) {
        throw new Error("OBS WebSocket is not connected or ready.");
    }


    const obsRequestId = await generateRequestId();
    const payload: ObsRequest = {
        op: 6, // Request
        d: {
            requestType,
            requestId: obsRequestId,
            requestData,
        },
    };
    
    console.log("Full OBS request payload:", JSON.stringify(payload, null, 2));

    return new Promise((resolve, reject) => {
        if (mcpContext && actionName) { // Only store if it's an MCP-initiated request needing response mapping
            pendingObsRequests.set(obsRequestId, { resolve, reject, mcpContext, actionName });
        } else {
            // If not from MCP tool (e.g. internal calls), handle response directly or differently
            // For now, still use pendingObsRequests for simplicity
            pendingObsRequests.set(obsRequestId, { resolve, reject, mcpContext: mcpContext!, actionName: actionName || requestType });
        }

        // console.log("OBS TX:", JSON.stringify(payload, null, 2));
        obsClient!.send(JSON.stringify(payload), (err) => {
            if (err) {
                console.error(`Error sending to OBS for request '${requestType}':`, err);
                pendingObsRequests.delete(obsRequestId);
                reject(err);
            }
        });

        // Timeout for OBS requests
        setTimeout(() => {
            if (pendingObsRequests.has(obsRequestId)) {
                console.warn(`OBS request '${requestType}' (ID: ${obsRequestId}) timed out.`);
                pendingObsRequests.get(obsRequestId)?.reject(new Error(`OBS request '${requestType}' timed out.`));
                pendingObsRequests.delete(obsRequestId);
            }
        }, 10000); // 10 seconds timeout
    });
}


// --- MCP Server Setup ---
const mcpServerOptions = {
    name: toolDefinitions.name || "obs-mcp-ts",
    version: toolDefinitions.version || "0.1.0",
    description: toolDefinitions.description || "MCP Server for controlling OBS Studio (TypeScript)",
    // tools: [], // Tools are added dynamically later
};

const server = new McpServer(mcpServerOptions);

// Dynamically add tools from JSON definition
if (toolDefinitions && toolDefinitions.actions) {
    toolDefinitions.actions.forEach(action => {
        const requestSchema = action.requestDataSchema ? zodSchemaFromMcpSchema(action.requestDataSchema) : undefined;

        server.tool(
            action.name,
            action.description || "",
            requestSchema ? { params: requestSchema } : {},
            async (params: any, context: any) => { // Using any for context if ToolContext is not easily available
                console.log(`Tool '${action.name}' called with params:`, JSON.stringify(params, null, 2));
                try {
                    // Ensure OBS is connected before attempting to send a command
                    if (!obsClient || obsClient.readyState !== WebSocket.OPEN) {
                        if (!isObsConnecting) {
                            console.log("OBS not connected. Attempting to connect before processing tool action.");
                            await connectToObs(); // This will throw if it fails
                            if (!obsClient || obsClient.readyState !== WebSocket.OPEN) {
                                throw new Error("Failed to connect to OBS.");
                            }
                        } else {
                            // Wait for existing connection attempt
                            await obsConnectionPromise;
                             if (!obsClient || obsClient.readyState !== WebSocket.OPEN) {
                                throw new Error("Failed to connect to OBS after waiting.");
                            }
                        }
                    }


                    let obsResponseData: any;
                    // Map MCP actions to OBS requestTypes and params
                    switch (action.name) {
                        case "SwitchScene":
                            console.log("SwitchScene params:", JSON.stringify(params, null, 2));
                            // Extract the scene name from the parameters
                            const sceneName = params.scene || (params.params && params.params.scene);
                            console.log("Extracted sceneName:", sceneName);
                            
                            if (!sceneName) {
                                throw new Error("No scene name provided");
                            }
                            
                            try {
                                // NOTE: Changed from SetCurrentProgramScene to use the direct parameters expected by OBS
                                obsResponseData = await sendToObs(
                                    "SetCurrentProgramScene", 
                                    { "sceneName": sceneName }, // Make sure we use the exact field name OBS expects
                                    context,
                                    action.name
                                );
                                console.log("OBS response:", JSON.stringify(obsResponseData, null, 2));
                            } catch (error) {
                                console.error("OBS error:", error);
                                throw error;
                            }
                            break;
                        case "StartStream":
                            obsResponseData = await sendToObs("StartStream", {}, context, action.name);
                            break;
                        case "StopStream":
                            obsResponseData = await sendToObs("StopStream", {}, context, action.name);
                            break;
                        case "StartRecording":
                            obsResponseData = await sendToObs("StartRecord", {}, context, action.name);
                            break;
                        case "StopRecording":
                            obsResponseData = await sendToObs("StopRecord", {}, context, action.name);
                            break;
                        case "SetSourceVisibility":
                            console.log("SetSourceVisibility params:", JSON.stringify(params, null, 2));
                            // Try different parameter access patterns
                            const sourceScene = params.scene || (params.params && params.params.scene);
                            const sourceName = params.source || (params.params && params.params.source);
                            const visible = params.visible !== undefined ? params.visible : 
                                           (params.params && params.params.visible !== undefined ? params.params.visible : null);
                            
                            if (!sourceScene || !sourceName || visible === null) {
                                throw new Error("Missing required parameters: scene, source, or visible");
                            }

                            const sceneItemIdResponse = await sendToObs<{ sceneItemId: number }>(
                                "GetSceneItemId",
                                { sceneName: sourceScene, sourceName: sourceName },
                                context,
                                action.name
                            );
                            obsResponseData = await sendToObs(
                                "SetSceneItemEnabled",
                                { sceneName: sourceScene, sceneItemId: sceneItemIdResponse.sceneItemId, sceneItemEnabled: visible },
                                context,
                                action.name
                            );
                            break;
                        case "GetSceneItemList":
                            // Extract sceneName from params
                            const sceneNameForItems = params.sceneName || params.scene || (params.params && (params.params.sceneName || params.params.scene));
                            if (!sceneNameForItems) {
                                throw new Error("Missing required parameter: sceneName");
                            }
                            obsResponseData = await sendToObs(
                                "GetSceneItemList",
                                { sceneName: sceneNameForItems },
                                context,
                                action.name
                            );
                            // Transform isGroup: null to isGroup: false to match schema
                            if (obsResponseData && Array.isArray(obsResponseData.sceneItems)) {
                                obsResponseData.sceneItems.forEach((item: any) => {
                                    if (item.isGroup === null) {
                                        item.isGroup = false;
                                    }
                                });
                            }
                            break;
                        case "GetSceneList":
                            obsResponseData = await sendToObs("GetSceneList", {}, context, action.name);
                            break;
                        case "SetTextContent":
                            console.log("SetTextContent params:", JSON.stringify(params, null, 2));
                            // Extract parameters
                            const textSourceName = params.source || (params.params && params.params.source);
                            const textContent = params.text || (params.params && params.params.text);
                            
                            if (!textSourceName || textContent === undefined) {
                                throw new Error("Missing required parameters: source or text");
                            }
                            
                            console.log(`Setting text content for source "${textSourceName}" to: ${textContent}`);
                            
                            try {
                                // Use SetInputSettings to update the text property
                                obsResponseData = await sendToObs(
                                    "SetInputSettings",
                                    { 
                                        inputName: textSourceName, 
                                        inputSettings: { 
                                            text: textContent 
                                        }
                                    },
                                    context,
                                    action.name
                                );
                                console.log("SetTextContent response:", JSON.stringify(obsResponseData, null, 2));
                            } catch (error) {
                                console.error("Error setting text content:", error);
                                throw error;
                            }
                            break;
                        case "SetAudioMute":
                            console.log("SetAudioMute params:", JSON.stringify(params, null, 2));
                            // Extract parameters
                            const audioSourceName = params.source || (params.params && params.params.source);
                            const muteState = params.mute !== undefined ? params.mute : 
                                             (params.params && params.params.mute !== undefined ? params.params.mute : null);
                            
                            if (!audioSourceName || muteState === null) {
                                throw new Error("Missing required parameters: source or mute");
                            }
                            
                            console.log(`Setting mute state for source "${audioSourceName}" to: ${muteState}`);
                            
                            try {
                                obsResponseData = await sendToObs(
                                    "SetInputMute",
                                    { 
                                        inputName: audioSourceName, 
                                        inputMuted: muteState 
                                    },
                                    context,
                                    action.name
                                );
                                console.log("SetAudioMute response:", JSON.stringify(obsResponseData, null, 2));
                            } catch (error) {
                                console.error("Error setting audio mute state:", error);
                                throw error;
                            }
                            break;
                        case "SetAudioVolume":
                            console.log("SetAudioVolume params:", JSON.stringify(params, null, 2));
                            // Extract parameters
                            const volumeSourceName = params.source || (params.params && params.params.source);
                            const volumeLevel = params.volume !== undefined ? params.volume : 
                                              (params.params && params.params.volume !== undefined ? params.params.volume : null);
                            
                            if (!volumeSourceName || volumeLevel === null) {
                                throw new Error("Missing required parameters: source or volume");
                            }
                            
                            if (volumeLevel < 0 || volumeLevel > 1) {
                                throw new Error("Volume must be between 0.0 and 1.0");
                            }
                            
                            console.log(`Setting volume for source "${volumeSourceName}" to: ${volumeLevel}`);
                            
                            try {
                                obsResponseData = await sendToObs(
                                    "SetInputVolume",
                                    { 
                                        inputName: volumeSourceName, 
                                        inputVolumeMul: volumeLevel  // Using multiplier (0.0 to 1.0) format
                                    },
                                    context,
                                    action.name
                                );
                                console.log("SetAudioVolume response:", JSON.stringify(obsResponseData, null, 2));
                            } catch (error) {
                                console.error("Error setting audio volume:", error);
                                throw error;
                            }
                            break;
                        case "SetSourcePosition":
                            console.log("SetSourcePosition params:", JSON.stringify(params, null, 2));
                            // Extract parameters
                            const posSceneName = params.scene || (params.params && params.params.scene);
                            const posSourceName = params.source || (params.params && params.params.source);
                            const xPos = params.x !== undefined ? params.x : 
                                       (params.params && params.params.x !== undefined ? params.params.x : null);
                            const yPos = params.y !== undefined ? params.y : 
                                       (params.params && params.params.y !== undefined ? params.params.y : null);
                            
                            if (!posSceneName || !posSourceName || xPos === null || yPos === null) {
                                throw new Error("Missing required parameters: scene, source, x, or y");
                            }
                            
                            console.log(`Setting position for source "${posSourceName}" in scene "${posSceneName}" to: x=${xPos}, y=${yPos}`);
                            
                            try {
                                // First get the scene item ID
                                const posItemIdResponse = await sendToObs<{ sceneItemId: number }>(
                                    "GetSceneItemId",
                                    { sceneName: posSceneName, sourceName: posSourceName },
                                    context,
                                    action.name
                                );
                                
                                // Then set the position
                                obsResponseData = await sendToObs(
                                    "SetSceneItemTransform",
                                    { 
                                        sceneName: posSceneName, 
                                        sceneItemId: posItemIdResponse.sceneItemId,
                                        sceneItemTransform: {
                                            positionX: xPos,
                                            positionY: yPos
                                        }
                                    },
                                    context,
                                    action.name
                                );
                                console.log("SetSourcePosition response:", JSON.stringify(obsResponseData, null, 2));
                            } catch (error) {
                                console.error("Error setting source position:", error);
                                throw error;
                            }
                            break;
                        case "SetSourceScale":
                            console.log("SetSourceScale params:", JSON.stringify(params, null, 2));
                            // Extract parameters
                            const scaleSceneName = params.scene || (params.params && params.params.scene);
                            const scaleSourceName = params.source || (params.params && params.params.source);
                            const scaleX = params.scaleX !== undefined ? params.scaleX : 
                                         (params.params && params.params.scaleX !== undefined ? params.params.scaleX : null);
                            const scaleY = params.scaleY !== undefined ? params.scaleY : 
                                         (params.params && params.params.scaleY !== undefined ? params.params.scaleY : null);
                            
                            if (!scaleSceneName || !scaleSourceName || scaleX === null || scaleY === null) {
                                throw new Error("Missing required parameters: scene, source, scaleX, or scaleY");
                            }
                            
                            console.log(`Setting scale for source "${scaleSourceName}" in scene "${scaleSceneName}" to: scaleX=${scaleX}, scaleY=${scaleY}`);
                            
                            try {
                                // First get the scene item ID
                                const scaleItemIdResponse = await sendToObs<{ sceneItemId: number }>(
                                    "GetSceneItemId",
                                    { sceneName: scaleSceneName, sourceName: scaleSourceName },
                                    context,
                                    action.name
                                );
                                
                                // Then set the scale
                                obsResponseData = await sendToObs(
                                    "SetSceneItemTransform",
                                    { 
                                        sceneName: scaleSceneName, 
                                        sceneItemId: scaleItemIdResponse.sceneItemId,
                                        sceneItemTransform: {
                                            scaleX: scaleX,
                                            scaleY: scaleY
                                        }
                                    },
                                    context,
                                    action.name
                                );
                                console.log("SetSourceScale response:", JSON.stringify(obsResponseData, null, 2));
                            } catch (error) {
                                console.error("Error setting source scale:", error);
                                throw error;
                            }
                            break;
                        case "TakeSourceScreenshot":
                            // Try to get source from params or params.params
                            const mcpInputParams = params.params || params;
                            const sourceNameForScreenshot = mcpInputParams.source; // Assuming 'source' is the key from MCP

                            if (!sourceNameForScreenshot) {
                                console.error("TakeSourceScreenshot Error: Missing required parameter 'source'. Params received:", JSON.stringify(params, null, 2));
                                throw new Error("Missing required parameter: source");
                            }
                            
                            // Ensure sourceNameForScreenshot is a string before calling replace
                            if (typeof sourceNameForScreenshot !== 'string') {
                                console.error("TakeSourceScreenshot Error: 'source' parameter is not a string. Value:", sourceNameForScreenshot);
                                throw new Error("'source' parameter must be a string.");
                            }

                            console.log(`Executing TakeSourceScreenshot for source: ${sourceNameForScreenshot}`);

                            const format = mcpInputParams.imageFormat || "png";
                            const timestamp = Date.now();
                            const filename = `screenshot-${sourceNameForScreenshot.replace(/[^a-z0-9]/gi, '_')}-${timestamp}.${format}`;
                            const absoluteFilePath = path.join(SCREENSHOTS_DIR_ABS, filename);
                            
                            // URI that will be returned to the client
                            const resourceUri = `file://${absoluteFilePath}`;

                            console.log(`Attempting to save screenshot to: ${absoluteFilePath}`);

                            try {
                                const obsRequestData: any = {
                                    sourceName: sourceNameForScreenshot, // OBS uses sourceName for SaveSourceScreenshot
                                    imageFormat: format,
                                    imageFilePath: absoluteFilePath, 
                                };
                                if (mcpInputParams.width !== undefined) obsRequestData.imageWidth = mcpInputParams.width;
                                if (mcpInputParams.height !== undefined) obsRequestData.imageHeight = mcpInputParams.height;
                                if (mcpInputParams.compressionQuality !== undefined) obsRequestData.imageCompressionQuality = mcpInputParams.compressionQuality;

                                // Use SaveSourceScreenshot OBS request
                                const obsResponse = await sendToObs("SaveSourceScreenshot", obsRequestData, context, "TakeSourceScreenshot");
                                
                                console.log(`SaveSourceScreenshot OBS response:`, obsResponse); 
                                console.log(`Screenshot for source ${sourceNameForScreenshot} saved to ${absoluteFilePath}. Returning URI: ${resourceUri}`);
                                
                                // Return the URI to the client as a resource
                                return {
                                    content: [{
                                        type: "resource",
                                        resource: {
                                            uri: resourceUri,
                                            text: `Screenshot for ${sourceNameForScreenshot} available at ${filename}`,
                                            // mimeType: `image/${format}` // Optional: include mimeType if known
                                        }
                                    }],
                                    filename: filename // Additional top-level info
                                };

                            } catch (e: any) {
                                console.error(`Error in TakeSourceScreenshot for source ${sourceNameForScreenshot}:`, e.message);
                                throw new Error(`Failed to take screenshot for ${sourceNameForScreenshot}: ${e.message}`);
                            }
                            break;
                        case "SetTransitionSettings":
                            const transitionParams = params as { transitionName: string; transitionDuration: number };
                            console.log(`Executing SetTransitionSettings with params:`, transitionParams);
                            try {
                                await sendToObs("SetCurrentSceneTransition", { transitionName: transitionParams.transitionName }, context, action.name);
                                await sendToObs("SetCurrentSceneTransitionSettings", { transitionSettings: { duration: transitionParams.transitionDuration }, overlay: false }, context, action.name);
                                return { structuredContent: { success: true } };
                            } catch (e: any) {
                                console.error(`Error in SetTransitionSettings for OBS:`, e.message);
                                return { structuredContent: { success: false, error: e.message } };
                            }
                        case "TriggerStudioModeTransition":
                            console.log(`Executing TriggerStudioModeTransition`);
                            try {
                                await sendToObs("TriggerStudioModeTransition", {}, context, action.name);
                                return { structuredContent: { success: true } };
                            } catch (e: any) {
                                console.error(`Error in TriggerStudioModeTransition for OBS:`, e.message);
                                return { structuredContent: { success: false, error: e.message } };
                            }
                        case "PlayPauseMedia":
                            const mediaParams = params as { sourceName: string; mediaAction: string };
                            console.log(`Executing PlayPauseMedia with params:`, mediaParams);
                            try {
                                await sendToObs("TriggerMediaInputAction", { inputName: mediaParams.sourceName, mediaAction: mediaParams.mediaAction.toUpperCase() }, context, action.name);
                                return { structuredContent: { success: true } };
                            } catch (e: any) {
                                console.error(`Error in PlayPauseMedia for OBS:`, e.message);
                                return { structuredContent: { success: false, error: e.message } };
                            }
                        case "SetMediaTime":
                            const timeParams = params as { sourceName: string; mediaTime: number };
                            console.log(`Executing SetMediaTime with params:`, timeParams);
                            try {
                                await sendToObs("SetMediaInputCursor", { inputName: timeParams.sourceName, mediaCursor: timeParams.mediaTime }, context, action.name);
                                return { structuredContent: { success: true } };
                            } catch (e: any) {
                                console.error(`Error in SetMediaTime for OBS:`, e.message);
                                return { structuredContent: { success: false, error: e.message } };
                            }
                        case "SaveReplayBuffer":
                            console.log(`Executing SaveReplayBuffer`);
                            try {
                                await sendToObs("SaveReplayBuffer", {}, context, action.name);
                                return { structuredContent: { success: true } };
                            } catch (e: any) {
                                console.error(`Error in SaveReplayBuffer for OBS:`, e.message);
                                return { structuredContent: { success: false, error: e.message } };
                            }
                        case "SaveReplayBufferAndAdd":
                            const replayParams = params as { sceneName: string; sourceName: string; replayFolder?: string };
                            console.log(`Executing SaveReplayBufferAndAdd with params:`, replayParams);
                            try {
                                // 1. Save the replay buffer
                                await sendToObs("SaveReplayBuffer", {}, context, action.name);
                                
                                // 2. Wait a bit for the file to be written to disk
                                await new Promise(resolve => setTimeout(resolve, 2000));
                                
                                // 3. Find the latest replay file
                                const defaultRecordingPath = process.env.OBS_REPLAY_PATH || path.join(os.homedir(), 'Movies');
                                const replayFolder = replayParams.replayFolder || defaultRecordingPath;
                                console.log(`Looking for the latest replay file in: ${replayFolder}`);
                                
                                // Get a list of replay files in the directory
                                let files: string[] = [];
                                try {
                                    files = fs.readdirSync(replayFolder)
                                        .filter(file => file.toLowerCase().includes('replay') && (file.endsWith('.mp4') || file.endsWith('.mov')))
                                        .map(file => path.join(replayFolder, file));
                                        
                                    // Sort by modification time, newest first
                                    files.sort((a, b) => {
                                        return fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime();
                                    });
                                    
                                    console.log(`Found ${files.length} replay files`);
                                } catch (fsError: any) {
                                    console.error(`Error reading replay directory ${replayFolder}:`, fsError.message);
                                    return { structuredContent: { success: false, error: `Failed to read replay directory: ${fsError.message}` } };
                                }
                                
                                if (files.length === 0) {
                                    return { structuredContent: { success: false, error: "No replay files found" } };
                                }
                                
                                // Get the most recent file
                                const latestReplayFile = files[0];
                                console.log(`Latest replay file: ${latestReplayFile}`);
                                
                                // 4. Create a media source with this file
                                const mediaSourceResponse = await sendToObs<{ sceneItemId: number }>("CreateInput", {
                                    sceneName: replayParams.sceneName,
                                    inputName: replayParams.sourceName,
                                    inputKind: "ffmpeg_source",
                                    inputSettings: {
                                        local_file: latestReplayFile,
                                        looping: true
                                    },
                                    sceneItemEnabled: true
                                }, context, action.name);
                                
                                console.log(`Created media source with ID: ${mediaSourceResponse.sceneItemId}`);
                                return { 
                                    structuredContent: { 
                                        success: true, 
                                        filePath: latestReplayFile,
                                        sceneItemId: mediaSourceResponse.sceneItemId 
                                    } 
                                };
                            } catch (e: any) {
                                console.error(`Error in SaveReplayBufferAndAdd for OBS:`, e.message);
                                return { structuredContent: { success: false, error: e.message } };
                            }
                        case "CreateSource":
                            const sourceParams = params as { sceneName: string; sourceName: string; sourceKind: string; sourceSettings: object; setVisible?: boolean };
                            console.log(`Executing CreateSource with params:`, sourceParams);
                            try {
                                const response = await sendToObs<{ sceneItemId: number }>("CreateInput", {
                                    sceneName: sourceParams.sceneName,
                                    inputName: sourceParams.sourceName,
                                    inputKind: sourceParams.sourceKind,
                                    inputSettings: sourceParams.sourceSettings,
                                    sceneItemEnabled: typeof sourceParams.setVisible === 'boolean' ? sourceParams.setVisible : true
                                }, context, action.name);
                                return { structuredContent: { success: true, sceneItemId: response.sceneItemId } };
                            } catch (e: any) {
                                console.error(`Error in CreateSource for OBS:`, e.message);
                                return { structuredContent: { success: false, error: e.message } };
                            }
                        case "SetShaderFilter":
                            const shaderParams = params as { 
                                sourceName: string; 
                                filterName: string; 
                                shaderCode?: string; 
                                shaderParameters?: Record<string, any> 
                            };
                            console.log(`Executing SetShaderFilter with params:`, shaderParams);
                            try {
                                // Directly construct filterSettings without GetSourceFilterInfo
                                const filterSettings: Record<string, any> = {};
                                
                                if (shaderParams.shaderCode) {
                                    // The actual key for shader code might depend on the specific shader filter plugin.
                                    // Common ones are 'shader_text', 'glsl', or 'code'.
                                    // Assuming 'shader_text' based on common OBS shader filter plugins.
                                    filterSettings.shader_text = shaderParams.shaderCode; 
                                }
                                
                                if (shaderParams.shaderParameters) {
                                    // Shader parameters are often applied directly at the root of filterSettings
                                    // or under a specific key like 'defaults'.
                                    // This assumes they are direct key-value pairs.
                                    for (const [key, value] of Object.entries(shaderParams.shaderParameters)) {
                                        filterSettings[key] = value;
                                    }
                                }
                                
                                // Apply the constructed filter settings
                                await sendToObs(
                                    "SetSourceFilterSettings", 
                                    {
                                        sourceName: shaderParams.sourceName,
                                        filterName: shaderParams.filterName,
                                        filterSettings: filterSettings
                                    },
                                    context,
                                    action.name
                                );
                                
                                console.log(`Successfully attempted to update shader filter settings for ${shaderParams.filterName} on ${shaderParams.sourceName}`);
                                return { structuredContent: { success: true } };
                            } catch (e: any) {
                                console.error(`Error in SetShaderFilter for OBS:`, e.message);
                                return { structuredContent: { success: false, error: e.message } };
                            }
                        case "SetLutFilter":
                            console.log(`Executing SetLutFilter with params:`, JSON.stringify(params, null, 2));
                            try {
                                // Parse the input parameters
                                // Check if params are directly in params or in a nested params object
                                const paramsObj = params.params || params;
                                const sourceName = paramsObj.sourceName;
                                const filterName = paramsObj.filterName;
                                const amount = paramsObj.amount;
                                const path = paramsObj.path;
                                
                                console.log(`SetLutFilter: Parsed parameters - sourceName: "${sourceName}", filterName: "${filterName}", amount: ${amount}, path: ${path || "undefined"}`);
                                
                                if (!sourceName || !filterName) {
                                    throw new Error("Missing required parameters: sourceName or filterName");
                                }
                                
                                console.log(`SetLutFilter: Setting LUT filter "${filterName}" on source "${sourceName}"`);
                                
                                // Direct approach - skip getting current settings
                                console.log("Using direct filter update approach");
                                
                                const filterSettings: Record<string, any> = {};
                                
                                if (amount !== undefined) {
                                    filterSettings.amount = amount;
                                }
                                
                                if (path) {
                                    filterSettings.path = path;
                                }
                                
                                console.log(`Filter settings to apply:`, JSON.stringify(filterSettings, null, 2));
                                
                                const setFilterResponse = await sendToObs(
                                    "SetSourceFilterSettings", 
                                    {
                                        sourceName: sourceName,
                                        filterName: filterName,
                                        filterSettings: filterSettings
                                    },
                                    context,
                                    action.name
                                );
                                
                                console.log(`SetSourceFilterSettings response:`, JSON.stringify(setFilterResponse, null, 2));
                                console.log(`Successfully updated LUT filter settings directly for ${filterName} on ${sourceName}`);
                                return { structuredContent: { success: true } };
                            } catch (e: any) {
                                console.error(`Error in SetLutFilter for OBS:`, e.message);
                                console.error(`Error details:`, e);
                                return { structuredContent: { success: false, error: e.message } };
                            }
                        default:
                            console.error(`Unknown MCP action: ${action.name}`);
                            throw new Error(`Action '${action.name}' is not implemented.`);
                    }
                    
                    // ★★★ デバッグログ追加箇所 ★★★
                    console.log(`DEBUG: Formatting response for action: '${action.name}'`);
                    console.log(`DEBUG: obsResponseData content for MCP: ${JSON.stringify(obsResponseData, null, 2)}`);
                    // ★★★ここまで★★★

                    // Return the appropriate response format based on the action
                    if (action.name === "GetSceneItemList") {
                        // EXPERIMENT: Return as content to test Claude client behavior
                        console.log(`DEBUG: Formatting GetSceneItemList response as 'content' for Claude client test.`);
                        return {
                            content: [{ type: "text", text: JSON.stringify(obsResponseData, null, 2) }]
                        };
                    } else if (action.name === "GetSceneList") {
                        // For GetSceneList, return the full response as content
                        return {
                            content: [
                                { type: "text", text: JSON.stringify(obsResponseData, null, 2) }
                            ]
                        };
                    } else {
                        // For other actions, return a simple success message
                        return {
                            content: [
                                { type: "text", text: `Action '${action.name}' executed successfully.` }
                            ]
                        };
                    }

                } catch (error: any) {
                    console.error(`Error executing tool '${action.name}':`, error);
                    throw error; 
                }
            }
        );
        console.log(`Registered tool: ${action.name}`);
    });
} else {
    console.warn("No tool actions found in tool_def.json or file not loaded.");
}

// Handler for resources/read
// server.setRequestHandler(ReadResourceRequestSchema, async (req): Promise<ReadResourceResponse> => {
// Temporary: Cast server to any to use setRequestHandler if it's a runtime-available method not in current typings
// (server as any).setRequestHandler(ReadResourceRequestSchema, async (req: any): Promise<ReadResourceResponse> => {
//     const uri = req.params.uri;
//     console.log(`Received resources/read request for URI: ${uri}`);

//     if (!uri.startsWith("file://")) {
//         console.error("Invalid URI scheme. Only file:// is supported.");
//         throw new Error("Invalid URI scheme. Only file:// is supported.");
//     }

//     const requestedFilePath = uri.substring("file://".length);
    
//     // IMPORTANT SECURITY CHECK: Ensure the path is within the designated screenshots directory
//     const normalizedRequestedPath = path.normalize(requestedFilePath);
//     const normalizedScreenshotsDir = path.normalize(SCREENSHOTS_DIR_ABS);

//     if (!normalizedRequestedPath.startsWith(normalizedScreenshotsDir)) {
//         console.error(`Access denied: Path ${normalizedRequestedPath} is outside the allowed directory ${normalizedScreenshotsDir}`);
//         throw new Error("Access denied: Requested resource is outside the allowed directory.");
//     }
    
//     // Check if file exists before attempting to read
//     if (!fs.existsSync(normalizedRequestedPath)) {
//         console.error(`File not found at path: ${normalizedRequestedPath}`);
//         throw new Error(`File not found: ${uri}`);
//     }

//     try {
//         const fileBuffer = await fs.promises.readFile(normalizedRequestedPath);
//         const base64Content = fileBuffer.toString("base64");
        
//         let mimeType = "application/octet-stream"; // Default MIME type
//         const extension = path.extname(normalizedRequestedPath).toLowerCase();
//         if (extension === ".png") mimeType = "image/png";
//         else if (extension === ".jpg" || extension === ".jpeg") mimeType = "image/jpeg";
//         else if (extension === ".webp") mimeType = "image/webp";
//         else if (extension === ".bmp") mimeType = "image/bmp";
//         // Add more MIME types as needed

//         console.log(`Successfully read resource ${uri}, MIME type: ${mimeType}, returning ${base64Content.length} Base64 chars.`);
//         return {
//             resources: [{
//                 uri: uri,
//                 mimeType: mimeType,
//                 blob: base64Content,
//             }],
//         };
//     } catch (error: any) {
//         console.error(`Error reading resource ${uri}:`, error.message);
//         throw new Error(`Failed to read resource ${uri}: ${error.message}`);
//     }
// });

console.warn("Resource handling (resources/read) is currently disabled due to 'setRequestHandler' not being available. Screenshots will be saved, but may not be loadable by the client.");

async function main() {
    connectToObs().catch(err => {
        console.error("Initial OBS connection failed:", err.message);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport); // Changed from listen to connect
    console.log(`OBS MCP Server (${mcpServerOptions.name} v${mcpServerOptions.version}) running on stdio`);
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    // Ensure OBS client is closed if it exists and an error occurs during startup
    if (obsClient && obsClient.readyState === WebSocket.OPEN) {
        obsClient.close();
    }
    process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nGracefully shutting down from SIGINT (Ctrl-C)');
  if (obsClient && obsClient.readyState === WebSocket.OPEN) {
    console.log('Closing OBS WebSocket connection...');
    obsClient.removeAllListeners(); // Important to prevent reconnection attempts during shutdown
    obsClient.close(1000, "Server shutdown"); // Normal closure
    obsClient = null;
  }
  // MCP server transport might also need graceful shutdown if applicable
  process.exit(0);
}); 