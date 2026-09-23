# ChatUI 插件运行时配置

ChatUI 的 HTTP 与 MCP 插件默认关闭。生产部署把配置放在 `data/plugins.json`（部署数据，不入 Git），并通过环境变量提供凭据：

```bash
CHATUI_PLUGINS_FILE=/path/to/data/plugins.json
CHATUI_PLUGIN_WEATHER_KEY=...
```

## HTTP 插件

```json
{
  "schema_version": "chatui_plugins.v1",
  "plugins": [
    {
      "id": "weather",
      "type": "http",
      "label": "天气",
      "enabled": true,
      "baseUrl": "https://api.example.com",
      "auth": { "type": "bearer", "env": "CHATUI_PLUGIN_WEATHER_KEY" },
      "tools": [
        {
          "name": "get_weather",
          "description": "查询城市天气",
          "method": "GET",
          "path": "/v1/weather",
          "risk": "read",
          "requiresApproval": false,
          "inputSchema": {
            "type": "object",
            "properties": { "city": { "type": "string", "maxLength": 80 } },
            "required": ["city"],
            "additionalProperties": false
          }
        }
      ]
    }
  ]
}
```

GET 参数从工具参数生成 JSON 兼容的 query；非 GET 方法把参数作为 JSON body 发送。

## MCP 插件

```json
{
  "schema_version": "chatui_plugins.v1",
  "plugins": [
    {
      "id": "company-tools",
      "type": "mcp",
      "label": "企业工具",
      "enabled": true,
      "serverUrl": "https://mcp.example.com/mcp",
      "auth": { "type": "bearer", "env": "CHATUI_PLUGIN_MCP_KEY" },
      "tools": [
        { "name": "search_docs", "description": "搜索企业文档", "risk": "read", "requiresApproval": false }
      ]
    }
  ]
}
```

MCP 使用 Streamable HTTP JSON-RPC，并只允许显式列出的工具。工具 schema 在每次调用前通过 `tools/list` 刷新并校验。
