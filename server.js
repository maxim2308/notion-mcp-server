````javascript
import express from "express";
import { Client } from "@notionhq/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const NOTION_API_TOKEN = process.env.NOTION_API_TOKEN;

if (!NOTION_API_TOKEN) {
  console.error("ERROR: NOTION_API_TOKEN is not set");
  process.exit(1);
}

const notion = new Client({
  auth: NOTION_API_TOKEN,
  notionVersion: "2026-03-11"
});

const sessions = new Map();

function textValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function extractRichText(items) {
  if (!Array.isArray(items)) {
    return "";
  }

  return items
    .map(function (item) {
      if (!item) {
        return "";
      }

      if (item.plain_text) {
        return item.plain_text;
      }

      if (item.text && item.text.content) {
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

    if (property && property.type === "title") {
      return extractRichText(property.title);
    }
  }

  return "";
}

function extractPropertyValue(property) {
  if (!property) {
    return null;
  }

  const type = property.type;

  if (type === "title") {
    return extractRichText(property.title);
  }

  if (type === "rich_text") {
    return extractRichText(property.rich_text);
  }

  if (type === "select") {
    return property.select ? property.select.name : null;
  }

  if (type === "multi_select") {
    return Array.isArray(property.multi_select)
      ? property.multi_select.map(function (item) {
          return item.name;
        })
      : [];
  }

  if (type === "status") {
    return property.status ? property.status.name : null;
  }

  if (type === "number") {
    return property.number;
  }

  if (type === "checkbox") {
    return property.checkbox;
  }

  if (type === "url") {
    return property.url;
  }

  if (type === "email") {
    return property.email;
  }

  if (type === "phone_number") {
    return property.phone_number;
  }

  if (type === "date") {
    if (!property.date) {
      return null;
    }

    if (property.date.end) {
      return property.date.start + " → " + property.date.end;
    }

    return property.date.start;
  }

  if (type === "formula") {
    if (!property.formula) {
      return null;
    }

    if (property.formula.type === "string") {
      return property.formula.string;
    }

    if (property.formula.type === "number") {
      return property.formula.number;
    }

    if (property.formula.type === "boolean") {
      return property.formula.boolean;
    }

    if (property.formula.type === "date") {
      return property.formula.date;
    }

    return null;
  }

  if (type === "people") {
    return Array.isArray(property.people)
      ? property.people.map(function (person) {
          return person.name || person.id;
        })
      : [];
  }

  if (type === "created_time") {
    return property.created_time;
  }

  if (type === "last_edited_time") {
    return property.last_edited_time;
  }

  if (type === "created_by") {
    return property.created_by
      ? property.created_by.name || property.created_by.id
      : null;
  }

  if (type === "last_edited_by") {
    return property.last_edited_by
      ? property.last_edited_by.name || property.last_edited_by.id
      : null;
  }

  if (type === "relation") {
    return Array.isArray(property.relation)
      ? property.relation.map(function (item) {
          return item.id;
        })
      : [];
  }

  if (type === "files") {
    return Array.isArray(property.files)
      ? property.files.map(function (file) {
          return file.name || file.type || "";
        })
      : [];
  }

  return null;
}

function convertPageToRow(page) {
  const row = {
    id: page.id,
    url: page.url || null
  };

  if (!page.properties) {
    return row;
  }

  for (const key of Object.keys(page.properties)) {
    row[key] = extractPropertyValue(page.properties[key]);
  }

  return row;
}

function buildNotionProperty(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return {
      rich_text: [
        {
          type: "text",
          text: {
            content: value
          }
        }
      ]
    };
  }

  if (typeof value === "number") {
    return {
      number: value
    };
  }

  if (typeof value === "boolean") {
    return {
      checkbox: value
    };
  }

  if (Array.isArray(value)) {
    return {
      multi_select: value.map(function (item) {
        return {
          name: String(item)
        };
      })
    };
  }

  if (typeof value === "object") {
    if (value.type === "title") {
      return {
        title: [
          {
            type: "text",
            text: {
              content: textValue(value.text)
            }
          }
        ]
      };
    }

    if (value.type === "rich_text") {
      return {
        rich_text: [
          {
            type: "text",
            text: {
              content: textValue(value.text)
            }
          }
        ]
      };
    }

    if (value.type === "select") {
      return {
        select: {
          name: textValue(value.name)
        }
      };
    }

    if (value.type === "status") {
      return {
        status: {
          name: textValue(value.name)
        }
      };
    }

    if (value.type === "multi_select") {
      return {
        multi_select: Array.isArray(value.values)
          ? value.values.map(function (item) {
              return {
                name: String(item)
              };
            })
          : []
      };
    }

    if (value.type === "number") {
      return {
        number: value.value === null ? null : Number(value.value)
      };
    }

    if (value.type === "checkbox") {
      return {
        checkbox: Boolean(value.value)
      };
    }

    if (value.type === "url") {
      return {
        url: value.value
      };
    }

    if (value.type === "email") {
      return {
        email: value.value
      };
    }

    if (value.type === "phone_number") {
      return {
        phone_number: value.value
      };
    }

    if (value.type === "date") {
      return {
        date: {
          start: value.start,
          end: value.end || null,
          time_zone: value.time_zone || null
        }
      };
    }
  }

  throw new Error(
    "Unsupported property value: " + JSON.stringify(value)
  );
}

function buildProperties(input) {
  if (!input || typeof input !== "object") {
    return {};
  }

  const result = {};

  for (const key of Object.keys(input)) {
    const value = input[key];

    if (value === null || value === undefined) {
      continue;
    }

    result[key] = buildNotionProperty(value);
  }

  return result;
}

function richText(text) {
  return [
    {
      type: "text",
      text: {
        content: String(text)
      }
    }
  ];
}

function paragraphBlock(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: richText(text)
    }
  };
}

