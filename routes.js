import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import _ from 'lodash'; // Import lodash for deep comparison

// Check DEBUG environment variable
const IS_DEBUG_MODE = ['true', '1'].includes(process.env.DEBUG?.toLowerCase());

// Get __dirname equivalent in ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS_DIR = path.join(__dirname, 'configs'); // Directory for client-specific configs
const MCP_SERVER_REGISTRY_PATH = path.join(__dirname, 'mcp_server_registry.json'); // Path for the server registry
const SYNC_CONFIGS_DIR = path.join(__dirname, 'sync_configs'); // Directory for sync group configs

// Default settings structure
const defaultSettings = {
    maxBackups: 10,
    clients: {
        claude: {
            name: "Claude Desktop",
            configPath: null, // Will be auto-detected
            enabled: true,
            builtIn: true,
            syncGroup: null
        },
        cursor: {
            name: "Cursor",
            configPath: null, // Will be auto-detected
            enabled: true,
            builtIn: true,
            syncGroup: null
        }
    },
    syncGroups: {}
    // Removed syncClients boolean
};

let settings = _.cloneDeep(defaultSettings);

// Settings files path
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const PRESETS_PATH = path.join(__dirname, 'presets.json'); // Path to presets file
const CONFIG_PATH = path.join(__dirname, 'config.json'); // Main config file (used for sync mode or last loaded view)

// Store the initially loaded active configuration for comparison
let initialActiveConfig = { mcpServers: {} };

// Ensure configs directory exists
async function ensureConfigsDir() {
    try {
        await fs.mkdir(CONFIGS_DIR, { recursive: true });
        await fs.mkdir(SYNC_CONFIGS_DIR, { recursive: true }); // Ensure sync dir exists
        console.log(`Ensured config directories exist: ${CONFIGS_DIR}, ${SYNC_CONFIGS_DIR}`);
    } catch (error) {
        console.error(`Failed to create config directories:`, error);
    }
}

// Ensure a JSON file exists, creating it with default content if not
async function ensureJsonFile(filePath, defaultContent = {}) {
    try {
        await fs.access(filePath);
        // Optionally, validate if it's valid JSON here
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`${path.basename(filePath)} not found, creating with defaults.`);
            await fs.writeFile(filePath, JSON.stringify(defaultContent, null, 2));
        } else {
            console.error(`Error accessing ${filePath}:`, error);
            // Consider throwing the error or handling it differently
        }
    }
}

// Load settings on startup
async function loadSettings() {
    try {
        await ensureJsonFile(SETTINGS_PATH, defaultSettings); // Use ensureJsonFile with default structure
        const data = await fs.readFile(SETTINGS_PATH, 'utf8');
        let loadedSettings = JSON.parse(data);

        // Merge loaded settings with defaults to ensure all keys exist
        settings = _.merge({}, defaultSettings, loadedSettings);

        if (IS_DEBUG_MODE) {
            console.log('Loaded settings:', JSON.stringify(settings, null, 2));
        }

        // Ensure client paths are set if null
        const defaultPaths = getDefaultConfigPaths();
        let settingsUpdated = false; // Flag to track if settings need saving
        Object.entries(settings.clients).forEach(([key, client]) => {
            if (!client.configPath) {
                if (key === 'claude') {
                    settings.clients[key].configPath = defaultPaths.CLAUDE_CONFIG_PATH;
                    settingsUpdated = true;
                } else if (key === 'cursor') {
                    settings.clients[key].configPath = defaultPaths.CURSOR_CONFIG_PATH;
                    settingsUpdated = true;
                }
            }
        });

        // Save updated settings if paths were updated
        if (settingsUpdated) {
            await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
            console.log('Updated settings.json with default paths.');
        }

        // Initialize syncGroups if missing
        if (!settings.syncGroups) settings.syncGroups = {};

    } catch (error) {
        // Handle potential JSON parse errors or other read errors
         console.error('Failed to load or parse settings.json, using defaults:', error);
         // Fallback to default settings might be needed here, ensure paths are set
          const defaultPaths = getDefaultConfigPaths();
          if (!settings.clients?.claude?.configPath) settings.clients.claude.configPath = defaultPaths.CLAUDE_CONFIG_PATH;
          if (!settings.clients?.cursor?.configPath) settings.clients.cursor.configPath = defaultPaths.CURSOR_CONFIG_PATH;
          // Initialize syncGroups if missing
          if (!settings.syncGroups) settings.syncGroups = {};
    }

    // Ensure other essential files exist
    await ensureJsonFile(PRESETS_PATH, { "Default": {} });
    await ensureJsonFile(CONFIG_PATH, { "mcpServers": {} });
    await ensureJsonFile(MCP_SERVER_REGISTRY_PATH, { "mcpServers": {} }); // Ensure registry file exists

    // Ensure configs directory exists
    await ensureConfigsDir();
}

const router = express.Router();

// Get default config file paths based on OS
function getDefaultConfigPaths() {
    const home = process.env.HOME || process.env.USERPROFILE;
    const isMac = process.platform === 'darwin';
    
    if (isMac) {
        return {
            CURSOR_CONFIG_PATH: path.join(home, '.cursor/mcp.json'),
            CLAUDE_CONFIG_PATH: path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json')
        };
    } else if (process.platform === 'win32') {
        return {
            CURSOR_CONFIG_PATH: path.join(home, '.cursor/mcp.json'),
            CLAUDE_CONFIG_PATH: path.join(home, 'AppData/Roaming/Claude/claude_desktop_config.json')
        };
    } else {
        // Linux paths
        return {
            CURSOR_CONFIG_PATH: path.join(home, '.cursor/mcp.json'),
            CLAUDE_CONFIG_PATH: path.join(home, '.config/Claude/claude_desktop_config.json')
        };
    }
}

