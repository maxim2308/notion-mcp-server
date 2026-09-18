import express from "express";
import { Client } from "@notionhq/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const NOTION_API_TOKEN = process.env.NOTION_API_TOKEN;

if (!NOTION_API_TOKEN) {
    console.error("ERROR: NOTION_API_TOKEN is not set");
    process.exit(1);
}

const notion = new Client({
    auth: NOTION_API_TOKEN
});

// --------------------------------------------------
// MCP SERVER
// --------------------------------------------------

const server = new Server(
    {
        name: "notion-mcp-qwen",
        version: "1.0.0"
    },
    {
        capabilities: {
            tools: {}
        }
    }
);

// --------------------------------------------------
// TOOLS
// --------------------------------------------------

server.setRequestHandler(
    ListToolsRequestSchema,
    async () => {
        const tools = [
            {
                name: "search_notion",
                description:
                    "Search pages and databases in Notion by title or keyword.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description:
                                "Text or keyword to search for in Notion."
                        }
                    },
                    required: ["query"]
                }
            },

            {
                name: "read_page",
                description:
                    "Read the text content of a Notion page by page ID.",
                inputSchema: {
                    type: "object",
                    properties: {
                        page_id: {
                            type: "string",
                            description:
                                "The Notion page ID."
                        }
                    },
                    required: ["page_id"]
                }
            }
        ];

        console.log("TOOLS/LIST requested");
        console.log(
            "TOOLS/LIST response:",
            JSON.stringify(tools)
        );

        return {
            tools
        };
    }
);

// --------------------------------------------------
// TOOL CALLS
// --------------------------------------------------

server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {

        const { name, arguments: args = {} } = request.params;

        try {

            // ------------------------------------------
            // SEARCH NOTION
            // ------------------------------------------

            if (name === "search_notion") {

                const query = String(args.query || "").trim();

                if (!query) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Search query cannot be empty."
                            }
                        ],
                        isError: true
                    };
                }

                console.log(`Notion search: "${query}"`);

                const response = await notion.search({
                    query,
                    page_size: 10
                });

                const results = response.results.map((item) => {

                    let title = "Untitled";

                    if (item.object === "page") {

                        const properties = item.properties || {};

                        for (const property of Object.values(properties)) {

                            if (
                                property &&
                                property.type === "title" &&
                                Array.isArray(property.title)
                            ) {
                                title =
                                    property.title[0]?.plain_text ||
                                    "Untitled";

                                break;
                            }
                        }
                    }

                    return {
                        id: item.id,
                        object: item.object,
                        title
                    };
                });

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(results, null, 2)
                        }
                    ]
                };
            }

            // ------------------------------------------
            // READ PAGE
            // ------------------------------------------

            if (name === "read_page") {

                const pageId = String(args.page_id || "").trim();

                if (!pageId) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "page_id is required."
                            }
                        ],
                        isError: true
                    };
                }

                console.log(`Reading Notion page: ${pageId}`);

                const response =
                    await notion.blocks.children.list({
                        block_id: pageId,
                        page_size: 100
                    });

                const lines = [];

                for (const block of response.results) {

                    const content = block[block.type];

                    if (!content) continue;

                    if (Array.isArray(content.rich_text)) {

                        const text = content.rich_text
                            .map((item) => item.plain_text || "")
                            .join("");

                        if (text) {
                            lines.push(text);
                        }
                    }
                }

                return {
                    content: [
                        {
                            type: "text",
                            text:
                                lines.length > 0
                                    ? lines.join("\n")
                                    : "Page is empty."
                        }
                    ]
                };
            }

            return {
                content: [
                    {
                        type: "text",
                        text: `Unknown tool: ${name}`
                    }
                ],
                isError: true
            };

        } catch (error) {

            console.error(
                "Notion API error:",
                error
            );

            return {
                content: [
                    {
                        type: "text",
                        text: `Notion API error: ${
                            error?.message || String(error)
                        }`
                    }
                ],
                isError: true
            };
        }
    }
);

// --------------------------------------------------
// SSE TRANSPORTS
// --------------------------------------------------

// IMPORTANT:
// We need one transport per Qwen SSE session.

const transports = new Map();

// --------------------------------------------------
// SSE CONNECTION
// --------------------------------------------------

app.get("/sse", async (req, res) => {

    console.log("=================================");
    console.log("New SSE connection");
    console.log("User-Agent:", req.headers["user-agent"]);
    console.log("Origin:", req.headers.origin);
    console.log("=================================");

    try {

        const transport =
            new SSEServerTransport(
                "/messages",
                res
            );

        transports.set(
            transport.sessionId,
            transport
        );

        console.log(
            "SSE session:",
            transport.sessionId
        );

        // Remove transport when connection closes
        res.on("close", () => {

            console.log(
                "SSE connection closed:",
                transport.sessionId
            );

            transports.delete(
                transport.sessionId
            );
        });

        transport.onerror = (error) => {
            console.error(
                "SSE transport error:",
                error
            );
        };

        await server.connect(transport);

        console.log(
            "MCP server connected to SSE transport:",
            transport.sessionId
        );

    } catch (error) {

        console.error(
            "SSE connection error:",
            error
        );

        if (!res.headersSent) {
            res.status(500).end("SSE connection failed");
        }
    }
});

// --------------------------------------------------
// MCP MESSAGES
// --------------------------------------------------

app.post(
    "/messages",
    express.json({
        limit: "4mb"
    }),
    async (req, res) => {

        const sessionId = req.query.sessionId;

        console.log(
            "MCP message received. sessionId:",
            sessionId
        );

        if (!sessionId) {
            return res
                .status(400)
                .send("Missing sessionId");
        }

        const transport =
            transports.get(sessionId);

        if (!transport) {

            console.error(
                "Unknown session:",
                sessionId
            );

            return res
                .status(404)
                .send("Session not found");
        }

        console.log(
            "MCP body:",
            JSON.stringify(req.body)
        );

        try {

            // IMPORTANT:
            // Do NOT use:
            //
            // transport.handleMessage(req, res)
            //
            // We must use handlePostMessage and
            // explicitly pass the parsed body.

            await transport.handlePostMessage(
                req,
                res,
                req.body
            );

        } catch (error) {

            console.error(
                "MCP message error:",
                error
            );

            if (!res.headersSent) {
                res
                    .status(500)
                    .send("MCP message processing failed");
            }
        }
    }
);

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {

    res.status(200).json({
        status: "ok",
        service: "notion-mcp-qwen",
        transport: "SSE",
        endpoint: "/sse"
    });
});

app.get("/health", (req, res) => {

    res.status(200).json({
        status: "ok"
    });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `MCP server running on port ${PORT}`
        );

        console.log(
            `SSE endpoint: http://0.0.0.0:${PORT}/sse`
        );
    }
);
