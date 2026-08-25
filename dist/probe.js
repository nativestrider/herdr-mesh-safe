import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: "herdr-mesh-safe-probe", version: "1.0.0" });
try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    const status = await client.callTool({ name: "herdr_bridge_status", arguments: {} });
    const text = status.content.find((item) => item.type === "text");
    if (!text || text.type !== "text")
        throw new Error("bridge status returned no text payload");
    console.log(JSON.stringify({ status: JSON.parse(String(text.text)), tools: tools.tools.map((tool) => tool.name).sort() }));
}
finally {
    await client.close();
    await server.close();
}
//# sourceMappingURL=probe.js.map