// Get client config path from ID
function getClientConfigPath(clientId) {
    if (settings.clients[clientId]) {
        const client = settings.clients[clientId];
        // If client is in a sync group, return the group's path
        if (client.syncGroup && settings.syncGroups[client.syncGroup]) {
            return settings.syncGroups[client.syncGroup].configPath;
        }
        // Otherwise, return its individual path (could be original or specific)
        return client.configPath || getClientSpecificConfigPath(clientId);
    }
    return null;
}

// Get path for client-specific config in the 'configs' directory
// This is used when a client is NOT synced
function getClientSpecificConfigPath(clientId) {
    if (!clientId) return null;
    return path.join(CONFIGS_DIR, `${clientId}.json`);
}

// Get all enabled client config paths (original locations)
function getEnabledClientConfigPaths() {
    return Object.entries(settings.clients)
        .filter(([_, client]) => client.enabled)
        .map(([_, client]) => client.configPath)
        .filter(Boolean); // Remove null/undefined paths
}

// Helper function to read config files - respects syncClients setting
async function readManagedConfigFile(clientId = null, filePathOverride = null) {
    let filePath = filePathOverride;
    let configSource = 'unknown'; // For logging
    let client = clientId ? settings.clients[clientId] : null;
    let syncGroupId = client?.syncGroup;

    if (!filePath) {
        if (syncGroupId && settings.syncGroups[syncGroupId]) {
             // --- Client is in a Sync Group ---
             filePath = settings.syncGroups[syncGroupId].configPath;
             configSource = `sync group (${syncGroupId}: ${filePath})`;
        } else if (clientId) {
            // --- Sync OFF, Client Specified (use client-specific managed file) ---
            filePath = getClientSpecificConfigPath(clientId);
            configSource = `client-specific (${clientId}: ${filePath})`;
        } else {
            // --- No Client or Sync Group (Shouldn't happen in normal flow for read?) ---
             // This case might be hit for the main aggregated view if not handled earlier,
             // or potentially if sync is ON but somehow no client context provided.
             // Let's default to reading the *old* main config path for now, though this might need refinement.
             filePath = CONFIG_PATH; 
             configSource = `fallback main config (${filePath})`;
             console.warn(`Reading from fallback main config path: ${filePath}. This might indicate an unexpected state.`);
        }
    }

    try {
        const data = await fs.readFile(filePath, 'utf8');
        if (IS_DEBUG_MODE) {
            console.log(`Reading active config from ${configSource}. Contents:
${data.substring(0, 500)}${data.length > 500 ? '...' : ''}`);
        }
        try {
            return JSON.parse(data);
        } catch (parseError) {
            console.error(`Error parsing JSON from ${configSource}:`, parseError);
            throw new Error(`Invalid JSON in active config file: ${filePath}`);
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`Active config file not found at ${filePath}.`);
            if (syncGroupId && settings.syncGroups[syncGroupId]) {
                 // --- Client is in a Sync Group ---
                 filePath = settings.syncGroups[syncGroupId].configPath;
                 configSource = `sync group (${syncGroupId}: ${filePath})`;
            } else if (clientId) {
                // --- Sync OFF, Client Specified (use client-specific managed file) ---
                filePath = getClientSpecificConfigPath(clientId);
                configSource = `client-specific (${clientId}: ${filePath})`;
            } else {
                // --- No Client or Sync Group (Shouldn't happen in normal flow for read?) ---
                 // This case might be hit for the main aggregated view if not handled earlier,
                 // or potentially if sync is ON but somehow no client context provided.
                 // Let's default to reading the *old* main config path for now, though this might need refinement.
                 filePath = CONFIG_PATH; 
                 configSource = `fallback main config (${filePath})`;
                 console.warn(`Reading from fallback main config path: ${filePath}. This might indicate an unexpected state.`);
            }
            return readManagedConfigFile(clientId, filePath); // Recursive call with override
        } else {
            console.error(`Failed to read active config file ${filePath}:`, error);
            return { mcpServers: {} }; // Return empty config on other errors
        }
    }
}

// Helper function to read the server registry
async function readServerRegistry() {
    try {
        const data = await fs.readFile(MCP_SERVER_REGISTRY_PATH, 'utf8');
        if (IS_DEBUG_MODE) {
            console.log('Reading server registry:', data.substring(0, 500) + (data.length > 500 ? '...' : ''));
        }
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('Server registry not found, returning empty.');
            return { mcpServers: {} };
        }
        console.error('Failed to read or parse server registry:', error);
        return { mcpServers: {} }; // Return empty/default on error
    }
}

// Helper function to write the server registry
async function writeServerRegistry(registryData) {
    try {
        await fs.writeFile(MCP_SERVER_REGISTRY_PATH, JSON.stringify(registryData, null, 2));
        console.log('Server registry updated.');
    } catch (error) {
        console.error('Failed to write server registry:', error);
    }
}

