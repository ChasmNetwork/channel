#!/usr/bin/env node

import { createServer, IncomingMessage, ServerResponse } from "http"
import { spawn, ChildProcessWithoutNullStreams } from "child_process"
import { fileURLToPath } from "url"
import { join, dirname } from "path"
import { readFileSync } from "fs"
import { parse } from "url"

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  JSONRPCMessage,
  JSONRPCRequest,
} from "@modelcontextprotocol/sdk/types.js"
// @ts-ignore - Import for type compatibility
import { z } from "zod"

// Types
interface Logger {
  info: (...args: any[]) => void
  error: (...args: any[]) => void
}

interface SessionInfo {
  transport: SSEServerTransport
  response: ServerResponse
}

interface ChannelArgs {
  stdio?: string
  sse?: string
  port: number
  baseUrl: string
  ssePath: string
  messagePath: string
  log: Logger
  cors: boolean
  healthEndpoints: string[]
  apiKey?: string
}

interface StdioToSseArgs {
  stdioCmd: string
  port: number
  baseUrl: string
  ssePath: string
  messagePath: string
  log: Logger
  cors: boolean
  healthEndpoints: string[]
  apiKey?: string
}

interface SseToStdioArgs {
  sseUrl: string
  log: Logger
  apiKey?: string
}

// Get version from package.json
const getVersion = (): string => {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    return (
      JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"))
        .version || "1.0.0"
    )
  } catch (err) {
    console.error("[Channel] Unable to retrieve version:", err)
    return "unknown"
  }
}

// Simple logger
const loggerFactory = {
  info: (...args: any[]): void => console.log("[Channel]", ...args),
  error: (...args: any[]): void => console.error("[Channel]", ...args),
  none: {
    info: (): void => {},
    error: (): void => {},
  },
}

// Handle process signals
const handleSignals = (): void => {
  const signals: string[] = ["SIGINT", "SIGTERM", "SIGHUP"]
  signals.forEach((signal) => process.on(signal, () => process.exit(0)))
  process.stdin.on("close", () => process.exit(0))
}

// Parse command line arguments
const parseArgs = (): ChannelArgs => {
  const args: Record<string, any> = {}
  process.argv.slice(2).forEach((arg, i, argv) => {
    if (arg.startsWith("--")) {
      const key = arg.slice(2)
      const value =
        argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true
      if (key === "healthEndpoint") {
        args[key] = args[key] || []
        args[key].push(value)
      } else {
        args[key] = value
      }
    }
  })

  // Process API key
  if (args.apiKeyEnv && !args.apiKey) {
    args.apiKey = process.env[args.apiKeyEnv]
  }

  return {
    stdio: args.stdio,
    sse: args.sse,
    port: parseInt(args.port) || 8000,
    baseUrl: args.baseUrl || "",
    ssePath: args.ssePath || "/sse",
    messagePath: args.messagePath || "/message",
    log: args.logLevel === "none" ? loggerFactory.none : loggerFactory,
    cors: !!args.cors,
    healthEndpoints: args.healthEndpoint || [],
    apiKey: args.apiKey,
  }
}

