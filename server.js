import express from 'express';
import { Client } from '@notionhq/client';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const app = express();
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const server = new Server(
    { name: "notion-sse", version: "1.0.0" },
    { capabilities: { tools: {} } }
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
