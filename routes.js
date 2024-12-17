import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Get config file paths based on OS
function getConfigPaths() {
    const home = process.env.HOME || process.env.USERPROFILE;
    const isMac = process.platform === 'darwin';
    
    if (isMac) {
        return {
            CURSOR_CONFIG_PATH: path.join(home, 'Library/Application Support/Cursor/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'),
            CLAUDE_CONFIG_PATH: path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json')
        };
    } else if (process.platform === 'win32') {
        return {
            CURSOR_CONFIG_PATH: path.join(home, 'AppData/Roaming/Cursor/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'),
            CLAUDE_CONFIG_PATH: path.join(home, 'AppData/Roaming/Claude/claude_desktop_config.json')
        };
    } else {
        // Linux paths
        return {
            CURSOR_CONFIG_PATH: path.join(home, '.config/Cursor/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'),
            CLAUDE_CONFIG_PATH: path.join(home, '.config/Claude/claude_desktop_config.json')
        };
    }
}

const { CURSOR_CONFIG_PATH, CLAUDE_CONFIG_PATH } = getConfigPaths();

// Helper function to read config files
async function readConfigFile(filePath) {
    try {
        console.log('Reading config file:', filePath);
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No existing config found, using empty config');
            return { mcpServers: {} };
        }
        console.error(`Error reading ${filePath}:`, error);
        throw error;
    }
}

// Helper function to merge configurations
function mergeConfigs(savedConfig, defaultConfig) {
    console.log('Merging configs:');
    console.log('Saved servers:', Object.keys(savedConfig.mcpServers || {}));
    console.log('Default servers:', Object.keys(defaultConfig));
    
    const mergedServers = {};
    
    // Start with all default servers
    Object.entries(defaultConfig).forEach(([name, config]) => {
        mergedServers[name] = { ...config };
    });
    
    // Override with saved configurations
    Object.entries(savedConfig.mcpServers || {}).forEach(([name, config]) => {
        mergedServers[name] = {
            ...mergedServers[name],
            ...config
        };
    });
    
    console.log('Merged servers:', Object.keys(mergedServers));
    return { mcpServers: mergedServers };
}

// Helper function to filter out disabled servers
function filterDisabledServers(config) {
    const filteredConfig = { mcpServers: {} };
    
    Object.entries(config.mcpServers).forEach(([name, server]) => {
        // Only include servers that are not disabled
        if (!server.disabled) {
            // Create a new server object without the disabled property
            const { disabled, ...serverConfig } = server;
            filteredConfig.mcpServers[name] = serverConfig;
        } else {
            console.log(`Filtering out disabled server: ${name}`);
        }
    });
    
    console.log('Filtered servers:', Object.keys(filteredConfig.mcpServers));
    return filteredConfig;
}

// Get cursor config
router.get('/cursor-config', async (req, res) => {
    console.log('Handling /api/cursor-config request');
    try {
        const savedConfig = await readConfigFile(CURSOR_CONFIG_PATH);
        const defaultConfig = await readConfigFile(path.join(__dirname, 'config.json'));
        const mergedConfig = mergeConfigs(savedConfig, defaultConfig.mcpServers || {});
        console.log('Returning merged config with servers:', Object.keys(mergedConfig.mcpServers));
        res.json(mergedConfig);
    } catch (error) {
        console.error('Error in /api/cursor-config:', error);
        res.status(500).json({ error: `Failed to read Cursor config: ${error.message}` });
    }
});

// Get claude config
router.get('/claude-config', async (req, res) => {
    console.log('Handling /api/claude-config request');
    try {
        const config = await readConfigFile(CLAUDE_CONFIG_PATH);
        res.json(config);
    } catch (error) {
        console.error('Error in /api/claude-config:', error);
        res.status(500).json({ error: `Failed to read Claude config: ${error.message}` });
    }
});

// Get tools list
router.get('/tools', async (req, res) => {
    console.log('Handling /api/tools request');
    try {
        const cursorConfig = await readConfigFile(CURSOR_CONFIG_PATH);
        const defaultConfig = await readConfigFile(path.join(__dirname, 'config.json'));
        const mergedConfig = mergeConfigs(cursorConfig, defaultConfig.mcpServers || {});
        const servers = mergedConfig.mcpServers;

        // Define available tools for each server
        const toolsMap = {
            'mcp-manager': [{
                name: 'launch_manager',
                description: 'Launch the MCP Server Manager interface',
                inputSchema: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            }]
        };

        // Filter tools based on enabled servers
        const enabledTools = Object.entries(toolsMap)
            .filter(([serverName]) => {
                return servers[serverName] && !servers[serverName].disabled;
            })
            .flatMap(([serverName, tools]) => 
                tools.map(tool => ({
                    ...tool,
                    server: serverName
                }))
            );

        console.log(`Returning ${enabledTools.length} tools`);
        res.json(enabledTools);
    } catch (error) {
        console.error('Error in /api/tools:', error);
        res.status(500).json({ error: error.message });
    }
});

// Save configs
router.post('/save-configs', async (req, res) => {
    console.log('Handling /api/save-configs request');
    try {
        const { mcpServers } = req.body;
        if (!mcpServers) {
            throw new Error('No server configuration provided');
        }

        // Save full config to Cursor settings (for UI state)
        const fullConfig = { mcpServers };
        await fs.writeFile(CURSOR_CONFIG_PATH, JSON.stringify(fullConfig, null, 2));

        // Save filtered config to Claude settings (removing disabled servers)
        const filteredConfig = filterDisabledServers(fullConfig);
        console.log('Filtered config for Claude:', JSON.stringify(filteredConfig, null, 2));
        await fs.writeFile(CLAUDE_CONFIG_PATH, JSON.stringify(filteredConfig, null, 2));

        console.log('Configurations saved successfully');
        res.json({ 
            success: true, 
            message: 'Configurations saved successfully. Please restart Claude to apply changes.' 
        });
    } catch (error) {
        console.error('Error in /api/save-configs:', error);
        res.status(500).json({ error: `Failed to save configurations: ${error.message}` });
    }
});

export default router;
