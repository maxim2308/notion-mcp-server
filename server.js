import express from 'express';
import { Client } from '@notionhq/client';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const app = express();
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

// Инициализация MCP-сервера с объявлением доступных инструментов для Qwen
const server = new Server(
    { name: "notion-sse", version: "1.0.0" },
    { 
        capabilities: { 
            tools: {
                listChanged: true
            } 
        } 
    }
);

// Регистрируем инструменты, которые Qwen Studio увидит при подключении
server.setRequestHandler(
    async (request) => {
        if (request.method === "tools/list") {
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
        }
        
        // Логика выполнения самих инструментов при запросе от Qwen
        if (request.method === "tools/call") {
            const { name, arguments: args } = request.params;
            
            try {
                if (name === "search_notion") {
                    const response = await notion.search({ query: args.query, page_size: 5 });
                    const results = response.results.map(p => ({
                        id: p.id,
                        title: p.properties?.title?.title?.[0]?.plain_text || p.properties?.Name?.title?.[0]?.plain_text || "Без названия",
                        type: p.object
                    }));
                    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
                }
                
                if (name === "read_page") {
                    const response = await notion.blocks.children.list({ block_id: args.page_id });
                    const text = response.results
                        .map(b => b[b.type]?.text?.[0]?.plain_text || b[b.type]?.rich_text?.[0]?.plain_text || "")
                        .filter(Boolean)
                        .join("\n");
                    return { content: [{ type: "text", text: text || "Страница пуста или содержит неподдерживаемый тип блоков" }] };
                }
            } catch (err) {
                return { content: [{ type: "text", text: `Ошибка Notion API: ${err.message}` }], isError: true };
            }
        }
        
        throw new Error(`Метод не поддерживается: ${request.method}`);
    }
);

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
