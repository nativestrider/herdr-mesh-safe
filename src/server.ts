import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolDef, execTool } from "./tools/types.js";
import { agentTools } from "./tools/agent.js";
import { sessionTools } from "./tools/session.js";
import { paneTools } from "./tools/pane.js";
import { tabTools, workspaceTools } from "./tools/workspace.js";
import { integrationTools } from "./tools/integration.js";
import { compositeTools } from "./tools/composite.js";
import { safeAgentTools } from "./tools/safe-agent.js";
import { safeWriterTools } from "./tools/safe-writer.js";

const safeToolNames = new Set([
  "herdr_relay",
  "herdr_handoff",
  "herdr_agent_list",
  "herdr_agent_get",
  "herdr_agent_read",
  "herdr_agent_wait",
  "herdr_agent_wait_settled",
  "herdr_agent_wait_any",
  "herdr_wait_output",
  "herdr_session_list",
  "herdr_pane_list",
  "herdr_pane_get",
  "herdr_pane_read",
  "herdr_tab_list",
  "herdr_tab_get",
  "herdr_workspace_list",
  "herdr_workspace_get",
  "herdr_integration_status",
  "herdr_owned_reviewer_start",
  "herdr_owned_reviewer_list",
  "herdr_owned_reviewer_close",
  "herdr_owned_reviewer_cleanup",
  "herdr_owned_worker_start",
  "herdr_owned_worker_list",
  "herdr_owned_worker_release",
]);

// Desktop orchestration may observe and message live agents, but it must not
// obtain arbitrary terminal execution or lifecycle/destructive controls.
const allTools: ToolDef[] = [
  ...compositeTools,
  ...safeAgentTools,
  ...safeWriterTools,
  ...agentTools,
  ...sessionTools,
  ...paneTools,
  ...tabTools,
  ...workspaceTools,
  ...integrationTools,
].filter((tool) => safeToolNames.has(tool.name));

export function createServer(): McpServer {
  const server = new McpServer({
    name: "herdr-mesh",
    version: "0.1.0-safe.5",
  });

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: Record<string, unknown>) => execTool(tool, args ?? {}),
    );
  }

  return server;
}
