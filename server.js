import express from 'express';
import { Client } from '@notionhq/client';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

// Инициализация MCP-сервера
const server = new Server(
    { name: "notion-sse", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

// 1. Регистрируем обработчик для вывода списка инструментов
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "search_notion",
                description: "Поиск страниц, заметок и баз данных в Notion по ключевым словам",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Текст или название страницы для поиска" }
                    },
                    required: ["query"]
                }
            },
            {
                name: "read_page",
                description: "Чтение содержимого конкретной страницы Notion по её ID",
                inputSchema: {
                    type: "object",
                    properties: {
                        page_id: { type: "string", description: "Уникальный идентификатор (ID) страницы" }
                    },
                    required: ["page_id"]
                }
            }
        ]
    };
});

// 2. Регистрируем обработчик для выполнения выбранного инструмента
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    try {
        if (name === "search_notion") {
            const response = await notion.search({ query: args.query, page_size: 5 });
            const results = response.results.map(p => {
                // Извлекаем название страницы из разных возможных структур Notion
                const titleObj = p.properties?.title || p.properties?.Name;
                const titleText = titleObj?.title?.[0]?.plain_text || "Без названия";
                return {
                    id: p.id,
                    title: titleText,
                    type: p.object
                };
            });
            return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
        }
        
        if (name === "read_page") {
            const response = await notion.blocks.children.list({ block_id: args.page_id });
            const text = response.results
                .map(b => {
                    const blockContent = b[b.type];
                    return blockContent?.text?.[0]?.plain_text || blockContent?.rich_text?.[0]?.plain_text || "";
                })
                .filter(Boolean)
                .join("\n");
            return { content: [{ type: "text", text: text || "Страница пуста или содержит сложные блоки" }] };
        }
    } catch (err) {
        return { content: [{ type: "text", text: `Ошибка Notion API: ${err.message}` }], isError: true };
    }
    
    throw new Error(`Инструмент не найден: ${name}`);
});

let transport;

app.get("/sse", (req, res) => {
    transport = new SSEServerTransport("/messages", res);
    server.connect(transport);
});

app.post("/messages", express.json(), (req, res) => {
    if (transport) {
        transport.handleMessage(req, res);
    } else {
        res.status(400).send("No active transport");
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
