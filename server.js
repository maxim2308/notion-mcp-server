import express from "express";
import { Client } from "@notionhq/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json({ limit: "4mb" }));

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
const SERVER_VERSION = "3.1.0";

/* -------------------------------------------------------------------------- */
/* Schema cache                                                               */
/* -------------------------------------------------------------------------- */
const schemaCache = new Map();
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут

function getCachedSchema(dataSourceId) {
  const entry = schemaCache.get(dataSourceId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > SCHEMA_CACHE_TTL_MS) {
    schemaCache.delete(dataSourceId);
    return null;
  }
  return entry.schema;
}

function setCachedSchema(dataSourceId, schema) {
  schemaCache.set(dataSourceId, { schema, timestamp: Date.now() });
  if (schemaCache.size > 200) {
    const oldestKey = schemaCache.keys().next().value;
    schemaCache.delete(oldestKey);
  }
}

/* -------------------------------------------------------------------------- */
/* Retry wrapper for Notion API (429 / 5xx / network errors)                  */
/* -------------------------------------------------------------------------- */
async function withRetry(fn, maxAttempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error?.status || error?.statusCode || error?.code;
      const isRateLimited = status === 429;
      const isServerError = typeof status === "number" && status >= 500 && status < 600;
      const isNetworkError = ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND"].includes(error?.code);
      if (!isRateLimited && !isServerError && !isNetworkError) throw error;
      if (attempt === maxAttempts) break;
      const retryAfter = error?.headers?.["retry-after"];
      const backoffMs = retryAfter ? Number(retryAfter) * 1000 : Math.pow(2, attempt - 1) * 1000;
      console.log(`[MCP] RETRY ${attempt}/${maxAttempts} after ${backoffMs}ms (status=${status})`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastError;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */
function textValue(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: jsonText(value) }]
  };
}

function toolError(error) {
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
        text: jsonText({
          success: false,
          error: message
        })
      }
    ],
    isError: true
  };
}

function extractRichText(items) {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => {
      if (!item) return "";
      if (item.plain_text) return item.plain_text;
      if (item.text && item.text.content) return item.text.content;
      return "";
    })
    .join("");
}

function extractTitleFromPage(page) {
  if (!page || !page.properties) return "";
  for (const key of Object.keys(page.properties)) {
    const property = page.properties[key];
    if (property && property.type === "title") {
      return extractRichText(property.title);
    }
  }
  return "";
}

function extractPropertyValue(property) {
  if (!property) return null;
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
      ? property.multi_select.map((item) => item.name)
      : [];
  }
  if (type === "status") {
    return property.status ? property.status.name : null;
  }
  if (type === "number") return property.number;
  if (type === "checkbox") return property.checkbox;
  if (type === "url") return property.url;
  if (type === "email") return property.email;
  if (type === "phone_number") return property.phone_number;
  if (type === "date") {
    if (!property.date) return null;
    return {
      start: property.date.start || null,
      end: property.date.end || null,
      time_zone: property.date.time_zone || null
    };
  }
  if (type === "formula") {
    if (!property.formula) return null;
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
      ? property.people.map((person) => person.name || person.id)
      : [];
  }
  if (type === "created_time") return property.created_time;
  if (type === "last_edited_time") return property.last_edited_time;
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
      ? property.relation.map((item) => item.id)
      : [];
  }
  if (type === "files") {
    return Array.isArray(property.files)
      ? property.files.map((file) => file.name || file.type || "")
      : [];
  }
  return null;
}

function convertPageToRow(page) {
  const row = {
    id: page.id,
    url: page.url || null
  };
  for (const key of Object.keys(page.properties || {})) {
    row[key] = extractPropertyValue(page.properties[key]);
  }
  return row;
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

function getSchemaProperties(schema) {
  return (schema && schema.properties) || {};
}

async function getDataSourceSchema(dataSourceId) {
  if (!dataSourceId) {
    throw new Error("data_source_id is required.");
  }
  const cached = getCachedSchema(dataSourceId);
  if (cached) return cached;
  const schema = await withRetry(() => notion.dataSources.retrieve({
    data_source_id: dataSourceId
  }));
  setCachedSchema(dataSourceId, schema);
  return schema;
}

/*
 * Resolve a database/data source either by exact ID or by exact title.
 * This lets Qwen say "Лиды" instead of having to remember an ID.
 */
async function resolveDataSource(input) {
  const value = textValue(input).trim();
  if (!value) {
    throw new Error("Database identifier/name is required.");
  }
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    try {
      const schema = await getDataSourceSchema(value);
      return {
        data_source_id: value,
        schema,
        title: extractRichText(schema.title) || value
      };
    } catch (error) {
      // Continue to title search if the value was not actually an ID.
    }
  }
  const response = await withRetry(() => notion.search({
    query: value,
    page_size: 100
  }));
  const sources = (response.results || []).filter(
    (item) => item.object === "data_source"
  );
  const exact = sources.find(
    (item) =>
      normalizeName(extractRichText(item.title)) === normalizeName(value)
  );
  if (!exact) {
    if (sources.length === 0) {
      throw new Error(
        `Database/data source "${value}" was not found. Use search_notion to discover it.`
      );
    }
    if (sources.length > 1) {
      const names = sources
        .map((item) => extractRichText(item.title))
        .filter(Boolean)
        .slice(0, 10);
      throw new Error(
        `Database/data source "${value}" was not matched exactly. ` +
        `Found multiple candidates: ${names.join(", ")}. ` +
        `Use the exact database name or data_source_id.`
      );
    }
  }
  const candidate = exact || sources[0];
  const schema = await getDataSourceSchema(candidate.id);
  return {
    data_source_id: candidate.id,
    schema,
    title:
      extractRichText(schema.title) ||
      extractRichText(candidate.title) ||
      value
  };
}

/*
 * Convert the value that an LLM naturally supplies into the exact Notion
 * property payload required by the database schema.
 */
