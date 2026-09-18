```js
import express from "express";

console.log("=== SERVER VERSION TEST ===");
console.log("FILE LOADED:", import.meta.url);

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
// HELPERS
// --------------------------------------------------

function extractRichText(items = []) {
    if (!Array.isArray(items)) {
        return "";
    }

    return items
        .map((item) => item?.plain_text || "")
        .join("");
}

function extractTitleFromPage(page) {
    if (!page || page.object !== "page") {
        return "Untitled";
    }

    const properties = page.properties || {};

    for (const property of Object.values(properties)) {
        if (
            property &&
            property.type === "title" &&
            Array.isArray(property.title)
        ) {
            const title = extractRichText(property.title);

            if (title) {
                return title;
            }
        }
    }

    return "Untitled";
}

function extractPropertyValue(property) {
    if (!property) {
        return "";
    }

    switch (property.type) {
        case "title":
            return extractRichText(property.title);

        case "rich_text":
            return extractRichText(property.rich_text);

        case "url":
            return property.url || "";

        case "email":
            return property.email || "";

        case "phone_number":
            return property.phone_number || "";

        case "number":
            return property.number ?? "";

        case "checkbox":
            return property.checkbox ? "true" : "false";

        case "select":
            return property.select?.name || "";

        case "multi_select":
            return (property.multi_select || [])
                .map((item) => item?.name || "")
                .filter(Boolean)
                .join(", ");

        case "status":
            return property.status?.name || "";

        case "date":
            if (!property.date) {
                return "";
            }

            return property.date.end
    ? property.date.start + " → " + property.date.end
    : property.date.start || "";

        case "people":
            return (property.people || [])
                .map((person) => person?.name || person?.id || "")
                .filter(Boolean)
                .join(", ");

        case "files":
            return (property.files || [])
                .map((file) => {
                    if (file?.name) {
                        return file.name;
                    }

                    return file?.external?.url ||
                        file?.file?.url ||
                        "";
                })
                .filter(Boolean)
                .join(", ");

        case "formula":
            if (!property.formula) {
                return "";
            }

            return (
                property.formula.string ??
                property.formula.number ??
                property.formula.boolean ??
                property.formula.date?.start ??
                ""
            );

        case "relation":
            return (property.relation || [])
                .map((relation) => relation?.id || "")
                .filter(Boolean)
                .join(", ");

        case "created_time":
            return property.created_time || "";

        case "last_edited_time":
            return property.last_edited_time || "";

        case "created_by":
            return property.created_by?.name ||
                property.created_by?.id ||
                "";

        case "last_edited_by":
            return property.last_edited_by?.name ||
                property.last_edited_by?.id ||
                "";

        default:
            return "";
    }
}

function convertPageToRow(page) {
    const properties = {};

    for (const [name, property] of Object.entries(
        page.properties || {}
    )) {
        properties[name] = extractPropertyValue(property);
    }

    return {
        id: page.id,
        url: page.url || "",
        properties
    };
}

// --------------------------------------------------
// MCP SERVER FACTORY
// --------------------------------------------------

function createMcpServer() {
    const server = new Server(
        {
            name: "notion-mcp-qwen",
            version: "2.0.0"
        },
        {
            capabilities: {
                tools: {}
            }
        }
    );

    // --------------------------------------------------
    // TOOLS LIST
    // --------------------------------------------------

    server.setRequestHandler(
        ListToolsRequestSchema,
        async () => {
            const tools = [
                {
                    name: "search_notion",
                    description:
                        "Search Notion for pages and databases/data sources by title or keyword. Returns object type and ID.",
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
                    name: "query_database",
                    description:
                        "Query rows from a Notion database/data source by its data source ID. Use this after search_notion finds an object with object='data_source'. Returns the database rows and their properties.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            data_source_id: {
                                type: "string",
                                description:
                                    "The data_source ID returned by search_notion."
                            },
                            page_size: {
                                type: "number",
                                description:
                                    "Maximum number of rows to return. Default is 20, maximum is 100."
                            }
                        },
                        required: ["data_source_id"]
                    }
                },

                {
                    name: "read_page",
                    description:
                        "Read the text content of a Notion page by page ID. Use this only with a page ID, not a data_source ID.",
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
            const {
                name,
                arguments: args = {}
            } = request.params;

            console.log(
                "================================="
            );

            console.log(
                "TOOL CALL:",
                name,
                JSON.stringify(args)
            );

            console.log(
                "================================="
            );

            try {
                // --------------------------------------------------
                // SEARCH NOTION
                // --------------------------------------------------

                if (name === "search_notion") {
                    const query = String(
                        args.query || ""
                    ).trim();

                    if (!query) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text:
                                        "Search query cannot be empty."
                                }
                            ],
                            isError: true
                        };
                    }

                    console.log(
                        `Notion search: "${query}"`
                    );

                    const response =
                        await notion.search({
                            query,
                            page_size: 20
                        });

                    console.log(
                        "Notion search raw result count:",
                        response.results?.length || 0
                    );

                    const results =
                        (response.results || []).map(
                            (item) => {

                                if (
                                    item.object ===
                                    "page"
                                ) {
                                    return {
                                        id: item.id,
                                        object: "page",
                                        title:
                                            extractTitleFromPage(
                                                item
                                            ),
                                        url:
                                            item.url ||
                                            ""
                                    };
                                }

                                if (
                                    item.object ===
                                    "data_source"
                                ) {
                                    return {
                                        id: item.id,
                                        object:
                                            "data_source",
                                        title:
                                            item.title
                                                ? extractRichText(
                                                      item.title
                                                  )
                                                : "Untitled",
                                        url:
                                            item.url ||
                                            ""
                                    };
                                }

                                if (
                                    item.object ===
                                    "database"
                                ) {
                                    return {
                                        id: item.id,
                                        object:
                                            "database",
                                        title:
                                            item.title
                                                ? extractRichText(
                                                      item.title
                                                  )
                                                : "Untitled",
                                        url:
                                            item.url ||
                                            ""
                                    };
                                }

                                return {
                                    id: item.id,
                                    object:
                                        item.object ||
                                        "unknown",
                                    title: "Untitled"
                                };
                            }
                        );

                    console.log(
                        "Notion search results:",
                        JSON.stringify(
                            results,
                            null,
                            2
                        )
                    );

                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    JSON.stringify(
                                        results,
                                        null,
                                        2
                                    )
                            }
                        ]
                    };
                }

                // --------------------------------------------------
                // QUERY DATABASE / DATA SOURCE
                // --------------------------------------------------

                if (name === "query_database") {
                    const dataSourceId =
                        String(
                            args.data_source_id ||
                                ""
                        ).trim();

                    if (!dataSourceId) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text:
                                        "data_source_id is required."
                                }
                            ],
                            isError: true
                        };
                    }

                    let pageSize = Number(
                        args.page_size || 20
                    );

                    if (
                        !Number.isFinite(pageSize)
                    ) {
                        pageSize = 20;
                    }

                    pageSize = Math.max(
                        1,
                        Math.min(
                            100,
                            Math.floor(pageSize)
                        )
                    );

                    console.log(
                        "Querying Notion data source:",
                        dataSourceId
                    );

                    console.log(
                        "Requested page size:",
                        pageSize
                    );

                    /*
                     * Current Notion API uses dataSources.query
                     * for querying rows of a data source.
                     *
                     * The fallback below also supports older
                     * @notionhq/client versions where the SDK
                     * exposes databases.query instead.
                     */

                    let response;

                    if (
                        notion.dataSources &&
                        typeof notion.dataSources.query ===
                            "function"
                    ) {
                        console.log(
                            "Using notion.dataSources.query()"
                        );

                        response =
                            await notion.dataSources.query(
                                {
                                    data_source_id:
                                        dataSourceId,
                                    page_size:
                                        pageSize
                                }
                            );
                    } else if (
                        notion.databases &&
                        typeof notion.databases.query ===
                            "function"
                    ) {
                        console.log(
                            "Using legacy notion.databases.query()"
                        );

                        response =
                            await notion.databases.query(
                                {
                                    database_id:
                                        dataSourceId,
                                    page_size:
                                        pageSize
                                }
                            );
                    } else {
                        throw new Error(
                            "Installed @notionhq/client does not provide dataSources.query() or databases.query(). Please update @notionhq/client."
                        );
                    }

                    const rows =
                        (response.results || [])
                            .map(
                                convertPageToRow
                            );

                    console.log(
                        "Data source rows:",
                        rows.length
                    );

                    console.log(
                        "Data source response:",
                        JSON.stringify(
                            rows,
                            null,
                            2
                        )
                    );

                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    JSON.stringify(
                                        {
                                            data_source_id:
                                                dataSourceId,
                                            count:
                                                rows.length,
                                            rows
                                        },
                                        null,
                                        2
                                    )
                            }
                        ]
                    };
                }

                // --------------------------------------------------
                // READ PAGE
                // --------------------------------------------------

                if (name === "read_page") {
                    const pageId = String(
                        args.page_id || ""
                    ).trim();

                    if (!pageId) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text:
                                        "page_id is required."
                                }
                            ],
                            isError: true
                        };
                    }

                    console.log(
                        "Reading Notion page:",
                        pageId
                    );

                    /*
                     * First retrieve the page so we can
                     * distinguish a real page from a data source.
                     */

                    let page;

                    try {
                        page =
                            await notion.pages.retrieve(
                                {
                                    page_id: pageId
                                }
                            );
                    } catch (error) {
                        console.error(
                            "Page retrieve error:",
                            error
                        );

                        return {
                            content: [
                                {
                                    type: "text",
                                    text:
                                        `Could not retrieve Notion page ${pageId}: ${
                                            error?.message ||
                                            String(error)
                                        }`
                                }
                            ],
                            isError: true
                        };
                    }

                    /*
                     * A data source must NOT be sent to
                     * blocks.children.list().
                     */

                    if (
                        page?.object !== "page"
                    ) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text:
                                        `The ID ${pageId} is not a Notion page. It is an object of type ${
                                            page?.object ||
                                            "unknown"
                                        }. Use query_database with a data_source ID instead.`
                                }
                            ],
                            isError: true
                        };
                    }

                    const response =
                        await notion.blocks.children.list(
                            {
                                block_id: pageId,
                                page_size: 100
                            }
                        );

                    const lines = [];

                    for (const block of response.results) {
                        const content =
                            block[
                                block.type
                            ];

                        if (!content) {
                            continue;
                        }

                        if (
                            Array.isArray(
                                content.rich_text
                            )
                        ) {
                            const text =
                                extractRichText(
                                    content.rich_text
                                );

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
                                    lines.length >
                                    0
                                        ? lines.join(
                                              "\n"
                                          )
                                        : "Page is empty."
                            }
                        ]
                    };
                }

                // --------------------------------------------------
                // UNKNOWN TOOL
                // --------------------------------------------------

                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `Unknown tool: ${name}`
                        }
                    ],
                    isError: true
                };
            } catch (error) {
                console.error(
                    "Tool execution error:",
                    error
                );

                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `Notion API error: ${
                                    error?.message ||
                                    String(error)
                                }`
                        }
                    ],
                    isError: true
                };
            }
        }
    );

    return server;
}

// --------------------------------------------------
// SSE TRANSPORTS
// --------------------------------------------------

const transports = new Map();

// --------------------------------------------------
// SSE CONNECTION
// --------------------------------------------------

app.get("/sse", async (req, res) => {
    console.log("=================================");
    console.log("New SSE connection");
    console.log(
        "User-Agent:",
        req.headers["user-agent"]
    );
    console.log(
        "Origin:",
        req.headers.origin
    );
    console.log("=================================");

    const transport =
        new SSEServerTransport(
            "/messages",
            res
        );

    const server = createMcpServer();

    transports.set(
        transport.sessionId,
        {
            transport,
            server
        }
    );

    console.log(
        "SSE session:",
        transport.sessionId
    );

    res.on("close", async () => {
        console.log(
            "SSE connection closed:",
            transport.sessionId
        );

        transports.delete(
            transport.sessionId
        );

        try {
            await server.close();
        } catch (error) {
            console.error(
                "Error closing MCP server:",
                error
            );
        }
    });

    transport.onerror = (error) => {
        console.error(
            "SSE transport error:",
            error
        );
    };

    try {
        await server.connect(
            transport
        );

        console.log(
            "MCP server connected to SSE transport:",
            transport.sessionId
        );
    } catch (error) {
        console.error(
            "SSE connection error:",
            error
        );

        transports.delete(
            transport.sessionId
        );

        try {
            await server.close();
        } catch {}

        if (!res.headersSent) {
            res
                .status(500)
                .end(
                    "SSE connection failed"
                );
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
        const sessionId =
            req.query.sessionId;

        console.log(
            "MCP message received. sessionId:",
            sessionId
        );

        if (!sessionId) {
            return res
                .status(400)
                .send(
                    "Missing sessionId"
                );
        }

        const session =
            transports.get(sessionId);

        if (!session) {
            console.error(
                "Unknown session:",
                sessionId
            );

            return res
                .status(404)
                .send(
                    "Session not found"
                );
        }

        console.log(
            "MCP body:",
            JSON.stringify(req.body)
        );

        try {
            await session.transport.handlePostMessage(
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
                    .send(
                        "MCP message processing failed"
                    );
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
```