function headingBlock(text, level) {
  const type = "heading_" + String(level);

  return {
    object: "block",
    type: type,
    [type]: {
      rich_text: richText(text)
    }
  };
}

function bulletedBlock(text) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: richText(text)
    }
  };
}

function numberedBlock(text) {
  return {
    object: "block",
    type: "numbered_list_item",
    numbered_list_item: {
      rich_text: richText(text)
    }
  };
}

function todoBlock(text, checked) {
  return {
    object: "block",
    type: "to_do",
    to_do: {
      rich_text: richText(text),
      checked: Boolean(checked)
    }
  };
}

function quoteBlock(text) {
  return {
    object: "block",
    type: "quote",
    quote: {
      rich_text: richText(text)
    }
  };
}

function codeBlock(text, language) {
  return {
    object: "block",
    type: "code",
    code: {
      rich_text: richText(text),
      language: language || "plain text"
    }
  };
}

function markdownToBlocks(markdown) {
  const lines = String(markdown || "").split("\n");
  const blocks = [];

  let inCode = false;
  let codeLanguage = "plain text";
  let codeLines = [];

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (!inCode) {
        inCode = true;
        codeLanguage = line.trim().substring(3).trim() || "plain text";
        codeLines = [];
      } else {
        inCode = false;
        blocks.push(codeBlock(codeLines.join("\n"), codeLanguage));
        codeLines = [];
      }

      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("### ")) {
      blocks.push(headingBlock(trimmed.substring(4), 3));
      continue;
    }

    if (trimmed.startsWith("## ")) {
      blocks.push(headingBlock(trimmed.substring(3), 2));
      continue;
    }

    if (trimmed.startsWith("# ")) {
      blocks.push(headingBlock(trimmed.substring(2), 1));
      continue;
    }

    if (trimmed.startsWith("- [ ] ")) {
      blocks.push(todoBlock(trimmed.substring(6), false));
      continue;
    }

    if (trimmed.startsWith("- [x] ")) {
      blocks.push(todoBlock(trimmed.substring(6), true));
      continue;
    }

    if (trimmed.startsWith("- ")) {
      blocks.push(bulletedBlock(trimmed.substring(2)));
      continue;
    }

    if (/^[0-9]+\\. /.test(trimmed)) {
      blocks.push(
        numberedBlock(
          trimmed.replace(/^[0-9]+\\. /, "")
        )
      );
      continue;
    }

    if (trimmed.startsWith("> ")) {
      blocks.push(quoteBlock(trimmed.substring(2)));
      continue;
    }

    blocks.push(paragraphBlock(line));
  }

  if (inCode && codeLines.length > 0) {
    blocks.push(codeBlock(codeLines.join("\n"), codeLanguage));
  }

  return blocks;
}

async function appendBlocksInChunks(blockId, blocks) {
  const results = [];

  for (let i = 0; i < blocks.length; i += 100) {
    const chunk = blocks.slice(i, i + 100);

    const response = await notion.blocks.children.append({
      block_id: blockId,
      children: chunk
    });

    if (response && response.results) {
      results.push.apply(results, response.results);
    }
  }

  return results;
}