function normalizePropertyValue(value, schemaProperty, propertyName) {
  if (!schemaProperty || !schemaProperty.type) {
    throw new Error(
      `Property "${propertyName}" does not exist in the database schema.`
    );
  }
  const type = schemaProperty.type;
  if (value === null || value === undefined) {
    return { [type]: null };
  }
  // Allow already-canonical Notion payloads for backward compatibility.
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, type)
  ) {
    return value;
  }
  if (type === "title") {
    return {
      title: [
        {
          type: "text",
          text: {
            content: textValue(value)
          }
        }
      ]
    };
  }
  if (type === "rich_text") {
    return {
      rich_text: [
        {
          type: "text",
          text: {
            content: textValue(value)
          }
        }
      ]
    };
  }
  if (type === "select") {
    const name =
      typeof value === "object" && value !== null ? value.name : value;
    const options = schemaProperty.select?.options || [];
    if (
      options.length > 0 &&
      !options.some((x) => x.name === String(name))
    ) {
      throw new Error(
        `Invalid value "${name}" for select property "${propertyName}". ` +
        `Allowed values: ${options.map((x) => x.name).join(", ")}`
      );
    }
    return {
      select: {
        name: String(name)
      }
    };
  }
  if (type === "status") {
    const name =
      typeof value === "object" && value !== null ? value.name : value;
    const options = schemaProperty.status?.options || [];
    if (
      options.length > 0 &&
      !options.some((x) => x.name === String(name))
    ) {
      throw new Error(
        `Invalid value "${name}" for status property "${propertyName}". ` +
        `Allowed values: ${options.map((x) => x.name).join(", ")}`
      );
    }
    return {
      status: {
        name: String(name)
      }
    };
  }
  if (type === "multi_select") {
    const values = Array.isArray(value)
      ? value
      : typeof value === "object" &&
        Array.isArray(value.values)
        ? value.values
        : [value];
    return {
      multi_select: values.map((item) => ({
        name: String(item)
      }))
    };
  }
  if (type === "number") {
    const numberValue =
      typeof value === "object" &&
      value !== null &&
      "value" in value
        ? value.value
        : value;
    if (
      numberValue !== null &&
      Number.isNaN(Number(numberValue))
    ) {
      throw new Error(
        `Property "${propertyName}" expects a number.`
      );
    }
    return {
      number:
        numberValue === null
          ? null
          : Number(numberValue)
    };
  }
  if (type === "checkbox") {
    const boolValue =
      typeof value === "object" &&
      value !== null &&
      "value" in value
        ? value.value
        : value;
    if (typeof boolValue === "string") {
      const normalized = boolValue.trim().toLowerCase();
      if (
        ["true", "1", "yes", "да", "on"].includes(
          normalized
        )
      ) {
        return {
          checkbox: true
        };
      }
      if (
        ["false", "0", "no", "нет", "off", ""].includes(
          normalized
        )
      ) {
        return {
          checkbox: false
        };
      }
    }
    return {
      checkbox: Boolean(boolValue)
    };
  }
  if (type === "url") {
    const urlValue =
      typeof value === "object" &&
      value !== null &&
      "value" in value
        ? value.value
        : value;
    return {
      url:
        urlValue === ""
          ? null
          : String(urlValue)
    };
  }
  if (type === "email") {
    const emailValue =
      typeof value === "object" &&
      value !== null &&
      "value" in value
        ? value.value
        : value;
    return {
      email:
        emailValue === ""
          ? null
          : String(emailValue)
    };
  }
  if (type === "phone_number") {
    const phoneValue =
      typeof value === "object" &&
      value !== null &&
      "value" in value
        ? value.value
        : value;
    return {
      phone_number:
        phoneValue === ""
          ? null
          : String(phoneValue)
    };
  }
  if (type === "date") {
    if (typeof value === "string") {
      return {
        date: {
          start: value,
          end: null,
          time_zone: null
        }
      };
    }
    if (
      typeof value === "object" &&
      value !== null
    ) {
      if (!value.start) {
        throw new Error(
          `Date property "${propertyName}" requires "start".`
        );
      }
      return {
        date: {
          start: String(value.start),
          end: value.end
            ? String(value.end)
            : null,
          time_zone:
            value.time_zone || null
        }
      };
    }
    throw new Error(
      `Property "${propertyName}" expects a date string or date object.`
    );
  }
  if (type === "relation") {
    let ids;
    if (Array.isArray(value)) {
      ids = value;
    } else if (
      typeof value === "object" &&
      Array.isArray(value.ids)
    ) {
      ids = value.ids;
    } else if (typeof value === "string") {
      ids = [value];
    } else {
      throw new Error(
        `Relation property "${propertyName}" expects page IDs, e.g. ["page-id"].`
      );
    }
    return {
      relation: ids.map((id) => ({
        id: String(id)
      }))
    };
  }
  if (type === "people") {
    let ids;
    if (Array.isArray(value)) {
      ids = value;
    } else if (
      typeof value === "object" &&
      Array.isArray(value.ids)
    ) {
      ids = value.ids;
    } else if (typeof value === "string") {
      ids = [value];
    } else {
      throw new Error(
        `People property "${propertyName}" expects user IDs.`
      );
    }
    return {
      people: ids.map((id) => ({
        id: String(id)
      }))
    };
  }
  if (type === "files") {
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(
        value,
        "files"
      )
    ) {
      return {
        files: value.files
      };
    }
    throw new Error(
      `Files property "${propertyName}" requires an explicit Notion files payload.`
    );
  }
  if (
    type === "formula" ||
    type === "created_time" ||
    type === "last_edited_time" ||
    type === "created_by" ||
    type === "last_edited_by"
  ) {
    throw new Error(
      `Property "${propertyName}" is computed/read-only (${type}) and cannot be written.`
    );
  }
  throw new Error(
    `Property "${propertyName}" has unsupported Notion type "${type}".`
  );
}

function buildSchemaAwareProperties(input, schema) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new Error(
      "properties must be an object keyed by Notion property names."
    );
  }
  const schemaProperties =
    getSchemaProperties(schema);
  const result = {};
  for (const [
    propertyName,
    value
  ] of Object.entries(input)) {
    const schemaProperty =
      schemaProperties[propertyName];
    if (!schemaProperty) {
      throw new Error(
        `Unknown property "${propertyName}". Available properties: ${Object.keys(
          schemaProperties
        ).join(", ")}`
      );
    }
    result[propertyName] =
      normalizePropertyValue(
        value,
        schemaProperty,
        propertyName
      );
  }
  return result;
}

