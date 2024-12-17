# MCP Server Manager

A web-based GUI tool for managing Model Context Protocol (MCP) servers in Claude and Cursor. This tool allows you to easily enable/disable MCP servers and their tools through a user-friendly interface.

## Features

- 🎛️ Enable/disable MCP servers with simple toggle switches
- 🔄 Changes are automatically synced between Claude and Cursor
- 🛠️ View available tools for each server
- 🔒 Secure handling of environment variables and API keys
- 📱 Responsive design that works on any screen size

![MCP Server Manager Interface](https://github.com/MediaPublishing/mcp-manager/blob/main/MCP-Server-Manager.png?raw=true)

## Installation

1. Clone this repository:
```bash
git clone https://github.com/yourusername/mcp-manager.git
cd mcp-manager
```

2. Install dependencies:
```bash
npm install
```

3. Create a configuration file:
```bash
cp config.example.json config.json
```

4. Start the server:
```bash
npm start
```

5. Open http://localhost:3456 in your browser

## Configuration

The MCP Server Manager uses two configuration files:

- `config.json`: Main configuration file for the server
- Claude config: Located at `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
- Cursor config: Located at `~/Library/Application Support/Cursor/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` (macOS)

### Example Configuration

```json
{
  "mcpServers": {
    "example-server": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": {
        "API_KEY": "your-api-key"
      }
    }
  }
}
```

## Usage

1. Launch the MCP Server Manager
2. Use the toggle switches to enable/disable servers
3. Click "Save Changes" to apply your changes
4. Restart Claude to activate the new configuration

## Keywords

- Model Context Protocol (MCP)
- Claude AI
- Anthropic Claude
- Cursor Editor
- MCP Server Management
- Claude Configuration
- AI Tools Management
- Claude Extensions
- MCP Tools
- AI Development Tools

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built for use with Anthropic's Claude AI
- Compatible with the Cursor editor
- Uses the Model Context Protocol (MCP)