// Helper function to merge configurations
function mergeConfigs(savedConfig, defaultConfig) {
    if (IS_DEBUG_MODE) {
        console.log('Merging configs:');
        console.log('Saved servers:', Object.keys(savedConfig.mcpServers || {}));
        console.log('Default servers:', Object.keys(defaultConfig));
    }
    
    const mergedServers = {};
    
    // Start with all saved servers that we want to keep
    Object.entries(savedConfig.mcpServers || {}).forEach(([name, config]) => {
        mergedServers[name] = { ...config };
    });
    
    // Add any default servers that don't exist in the saved config
    Object.entries(defaultConfig).forEach(([name, config]) => {
        if (!mergedServers[name]) {
            mergedServers[name] = { ...config };
        } else {
            // Server exists in both configs - preserve custom settings but add any new fields from default
            for (const [key, value] of Object.entries(config)) {
                // Only add properties from default that don't exist in saved config
                if (mergedServers[name][key] === undefined) {
                    mergedServers[name][key] = value;
                }
            }
        }
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

// Helper function to create backups
async function createBackup(filePath) {
    if (!filePath) {
        console.warn("createBackup called with invalid filePath:", filePath);
        return;
    }
    try {
        // Check if the file exists before trying to back it up
        await fs.access(filePath); 
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`Skipping backup for non-existent file: ${filePath}`);
            return; // Don't attempt backup if original file doesn't exist
        }
        // Rethrow other errors
        throw error;
    }
    
    const backupDir = path.join(path.dirname(filePath), 'mcp-backups');
    try {
        await fs.mkdir(backupDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFileName = `backup-${path.basename(filePath)}-${timestamp}.json`;
        const backupPath = path.join(backupDir, backupFileName);
        
        console.log(`Creating backup for ${filePath} at ${backupPath}`);
        await fs.copyFile(filePath, backupPath);

        // Clean up old backups
        const files = await fs.readdir(backupDir);
        const backupsForFile = files
            .filter(f => f.startsWith(`backup-${path.basename(filePath)}`))
            .sort() // Sorts alphabetically, which works for ISO timestamps
            .reverse(); // Newest first

        if (backupsForFile.length > settings.maxBackups) {
            const backupsToDelete = backupsForFile.slice(settings.maxBackups);
            console.log(`Cleaning up ${backupsToDelete.length} old backups for ${path.basename(filePath)}`);
            await Promise.all(backupsToDelete.map(f => fs.unlink(path.join(backupDir, f))));
        }
    } catch (backupError) {
        console.error(`Failed to create or clean up backups for ${filePath}:`, backupError);
        // Decide if this error should prevent saving. For now, we'll log and continue.
    }
}

// Helper function to get file metadata (modification time)
async function getFileMetadata(filePath) {
    try {
        const stats = await fs.stat(filePath);
        return {
            mtime: stats.mtime.toISOString(),
            exists: true
        };
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { exists: false };
        }
        console.error(`Error getting metadata for ${filePath}:`, error);
        throw error;
    }
}

// Helper function to compare configurations (deep comparison)
function compareConfigs(config1, config2) {
    // Normalize undefined/null mcpServers to empty objects for comparison
    const servers1 = config1?.mcpServers ?? {};
    const servers2 = config2?.mcpServers ?? {};

    // console.log("Comparing Config 1:", JSON.stringify(servers1, null, 2)); // Debug
    // console.log("Comparing Config 2:", JSON.stringify(servers2, null, 2)); // Debug


    // Use lodash for deep comparison
    const areEqual = _.isEqual(servers1, servers2);
    // console.log("Are configs equal?", areEqual); // Debug
    return areEqual;
}

// Endpoint to fetch current settings
router.get('/api/settings', (req, res) => {
    if (IS_DEBUG_MODE) {
        console.log('GET /api/settings - Returning current settings');
    }
    res.json(settings);
});

// Endpoint to update settings
router.post('/api/settings', async (req, res) => {
    const newSettings = req.body;
    console.log('POST /api/settings - Updating settings');
    
    // Basic validation
    if (!newSettings || !newSettings.clients) {
        return res.status(400).json({ error: 'Invalid settings format' });
    }

    try {
        // Merge carefully? Or just overwrite?
        // Overwriting is simpler but might lose keys if frontend doesn't send everything.
        // Let's merge to be safer, assuming frontend sends updates.
        settings = _.merge({}, settings, newSettings);
        
        await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        console.log('Settings saved to settings.json');
        res.json({ success: true, settings });
    } catch (error) {
        console.error('Error saving settings:', error);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});


// Endpoint to fetch client list and their status
router.get('/api/clients', async (req, res) => {
    console.log('GET /api/clients');
    const clientData = {};
    for (const [id, client] of Object.entries(settings.clients)) {
        let metadata = { exists: false, mtime: null };
        if (client.configPath) {
            try {
                 metadata = await getFileMetadata(client.configPath);
            } catch (e) {
                // Ignore errors here, metadata will show exists: false
                 console.warn(`Could not get metadata for ${client.configPath}: ${e.message}`);
            }
        }
        // Also check metadata for the client-specific config if sync is off
        let specificMetadata = { exists: false, mtime: null };
        if (!settings.syncGroups) {
            const specificPath = getClientSpecificConfigPath(id);
             try {
                specificMetadata = await getFileMetadata(specificPath);
            } catch (e) {
                 console.warn(`Could not get metadata for ${specificPath}: ${e.message}`);
            }
        }

        clientData[id] = {
            ...client,
            originalConfigMeta: metadata, // Metadata of the original file
            managedConfigMeta: specificMetadata // Metadata of the configs/CLIENT_ID.json file
        };
    }
    res.json(clientData);
});


// API endpoint to get the current configuration state
router.get('/api/config', async (req, res) => {
    const clientId = req.query.clientId; // Get client ID from query param
    const client = clientId ? settings.clients[clientId] : null;
    const syncGroupId = client?.syncGroup;
    
    console.log(`GET /api/config - Request for client: ${clientId || '[servers view]'}, Sync Group: ${syncGroupId || '[none]'}`);

    try {
        if (syncGroupId && settings.syncGroups[syncGroupId]) {
             // --- Client is in a Sync Group ---
             const groupConfigPath = settings.syncGroups[syncGroupId].configPath;
             const config = await readManagedConfigFile(clientId, groupConfigPath);
             res.json(config || { mcpServers: {} });
        } else if (clientId) {
            // --- Sync OFF, Client Specified ---
            const config = await readManagedConfigFile(clientId);
            res.json(config || { mcpServers: {} });
        } else {
            // --- No Client Specified (Server Configuration View) ---
            console.log('Aggregating configs for Server Configuration view');
            const aggregatedServers = {};
            const serverSources = {};

            for (const id in settings.clients) {
                const currentClient = settings.clients[id];
                if (currentClient.enabled) {
                    let clientConfig;
                    if (currentClient.syncGroup && settings.syncGroups[currentClient.syncGroup]) {
                        // Read from sync group config if part of one
                        clientConfig = await readConfigFile(settings.syncGroups[currentClient.syncGroup].configPath);
                    } else {
                        // Read from individual managed config
                        clientConfig = await readManagedConfigFile(id);
                    }
                    
                    if (clientConfig && clientConfig.mcpServers) {
                        Object.entries(clientConfig.mcpServers).forEach(([name, serverConf]) => {
                            const serverKey = `${name}`; 
                            
                            if (!aggregatedServers[serverKey]) {
                                aggregatedServers[serverKey] = _.cloneDeep(serverConf);
                                serverSources[serverKey] = [id]; // Store source ID
                            } else {
                                if (!_.isEqual(aggregatedServers[serverKey], serverConf)) {
                                    if (!serverSources[serverKey].includes(id)) {
                                        serverSources[serverKey].push(id);
                                        aggregatedServers[serverKey]._conflicts = true;
                                    }
                                } else if (!serverSources[serverKey].includes(id)){
                                    serverSources[serverKey].push(id);
                                }
                            }
                        });
                    }
                }
            }
            
            Object.keys(aggregatedServers).forEach(serverKey => {
                 const sourceIds = serverSources[serverKey] || [];
                 aggregatedServers[serverKey]._sources = sourceIds.map(cid => settings.clients[cid]?.name || cid);
                 if (!aggregatedServers[serverKey]._conflicts) {
                     aggregatedServers[serverKey]._conflicts = false;
                 }
            });
            
            res.json({ mcpServers: aggregatedServers });
        }
    } catch (error) {
        console.error('Error in /api/config:', error);
        res.status(500).json({ error: 'Failed to get configuration', details: error.message });
    }
});

// GET client-specific MCP config
router.get('/api/config/:clientId', async (req, res) => {
    const clientId = req.params.clientId;
    console.log(`GET /api/config/${clientId}`);

    try {
        // 1. Read the full server registry
        const serverRegistry = await readServerRegistry();

        // 2. Read the client-specific configuration file
        const activeConfig = await readManagedConfigFile(clientId);
        
        // 3. Merge active state into the registry data
        const combinedConfig = _.cloneDeep(serverRegistry); // Start with registry content
        if (!combinedConfig.mcpServers || typeof combinedConfig.mcpServers !== 'object') {
            console.warn("Registry mcpServers format is invalid or missing. Initializing.");
            combinedConfig.mcpServers = {}; // Ensure it's an object
        }
        
        // Ensure all servers in the registry have an 'enabled' flag (default to false)
        Object.values(combinedConfig.mcpServers).forEach(server => {
            server.enabled = false; 
        });

        // Mark servers present in the active config as enabled and update registry if needed
        if (activeConfig.mcpServers && typeof activeConfig.mcpServers === 'object') {
            Object.entries(activeConfig.mcpServers).forEach(([serverKey, activeServerData]) => {
                if (combinedConfig.mcpServers[serverKey]) {
                    // Server exists in registry, mark as enabled
                    combinedConfig.mcpServers[serverKey].enabled = true;
                } else {
                    // Server exists in active config but not registry? Add it to the combined view.
                    console.warn(`Server '${serverKey}' found in active config but not in registry. Adding to combined view.`);
                    combinedConfig.mcpServers[serverKey] = { ...activeServerData, enabled: true };
                }
            });
        }

        res.json(combinedConfig); // Return the combined view
    } catch (error) {
        console.error(`Error fetching config for client ${clientId}:`, error);
        res.status(500).json({ error: `Failed to get configuration: ${error.message}` });
    }
});

// API: Save configuration (handles sync groups)
router.post('/api/config', async (req, res) => {
    const clientId = req.query.clientId;
    const client = clientId ? settings.clients[clientId] : null;
    const syncGroupId = client?.syncGroup;
    const configData = req.body; // { mcpServers: { ... } }

    console.log(`POST /api/config - Client: ${clientId || '[servers view]'}, Sync Group: ${syncGroupId || '[none]'}`);

    if (!configData || typeof configData.mcpServers !== 'object') {
        return res.status(400).json({ error: 'Invalid configuration data format' });
    }

    try {
        let savePath;
        let affectedClientIds = [];

        if (syncGroupId && settings.syncGroups[syncGroupId]) {
            // --- Saving for a Sync Group ---
            savePath = settings.syncGroups[syncGroupId].configPath;
            affectedClientIds = settings.syncGroups[syncGroupId].members;
            console.log(`Saving to sync group config: ${savePath}`);
        } else if (clientId && client) {
            // --- Saving for a Single, Unsynced Client ---
            savePath = getClientSpecificConfigPath(clientId);
            affectedClientIds = [clientId];
            console.log(`Saving to client-specific config: ${savePath}`);
        } else {
            // --- Saving from Server Configuration View (Sync OFF) ---
            // This requires updating potentially multiple client-specific files.
            // Or potentially creating new sync groups if conflicts were resolved?
            // For now, let's disallow direct saving from Server View if sync is off.
            // User should select a client first.
            // TODO: Revisit saving from aggregated view.
             return res.status(400).json({ error: 'Cannot save directly from Server Configuration view when sync is off. Select a client.' });
        }

        // Write the config file
        await fs.writeFile(savePath, JSON.stringify(configData, null, 2));
        console.log(`Configuration saved to ${savePath}`);

        // Optionally: Update original client files if needed? No, managed files handle this.

        res.json({ success: true, message: `Configuration saved successfully for ${affectedClientIds.join(', ')}` });

    } catch (error) {
        console.error(`Error saving configuration for ${clientId || syncGroupId || 'servers view'}:`, error);
        res.status(500).json({ error: 'Failed to save configuration', details: error.message });
    }
});

// GET initial config state (used by client to compare for Reset)
// This should return the state as it was when GET /api/config was last called
router.get('/api/config/initial', (req, res) => {
    console.log("GET /api/config/initial - Returning stored initial state");
    // console.log("Initial state being returned:", JSON.stringify(initialActiveConfig || { mcpServers: {} }, null, 2));
    res.json(initialActiveConfig || { mcpServers: {} }); // Return the stored initial state
});


// Endpoint to check if current config differs from initial state
// This was previously here, but diff checking is better handled client-side.
// Remove or comment out if unused.
/*
router.get('/api/config/differs', (req, res) => {
     res.status(404).send("Diff checking is handled client-side.");
});
*/


// Endpoint to get presets - updated to return full presets object
router.get('/api/presets', async (req, res) => {
    try {
        // Set proper content type header
        res.setHeader('Content-Type', 'application/json');
        
        const PRESETS_FILE = path.join(__dirname, 'presets.json');
        
        try {
            // Use fs.access instead of fs.existsSync since we're using the promises API
            await fs.access(PRESETS_FILE);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('Presets file not found, returning empty object');
                return res.json({});
            }
            throw error; // Rethrow other errors
        }
        
        const presetsData = await fs.readFile(PRESETS_FILE, 'utf8');
        const presets = JSON.parse(presetsData);
        
        // Return the object of presets rather than just keys
        return res.json(presets);
    } catch (error) {
        console.error('Error getting presets:', error);
        // Return empty object on error rather than error status
        return res.json({});
    }
});

// Helper function to read presets
async function readPresetsFile() {
    try {
        const data = await fs.readFile(PRESETS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('Presets file not found, creating default.');
            const defaultPresets = { "Default": {} };
            await fs.writeFile(PRESETS_PATH, JSON.stringify(defaultPresets, null, 2));
            return defaultPresets;
        }
        console.error('Error reading presets file:', error);
        throw error;
    }
}

// Endpoint to save presets
router.post('/presets', async (req, res) => {
    const { presets } = req.body;
    console.log('POST /api/presets');
    if (!presets || typeof presets !== 'object') {
        return res.status(400).json({ error: 'Invalid presets data format.' });
    }
    try {
        await fs.writeFile(PRESETS_PATH, JSON.stringify(presets, null, 2));
        console.log(`Presets saved successfully to ${PRESETS_PATH}`);
        res.json({ success: true, message: 'Presets saved successfully.' });
    } catch (error) {
        console.error('Error saving presets:', error);
        res.status(500).json({ error: 'Failed to save presets.' });
    }
});


// Endpoint to check for configuration differences (relevant primarily for sync mode)
router.get('/check-configs', async (req, res) => {
    console.log('GET /api/check-configs');
     if (!settings.syncGroups) {
         console.log("Sync OFF: Skipping config difference check.");
         // In non-sync mode, differences between original files don't matter for warnings.
         // The relevant check (editor vs. saved) happens client-side.
         return res.json({ configsDiffer: false, differences: [], message: "Sync is disabled, comparison skipped." });
     }

     console.log("Sync ON: Comparing original configurations of enabled clients.");
     const enabledClients = Object.entries(settings.clients)
         .filter(([_, client]) => client.enabled && client.configPath);

     if (enabledClients.length < 2) {
         console.log("Sync ON: Less than two enabled clients, no comparison needed.");
         return res.json({ configsDiffer: false, differences: [] });
     }

     try {
         const configs = await Promise.all(
             enabledClients.map(async ([id, client]) => {
                 try {
                     const config = await readConfigFile(client.configPath);
                     return { id, name: client.name, config };
                 } catch (error) {
                     if (error.code === 'ENOENT') {
                         console.warn(`Original config not found for ${client.name} (${client.configPath}) during check. Treating as empty.`);
                         return { id, name: client.name, config: { mcpServers: {} } }; // Treat missing as empty for comparison
                     }
                     console.error(`Error reading config for ${client.name} (${client.configPath}) during check:`, error);
                     throw new Error(`Failed to read config for ${client.name}`); // Propagate error
                 }
             })
         );

         const firstConfig = configs[0].config;
         const differences = [];
         let configsDiffer = false;

         for (let i = 1; i < configs.length; i++) {
             if (!compareConfigs(firstConfig, configs[i].config)) {
                 configsDiffer = true;
                 differences.push({
                     client1: configs[0].name,
                     client2: configs[i].name,
                     // Optionally add detailed diff here later if needed
                     message: `${configs[0].name} and ${configs[i].name} configurations differ.`
                 });
                 console.log(`Difference detected between ${configs[0].name} and ${configs[i].name}`);
                 // Break early if we just need to know *if* they differ
                 // break;
             }
         }

         res.json({ configsDiffer, differences });

     } catch (error) {
         console.error('Error checking configurations:', error);
         res.status(500).json({ error: `Failed to check configurations: ${error.message}` });
     }
});

// Resolve executable paths for npm/npx/node commands
router.post('/api/resolve-path', (req, res) => {
    try {
        const { command } = req.body;
        
        if (!command) {
            return res.status(400).json({ error: 'Command is required' });
        }
        
        // Extract the base command (before any arguments)
        const baseCommand = command.split(' ')[0];
        
        // Check if it's a command we should resolve
        if (!/^(npm|npx|node|yarn|pnpm)$/.test(baseCommand)) {
            return res.json({ message: 'Not a resolvable command', path: command });
        }
        
        // Use which command to find the absolute path
        const { execSync } = require('child_process');
        try {
            const path = execSync(`which ${baseCommand}`).toString().trim();
            return res.json({ path, originalCommand: command });
        } catch (error) {
            console.error(`Error resolving path for ${baseCommand}:`, error);
            return res.status(404).json({ error: `Could not resolve path for ${baseCommand}` });
        }
    } catch (error) {
        console.error('Error in path resolution endpoint:', error);
        return res.status(500).json({ error: 'Internal server error resolving path' });
    }
});

// *** Initialization and other routes ***

// Test endpoint
router.get('/test', (req, res) => {
    console.log('GET /api/test');
    res.send('MCP Manager API is running!');
});

// Initial configuration check logic (maybe simplify or remove if check-configs handles it?)
// This seems complex and potentially redundant now.
// Let's comment it out for now and rely on client-side checks + /api/check-configs for sync mode.
/*
async function checkConfigsFirstTime() {
    console.log('Performing initial configuration check...');
    if (!settings.syncGroups) {
        console.log('Sync is disabled, skipping initial cross-client config check.');
        // When sync is off, we load the specific client's config.
        // We don't need to compare originals at startup.
        return { configsDiffer: false, differences: [], firstConfig: null };
    }

    console.log('Sync is enabled, comparing original configs of enabled clients...');
    // ... (rest of the original logic for comparing configs when sync is ON) ...
    // ... This logic is now mostly duplicated in GET /api/check-configs ...
    // ... We should rely on the endpoint instead of doing this complex check at startup ...

     try {
        const enabledClients = Object.entries(settings.clients)
            .filter(([_, client]) => client.enabled && client.configPath);

        if (enabledClients.length < 1) {
            console.log("No enabled clients found for initial check.");
            // Load from main config.json as fallback?
             try {
                const mainConfig = await readConfigFile(CONFIG_PATH);
                return { configsDiffer: false, differences: [], firstConfig: mainConfig };
            } catch {
                return { configsDiffer: false, differences: [], firstConfig: { mcpServers: {} } }; // Empty if main fails too
            }
        }

        const configs = await Promise.all(
            enabledClients.map(async ([id, client]) => {
                try {
                    const config = await readConfigFile(client.configPath);
                    return { id, name: client.name, config };
                } catch (error) {
                    if (error.code === 'ENOENT') {
                         console.warn(`Initial check: Config not found for ${client.name}, using empty.`);
                        return { id, name: client.name, config: { mcpServers: {} } };
                    }
                    throw error; // Rethrow other errors
                }
            })
        );

        const firstConfigData = configs[0].config;
        let differ = false;
        const diffDetails = [];

        for (let i = 1; i < configs.length; i++) {
             if (!compareConfigs(firstConfigData, configs[i].config)) {
                differ = true;
                diffDetails.push(`${configs[0].name} vs ${configs[i].name}`);
                // No need to continue checking if we know they differ
                break;
            }
        }

         if (differ) {
             console.warn('Initial check: Configurations differ between enabled clients.');
             // We should probably load the main config.json in this case,
             // as it represents the last saved state (which might be synced or not).
             try {
                 const mainConfig = await readConfigFile(CONFIG_PATH);
                 console.log("Loading main config.json due to initial differences.");
                 return { configsDiffer: true, differences: diffDetails, firstConfig: mainConfig };
             } catch (mainReadError) {
                 console.error("Failed to read main config.json during initial diff check, falling back to first client's config.");
                 return { configsDiffer: true, differences: diffDetails, firstConfig: firstConfigData };
             }
         } else {
             console.log('Initial check: Configurations are consistent.');
             // If consistent, also update main config.json? Yes.
              try {
                  await createBackup(CONFIG_PATH);
                  await fs.writeFile(CONFIG_PATH, JSON.stringify(firstConfigData, null, 2));
                  console.log("Updated main config.json to match consistent client configs.");
              } catch (writeError) {
                  console.error("Failed to update main config.json during initial consistency check:", writeError);
              }
             return { configsDiffer: false, differences: [], firstConfig: firstConfigData };
         }

    } catch (error) {
        console.error('Error during initial configuration check:', error);
         // Fallback: try reading main config.json
         try {
            const mainConfig = await readConfigFile(CONFIG_PATH);
            console.warn("Falling back to main config.json due to error in initial check.");
            return { configsDiffer: false, differences: [], firstConfig: mainConfig, error: true }; // Indicate error occurred
        } catch {
             console.error("Failed to read main config.json as fallback during initial check.");
            return { configsDiffer: false, differences: [], firstConfig: { mcpServers: {} }, error: true }; // Final fallback: empty
        }
    }
}
*/


// Initialization function
async function initialize() {
    await loadSettings();
    // Initial config check is removed, frontend will call /api/config and /api/check-configs as needed.
    console.log("Initialization complete. Settings loaded.");
    console.log("Current settings:", settings);
}


initialize().catch(err => {
    console.error("Failed to initialize server:", err);
    // process.exit(1); // Optional: exit if initialization fails critically
});


export default router;

// Utility function to read original config file directly (used internally)
async function readConfigFile(filePath) {
    try {
        console.log('Reading original config file:', filePath);
        const data = await fs.readFile(filePath, 'utf8');
        // Add try-catch for JSON parsing
        try {
            return JSON.parse(data);
        } catch (parseError) {
            console.error(`Error parsing JSON from ${filePath}:`, parseError);
            // Return empty object or rethrow depending on desired behavior
            throw new Error(`Invalid JSON in file: ${filePath}`);
        }
    } catch (error) {
        // Let the caller handle ENOENT specifically if needed
        console.error(`Error reading ${filePath}:`, error.message);
        throw error;
    }
}

// Get available presets
router.get('/api/presets', (req, res) => {
    try {
        // Set proper content type header
        res.setHeader('Content-Type', 'application/json');
        
        const PRESETS_FILE = path.join(__dirname, 'presets.json');
        
        if (!fs.existsSync(PRESETS_FILE)) {
            console.log('Presets file not found, returning empty object');
            return res.json({});
        }
        
        const presetsData = fs.readFileSync(PRESETS_FILE, 'utf8');
        const presets = JSON.parse(presetsData);
        
        // Return the object of presets rather than just keys
        return res.json(presets);
    } catch (error) {
        console.error('Error getting presets:', error);
        // Return empty object on error rather than error status
        return res.json({});
    }
});

// API endpoint to check for differences between original client config files
router.get('/api/check-configs', async (req, res) => {
    console.log('GET /api/check-configs - Checking original client file differences');
    if (!settings.syncGroups) {
        return res.json({ configsDiffer: false, differences: [] });
    }

    const enabledClientPaths = getEnabledClientConfigPaths();
    if (enabledClientPaths.length < 2) {
        return res.json({ configsDiffer: false, differences: [] }); // No need to check if less than 2 clients
    }

    let referenceConfig = null;
    let referenceClientId = null;
    const differences = [];
    let configsDiffer = false;

    try {
        for (const clientId in settings.clients) {
            const client = settings.clients[clientId];
            if (client.enabled && client.configPath) {
                const config = await readConfigFile(client.configPath); // Read the actual file
                if (referenceConfig === null) {
                    referenceConfig = config;
                    referenceClientId = clientId;
                } else {
                    if (!_.isEqual(referenceConfig, config)) {
                        configsDiffer = true;
                        differences.push({ 
                            client1: referenceClientId,
                            client2: clientId,
                            message: `${settings.clients[referenceClientId]?.name || referenceClientId} and ${client.name || clientId} configs differ.`
                        });
                        // Break early if we only need to know *if* they differ
                        // break; 
                    }
                }
            }
        }
        res.json({ configsDiffer, differences });
    } catch (error) {
        console.error('Error comparing original client config files:', error);
        res.status(500).json({ error: 'Failed to compare client configurations' });
    }
});

// --- Custom Client CRUD & Sync Group API --- 

// Add/Update Client
router.post('/api/clients', async (req, res) => {
    const { clientId, name, configPath, enabled } = req.body;
    const isUpdate = !!clientId;
    const idToSave = clientId || `custom_${Date.now()}`;

    if (!name || !configPath) {
        return res.status(400).json({ error: 'Client name and config path are required' });
    }

    console.log(`${isUpdate ? 'Updating' : 'Adding'} client: ${idToSave}`);

    settings.clients[idToSave] = {
        name,
        configPath,
        enabled: enabled !== undefined ? enabled : true,
        builtIn: false,
        syncGroup: settings.clients[idToSave]?.syncGroup || null // Preserve sync group if updating
    };

    try {
        await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        res.json({ success: true, clientId: idToSave, client: settings.clients[idToSave] });
    } catch (error) {
        console.error('Error saving client settings:', error);
        res.status(500).json({ error: 'Failed to save client settings' });
    }
});

// Delete Client
router.delete('/api/clients/:clientId', async (req, res) => {
    const { clientId } = req.params;

    if (!settings.clients[clientId]) {
        return res.status(404).json({ error: 'Client not found' });
    }
    if (settings.clients[clientId].builtIn) {
        return res.status(400).json({ error: 'Cannot delete built-in clients' });
    }
    
    // TODO: Handle removing client from sync groups
    const syncGroupId = settings.clients[clientId].syncGroup;
    if (syncGroupId && settings.syncGroups[syncGroupId]) {
        _.pull(settings.syncGroups[syncGroupId].members, clientId);
        // If group becomes empty or single, delete the group?
        if (settings.syncGroups[syncGroupId].members.length <= 1) {
             console.log(`Deleting sync group ${syncGroupId} as it has <= 1 member after deleting ${clientId}`);
             // Also need to reset syncGroup for remaining member
             if(settings.syncGroups[syncGroupId].members.length === 1) {
                 const remainingClientId = settings.syncGroups[syncGroupId].members[0];
                 if (settings.clients[remainingClientId]) {
                     settings.clients[remainingClientId].syncGroup = null;
                 }
             }
             // Delete group config file?
             try { await fs.unlink(settings.syncGroups[syncGroupId].configPath); } catch (e) { console.error('Failed to delete group config', e);}
             delete settings.syncGroups[syncGroupId];
        }
    }

    console.log(`Deleting client: ${clientId}`);
    delete settings.clients[clientId];

    try {
        await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        res.json({ success: true });
    } catch (error) {
        console.error('Error saving settings after deleting client:', error);
        res.status(500).json({ error: 'Failed to save settings after deletion' });
    }
});

// Create/Update Sync Group
router.post('/api/sync-groups', async (req, res) => {
    const { clientIds } = req.body; // Expecting an array of client IDs to sync

    if (!clientIds || clientIds.length < 2) {
        return res.status(400).json({ error: 'At least two client IDs are required to form a sync group' });
    }

    // Basic validation: Check if clients exist
    for (const id of clientIds) {
        if (!settings.clients[id]) {
            return res.status(400).json({ error: `Client with ID ${id} not found` });
        }
    }
    
    // Determine if this merges existing groups or creates a new one
    // For simplicity now, let's assume it creates a new group or overwrites existing client assignments.
    // A more robust implementation would handle merging groups.
    
    const newGroupId = `group_${Date.now()}`;
    const newGroupConfigPath = path.join(SYNC_CONFIGS_DIR, `${newGroupId}.json`);
    
    console.log(`Creating/Updating sync group ${newGroupId} with members: ${clientIds.join(', ')}`);

    // 1. Create the group entry
    settings.syncGroups[newGroupId] = {
        members: clientIds,
        configPath: newGroupConfigPath
    };
    
    // 2. Update client entries to point to this group
    // Also handle clients previously in other groups
    const clientIdsToUpdate = new Set(clientIds);
    const groupsToDelete = new Set(); // Track old groups to potentially delete
    const clientsToRemoveFromOldGroups = {}; // { oldGroupId: [clientId1, clientId2] }

    // First pass: Assign new group and identify clients leaving old groups
    for (const id of Object.keys(settings.clients)) {
        const client = settings.clients[id];
        const oldGroupId = client.syncGroup;

        if (clientIdsToUpdate.has(id)) {
            // Assign to new group
            client.syncGroup = newGroupId;
            // If it was in an old group different from the new one, mark for removal
            if (oldGroupId && oldGroupId !== newGroupId && settings.syncGroups[oldGroupId]) {
                 if (!clientsToRemoveFromOldGroups[oldGroupId]) {
                     clientsToRemoveFromOldGroups[oldGroupId] = [];
                 }
                 clientsToRemoveFromOldGroups[oldGroupId].push(id);
                 groupsToDelete.add(oldGroupId); // Mark old group for potential deletion check
            }
        } 
    }
    
    // Second pass: Process old groups removal and deletion checks asynchronously
    for (const oldGroupId of groupsToDelete) {
        if (settings.syncGroups[oldGroupId]) {
            const clientsToRemove = clientsToRemoveFromOldGroups[oldGroupId] || [];
            // Remove clients from the old group's member list
            _.pull(settings.syncGroups[oldGroupId].members, ...clientsToRemove);

            // Check if old group needs deletion
            if (settings.syncGroups[oldGroupId].members.length <= 1) {
                console.log(`Marking sync group ${oldGroupId} for deletion (<= 1 member).`);
                const remainingMemberId = settings.syncGroups[oldGroupId].members[0]; // Could be undefined if 0 members
                 // Reset syncGroup for the remaining member (if any)
                 if (remainingMemberId && settings.clients[remainingMemberId]) {
                     settings.clients[remainingMemberId].syncGroup = null;
                 }
                 // Delete group config file asynchronously
                 try {
                     await fs.unlink(settings.syncGroups[oldGroupId].configPath);
                     console.log(`Deleted old group config: ${settings.syncGroups[oldGroupId].configPath}`);
                 } catch (e) {
                     if (e.code !== 'ENOENT') { // Ignore if file already gone
                         console.error('Failed to delete old group config', e);
                     }
                 }
                 // Delete the group entry from settings
                 delete settings.syncGroups[oldGroupId];
            }
        }
    }

    // 3. Create the initial config file for the group (e.g., copy from first client? or merge?)
    // Let's copy from the first client in the list for now
    try {
        const firstClientConfig = await readManagedConfigFile(clientIds[0]);
        await fs.writeFile(newGroupConfigPath, JSON.stringify(firstClientConfig || { mcpServers: {} }, null, 2));
        console.log(`Created initial sync config at ${newGroupConfigPath} based on ${clientIds[0]}`);
    } catch (copyError) {
        console.error(`Failed to create initial sync config for group ${newGroupId}:`, copyError);
        // Proceed even if initial config copy fails, but log error
    }

    // 4. Save updated settings
    try {
        await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        res.json({ success: true, groupId: newGroupId, group: settings.syncGroups[newGroupId] });
    } catch (error) {
        console.error('Error saving settings after creating sync group:', error);
        res.status(500).json({ error: 'Failed to save settings after creating sync group' });
    }
});