function semanticValue(
  value,
  schemaProperty
) {
  if (!schemaProperty) return value;
  const type = schemaProperty.type;
  if (
    type === "title" ||
    type === "rich_text"
  ) {
    return textValue(value);
  }
  if (
    type === "select" ||
    type === "status"
  ) {
    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }
    if (
      typeof value === "object" &&
      value !== null
    ) {
      return value.name || null;
    }
    return String(value);
  }
  if (type === "multi_select") {
    if (
      value === null ||
      value === undefined
    ) {
      return [];
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => String(item))
        .sort();
    }
    return [String(value)].sort();
  }
  if (type === "number") {
    return value === null ||
      value === undefined
      ? null
      : Number(value);
  }
  if (type === "checkbox") {
    return Boolean(value);
  }
  if (
    type === "url" ||
    type === "email" ||
    type === "phone_number"
  ) {
    return value === null ||
      value === undefined ||
      value === ""
      ? null
      : String(value);
  }
  if (type === "date") {
    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }
    if (typeof value === "string") {
      return {
        start: value,
        end: null
      };
    }
    return {
      start: value.start || null,
      end: value.end || null
    };
  }
  if (type === "relation") {
    if (!Array.isArray(value)) {
      return value
        ? [String(value)]
        : [];
    }
    return value
      .map((item) => {
        if (
          typeof item === "object" &&
          item !== null
        ) {
          return String(item.id);
        }
        return String(item);
      })
      .sort();
  }
  if (type === "people") {
    if (!Array.isArray(value)) {
      return value
        ? [String(value)]
        : [];
    }
    return value
      .map((item) => {
        if (
          typeof item === "object" &&
          item !== null
        ) {
          return String(item.id);
        }
        return String(item);
      })
      .sort();
  }
  return value;
}

function valuesEqual(
  expected,
  actual,
  schemaProperty
) {
  const left = semanticValue(
    expected,
    schemaProperty
  );
  const right = semanticValue(
    actual,
    schemaProperty
  );
  return (
    JSON.stringify(left) ===
    JSON.stringify(right)
  );
}

function verifyPageProperties(
  page,
  requestedProperties,
  schema
) {
  const mismatches = [];
  const actualProperties =
    page?.properties || {};
  const schemaProperties =
    getSchemaProperties(schema);
  const actual = {};
  for (const [
    propertyName,
    expected
  ] of Object.entries(
    requestedProperties || {}
  )) {
    const schemaProperty =
      schemaProperties[propertyName];
    if (!schemaProperty) {
      mismatches.push({
        property: propertyName,
        expected,
        actual: null,
        error:
          "Property does not exist in schema"
      });
      continue;
    }
    const actualProperty =
      actualProperties[propertyName];
    if (!actualProperty) {
      mismatches.push({
        property: propertyName,
        expected,
        actual: null,
        error:
          "Property missing from returned page"
      });
      actual[propertyName] = null;
      continue;
    }
    const actualValue =
      extractPropertyValue(
        actualProperty
      );
    actual[propertyName] =
      actualValue;
    if (
      !valuesEqual(
        expected,
        actualValue,
        schemaProperty
      )
    ) {
      mismatches.push({
        property: propertyName,
        expected,
        actual: actualValue
      });
    }
  }
  return {
    verified:
      mismatches.length === 0,
    mismatches,
    actual
  };
}

async function verifyPage(
  pageId,
  requestedProperties,
  schema
) {
  const page =
    await withRetry(() => notion.pages.retrieve({
      page_id: pageId
    }));
  const verification =
    verifyPageProperties(
      page,
      requestedProperties,
      schema
    );
  return {
    page,
    ...verification
  };
}

async function fetchPageBlocks(
  pageId,
  recursive = false,
  depth = 0
) {
  const MAX_DEPTH = 3;
  const blocks = [];
  let cursor = undefined;
  do {
    const response =
      await withRetry(() => notion.blocks.children.list({
        block_id: pageId,
        page_size: 100,
        ...(cursor
          ? {
            start_cursor: cursor
          }
          : {})
      }));
    for (const block of (response.results || [])) {
      if (recursive && block.has_children && depth < MAX_DEPTH) {
        block.children = await fetchPageBlocks(block.id, true, depth + 1);
      }
      blocks.push(block);
    }
    cursor = response.has_more
      ? response.next_cursor
      : null;
  } while (cursor);
  return blocks;
}

async function queryAllDataSourcePages(
  dataSourceId,
  pageSize = 100,
  startCursor = undefined,
  maxPages = null
) {
  const pages = [];
  let cursor = startCursor;
  let pagesFetched = 0;
  let hasMore = false;
  let nextCursor = null;
  do {
    const response =
      await withRetry(() => notion.dataSources.query({
        data_source_id: dataSourceId,
        page_size: Math.min(Number(pageSize) || 100, 100),
        ...(cursor ? { start_cursor: cursor } : {})
      }));
    pages.push(...(response.results || []));
    hasMore = !!response.has_more;
    nextCursor = response.next_cursor || null;
    cursor = nextCursor;
    pagesFetched++;
    if (maxPages && pagesFetched >= maxPages) break;
  } while (cursor);
  return { pages, has_more: hasMore, next_cursor: nextCursor };
}

