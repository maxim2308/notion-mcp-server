import express from "express";
import { Client } from "@notionhq/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = process.env.PORT || 10000;
const NOTION_API_TOKEN = process.env.NOTION_API_TOKEN;

if (!NOTION_API_TOKEN) {
  console.error("ERROR: NOTION_API_TOKEN is not set");
  process.exit(1);
}

const notion = new Client({
  auth: NOTION_API_TOKEN,
});

const app = express();

app.use(express.json());

const transports = new Map();

console.log("=== notion-mcp-server starting ===");
console.log("PORT:", PORT);
console.log("NOTION_API_TOKEN:", NOTION_API_TOKEN ? "SET" : "NOT SET");

function extractRichText(items) {
  if (!Array.isArray(items)) {
    return "";
  }

  return items
    .map(function (item) {
      if (item && item.plain_text) {
        return item.plain_text;
      }

      if (
        item &&
        item.text &&
        typeof item.text.content === "string"
      ) {
        return item.text.content;
      }

      return "";
    })
    .join("");
}

function extractTitleFromPage(page) {
  if (!page || !page.properties) {
    return "";
  }

  const properties = page.properties;

  for (const key of Object.keys(properties)) {
    const property = properties[key];

    if (!property) {
      continue;
    }

    if (property.type === "title") {
      return extractRichText(property.title);
    }
  }

  return "";
}

function extractPropertyValue(property) {
  if (!property || !property.type) {
    return "";
  }

  switch (property.type) {
    case "title":
      return extractRichText(property.title);

    case "rich_text":
      return extractRichText(property.rich_text);

    case "select":
      return property.select ? property.select.name || "" : "";

    case "multi_select":
      if (!Array.isArray(property.multi_select)) {
        return "";
      }

      return property.multi_select
        .map(function (item) {
          return item.name || "";
        })
        .join(", ");

    case "status":
      return property.status ? property.status.name || "" : "";

    case "number":
      return property.number === null || property.number === undefined
        ? ""
        : String(property.number);

    case "checkbox":
      return property.checkbox ? "true" : "false";

    case "url":
      return property.url || "";

    case "email":
      return property.email || "";

    case "phone_number":
      return property.phone_number || "";

    case "date":
      if (!property.date) {
        return "";
      }

      if (property.date.end) {
        return (
          property.date.start +
          " → " +
          property.date.end
        );
      }

      return property.date.start || "";

    case "formula":
      if (!property.formula) {
        return "";
      }

      if (property.formula.type === "string") {
        return property.formula.string || "";
      }

      if (property.formula.type === "number") {
        return property.formula.number === null ||
          property.formula.number === undefined
          ? ""
          : String(property.formula.number);
      }

      if (property.formula.type === "boolean") {
        return property.formula.boolean ? "true" : "false";
      }

      if (property.formula.type === "date") {
        if (!property.formula.date) {
          return "";
        }

        if (property.formula.date.end) {
          return (
            property.formula.date.start +
            " → " +
            property.formula.date.end
          );
        }

        return property.formula.date.start || "";
      }

      return "";

    case "people":
      if (!Array.isArray(property.people)) {
        return "";
      }

      return property.people
        .map(function (person) {
          return person.name || person.id || "";
        })
        .join(", ");

    case "created_time":
      return property.created_time || "";

    case "last_edited_time":
      return property.last_edited_time || "";

    case "created_by":
      return property.created_by
        ? property.created_by.name || property.created_by.id || ""
        : "";

    case "last_edited_by":
      return property.last_edited_by
        ? property.last_edited_by.name || property.last_edited_by.id || ""
        : "";

    case "relation":
      if (!Array.isArray(property.relation)) {
        return "";
      }

      return property.relation
        .map(function (item) {
          return item.id || "";
        })
        .join(", ");

    case "files":
      if (!Array.isArray(property.files)) {
        return "";
      }

      return property.files
        .map(function (file) {
          return file.name || "";
        })
        .join(", ");

    default:
      return "";
  }
}

function convertPageToRow(page) {
  const row = {
    id: page.id,
    url: page.url || "",
  };

  if (page.properties) {
    for (const key of Object.keys(page.properties)) {
      row[key] = extractPropertyValue(page.properties[key]);
    }
  }

  return row;
}

