# MCP Server Manager

A web-based GUI tool for managing Model Context Protocol (MCP) servers in Claude and Cursor. This tool allows you to easily enable/disable MCP servers and their tools through a user-friendly interface.

## Features

- 🎛️ Enable/disable MCP servers
- 💾 Manage configurations per client (Claude, Cursor, etc.) when sync is disabled
  - Creates separate `configs/CLIENT_ID.json` files
- 🔄 Optionally sync configurations across all enabled clients
- ✨ Preset management: Save, load, and delete named configuration presets
- 🔒 Secure display of sensitive environment variables (API Keys, Tokens) with Shift-to-reveal and click-to-copy
- 📜 View configuration backups
- 📱 Responsive design

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

4. (Optional) Review and adjust paths in `settings.json` if defaults are incorrect.
5. Start the server:
```bash
npm start
```

6. Open http://localhost:3456 in your browser

## Configuration

The MCP Server Manager uses the following configuration files:

- `settings.json`: Defines client applications (like Claude, Cursor), their original config file paths, and the global `syncClients` setting.
- `config.json`: Used as the main configuration source when `syncClients` is `true`, and as a temporary working copy reflecting the last loaded/saved state.
- `configs/CLIENT_ID.json`: (Auto-generated when `syncClients` is `false`) Stores the specific configuration for each client independently.
- `presets.json`: Stores named configuration presets.
- Client-specific config files: The original configuration files used by Claude, Cursor, etc. (paths defined in `settings.json`). These are read from when resetting or when loading a client config for the first time with sync disabled. They are written to only when `syncClients` is `true` and changes are saved.
- `mcp-backups/`: Directory automatically created within the location of each managed config file (`config.json`, `configs/CLIENT_ID.json`, original client files) to store timestamped backups on save/reset operations.

### `settings.json` Example

```json
{
  "maxBackups": 10,
  "clients": {
    "claude": {
      "name": "Claude Desktop",
      "enabled": true, // Whether this client appears in the UI and is synced (if syncClients=true)
      "configPath": "/path/to/claude_desktop_config.json" // Path to the *original* config file
    },
    "cursor": {
      "name": "Cursor",
      "enabled": true,
      "configPath": "/path/to/cursor_mcp.json"
    }
  },
  "syncClients": false // If true, all enabled clients share config.json. If false, uses configs/CLIENT_ID.json
}
```


### `config.json` / `configs/CLIENT_ID.json` Format

```json
{
  "mcpServers": {
    "example-server": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": {
        "API_KEY": "your-api-key", // Will be masked in UI
        "SOME_VAR": "some-value"
      },
      "enabled": true // Optional: Controls if server runs (defaults to true)
    }
    // ... other servers
  }
}
```


## Usage

1.  Launch the MCP Server Manager (`npm start`).
2.  **Sync Mode:**
    *   Toggle `Sync Clients` **ON** in the sidebar.
    *   The main `config.json` is loaded.
    *   Changes made in the editor apply to `config.json`.
    *   Clicking `Save Changes` writes the current editor state to `config.json` AND overwrites the *original* config files of all *enabled* clients.
    *   Clicking `Reset Changes` reverts the editor to the state of the *original* config file of the *first enabled* client.
3.  **Individual Client Mode:**
    *   Ensure `Sync Clients` is **OFF**.
    *   Click a client name (e.g., "Cursor") in the sidebar.
    *   The manager loads `configs/cursor.json` (creating it from the original `~/.cursor/mcp.json` if it doesn't exist).
    *   Changes made apply only to the selected client's configuration in memory.
    *   Clicking `Save Changes` writes the current editor state ONLY to `configs/cursor.json`.
    *   Clicking `Reset Changes` reverts the editor state to the content of the *original* `~/.cursor/mcp.json` file.
4.  **Presets:**
    *   Use the dropdown to load a preset configuration into the editor.
    *   Modify and use "Save As New" or "Save Changes to Preset".
    *   *Note:* Loading a preset modifies the editor state; you still need to click the main "Save Changes" button to apply this configuration to the active client(s).
5.  **Servers:**
    *   Toggle servers on/off directly in the server cards.
    *   Click a server card to open the modal and edit command, args, env vars, etc.
    *   Env vars containing `KEY`, `TOKEN`, `SECRET`, or `PASS` are masked (`******`).
    *   Hover over a masked value to reveal it.
    *   Hold `Shift` to reveal all masked values simultaneously.
    *   Click a (revealed) sensitive value or any non-sensitive value to copy it to the clipboard.
6.  **Backups Tab:** View timestamped backups created automatically when saving or resetting configurations.
7.  Restart relevant client applications (Claude, Cursor) if needed for changes to take effect (especially changes to server commands/args/env).


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
