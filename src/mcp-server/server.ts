/**
 * @fileoverview Main entry point for the MCP (Model Context Protocol) server.
 * This file sets up the server instance, configures the transport layer (stdio or HTTP),
 * registers resources and tools, and handles incoming MCP requests.
 * It supports both standard input/output communication and HTTP-based communication
 * with Server-Sent Events (SSE) for streaming responses.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import { config, environment } from '../config/index.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';
import { requestContextService } from '../utils/requestContext.js';
import { registerGitAddTool } from './tools/gitAdd/index.js'; // Import git_add
import { initializeGitBranchStateAccessors, registerGitBranchTool } from './tools/gitBranch/index.js'; // Import git_branch
import { initializeGitCheckoutStateAccessors, registerGitCheckoutTool } from './tools/gitCheckout/index.js'; // Import git_checkout
import { initializeGitCherryPickStateAccessors, registerGitCherryPickTool } from './tools/gitCherryPick/index.js'; // Import git_cherry_pick
import { initializeGitCleanStateAccessors, registerGitCleanTool } from './tools/gitClean/index.js'; // Import git_clean
import { initializeGitClearWorkingDirStateAccessors, registerGitClearWorkingDirTool } from './tools/gitClearWorkingDir/index.js'; // Import git_clear_working_dir
import { registerGitCloneTool } from './tools/gitClone/index.js'; // Import git_clone
import { registerGitCommitTool } from './tools/gitCommit/index.js'; // Import git_commit
import { initializeGitDiffStateAccessors, registerGitDiffTool } from './tools/gitDiff/index.js'; // Import git_diff
import { initializeGitFetchStateAccessors, registerGitFetchTool } from './tools/gitFetch/index.js'; // Import git_fetch
import { registerGitInitTool } from './tools/gitInit/index.js'; // Import git_init
import { initializeGitLogStateAccessors, registerGitLogTool } from './tools/gitLog/index.js'; // Import git_log
import { initializeGitMergeStateAccessors, registerGitMergeTool } from './tools/gitMerge/index.js'; // Import git_merge
import { initializeGitPullStateAccessors, registerGitPullTool } from './tools/gitPull/index.js'; // Import git_pull
import { initializeGitPushStateAccessors, registerGitPushTool } from './tools/gitPush/index.js'; // Import git_push
import { initializeGitRebaseStateAccessors, registerGitRebaseTool } from './tools/gitRebase/index.js'; // Import git_rebase
import { initializeGitRemoteStateAccessors, registerGitRemoteTool } from './tools/gitRemote/index.js'; // Import git_remote
import { initializeGitResetStateAccessors, registerGitResetTool } from './tools/gitReset/index.js'; // Import git_reset
import { initializeGitSetWorkingDirStateAccessors, registerGitSetWorkingDirTool } from './tools/gitSetWorkingDir/index.js'; // Import git_set_working_dir
import { initializeGitShowStateAccessors, registerGitShowTool } from './tools/gitShow/index.js'; // Import git_show
import { initializeGitStashStateAccessors, registerGitStashTool } from './tools/gitStash/index.js'; // Import git_stash
import { registerGitStatusTool } from './tools/gitStatus/index.js'; // Import git_status
import { initializeGitTagStateAccessors, registerGitTagTool } from './tools/gitTag/index.js'; // Import git_tag
// --- Import Accessor Inits ---
import { initializeGitAddStateAccessors } from './tools/gitAdd/index.js'; // Import add accessor init
import { initializeGitCommitStateAccessors } from './tools/gitCommit/index.js'; // Import commit accessor init
import { initializeGitStatusStateAccessors } from './tools/gitStatus/index.js'; // Import status accessor init
import morgan from 'morgan'; // <--- Add morgan import


// --- Configuration Constants ---

/**
 * Determines the transport type for the MCP server based on the MCP_TRANSPORT_TYPE environment variable.
 * Defaults to 'stdio' if the variable is not set. Converts the value to lowercase.
 * @constant {string} TRANSPORT_TYPE - The transport type ('stdio' or 'http').
 */
const TRANSPORT_TYPE = (process.env.MCP_TRANSPORT_TYPE || 'stdio').toLowerCase();

/**
 * The port number for the HTTP transport, configured via the MCP_HTTP_PORT environment variable.
 * Defaults to 3000 if the variable is not set or invalid.
 * @constant {number} HTTP_PORT - The port number for the HTTP server.
 */