// STDIO to SSE server
async function stdioToSse(args: StdioToSseArgs): Promise<void> {
  const {
    stdioCmd,
    port,
    baseUrl,
    ssePath,
    messagePath,
    log,
    cors,
    healthEndpoints,
    apiKey,
  } = args

  log.info("Starting sdtio → SSE server...")
  log.info(`Channel v${getVersion()} - https://chasm.net`)
  handleSignals()

  const child: ChildProcessWithoutNullStreams = spawn(stdioCmd, { shell: true })
  child.on("exit", (code: number | null) => process.exit(code || 1))

  const server = new Server(
    { name: "Channel", version: getVersion() },
    { capabilities: {} }
  )
  const sessions: Record<string, SessionInfo> = {}

  // Create simple HTTP server
  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.writeHead(400)
        res.end("Bad request")
        return
      }

      const { pathname, query } = parse(req.url, true)
      if (!pathname) {
        res.writeHead(400)
        res.end("Bad request")
        return
      }

      const headers: Record<string, string> = {}

      // CORS handling
      if (cors) {
        headers["Access-Control-Allow-Origin"] = "*"
        headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"

        if (req.method === "OPTIONS") {
          res.writeHead(204, headers)
          res.end()
          return
        }
      }

      // Authentication middleware
      if (
        apiKey &&
        (!req.headers.authorization ||
          req.headers.authorization !== `Bearer ${apiKey}`)
      ) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({ error: "Unauthorized: Invalid or missing API key" })
        )
        return
      }

      // Health endpoints
      if (healthEndpoints.includes(pathname)) {
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.end("ok")
        return
      }

      // SSE endpoint
      if (pathname === ssePath && req.method === "GET") {
        log.info(`New SSE connection from ${req.socket.remoteAddress}`)

        res.writeHead(200, {
          ...headers,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })

        const sseTransport = new SSEServerTransport(
          `${baseUrl}${messagePath}`,
          res
        )
        await server.connect(sseTransport)

        const sessionId = sseTransport.sessionId
        if (sessionId) {
          sessions[sessionId] = { transport: sseTransport, response: res }

          sseTransport.onmessage = (msg: JSONRPCMessage) => {
            log.info(`SSE → Child (${sessionId}): ${JSON.stringify(msg)}`)
            child.stdin.write(JSON.stringify(msg) + "\n")
          }

          sseTransport.onclose = () => delete sessions[sessionId]
          sseTransport.onerror = (err: Error) => {
            log.error(`‼️ SSE error (${sessionId}):`, err)
            delete sessions[sessionId]
          }

          req.on("close", () => delete sessions[sessionId])
        }
        return
      }

      // Message endpoint
      if (pathname === messagePath && req.method === "POST") {
        const sessionId = query.sessionId as string
        if (!sessionId) {
          res.writeHead(400)
          res.end("Missing sessionId parameter")
          return
        }

        const session = sessions[sessionId]
        if (session?.transport?.handlePostMessage) {
          let body = ""
          req.on("data", (chunk: Buffer) => {
            body += chunk.toString()
          })
          req.on("end", async () => {
            try {
              const data = JSON.parse(body)
              // @ts-ignore - Custom type expected by SDK
              await session.transport.handlePostMessage({ body: data }, res)
            } catch (err) {
              res.writeHead(400)
              res.end("Invalid JSON")
            }
          })
        } else {
          res.writeHead(503)
          res.end(`No active SSE connection for session ${sessionId}`)
        }
        return
      }

      // Not found
      res.writeHead(404)
      res.end("Not found")
    }
  )

  // Process child stdout
  let buffer = ""
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ""

    lines
      .filter((line) => line.trim())
      .forEach((line) => {
        try {
          const jsonMsg = JSON.parse(line)
          log.info("Child → SSE:", jsonMsg)

          Object.entries(sessions).forEach(([sid, session]) => {
            try {
              session.transport.send(jsonMsg)
            } catch (err) {
              log.error(`Failed to send to session ${sid}:`, err)
              delete sessions[sid]
            }
          })
        } catch (err) {
          log.error(`Child non-JSON: ${line}`)
        }
      })
  })

  child.stderr.on("data", (chunk: Buffer) =>
    log.error(`‼️ Child stderr: ${chunk.toString()}`)
  )

  // Start server
  httpServer.listen(port, () => {
    log.info(`🎧 Listening on port ${port}`)
    log.info(`🛰️ SSE endpoint: http://localhost:${port}${ssePath}`)
    log.info(`📮 POST messages: http://localhost:${port}${messagePath}`)
  })
}