/* -------------------------------------------------------------------------- */
/* Block helpers                                                              */
/* -------------------------------------------------------------------------- */
function richText(text) {
  const input = String(text || "");
  const segments = [];
  const patterns = [
    { re: /\*\*(.+?)\*\*/g, annotations: { bold: true } },
    { re: /__(.+?)__/g, annotations: { bold: true } },
    { re: /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, annotations: { italic: true } },
    { re: /(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, annotations: { italic: true } },
    { re: /~~(.+?)~~/g, annotations: { strikethrough: true } },
    { re: /`([^`]+)`/g, annotations: { code: true } }
  ];
  const matches = [];
  for (const { re, annotations } of patterns) {
    let m;
    while ((m = re.exec(input)) !== null) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        inner: m[1],
        annotations
      });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  if (matches.length === 0) {
    return [{ type: "text", text: { content: input } }];
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const filtered = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      filtered.push(m);
      lastEnd = m.end;
    }
  }
  let cursorPos = 0;
  for (const m of filtered) {
    if (m.start > cursorPos) {
      segments.push({
        type: "text",
        text: { content: input.slice(cursorPos, m.start) }
      });
    }
    segments.push({
      type: "text",
      text: { content: m.inner },
      annotations: m.annotations
    });
    cursorPos = m.end;
  }
  if (cursorPos < input.length) {
    segments.push({
      type: "text",
      text: { content: input.slice(cursorPos) }
    });
  }
  return segments.length > 0
    ? segments
    : [{ type: "text", text: { content: input } }];
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

function headingBlock(
  text,
  level
) {
  const type =
    "heading_" + String(level);
  return {
    object: "block",
    type,
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

function todoBlock(
  text,
  checked
) {
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

function codeBlock(
  text,
  language
) {
  return {
    object: "block",
    type: "code",
    code: {
      rich_text: [
        {
          type: "text",
          text: { content: String(text || "") }
        }
      ],
      language:
        language || "plain text"
    }
  };
}

function markdownToBlocks(
  markdown
) {
  const lines =
    String(markdown || "")
      .split("\n");
  const blocks = [];
  let inCode = false;
  let codeLanguage =
    "plain text";
  let codeLines = [];
  for (const line of lines) {
    if (
      line.trim().startsWith("```")
    ) {
      if (!inCode) {
        inCode = true;
        codeLanguage =
          line
            .trim()
            .substring(3)
            .trim() ||
          "plain text";
        codeLines = [];
      } else {
        inCode = false;
        blocks.push(
          codeBlock(
            codeLines.join("\n"),
            codeLanguage
          )
        );
        codeLines = [];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const trimmed =
      line.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith("### ")
    ) {
      blocks.push(
        headingBlock(
          trimmed.substring(4),
          3
        )
      );
      continue;
    }
    if (
      trimmed.startsWith("## ")
    ) {
      blocks.push(
        headingBlock(
          trimmed.substring(3),
          2
        )
      );
      continue;
    }
    if (
      trimmed.startsWith("# ")
    ) {
      blocks.push(
        headingBlock(
          trimmed.substring(2),
          1
        )
      );
      continue;
    }
    if (
      trimmed.startsWith("- [ ] ")
    ) {
      blocks.push(
        todoBlock(
          trimmed.substring(6),
          false
        )
      );
      continue;
    }
    if (
      trimmed.startsWith("- [x] ")
    ) {
      blocks.push(
        todoBlock(
          trimmed.substring(6),
          true
        )
      );
      continue;
    }
    if (
      trimmed.startsWith("* ")
    ) {
      blocks.push(
        bulletedBlock(
          trimmed.substring(2)
        )
      );
      continue;
    }
    if (
      trimmed.startsWith("- ")
    ) {
      blocks.push(
        bulletedBlock(
          trimmed.substring(2)
        )
      );
      continue;
    }
    if (
      /^\d+\.\s+/.test(trimmed)
    ) {
      blocks.push(
        numberedBlock(
          trimmed.replace(
            /^\d+\.\s+/,
            ""
          )
        )
      );
      continue;
    }
    if (
      trimmed.startsWith("> ")
    ) {
      blocks.push(
        quoteBlock(
          trimmed.substring(2)
        )
      );
      continue;
    }
    blocks.push(
      paragraphBlock(trimmed)
    );
  }
  if (
    inCode &&
    codeLines.length > 0
  ) {
    blocks.push(
      codeBlock(
        codeLines.join("\n"),
        codeLanguage
      )
    );
  }
  return blocks;
}