const HTTP_PORT = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT, 10) : 3000;

/**
 * The host address for the HTTP transport, configured via the MCP_HTTP_HOST environment variable.
 * Defaults to '127.0.0.1' (localhost) if the variable is not set.
 * @constant {string} HTTP_HOST - The host address for the HTTP server.
 */
const HTTP_HOST = process.env.MCP_HTTP_HOST || '127.0.0.1';

/**
 * The specific endpoint path for handling MCP requests over HTTP.
 * @constant {string} MCP_ENDPOINT_PATH - The URL path for MCP communication.
 */
const MCP_ENDPOINT_PATH = '/mcp';

/**
 * The maximum number of attempts to find an available port if the initial HTTP_PORT is in use.
 * The server will try `HTTP_PORT`, `HTTP_PORT + 1`, ..., `HTTP_PORT + MAX_PORT_RETRIES`.
 * @constant {number} MAX_PORT_RETRIES - Maximum retry attempts for port binding.
 */
const MAX_PORT_RETRIES = 15;

/**
 * A record (dictionary/map) to store active HTTP transport instances, keyed by their session ID.
 * This allows associating incoming HTTP requests with the correct ongoing MCP session.
 * @type {Record<string, StreamableHTTPServerTransport>}
 */
const httpTransports: Record<string, StreamableHTTPServerTransport> = {};

/**
 * Stores the current working directory setting for each active HTTP session.
 * Keyed by session ID. Undefined means no specific working directory is set for the session.
 * @type {Record<string, string | undefined>}
 */
const sessionWorkingDirectories: Record<string, string | undefined> = {};


/**
 * Checks if an incoming HTTP request's origin header is permissible based on configuration.
 * It considers the `MCP_ALLOWED_ORIGINS` environment variable and whether the server
 * is bound to a loopback address (localhost). If allowed, it sets appropriate
 * Cross-Origin Resource Sharing (CORS) headers on the response.
 *
 * Security Note: Carefully configure `MCP_ALLOWED_ORIGINS` in production environments
 * to prevent unauthorized websites from interacting with the MCP server.
 *
 * @param {Request} req - The Express request object, containing headers like 'origin'.
 * @param {Response} res - The Express response object, used to set CORS headers.
 * @returns {boolean} Returns `true` if the origin is allowed, `false` otherwise.
 */
function isOriginAllowed(req: Request, res: Response): boolean {
  const origin = req.headers.origin;
  // Use req.hostname which correctly considers the Host header or falls back
  const host = req.hostname;
  // Check if the server is effectively bound only to loopback addresses
  const isLocalhostBinding = ['127.0.0.1', '::1', 'localhost'].includes(host);
  // Retrieve allowed origins from environment variable, split into an array
  const allowedOrigins = process.env.MCP_ALLOWED_ORIGINS?.split(',') || [];

  // Determine if the origin is allowed:
  // 1. The origin header is present AND is in the configured allowed list.
  // OR
  // 2. The server is bound to localhost AND the origin header is missing or 'null' (common for local file access or redirects).
  // OR
  // 3. There is no origin and it's not a localhost binding (likely an internal service call)
  const isInternalServiceCall = !origin && !isLocalhostBinding;
  const allowed = (origin && allowedOrigins.includes(origin)) || (isLocalhostBinding && (!origin || origin === 'null')) || isInternalServiceCall;

  if (allowed && origin) {
    // If allowed and an origin was provided, set CORS headers to allow the specific origin.
    res.setHeader('Access-Control-Allow-Origin', origin);
    // Allow necessary HTTP methods for MCP communication.
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    // Allow standard MCP headers and Content-Type. Last-Event-ID is for SSE resumption.
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Last-Event-ID');
    // Set credentials allowance if needed (e.g., if cookies or authentication headers are involved).
    res.setHeader('Access-Control-Allow-Credentials', 'true'); // Adjust if using credentials
  } else if (allowed && !origin) {
     // Origin is allowed (e.g., localhost binding with missing/null origin), but no origin header to echo back.
     // No specific CORS headers needed in this case as there's no origin to restrict/allow.
  } else if (!allowed && origin) {
    // Log a warning if an origin was provided but is not allowed.
    logger.warning(`Origin denied: ${origin}`, { operation: 'isOriginAllowed', origin, host, allowedOrigins, isLocalhostBinding });
  }
  // Note: If !allowed and !origin, no action/logging is needed.

  return allowed;
}