// SSE to STDIO client
async function sseToStdio(args: SseToStdioArgs): Promise<void> {
  const { sseUrl, log, apiKey } = args

  log.info("Starting SSE → stdio client...")
  log.info(`Channel v${getVersion()} - https://chasm.net`)
  handleSignals()

  // Initialize transport with API key if provided
  const transportOptions = apiKey
    ? {
        requestInit: {
          headers: { authorization: `Bearer ${apiKey}` },
        },
        eventSourceInit: {
          async fetch(input: RequestInfo | URL, init: RequestInit = {}) {
            const headers = new Headers(init.headers || {})
            headers.set("authorization", `Bearer ${apiKey}`)
            return fetch(input, { ...init, headers })
          },
        },
      }
    : undefined

  // Connect to SSE
  const sseTransport = new SSEClientTransport(new URL(sseUrl), transportOptions)
  const sseClient = new Client(
    { name: "Channel", version: getVersion() },
    { capabilities: {} }
  )

  sseTransport.onerror = (err: Error) => log.error("SSE error:", err)
  sseTransport.onclose = () => {
    log.error("🛑 SSE connection closed")
    process.exit(1)
  }

  await sseClient.connect(sseTransport)
  log.info("✅ SSE connected")

  // Set up STDIO server
  const stdioServer = new Server(
    sseClient.getServerVersion() || { name: "Channel", version: getVersion() },
    { capabilities: sseClient.getServerCapabilities() || {} }
  )

  const stdioTransport = new StdioServerTransport()
  await stdioServer.connect(stdioTransport)

  // Handle messages between STDIO and SSE
  if (stdioServer.transport) {
    stdioServer.transport.onmessage = async (message: JSONRPCMessage) => {
      const isRequest = "method" in message && "id" in message

      if (isRequest) {
        log.info("stdio → SSE:", message)
        const req = message as JSONRPCRequest

        try {
          // Use z.any() to satisfy TypeScript
          const result = await sseClient.request(req, z.any())
          const response = {
            jsonrpc: req.jsonrpc || "2.0",
            id: req.id,
            // @ts-ignore - Dynamic property access
            ...(result.hasOwnProperty("error")
              ? // @ts-ignore - Dynamic property access
                { error: { ...result.error } }
              : // @ts-ignore - Dynamic property access
                { result: { ...result } }),
          }

          log.info("Response:", response)
          process.stdout.write(JSON.stringify(response) + "\n")
        } catch (err: any) {
          const errorCode = err?.code || -32000
          let errorMsg = err?.message || "Internal error"

          if (errorMsg.startsWith(`‼️ MCP error ${errorCode}:`)) {
            errorMsg = errorMsg
              .slice(`‼️ MCP error ${errorCode}:`.length)
              .trim()
          }

          const errorResp = {
            jsonrpc: req.jsonrpc || "2.0",
            id: req.id,
            error: { code: errorCode, message: errorMsg },
          }

          process.stdout.write(JSON.stringify(errorResp) + "\n")
        }
      } else {
        log.info("SSE → stdio:", message)
        process.stdout.write(JSON.stringify(message) + "\n")
      }
    }
  }

  log.info("🎧 stdio server listening")
}

// Main function
const main = async (): Promise<void> => {
  const args = parseArgs()

  if (args.stdio && args.sse) {
    loggerFactory.error("⚠️: Please choose either --stdio or --sse, not both")
    process.exit(1)
  } else if (!args.stdio && !args.sse) {
    loggerFactory.error("⚠️: Please specify either --stdio or --sse")
    process.exit(1)
  }

  try {
    if (args.stdio) {
      await stdioToSse({
        stdioCmd: args.stdio,
        port: args.port,
        baseUrl: args.baseUrl,
        ssePath: args.ssePath,
        messagePath: args.messagePath,
        log: args.log,
        cors: args.cors,
        healthEndpoints: args.healthEndpoints,
        apiKey: args.apiKey,
      })
    } else if (args.sse) {
      await sseToStdio({
        sseUrl: args.sse,
        log: args.log,
        apiKey: args.apiKey,
      })
    }
  } catch (err) {
    loggerFactory.error("Fatal error:", err)
    process.exit(1)
  }
}

main()