async function appendBlocksInChunks(
  blockId,
  blocks
) {
  const results = [];
  for (
    let i = 0;
    i < blocks.length;
    i += 100
  ) {
    const chunk =
      blocks.slice(i, i + 100);
    const response =
      await withRetry(() => notion.blocks.children.append(
        {
          block_id: blockId,
          children: chunk
        }
      ));
    if (
      response &&
      response.results
    ) {
      results.push(
        ...response.results
      );
    }
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* MCP server                                                                 */
/* -------------------------------------------------------------------------- */
async function createMcpServer() {
  const server =
    new Server(
      {
        name:
          "notion-mcp-qwen",
        version:
          SERVER_VERSION
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async () => {
      return {
        tools: [
          {
            name: "search_notion",
            description:
              "Search Notion pages and databases/data sources by title or text. Use this to discover IDs when needed. Set fuzzy=true for substring search across titles and properties.",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string"
                },
                page_size: {
                  type: "number",
                  default: 20
                },
                fuzzy: {
                  type: "boolean",
                  description: "If true, searches by substring across titles and properties instead of Notion's exact-match search."
                }
              },
              required: [
                "query"
              ]
            }
          },
          {
            name:
              "find_database",
            description:
              "Find a Notion database by name and return its data_source_id and schema. Prefer this over manually guessing IDs.",
            inputSchema: {
              type: "object",
              properties: {
                name: {
                  type: "string"
                }
              },
              required: [
                "name"
              ]
            }
          },
          {
            name:
              "get_database_schema",
            description:
              "Get the schema of a Notion database/data source, including property names, types and select/status options.",
            inputSchema: {
              type: "object",
              properties: {
                data_source_id: {
                  type: "string"
                }
              },
              required: [
                "data_source_id"
              ]
            }
          },
          {
            name:
              "find_records",
            description:
              "Find rows in a Notion database. Automatically paginates through all records. Use start_cursor and max_pages for very large databases. Filtering is performed against readable property values.",
            inputSchema: {
              type: "object",
              properties: {
                database: {
                  type: "string"
                },
                data_source_id: {
                  type: "string"
                },
                filters: {
                  type: "object"
                },
                page_size: {
                  type: "number",
                  default: 100
                },
                start_cursor: {
                  type: "string",
                  description: "Cursor for pagination. Pass the next_cursor from the previous call."
                },
                max_pages: {
                  type: "number",
                  description: "Maximum number of pages to fetch (each page has up to 100 records)."
                }
              }
            }
          },
          {
            name:
              "get_record",
            description:
              "Read one Notion database row/page by page_id, including all readable properties and page content blocks. Use recursive=true to fetch nested blocks.",
            inputSchema: {
              type: "object",
              properties: {
                page_id: {
                  type: "string"
                },
                recursive: {
                  type: "boolean",
                  description: "If true, recursively fetch nested blocks (toggles, nested lists, etc)."
                }
              },
              required: [
                "page_id"
              ]
            }
          },
          {
            name:
              "create_record",
            description:
              "Create a row in a Notion database. IMPORTANT: pass properties as simple natural values matching the database schema, for example {\"Имя\":\"Иван\",\"Компания\":\"ООО Ромашка\",\"Статус\":\"новый\"}. Do NOT construct Notion API title/rich_text/select wrappers. The MCP resolves property types automatically and verifies the created row after writing.",
            inputSchema: {
              type: "object",
              properties: {
                database: {
                  type: "string",
                  description:
                    "Database name, e.g. \"Лиды\"."
                },
                data_source_id: {
                  type: "string",
                  description:
                    "Optional data_source_id. Use either this or database."
                },
                properties: {
                  type: "object",
                  description:
                    "Simple values keyed by exact Notion property names. Strings, numbers, booleans, arrays and date strings are converted automatically according to the database schema."
                },
                content: {
                  type: "string",
                  description:
                    "Optional Markdown content to put inside the new page. Supports **bold**, *italic*, ~~strike~~ and `code`."
                }
              },
              required: [
                "properties"
              ]
            }
          },
          {
            name:
              "create_records_batch",
            description:
              "Create multiple rows in a Notion database in parallel. Each item has 'properties' and optional 'content' (Markdown). Max 50 records per batch. Returns per-record results.",
            inputSchema: {
              type: "object",
              properties: {
                database: {
                  type: "string",
                  description: "Database name, e.g. \"Лиды\"."
                },
                data_source_id: {
                  type: "string",
                  description: "Optional data_source_id."
                },
                records: {
                  type: "array",
                  description: "Array of objects with 'properties' and optional 'content'.",
                  items: {
                    type: "object"
                  }
                }
              },
              required: [
                "records"
              ]
            }
          },
          {
            name:
              "update_record",
            description:
              "Update properties of an existing Notion row/page. Pass simple natural values such as {\"Статус\":\"написано\"}; the MCP resolves the exact Notion property format and verifies the result.",
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
              required: [
                "page_id",
                "properties"
              ]
            }
          },
          {
            name:
              "upsert_record",
            description:
              "Create or update a database row without creating a duplicate. First search using match properties, then update the matching row or create a new one. Afterward verify the result.",
            inputSchema: {
              type: "object",
              properties: {
                database: {
                  type: "string"
                },
                data_source_id: {
                  type: "string"
                },
                match: {
                  type: "object",
                  description:
                    "Properties used to identify an existing row, e.g. {\"Имя\":\"Иван Петров\",\"Компания\":\"ООО Ромашка\"}."
                },
                properties: {
                  type: "object",
                  description:
                    "Properties to create/update."
                },
                content: {
                  type: "string"
                }
              },
              required: [
                "match",
                "properties"
              ]
            }
          },
          {
            name:
              "verify_record",
            description:
              "Verify that specific properties on an existing Notion row contain the requested values. Returns verified=true only when all requested values match.",
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
              required: [
                "page_id",
                "properties"
              ]
            }
          },
          {
            name:
              "delete_record",
            description:
              "Archive (soft-delete) a Notion page/record. The page disappears from database views but can be restored from Notion's trash.",
            inputSchema: {
              type: "object",
              properties: {
                page_id: {
                  type: "string",
                  description: "The ID of the page/record to archive."
                }
              },
              required: [
                "page_id"
              ]
            }
          },
          {
            name:
              "append_note",
            description:
              "Append readable Markdown/text content to an existing Notion page. Supports **bold**, *italic*, ~~strike~~ and `code` inline styles. Use this instead of constructing raw Notion blocks.",
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
              required: [
                "page_id",
                "markdown"
              ]
            }
          },
          {
            name:
              "update_database_schema",
            description:
              "Add or update columns/properties in an existing Notion database. Use raw Notion schema definitions here because this operation changes the database structure itself.",
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
              required: [
                "data_source_id",
                "properties"
              ]
            }
          },
          {
            name:
              "create_database",
            description:
              "Create a new Notion database under a page. The properties argument is a database schema, not row values. Use standard Notion property definitions.",
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
              required: [
                "parent_page_id",
                "title",
                "properties"
              ]
            }
          },
          {
            name:
              "clear_schema_cache",
            description:
              "Clear the in-memory cache of database schemas. Use if the schema was changed in Notion but MCP still sees the old one.",
            inputSchema: {
              type: "object",
              properties: {},
              required: []
            }
          },
          {
            name:
              "query_database",
            description:
              "Legacy/low-level database query. Automatically paginates through all records. Use find_records for normal work.",
            inputSchema: {
              type: "object",
              properties: {
                data_source_id: {
                  type: "string"
                },
                page_size: {
                  type: "number",
                  default: 100
                }
              },
              required: [
                "data_source_id"
              ]
            }
          },
          {
            name:
              "read_page",
            description:
              "Legacy page reader. Use get_record for normal database-row work.",
            inputSchema: {
              type: "object",
              properties: {
                page_id: {
                  type: "string"
                }
              },
              required: [
                "page_id"
              ]
            }
          },
          {
            name:
              "create_page",
            description:
              "Legacy create-page tool. Properties may be supplied as simple values; MCP automatically reads the database schema and converts them to the correct Notion types. Prefer create_record.",
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
              required: [
                "data_source_id",
                "properties"
              ]
            }
          },
          {
            name:
              "update_page",
            description:
              "Legacy update-page tool. Properties may be supplied as simple values; MCP automatically reads the database schema and converts them to the correct Notion types. Prefer update_record.",
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
              required: [
                "page_id",
                "properties"
              ]
            }
          },
          {
            name:
              "append_blocks",
            description:
              "Append raw Notion blocks to a page. Prefer append_note when possible.",
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
              required: [
                "page_id",
                "blocks"
              ]
            }
          },
          {
            name:
              "append_markdown",
            description:
              "Append simple Markdown as Notion blocks. Prefer append_note for normal Qwen usage.",
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
              required: [
                "page_id",
                "markdown"
              ]
            }
          },
          {
            name:
              "update_block",
            description:
              "Update an existing Notion block using its block type payload.",
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
              required: [
                "block_id",
                "type",
                "block"
              ]
            }
          }
        ]
      };
    }
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async function (request) {
      const name =
        request.params.name;
      const args =
        request.params.arguments || {};
      const startedAt =
        Date.now();
      console.log(
        `[MCP] TOOL START: ${name}`
      );
      console.log(
        "[MCP] TOOL ARGS:",
        JSON.stringify(args)
      );
      try {
        /* ------------------------------ cache ------------------------------ */
        if (name === "clear_schema_cache") {
          const size = schemaCache.size;
          schemaCache.clear();
          return toolResult({
            success: true,
            cleared: size,
            message: `Cleared ${size} cached schema(s).`
          });
        }

        /* ------------------------------ search ----------------------------- */
        if (
          name === "search_notion"
        ) {
          const fuzzy = !!args.fuzzy;
          const queryText = String(args.query || "");
          const response =
            await withRetry(() => notion.search({
              query: fuzzy ? "" : args.query,
              page_size:
                Math.min(
                  Number(
                    args.page_size || 20
                  ),
                  100
                )
            }));
          let results =
            response.results.map(
              (item) => ({
                id: item.id,
                object: item.object,
                title:
                  item.object ===
                    "page"
                    ? extractTitleFromPage(
                      item
                    )
                    : item.object ===
                      "data_source"
                      ? extractRichText(
                        item.title
                      )
                      : "",
                raw: item
              })
            );
          if (fuzzy && queryText) {
            const needle = queryText.trim().toLowerCase();
            results = results.filter((r) => {
              if ((r.title || "").toLowerCase().includes(needle)) return true;
              const props = r.raw?.properties || {};
              for (const key of Object.keys(props)) {
                const val = extractPropertyValue(props[key]);
                if (val && String(val).toLowerCase().includes(needle)) return true;
              }
              return false;
            });
          }
          return toolResult(
            results.map((r) => ({
              id: r.id,
              object: r.object,
              title: r.title
            }))
          );
        }
        if (
          name === "find_database"
        ) {
          const resolved =
            await resolveDataSource(
              args.name
            );
          return toolResult({
            success: true,
            data_source_id:
              resolved.data_source_id,
            title:
              resolved.title,
            schema:
              resolved.schema
          });
        }
        if (
          name === "get_database_schema"
        ) {
          const response =
            await getDataSourceSchema(
              args.data_source_id
            );
          return toolResult(
            response
          );
        }
        /* ---------------------------- records ----------------------------- */
        if (
          name === "find_records"
        ) {
          const resolved =
            args.data_source_id
              ? {
                data_source_id:
                  args.data_source_id,
                schema:
                  await getDataSourceSchema(
                    args.data_source_id
                  )
              }
              : await resolveDataSource(
                args.database
              );
          const pageSize =
            Math.min(
              Number(
                args.page_size || 100
              ),
              100
            );
          const startCursor = args.start_cursor || undefined;
          const maxPages = args.max_pages ? Number(args.max_pages) : null;
          const queryResult = await queryAllDataSourcePages(
            resolved.data_source_id,
            pageSize,
            startCursor,
            maxPages
          );
          let rows = queryResult.pages.map(convertPageToRow);
          const filters =
            args.filters || {};
          for (
            const key of Object.keys(
              filters
            )
          ) {
            const expected =
              filters[key];
            rows =
              rows.filter(
                (row) => {
                  const actual =
                    row[key];
                  if (
                    Array.isArray(
                      expected
                    )
                  ) {
                    return (
                      JSON.stringify(
                        (
                          Array.isArray(
                            actual
                          )
                            ? actual
                            : [actual]
                        )
                          .map(String)
                          .sort()
                      ) ===
                      JSON.stringify(
                        expected
                          .map(String)
                          .sort()
                      )
                    );
                  }
                  return (
                    String(
                      actual ?? ""
                    ) ===
                    String(
                      expected ?? ""
                    )
                  );
                }
              );
          }
          return toolResult({
            success: true,
            data_source_id: resolved.data_source_id,
            count: rows.length,
            has_more: queryResult.has_more,
            next_cursor: queryResult.next_cursor,
            rows
          });
        }
        if (
          name === "query_database"
        ) {
          const queryResult = await queryAllDataSourcePages(
            args.data_source_id
          );
          const rows = queryResult.pages.map(convertPageToRow);
          return toolResult({
            success: true,
            data_source_id: args.data_source_id,
            count: rows.length,
            has_more: queryResult.has_more,
            next_cursor: queryResult.next_cursor,
            rows
          });
        }
        if (
          name === "get_record" ||
          name === "read_page"
        ) {
          const page =
            await withRetry(() => notion.pages.retrieve(
              {
                page_id:
                  args.page_id
              }
            ));
          if (
            !page ||
            page.object !== "page"
          ) {
            throw new Error(
              "The supplied ID is not a Notion page."
            );
          }
          const blocks =
            await fetchPageBlocks(
              args.page_id,
              !!args.recursive
            );
          const result = {
            id: page.id,
            url:
              page.url || null,
            title:
              extractTitleFromPage(
                page
              ),
            properties: {},
            blocks
          };
          for (
            const key of Object.keys(
              page.properties || {}
            )
          ) {
            result.properties[
              key
            ] =
              extractPropertyValue(
                page.properties[key]
              );
          }
          return toolResult(
            result
          );
        }
        if (
          name === "create_record" ||
          name === "create_page"
        ) {
          const dataSourceId =
            args.data_source_id ||
            (
              args.database
                ? (
                  await resolveDataSource(
                    args.database
                  )
                ).data_source_id
                : null
            );
          if (!dataSourceId) {
            throw new Error(
              "Provide database or data_source_id."
            );
          }
          const schema =
            await getDataSourceSchema(
              dataSourceId
            );
          const properties =
            buildSchemaAwareProperties(
              args.properties,
              schema
            );
          const payload = {
            parent: {
              type:
                "data_source_id",
              data_source_id:
                dataSourceId
            },
            properties
          };
          if (
            Array.isArray(
              args.children
            ) &&
            args.children.length > 0
          ) {
            payload.children =
              args.children;
          }
          const response =
            await withRetry(() => notion.pages.create(
              payload
            ));
          if (args.content) {
            const blocks =
              markdownToBlocks(
                args.content
              );
            if (
              blocks.length > 0
            ) {
              await appendBlocksInChunks(
                response.id,
                blocks
              );
            }
          }
          const verification =
            await verifyPage(
              response.id,
              args.properties,
              schema
            );
          if (
            !verification.verified
          ) {
            return toolResult({
              success: false,
              operation:
                "create_record",
              id:
                response.id,
              url:
                response.url ||
                null,
              verified: false,
              error:
                "Page was created, but read-after-write verification failed.",
              mismatches:
                verification.mismatches,
              actual:
                verification.actual
            });
          }
          return toolResult({
            success: true,
            operation:
              "created",
            id:
              response.id,
            url:
              response.url ||
              null,
            verified: true,
            properties:
              verification.actual,
            message:
              "Record created and verified successfully."
          });
        }
        if (name === "create_records_batch") {
          const dataSourceId =
            args.data_source_id ||
            (
              args.database
                ? (
                  await resolveDataSource(
                    args.database
                  )
                ).data_source_id
                : null
            );
          if (!dataSourceId) {
            throw new Error(
              "Provide database or data_source_id."
            );
          }
          const records = Array.isArray(args.records) ? args.records : [];
          if (records.length === 0) {
            throw new Error("records array is empty.");
          }
          if (records.length > 50) {
            throw new Error("Maximum 50 records per batch.");
          }
          const schema =
            await getDataSourceSchema(
              dataSourceId
            );
          const results = [];
          for (let index = 0; index < records.length; index++) {
            const rec = records[index] || {};
            try {
              const properties =
                buildSchemaAwareProperties(
                  rec.properties || {},
                  schema
                );
              const payload = {
                parent: {
                  type: "data_source_id",
                  data_source_id: dataSourceId
                },
                properties
              };
              const created =
                await withRetry(() => notion.pages.create(payload));
              if (rec.content) {
                const blocks = markdownToBlocks(rec.content);
                if (blocks.length > 0) {
                  await appendBlocksInChunks(created.id, blocks);
                }
              }
              const verification =
                await verifyPage(
                  created.id,
                  rec.properties || {},
                  schema
                );
              results.push({
                index,
                success: verification.verified,
                id: created.id,
                url: created.url || null,
                verified: verification.verified,
                mismatches: verification.mismatches
              });
            } catch (error) {
              results.push({
                index,
                success: false,
                error: error?.message || String(error)
              });
            }
          }
          const successCount = results.filter((r) => r.success).length;
          return toolResult({
            success: successCount === results.length,
            total: results.length,
            succeeded: successCount,
            failed: results.length - successCount,
            results
          });
        }
        if (
          name === "update_record" ||
          name === "update_page"
        ) {
          const current =
            await withRetry(() => notion.pages.retrieve(
              {
                page_id:
                  args.page_id
              }
            ));
          if (
            !current ||
            current.object !==
            "page"
          ) {
            throw new Error(
              "The supplied ID is not a Notion page."
            );
          }
          const dataSourceId =
            current.parent
              ?.data_source_id;
          if (!dataSourceId) {
            throw new Error(
              "This page is not a database row with a resolvable data_source_id."
            );
          }
          const schema =
            await getDataSourceSchema(
              dataSourceId
            );
          const properties =
            buildSchemaAwareProperties(
              args.properties,
              schema
            );
          const response =
            await withRetry(() => notion.pages.update(
              {
                page_id:
                  args.page_id,
                properties
              }
            ));
          const verification =
            await verifyPage(
              response.id,
              args.properties,
              schema
            );
          if (
            !verification.verified
          ) {
            return toolResult({
              success: false,
              operation:
                "update_record",
              id:
                response.id,
              url:
                response.url ||
                null,
              verified: false,
              error:
                "Update was sent, but read-after-write verification failed.",
              mismatches:
                verification.mismatches,
              actual:
                verification.actual
            });
          }
          return toolResult({
            success: true,
            operation:
              "updated",
            id:
              response.id,
            url:
              response.url ||
              null,
            verified: true,
            properties:
              verification.actual,
            message:
              "Record updated and verified successfully."
          });
        }
        if (
          name === "verify_record"
        ) {
          const current =
            await withRetry(() => notion.pages.retrieve(
              {
                page_id:
                  args.page_id
              }
            ));
          if (
            !current ||
            current.object !==
            "page"
          ) {
            throw new Error(
              "The supplied ID is not a Notion page."
            );
          }
          const dataSourceId =
            current.parent
              ?.data_source_id;
          if (!dataSourceId) {
            throw new Error(
              "The page has no data_source_id."
            );
          }
          const schema =
            await getDataSourceSchema(
              dataSourceId
            );
          const verification =
            await verifyPage(
              args.page_id,
              args.properties,
              schema
            );
          return toolResult({
            success: true,
            verified:
              verification.verified,
            id:
              args.page_id,
            url:
              current.url || null,
            mismatches:
              verification.mismatches,
            actual:
              verification.actual
          });
        }
        if (name === "delete_record") {
          const current =
            await withRetry(() => notion.pages.retrieve({
              page_id: args.page_id
            }));
          if (!current || current.object !== "page") {
            throw new Error("The supplied ID is not a Notion page.");
          }
          const title = extractTitleFromPage(current);
          const response =
            await withRetry(() => notion.pages.update({
              page_id: args.page_id,
              archived: true
            }));
          return toolResult({
            success: true,
            operation: "archived",
            id: response.id,
            title: title,
            url: response.url || null,
            archived: true,
            message: "Record archived successfully. It can be restored from Notion's trash."
          });
        }
        if (
          name === "upsert_record"
        ) {
          const resolved =
            args.data_source_id
              ? {
                data_source_id:
                  args.data_source_id,
                schema:
                  await getDataSourceSchema(
                    args.data_source_id
                  )
              }
              : await resolveDataSource(
                args.database
              );
          const schema =
            resolved.schema;
          buildSchemaAwareProperties(
            args.match,
            schema
          );
          buildSchemaAwareProperties(
            args.properties,
            schema
          );
          const queryResult =
            await queryAllDataSourcePages(
              resolved.data_source_id
            );
          const match =
            queryResult.pages.find(
              (page) => {
                for (
                  const key of Object.keys(
                    args.match || {}
                  )
                ) {
                  const schemaProperty =
                    schema.properties?.[
                    key
                    ];
                  if (
                    !schemaProperty
                  ) {
                    return false;
                  }
                  const actual =
                    extractPropertyValue(
                      page.properties?.[
                      key
                      ]
                    );
                  if (
                    !valuesEqual(
                      args.match[key],
                      actual,
                      schemaProperty
                    )
                  ) {
                    return false;
                  }
                }
                return true;
              }
            );
          if (match) {
            const properties =
              buildSchemaAwareProperties(
                args.properties,
                schema
              );
            const updated =
              await withRetry(() => notion.pages.update(
                {
                  page_id:
                    match.id,
                  properties
                }
              ));
            if (args.content) {
              const blocks =
                markdownToBlocks(
                  args.content
                );
              if (
                blocks.length > 0
              ) {
                await appendBlocksInChunks(
                  updated.id,
                  blocks
                );
              }
            }
            const verification =
              await verifyPage(
                updated.id,
                args.properties,
                schema
              );
            return toolResult({
              success:
                verification.verified,
              operation:
                "updated_existing",
              id:
                updated.id,
              url:
                updated.url ||
                null,
              verified:
                verification.verified,
              mismatches:
                verification.mismatches,
              actual:
                verification.actual,
              message:
                verification.verified
                  ? "Existing record updated and verified."
                  : "Existing record was updated but verification failed."
            });
          }
          const properties =
            buildSchemaAwareProperties(
              args.properties,
              schema
            );
          const payload = {
            parent: {
              type:
                "data_source_id",
              data_source_id:
                resolved.data_source_id
            },
            properties
          };
          const created =
            await withRetry(() => notion.pages.create(
              payload
            ));
          if (args.content) {
            const blocks =
              markdownToBlocks(
                args.content
              );
            if (
              blocks.length > 0
            ) {
              await appendBlocksInChunks(
                created.id,
                blocks
              );
            }
          }
          const verification =
            await verifyPage(
              created.id,
              args.properties,
              schema
            );
          return toolResult({
            success:
              verification.verified,
            operation:
              "created_new",
            id:
              created.id,
            url:
              created.url ||
              null,
            verified:
              verification.verified,
            mismatches:
              verification.mismatches,
            actual:
              verification.actual,
            message:
              verification.verified
                ? "New record created and verified."
                : "New record was created but verification failed."
          });
        }
        /* ------------------------------ notes ------------------------------ */
        if (
          name === "append_note" ||
          name === "append_markdown"
        ) {
          const markdown =
            args.markdown;
          const blocks =
            markdownToBlocks(
              markdown
            );
          if (
            blocks.length === 0
          ) {
            throw new Error(
              "No content to append."
            );
          }
          const results =
            await appendBlocksInChunks(
              args.page_id,
              blocks
            );
          return toolResult({
            success: true,
            appended:
              results.length,
            message:
              "Content appended successfully."
          });
        }
        if (
          name === "append_blocks"
        ) {
          if (
            !Array.isArray(
              args.blocks
            )
          ) {
            throw new Error(
              "blocks must be an array."
            );
          }
          const results =
            await appendBlocksInChunks(
              args.page_id,
              args.blocks
            );
          return toolResult({
            success: true,
            appended:
              results.length,
            results
          });
        }
        if (
          name === "update_block"
        ) {
          const payload = {};
          payload[
            args.type
          ] = args.block;
          const response =
            await withRetry(() => notion.blocks.update(
              {
                block_id:
                  args.block_id,
                type:
                  args.type,
                ...payload
              }
            ));
          return toolResult({
            success: true,
            block:
              response
          });
        }
        /* ---------------------------- databases ---------------------------- */
        if (
          name === "create_database"
        ) {
          const response =
            await withRetry(() => notion.databases.create(
              {
                parent: {
                  type:
                    "page_id",
                  page_id:
                    args.parent_page_id
                },
                title: [
                  {
                    type:
                      "text",
                    text: {
                      content:
                        args.title
                    }
                  }
                ],
                initial_data_source: {
                  properties:
                    args.properties ||
                    {}
                }
              }
            ));
          return toolResult({
            success: true,
            database_id:
              response.id,
            data_sources:
              response.data_sources ||
              [],
            url:
              response.url ||
              null,
            message:
              "Database created successfully."
          });
        }
        if (
          name ===
          "update_database_schema"
        ) {
          const response =
            await withRetry(() => notion.dataSources.update(
              {
                data_source_id:
                  args.data_source_id,
                properties:
                  args.properties ||
                  {}
              }
            ));
          setCachedSchema(args.data_source_id, response);
          return toolResult({
            success: true,
            data_source_id:
              args.data_source_id,
            schema:
              response
          });
        }
        throw new Error(
          "Unknown tool: " + name
        );
      } catch (error) {
        console.error(
          "[MCP] TOOL ERROR:",
          error
        );
        return toolError(
          error
        );
      } finally {
        console.log(
          `[MCP] TOOL END: ${name} (${Date.now() - startedAt}ms)`
        );
      }
    }
  );
  return server;
}