/**
 * Creates and configures a new instance of the McpServer.
 * This function encapsulates the server setup, including setting the server name,
 * version, capabilities, and registering all defined resources and tools.
 * It's designed to be called either once for the stdio transport or potentially
 * multiple times for stateless handling in the HTTP transport (though currently
 * used once per session in HTTP).
 *
 * @async
 * @returns {Promise<McpServer>} A promise that resolves with the fully configured McpServer instance.
 * @throws {Error} Throws an error if the registration of any resource or tool fails.
 */
async function createMcpServerInstance(): Promise<McpServer> {
  const context = { operation: 'createMcpServerInstance' };
  logger.info('Initializing MCP server instance', context);

  // Configure the request context service for associating logs/traces with specific requests or operations.
  requestContextService.configure({
    appName: config.mcpServerName,
    appVersion: config.mcpServerVersion,
    environment,
  });

  // Instantiate the core McpServer with its identity and declared capabilities.
  // Capabilities inform the client about what features the server supports (e.g., logging).
  const server = new McpServer(
    { name: config.mcpServerName, version: config.mcpServerVersion },
    { capabilities: { logging: {}, tools: { listChanged: true } } }
  );

  try {
    // Register all available tools with the server instance.
    // These functions typically call `server.tool()`.
    await registerGitAddTool(server); // Register git_add tool
    await registerGitBranchTool(server); // Added unified git_branch registration
    await registerGitCheckoutTool(server); // Register git_checkout tool
    await registerGitCherryPickTool(server); // Added git_cherry_pick registration
    await registerGitCleanTool(server); // Register git_clean tool
    await registerGitClearWorkingDirTool(server); // Register the git_clear_working_dir tool
    await registerGitCloneTool(server); // Added clone registration
    await registerGitCommitTool(server); // Register git_commit tool
    await registerGitDiffTool(server); // Register git_diff tool
    await registerGitFetchTool(server); // Register git_fetch tool
    await registerGitInitTool(server); // Added init registration
    await registerGitLogTool(server); // Register git_log tool
    await registerGitMergeTool(server); // Register git_merge tool
    await registerGitPullTool(server); // Register git_pull tool
    await registerGitPushTool(server); // Register git_push tool
    await registerGitRebaseTool(server); // Added git_rebase registration
    await registerGitRemoteTool(server); // Register git_remote tool
    await registerGitResetTool(server); // Register git_reset tool
    await registerGitSetWorkingDirTool(server); // Register git_set_working_dir tool
    await registerGitShowTool(server); // Register git_show tool
    await registerGitStashTool(server); // Register git_stash tool
    await registerGitStatusTool(server); // Register git_status tool
    await registerGitTagTool(server); // Register git_tag tool
    logger.info('All Git tools registered successfully', context);

  } catch (err) {
    // Log and re-throw any errors during registration, as the server cannot function correctly without them.
    logger.error('Failed to register resources/tools', {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err; // Propagate the error to the caller.
  }

  return server;
}

/**
 * Attempts to start the Node.js HTTP server on a specified port and host.
 * If the initial port is already in use (EADDRINUSE error), it increments the port
 * number and retries, up to a maximum number of retries (`maxRetries`).
 *
 * @async
 * @param {http.Server} serverInstance - The Node.js HTTP server instance to start.
 * @param {number} initialPort - The first port number to attempt binding to.
 * @param {string} host - The host address to bind to (e.g., '127.0.0.1').
 * @param {number} maxRetries - The maximum number of additional ports to try (initialPort + 1, initialPort + 2, ...).
 * @param {Record<string, any>} context - Logging context to associate with log messages.
 * @returns {Promise<number>} A promise that resolves with the port number the server successfully bound to.
 * @throws {Error} Rejects if the server fails to bind to any port after all retries, or if a non-EADDRINUSE error occurs.
 */
function startHttpServerWithRetry(
  serverInstance: http.Server,
  initialPort: number,
  host: string,
  maxRetries: number,
  context: Record<string, any>
): Promise<number> {
  return new Promise(async (resolve, reject) => {
    let lastError: Error | null = null;
    // Loop through ports: initialPort, initialPort + 1, ..., initialPort + maxRetries
    for (let i = 0; i <= maxRetries; i++) {
      const currentPort = initialPort + i;
      try {
        // Attempt to listen on the current port and host.
        await new Promise<void>((listenResolve, listenReject) => {
          serverInstance.listen(currentPort, host, () => {
            // If listen succeeds immediately, log the success and resolve the inner promise.
            const serverAddress = `http://${host}:${currentPort}${MCP_ENDPOINT_PATH}`;
            logger.info(`HTTP transport listening at ${serverAddress}`, { ...context, port: currentPort, address: serverAddress });
            listenResolve();
          }).on('error', (err: NodeJS.ErrnoException) => {
            // If an error occurs during listen (e.g., EADDRINUSE), reject the inner promise.
            listenReject(err);
          });
        });
        // If the inner promise resolved (listen was successful), resolve the outer promise with the port used.
        resolve(currentPort);
        return; // Exit the loop and the function.
      } catch (err: any) {
        lastError = err; // Store the error for potential final rejection message.
        if (err.code === 'EADDRINUSE') {
          // If the port is in use, log a warning and continue to the next iteration.
          logger.warning(`Port ${currentPort} already in use, retrying... (${i + 1}/${maxRetries + 1})`, { ...context, port: currentPort });
          // Optional delay before retrying to allow the other process potentially release the port.
          await new Promise(res => setTimeout(res, 100));
        } else {
          // If a different error occurred (e.g., permission denied), log it and reject immediately.
          logger.error(`Failed to bind to port ${currentPort}: ${err.message}`, { ...context, port: currentPort, error: err.message });
          reject(err);
          return; // Exit the loop and the function.
        }
      }
    }
    // If the loop completes without successfully binding to any port.
    logger.error(`Failed to bind to any port after ${maxRetries + 1} attempts. Last error: ${lastError?.message}`, { ...context, initialPort, maxRetries, error: lastError?.message });
    reject(lastError || new Error('Failed to bind to any port after multiple retries.'));
  });
}


/**
 * Sets up and starts the MCP transport layer based on the `TRANSPORT_TYPE` constant.
 *
 * If `TRANSPORT_TYPE` is 'http':
 * - Creates an Express application.
 * - Configures middleware for JSON parsing and CORS handling (using `isOriginAllowed`).
 * - Defines endpoints (`POST`, `GET`, `DELETE` at `MCP_ENDPOINT_PATH`) to handle MCP requests:
 *   - `POST`: Handles initialization requests (creating new sessions/transports) and subsequent message requests for existing sessions.
 *   - `GET`: Handles establishing the Server-Sent Events (SSE) connection for streaming responses.
 *   - `DELETE`: Handles session termination requests.
 * - Manages session lifecycles using the `httpTransports` map.
 * - Starts the HTTP server using `startHttpServerWithRetry`.
 *
 * If `TRANSPORT_TYPE` is 'stdio':
 * - Creates a single `McpServer` instance.
 * - Creates a `StdioServerTransport`.
 * - Connects the server and transport to process messages via standard input/output.
 * - Returns the created `McpServer` instance.
 *
 * @async
 * @returns {Promise<McpServer | void>} For 'stdio' transport, returns the `McpServer` instance. For 'http' transport, returns `void` as the server runs indefinitely.
 * @throws {Error} Throws an error if the transport type is unsupported, or if server creation/connection fails.
 */
async function startTransport(): Promise<McpServer | void> {
  const context = { operation: 'startTransport', transport: TRANSPORT_TYPE };
  logger.info(`Starting transport: ${TRANSPORT_TYPE}`, context);

  // Variable to hold the working directory for the single stdio session.
  // Declared here so it's accessible in the closure of setWorkingDirectoryFn.
  let stdioWorkingDirectory: string | undefined;

  // --- Define State Accessor Functions ---
  // These functions provide a bridge between the tool registration logic and the transport-specific state.

  const setWorkingDirectoryFn = (sessionId: string | undefined, path: string): void => {
    if (TRANSPORT_TYPE === 'http') {
      if (sessionId && sessionId in sessionWorkingDirectories) {
        sessionWorkingDirectories[sessionId] = path;
        logger.debug(`Set working directory for HTTP session ${sessionId} to ${path}`, { ...context, sessionId });
      } else {
        logger.error(`Attempted to set working directory for unknown HTTP session: ${sessionId}`, { ...context, sessionId });
      }
    } else if (TRANSPORT_TYPE === 'stdio') {
      // For stdio, we modify the variable directly (assuming it's accessible in this scope)
      stdioWorkingDirectory = path; // This relies on stdioWorkingDirectory being declared below
      logger.debug(`Set working directory for stdio session to ${path}`, context);
    }
  };

  const clearWorkingDirectoryFn = (sessionId: string | undefined): void => {
    if (TRANSPORT_TYPE === 'http') {
      if (sessionId && sessionId in sessionWorkingDirectories) {
        sessionWorkingDirectories[sessionId] = undefined; // Set to undefined to clear
        logger.debug(`Cleared working directory for HTTP session ${sessionId}`, { ...context, sessionId });
      } else {
        // Log warning instead of error, as clearing a non-existent/already cleared session isn't critical
        logger.warning(`Attempted to clear working directory for unknown or already cleared HTTP session: ${sessionId}`, { ...context, sessionId });
      }
    } else if (TRANSPORT_TYPE === 'stdio') {
      stdioWorkingDirectory = undefined; // Set to undefined to clear
      logger.debug(`Cleared working directory for stdio session`, context);
    }
  };

  const getWorkingDirectoryFn = (sessionId: string | undefined): string | undefined => {
    if (TRANSPORT_TYPE === 'http') {
      return sessionId ? sessionWorkingDirectories[sessionId] : undefined;
    } else if (TRANSPORT_TYPE === 'stdio') {
      return stdioWorkingDirectory;
    }
    return undefined; // Should not happen
  };

  const getSessionIdFn = (reqContext: Record<string, any>): string | undefined => {
    // The SDK's callContext passed to the tool handler might contain session info.
    // Alternatively, our RequestContext might have it if populated correctly.
    // Let's assume it's available as 'sessionId' in the context passed to the tool handler.
    // This might need refinement based on how the SDK passes context.
    return reqContext?.sessionId as string | undefined;
  };

  // Initialize the state accessors for the tools that need them
  initializeGitAddStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_add accessors
  initializeGitBranchStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_branch accessors
  initializeGitCheckoutStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_checkout accessors
  initializeGitCherryPickStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_cherry_pick accessors
  initializeGitCleanStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_clean accessors
  initializeGitClearWorkingDirStateAccessors(clearWorkingDirectoryFn, getSessionIdFn); // Initialize git_clear_working_dir accessors
  // initializeGitCloneStateAccessors - No state needed for clone
  initializeGitCommitStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_commit accessors
  initializeGitDiffStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_diff accessors
  initializeGitFetchStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_fetch accessors
  // initializeGitInitStateAccessors - No state needed for init
  initializeGitLogStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_log accessors
  initializeGitMergeStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_merge accessors
  initializeGitPullStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_pull accessors
  initializeGitPushStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_push accessors
  initializeGitRebaseStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_rebase accessors
  initializeGitRemoteStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_remote accessors
  initializeGitResetStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_reset accessors
  initializeGitSetWorkingDirStateAccessors(setWorkingDirectoryFn, getSessionIdFn); // Initialize git_set_working_dir accessors
  initializeGitShowStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_show accessors
  initializeGitStashStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_stash accessors
  initializeGitStatusStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_status accessors
  initializeGitTagStateAccessors(getWorkingDirectoryFn, getSessionIdFn); // Initialize git_tag accessors

  // --- HTTP Transport Setup ---
  if (TRANSPORT_TYPE === 'http') {
    const app = express();
    app.use(morgan('dev')); // <--- Use morgan for request logging
    // Middleware to parse JSON request bodies.
    app.use(express.json());

    // Handle CORS preflight (OPTIONS) requests.
    app.options(MCP_ENDPOINT_PATH, (req, res) => {
      if (isOriginAllowed(req, res)) {
        // Origin is allowed, send success status for preflight.
        res.sendStatus(204); // No Content
      } else {
        // Origin not allowed, send forbidden status. isOriginAllowed logs the warning.
        res.status(403).send('Forbidden: Invalid Origin');
      }
    });

    // Middleware for all requests to check origin and set security headers.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (!isOriginAllowed(req, res)) {
        // Origin not allowed, block the request. isOriginAllowed logs the warning.
        res.status(403).send('Forbidden: Invalid Origin');
        return; // Stop processing the request.
      }
      // Set standard security headers for allowed requests.
      res.setHeader('X-Content-Type-Options', 'nosniff'); // Prevent MIME type sniffing.
      // Consider adding other headers like Content-Security-Policy (CSP), Strict-Transport-Security (HSTS) here.
      next(); // Origin is allowed, proceed to the specific route handler.
    });


    // Handle POST requests (Initialization and subsequent messages).
    app.post(MCP_ENDPOINT_PATH, async (req, res) => {
      // Extract session ID from the custom MCP header.
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      // Look up existing transport for this session.
      let transport = sessionId ? httpTransports[sessionId] : undefined;
      // Check if the request body is an MCP Initialize request.
      const isInitReq = isInitializeRequest(req.body);
      const requestId = (req.body as any)?.id || null; // For error responses

      try {
        // --- Handle Initialization Request ---
        if (isInitReq) {
          if (transport) {
            // This indicates a potential client error or session ID collision (very unlikely).
            logger.warning('Received initialize request on an existing session ID. Closing old session.', { ...context, sessionId });
            // Close the old transport cleanly before creating a new one.
            await transport.close(); // Assuming close is async and handles cleanup
            delete httpTransports[sessionId!]; // Remove from map
          }

          logger.info('Initializing new session via POST request', { ...context, bodyPreview: JSON.stringify(req.body).substring(0, 100) }); // Log preview for debugging

          // Create a new streamable HTTP transport for this session.
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(), // Generate a unique session ID.
            onsessioninitialized: (newId) => {
              // Store the transport instance and initialize working directory state.
              httpTransports[newId] = transport!;
              sessionWorkingDirectories[newId] = undefined; // Initialize as undefined
              logger.info(`HTTP Session created: ${newId}`, { ...context, sessionId: newId });
            },
          });

          // Define cleanup logic when the transport closes (e.g., client disconnects, DELETE request).
          transport.onclose = () => {
            const closedSessionId = transport!.sessionId;
            if (closedSessionId) {
              delete httpTransports[closedSessionId];
              delete sessionWorkingDirectories[closedSessionId]; // Clean up working directory state
              logger.info(`HTTP Session closed: ${closedSessionId}`, { ...context, sessionId: closedSessionId });
            }
          };

          // Create a dedicated McpServer instance for this new session.
          const server = await createMcpServerInstance();
          // Connect the server logic to the transport layer.
          await server.connect(transport);
          // Note: The transport handles sending the initialize response internally upon connection.
          // We still need to call handleRequest below to process the *content* of the initialize message.

        } else if (!transport) {
          // --- Handle Non-Initialize Request without Valid Session ---
          logger.warning('Invalid session ID provided for non-initialize POST request', { ...context, sessionId });
          res.status(404).json({ jsonrpc: '2.0', error: { code: -32004, message: 'Invalid or expired session ID' }, id: requestId });
          return; // Stop processing.
        }

        // --- Handle Request (Initialize or Subsequent Message) ---
        // At this point, 'transport' must be defined (either found or newly created).
        if (!transport) {
           // Defensive check: This state should not be reachable if logic above is correct.
           logger.error('Internal error: Transport is unexpectedly undefined before handleRequest', { ...context, sessionId, isInitReq });
           throw new Error('Internal server error: Transport unavailable');
        }
        // Delegate the actual handling of the request (parsing, routing to server, sending response)
        // to the transport instance. This works for both the initial initialize message and subsequent messages.
        await transport.handleRequest(req, res, req.body);

        // If it was an init request via POST and the transport hasn't ended the response,
        // (which can happen if it sent a JSON body but expects the stream to be kept for SSE, which is wrong for init POST)
        // we explicitly end it here to prevent Express 404ing.
        if (isInitReq && !res.writableEnded) {
          logger.debug('Explicitly ending response for POST initialize request.', { ...context, sessionId });
          res.end();
        }

      } catch (err) {
        // Catch-all for errors during POST handling.
        logger.error('Error handling POST request', {
            ...context,
            sessionId,
            isInitReq,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        });
        // Send a generic JSON-RPC error response if headers haven't been sent yet.
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error during POST handling' }, id: requestId });
        }
        // Ensure transport is cleaned up if an error occurred during initialization
        if (isInitReq && transport && !transport.sessionId) {
            // If init failed before session ID was assigned, manually trigger cleanup if needed
            await transport.close().catch(closeErr => logger.error('Error closing transport after init failure', { ...context, closeError: closeErr }));
        }
      }
    });

    // Unified handler for GET (SSE connection) and DELETE (session termination).
    const handleSessionReq = async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId ? httpTransports[sessionId] : undefined;
      const method = req.method; // GET or DELETE

      if (!transport) {
        logger.warning(`Session not found for ${method} request`, { ...context, sessionId, method });
        res.status(404).send('Session not found or expired');
        return;
      }

      try {
        // Delegate handling to the transport (establishes SSE for GET, triggers close for DELETE).
        await transport.handleRequest(req, res);
        logger.info(`Successfully handled ${method} request for session`, { ...context, sessionId, method });
      } catch (err) {
        logger.error(`Error handling ${method} request for session`, {
            ...context,
            sessionId,
            method,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        });
        // Send generic error if headers not sent (e.g., error before SSE connection established).
        if (!res.headersSent) {
            res.status(500).send('Internal Server Error');
        }
        // Note: If SSE connection was established, errors might need different handling (e.g., sending error event).
        // The transport's handleRequest should manage SSE-specific error reporting.
      }
    };
    // Route GET and DELETE requests to the unified handler.
    app.get(MCP_ENDPOINT_PATH, handleSessionReq);
    app.delete(MCP_ENDPOINT_PATH, handleSessionReq);

    // --- Start HTTP Server ---
    const serverInstance = http.createServer(app);
    try {
      // Attempt to start the server, retrying ports if necessary.
      const actualPort = await startHttpServerWithRetry(serverInstance, HTTP_PORT, HTTP_HOST, MAX_PORT_RETRIES, context);
      // Log the final address only after successful binding.
      const serverAddress = `http://${HTTP_HOST}:${actualPort}${MCP_ENDPOINT_PATH}`;
      // Use console.log for prominent startup message visibility.
      console.log(`\n🚀 MCP Server running in HTTP mode at: ${serverAddress}\n`);
    } catch (err) {
      // If startHttpServerWithRetry failed after all retries.
      logger.fatal('HTTP server failed to start after multiple port retries.', { ...context, error: err instanceof Error ? err.message : String(err) });
      // Rethrow or exit, as the server cannot run.
      throw err;
    }
    // For HTTP transport, the server runs indefinitely, so return void.
    return;
  }

  // --- Stdio Transport Setup ---
  if (TRANSPORT_TYPE === 'stdio') {
    // stdioWorkingDirectory is declared above the state accessor functions

    try {
      // Create a single server instance for the stdio process.
      // State accessors are already initialized above.
      const server = await createMcpServerInstance();
      // Create the stdio transport, which reads from stdin and writes to stdout.
      const transport = new StdioServerTransport();
      // Connect the server logic to the stdio transport.
      await server.connect(transport);
      logger.info('MCP Server connected via stdio transport', context);
      // Return the server instance, as it might be needed by the calling process.
      return server;
    } catch (err) {
      // Handle critical errors during stdio setup.
      ErrorHandler.handleError(err, { operation: 'stdioConnect', critical: true });
      // Rethrow to indicate failure.
      throw err;
    }
  }

  // --- Unsupported Transport ---
  // If TRANSPORT_TYPE is neither 'http' nor 'stdio'.
  logger.fatal(`Unsupported transport type configured: ${TRANSPORT_TYPE}`, context);
  throw new Error(`Unsupported transport type: ${TRANSPORT_TYPE}. Must be 'stdio' or 'http'.`);
}

/**
 * Main application entry point.
 * Calls `startTransport` to initialize and start the MCP server based on the
 * configured transport type. Handles top-level errors during startup.
 *
 * @async
 * @export
 * @returns {Promise<void | McpServer>} Resolves with the McpServer instance if using stdio, or void if using http (as it runs indefinitely). Rejects on critical startup failure.
 */
export async function initializeAndStartServer(): Promise<void | McpServer> {
  try {
    // Start the appropriate transport (stdio or http).
    return await startTransport();
  } catch (err) {
    // Log fatal errors during the server startup process.
    logger.fatal('Failed to initialize and start MCP server', { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    // Use the global error handler for critical failures.
    ErrorHandler.handleError(err, { operation: 'initializeAndStartServer', critical: true });
    // Exit the process with an error code to signal failure.
    process.exit(1);
  }
}