async function createMcpServer() {
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

  server.setRequestHandler(
    ListToolsRequestSchema,
    async function () {
      return {
        tools: [
          {
            name: "search_notion",
            description:
              "Search Notion pages and data sources by title or text.",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string"
                },
                page_size: {
                  type: "number",
                  default: 20
                }
              },
              required: ["query"]
            }
          },

          {
            name: "query_database",
            description:
              "Query rows from a Notion data source/database. Use data_source_id, not page_id.",
            inputSchema: {
              type: "object",
              properties: {
                data_source_id: {
                  type: "string"
                },
                page_size: {
                  type: "number",
                  default: 20
                }
              },
              required: ["data_source_id"]
            }
          },

          {
            name: "get_database_schema",
            description:
              "Get the schema and property definitions of a Notion data source.",
            inputSchema: {
              type: "object",
              properties: {
                data_source_id: {
                  type: "string"
                }
              },
              required: ["data_source_id"]
            }
          },

          {
            name: "read_page",
            description:
              "Read a Notion page properties and its child blocks.",
            inputSchema: {
              type: "object",
              properties: {
                page_id: {
                  type: "string"
                }
              },
              required: ["page_id"]
            }
          },

          {
            name: "update_page",
            description:
              "Update properties of an existing Notion page or database row.",
            inputSchema: {
              type: "object",
              properties: {
                page_id: {
                  type: "string"
                },
                properties: {
                  type: "object"
                }
              },
              required: ["page_id", "properties"]
            }
          },

          {
            name: "create_page",
            description:
              "Create a new row/page inside a Notion data source.",
            inputSchema: {
              type: "object",
              properties: {
                data_source_id: {
                  type: "string"
                },
                properties: {
                  type: "object"
                },
                children: {
                  type: "array"
                }
              },
              required: ["data_source_id", "properties"]
            }
          },

          {
            name: "append_blocks",
            description:
              "Append raw Notion blocks to the end of a page.",
            inputSchema: {
              type: "object",
              properties: {
                page_id: {
                  type: "string"
                },
                blocks: {
                  type: "array"
                }
              },
              required: ["page_id", "blocks"]
            }
          },

          {
            name: "append_markdown",
            description:
              "Convert simple Markdown into Notion blocks and append it to a page. Supports headings, bullets, numbered lists, todos, quotes and code blocks.",
            inputSchema: {
              type: "object",
              properties: {
                page_id: {
                  type: "string"
                },
                markdown: {
                  type: "string"
                }
              },
              required: ["page_id", "markdown"]
            }
          },

          {
            name: "update_block",
            description:
              "Update an existing Notion block. Use the raw block type payload.",
            inputSchema: {
              type: "object",
              properties: {
                block_id: {
                  type: "string"
                },
                type: {
                  type: "string"
                },
                block: {
                  type: "object"
                }
              },
              required: ["block_id", "type", "block"]
            }
          },

          {
            name: "create_database",
            description:
              "Create a brand new Notion database under a page. The database gets a title and initial columns.",
            inputSchema: {
              type: "object",
              properties: {
                parent_page_id: {
                  type: "string"
                },
                title: {
                  type: "string"
                },
                properties: {
                  type: "object"
                }
              },
              required: ["parent_page_id", "title", "properties"]
            }
          },

          {
            name: "update_database_schema",
            description:
              "Add or update properties/columns of an existing Notion database. Use data_source_id and a raw properties schema.",
            inputSchema: {
              type: "object",
              properties: {
                data_source_id: {
                  type: "string"
                },
                properties: {
                  type: "object"
                }
              },
              required: ["data_source_id", "properties"]
            }
          }
        ]
      };
    }
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async function (request) {
      const name = request.params.name;
      const args = request.params.arguments || {};

      console.log("TOOL:", name);
      console.log("ARGS:", JSON.stringify(args));

      try {
        if (name === "search_notion") {
          const response = await notion.search({
            query: args.query,
            page_size: Math.min(Number(args.page_size || 20), 100)
          });

          const results = response.results.map(function (item) {
            return {
              id: item.id,
              object: item.object,
              title:
                item.object === "page"
                  ? extractTitleFromPage(item)
                  : item.object === "data_source"
                    ? extractRichText(item.title)
                    : ""
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

        if (name === "query_database") {
          const response = await notion.dataSources.query({
            data_source_id: args.data_source_id,
            page_size: Math.min(Number(args.page_size || 20), 100)
          });

          const rows = response.results.map(convertPageToRow);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    data_source_id: args.data_source_id,
                    has_more: response.has_more,
                    next_cursor: response.next_cursor || null,
                    count: rows.length,
                    rows: rows
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        if (name === "get_database_schema") {
          const response = await notion.dataSources.retrieve({
            data_source_id: args.data_source_id
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response, null, 2)
              }
            ]
          };
        }

        if (name === "read_page") {
          const page = await notion.pages.retrieve({
            page_id: args.page_id
          });

          if (!page || page.object !== "page") {
            throw new Error(
              "The supplied ID is not a Notion page. If it is a data_source ID, use query_database."
            );
          }

          const blocks = await notion.blocks.children.list({
            block_id: args.page_id,
            page_size: 100
          });

          const result = {
            id: page.id,
            url: page.url || null,
            title: extractTitleFromPage(page),
            properties: {},
            blocks: blocks.results || []
          };

          for (const key of Object.keys(page.properties || {})) {
            result.properties[key] =
              extractPropertyValue(page.properties[key]);
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        if (name === "update_page") {
          const properties = buildProperties(args.properties);

          const response = await notion.pages.update({
            page_id: args.page_id,
            properties: properties
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    id: response.id,
                    url: response.url || null,
                    message: "Page properties updated successfully."
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        if (name === "create_page") {
          const properties = buildProperties(args.properties);

          const payload = {
            parent: {
              type: "data_source_id",
              data_source_id: args.data_source_id
            },
            properties: properties
          };

          if (Array.isArray(args.children) && args.children.length > 0) {
            payload.children = args.children;
          }

          const response = await notion.pages.create(payload);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    id: response.id,
                    url: response.url || null,
                    message: "Page created successfully."
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        if (name === "append_blocks") {
          if (!Array.isArray(args.blocks)) {
            throw new Error("blocks must be an array.");
          }

          const results = await appendBlocksInChunks(
            args.page_id,
            args.blocks
          );

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    appended: results.length,
                    results: results
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        if (name === "append_markdown") {
          const blocks = markdownToBlocks(args.markdown);

          if (blocks.length === 0) {
            throw new Error("No content to append.");
          }

          const results = await appendBlocksInChunks(
            args.page_id,
            blocks
          );

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    generated_blocks: blocks.length,
                    appended: results.length
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        if (name === "update_block") {
          const payload = {};

          payload[args.type] = args.block;

          const response = await notion.blocks.update({
            block_id: args.block_id,
            type: args.type,
            ...payload
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    block: response
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        if (name === "create_database") {
          const databaseProperties = args.properties || {};

          const response = await notion.databases.create({
            parent: {
              type: "page_id",
              page_id: args.parent_page_id
            },
            title: [
              {
                type: "text",
                text: {
                  content: args.title
                }
              }
            ],
            initial_data_source: {
              properties: databaseProperties
            }
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    database_id: response.id,
                    data_sources: response.data_sources || [],
                    url: response.url || null,
                    message: "Database created successfully."
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        if (name === "update_database_schema") {
          const response = await notion.dataSources.update({
            data_source_id: args.data_source_id,
            properties: args.properties || {}
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    data_source_id: args.data_source_id,
                    schema: response
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        throw new Error("Unknown tool: " + name);
      } catch (error) {
        console.error("TOOL ERROR:", error);

        const message =
          error && error.body && error.body.message
            ? error.body.message
            : error && error.message
              ? error.message
              : String(error);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: message
                },
                null,
                2
              )
            }
          ],
          isError: true
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
    version: "2.0.0"
  });
});

app.get("/sse", async function (req, res) {
  console.log("New SSE connection");

  try {
    const server = await createMcpServer();

    const transport = new SSEServerTransport(
      "/messages",
      res
    );

    const sessionId = transport.sessionId;

    sessions.set(sessionId, {
      transport: transport,
      server: server
    });

    console.log("SSE session:", sessionId);

    res.on("close", async function () {
      console.log("SSE closed:", sessionId);

      sessions.delete(sessionId);

      try {
        await server.close();
      } catch (error) {
        console.error("Server close error:", error);
      }
    });

    await server.connect(transport);
  } catch (error) {
    console.error("SSE ERROR:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: error.message
      });
    }
  }
});

app.post("/messages", async function (req, res) {
  const sessionId = req.query.sessionId;

  console.log("POST /messages session:", sessionId);

  if (!sessionId) {
    return res.status(400).json({
      error: "Missing sessionId"
    });
  }

  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      error: "Session not found"
    });
  }

  try {
    await session.transport.handlePostMessage(
      req,
      res,
      req.body
    );
  } catch (error) {
    console.error("MESSAGE ERROR:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: error.message
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", function () {
  console.log(
    "Notion MCP Qwen server listening on port " + PORT
  );
});
````