/* -------------------------------------------------------------------------- */
/* HTTP / SSE                                                                 */
/* -------------------------------------------------------------------------- */
app.get(
  "/",
  (req, res) => {
    res.json({
      status: "ok",
      service:
        "notion-mcp-qwen",
      transport: "SSE",
      endpoint: "/sse",
      version:
        SERVER_VERSION,
      capabilities: [
        "schema-aware record create/update",
        "batch record creation",
        "soft delete (archive)",
        "upsert",
        "read-after-write verification",
        "database discovery by name",
        "full pagination (400+ records)",
        "schema caching",
        "retry on rate limits",
        "fuzzy search",
        "recursive page blocks",
        "markdown inline styles",
        "relations",
        "people",
        "markdown page content"
      ]
    });
  }
);

app.get(
  "/sse",
  async (req, res) => {
    console.log(
      "[MCP] New SSE connection"
    );
    try {
      const server =
        await createMcpServer();
      const transport =
        new SSEServerTransport(
          "/messages",
          res
        );
      const sessionId =
        transport.sessionId;
      sessions.set(
        sessionId,
        {
          transport,
          server
        }
      );
      console.log(
        "[MCP] SSE session:",
        sessionId
      );
      res.on(
        "close",
        async () => {
          console.log(
            "[MCP] SSE closed:",
            sessionId
          );
          sessions.delete(
            sessionId
          );
          try {
            await server.close();
          } catch (error) {
            console.error(
              "[MCP] Server close error:",
              error
            );
          }
        }
      );
      await server.connect(
        transport
      );
    } catch (error) {
      console.error(
        "[MCP] SSE ERROR:",
        error
      );
      if (
        !res.headersSent
      ) {
        res.status(500).json({
          error:
            error.message
        });
      }
    }
  }
);

app.post(
  "/messages",
  async (req, res) => {
    const sessionId =
      req.query.sessionId;
    console.log(
      "[MCP] POST /messages session:",
      sessionId
    );
    if (!sessionId) {
      return res.status(400).json({
        error:
          "Missing sessionId"
      });
    }
    const session =
      sessions.get(
        sessionId
      );
    if (!session) {
      return res.status(404).json({
        error:
          "Session not found"
      });
    }
    try {
      console.log(
        "[MCP] POST /messages body received"
      );
      await session.transport.handlePostMessage(
        req,
        res,
        req.body
      );
      console.log(
        "[MCP] POST /messages handled"
      );
    } catch (error) {
      console.error(
        "[MCP] MESSAGE ERROR:",
        error
      );
      if (
        !res.headersSent
      ) {
        res.status(500).json({
          error:
            error.message
        });
      }
    }
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Notion MCP Qwen server v${SERVER_VERSION} listening on port ${PORT}`
    );
  }
);