function createMcpServer() {
  const server = new Server(
    {
      name: "notion-mcp-qwen",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async function () {
      console.log("TOOLS/LIST requested");

      const tools = [
        {
          name: "search_notion",
          description:
            "Search Notion pages and data sources by text. Use this to find a Notion database or page.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Text to search for in Notion",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "query_database",
          description:
            "Query a Notion data source/database and return rows with their properties. Use the data_source_id returned by search_notion.",
          inputSchema: {
            type: "object",
            properties: {
              data_source_id: {
                type: "string",
                description:
                  "The Notion data source ID returned by search_notion",
              },
              page_size: {
                type: "number",
                description:
                  "Maximum number of rows to return. Default 5.",
              },
            },
            required: ["data_source_id"],
          },
        },
        {
          name: "read_page",
          description:
            "Read the blocks of a Notion page. This is only for page IDs, not data source IDs.",
          inputSchema: {
            type: "object",
            properties: {
              page_id: {
                type: "string",
                description:
                  "Notion page ID",
              },
            },
            required: ["page_id"],
          },
        },
      ];

      console.log(
        "TOOLS/LIST response:",
        tools.map(function (tool) {
          return tool.name;
        })
      );

      return {
        tools: tools,
      };
    }
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async function (request) {
      const name = request.params.name;
      const args = request.params.arguments || {};

      console.log("TOOL CALL:", name);
      console.log("TOOL ARGS:", JSON.stringify(args));

      try {
        if (name === "search_notion") {
          const query =
            typeof args.query === "string"
              ? args.query
              : "";

          console.log("Notion search: " + query);

          const response = await notion.search({
            query: query,
            page_size: 20,
          });

          console.log(
            "Notion search results:",
            response.results.length
          );

          const results = response.results.map(function (item) {
            if (item.object === "data_source") {
              return {
                id: item.id,
                object: "data_source",
                title: extractRichText(item.title),
              };
            }

            if (item.object === "page") {
              return {
                id: item.id,
                object: "page",
                title: extractTitleFromPage(item),
                url: item.url || "",
              };
            }

            return {
              id: item.id,
              object: item.object,
            };
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(results, null, 2),
              },
            ],
          };
        }

        if (name === "query_database") {
          const dataSourceId =
            typeof args.data_source_id === "string"
              ? args.data_source_id
              : "";

          const pageSize =
            Number(args.page_size) > 0
              ? Math.min(Number(args.page_size), 100)
              : 5;

          if (!dataSourceId) {
            return {
              content: [
                {
                  type: "text",
                  text: "data_source_id is required",
                },
              ],
              isError: true,
            };
          }

          console.log(
            "Querying Notion data source:",
            dataSourceId
          );

          const response = await notion.dataSources.query({
            data_source_id: dataSourceId,
            page_size: pageSize,
          });

          console.log(
            "Data source rows:",
            response.results.length
          );

          const rows = response.results
            .filter(function (item) {
              return item.object === "page";
            })
            .map(function (page) {
              return convertPageToRow(page);
            });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    data_source_id: dataSourceId,
                    count: rows.length,
                    rows: rows,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        if (name === "read_page") {
          const pageId =
            typeof args.page_id === "string"
              ? args.page_id
              : "";

          if (!pageId) {
            return {
              content: [
                {
                  type: "text",
                  text: "page_id is required",
                },
              ],
              isError: true,
            };
          }

          console.log("Reading Notion page:", pageId);

          const page = await notion.pages.retrieve({
            page_id: pageId,
          });

          if (page.object !== "page") {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "The supplied ID is not a Notion page. If it is a data source ID, use query_database instead.",
                },
              ],
              isError: true,
            };
          }

          const blocks = await notion.blocks.children.list({
            block_id: pageId,
            page_size: 100,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    page_id: pageId,
                    blocks: blocks.results,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: "Unknown tool: " + name,
            },
          ],
          isError: true,
        };
      } catch (error) {
        console.error("TOOL ERROR:", error);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: true,
                  message: error.message || String(error),
                  code: error.code || null,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

app.get("/", function (req, res) {
  res.json({
    status: "ok",
    service: "notion-mcp-qwen",
    transport: "SSE",
    endpoint: "/sse",
  });
});

app.get("/health", function (req, res) {
  res.json({
    status: "ok",
  });
});

app.get("/sse", async function (req, res) {
  console.log("New SSE connection");

  try {
    const server = createMcpServer();

    const transport = new SSEServerTransport(
      "/messages",
      res
    );

    const sessionId = transport.sessionId;

    transports.set(sessionId, {
      transport: transport,
      server: server,
    });

    console.log("SSE session:", sessionId);

    res.on("close", async function () {
      console.log(
        "SSE connection closed:",
        sessionId
      );

      const session = transports.get(sessionId);

      if (session) {
        transports.delete(sessionId);

        try {
          await session.server.close();
        } catch (error) {
          console.error(
            "Error closing MCP server:",
            error
          );
        }
      }
    });

    await server.connect(transport);

    console.log(
      "MCP server connected to SSE transport:",
      sessionId
    );
  } catch (error) {
    console.error(
      "SSE connection error:",
      error
    );

    if (!res.headersSent) {
      res.status(500).json({
        error: error.message || String(error),
      });
    }
  }
});

app.post("/messages", async function (req, res) {
  const sessionId = req.query.sessionId;

  console.log(
    "MCP message received, sessionId:",
    sessionId
  );

  console.log(
    "MCP body:",
    JSON.stringify(req.body)
  );

  if (!sessionId) {
    res.status(400).json({
      error: "Missing sessionId",
    });
    return;
  }

  const session = transports.get(sessionId);

  if (!session) {
    res.status(404).json({
      error: "Unknown sessionId",
    });
    return;
  }

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
      res.status(500).json({
        error: error.message || String(error),
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", function () {
  console.log(
    "Server listening on port " + PORT
  );
});
