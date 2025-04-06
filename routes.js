import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import _ from 'lodash'; // Import lodash for deep comparison

// Get __dirname equivalent in ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS_DIR = path.join(__dirname, 'configs'); // Directory for client-specific configs
const MCP_SERVER_REGISTRY_PATH = path.join(__dirname, 'mcp_server_registry.json'); // Path for the server registry

// Default settings
let settings = {
    maxBackups: 10,
    clients: {
        claude: {
            name: "Claude Desktop",
            enabled: true,
            configPath: null
        },
        cursor: {
            name: "Cursor", 
            enabled: true,
            configPath: null
        }
    },
    syncClients: false
};

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
        console.log(`Ensured configs directory exists: ${CONFIGS_DIR}`);
    } catch (error) {
        console.error(`Failed to create configs directory ${CONFIGS_DIR}:`, error);
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
        await ensureJsonFile(SETTINGS_PATH, settings); // Use ensureJsonFile
        const data = await fs.readFile(SETTINGS_PATH, 'utf8');
        settings = JSON.parse(data);
        console.log('Loaded settings:', settings);

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

    } catch (error) {
        // Handle potential JSON parse errors or other read errors
         console.error('Failed to load or parse settings.json, using defaults:', error);
         // Fallback to default settings might be needed here, ensure paths are set
          const defaultPaths = getDefaultConfigPaths();
          if (!settings.clients?.claude?.configPath) settings.clients.claude.configPath = defaultPaths.CLAUDE_CONFIG_PATH;
          if (!settings.clients?.cursor?.configPath) settings.clients.cursor.configPath = defaultPaths.CURSOR_CONFIG_PATH;
          settings.syncClients = false; // Ensure sync is off if settings fail
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
        return settings.clients[clientId].configPath;
    }
    return null;
}

// Get path for client-specific config in the 'configs' directory
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
    let isClientSpecific = false;

    if (!filePath) { // Determine filePath if not overridden
        if (!settings.syncClients && clientId) {
            // Sync OFF: Try reading the client-specific config first
            filePath = getClientSpecificConfigPath(clientId);
            configSource = `client-specific (${filePath})`;
            isClientSpecific = true;
        } else {
            // Sync ON or no specific client: Use the main config file
            filePath = CONFIG_PATH;
            configSource = `main config (${filePath})`;
        }
    } else {
        configSource = `override (${filePath})`; // If path was provided
    }


    try {
        const data = await fs.readFile(filePath, 'utf8');
        console.log(`Reading active config from ${configSource}`);
        try {
            return JSON.parse(data);
        } catch (parseError) {
            console.error(`Error parsing JSON from ${configSource}:`, parseError);
            throw new Error(`Invalid JSON in active config file: ${filePath}`);
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`Active config file not found at ${filePath}.`);
            if (isClientSpecific) {
                 // Fallback: Try reading the original client config file if client-specific failed
                 const originalPath = getClientConfigPath(clientId);
                 if (!originalPath) {
                     console.error(`No original config path defined for client ${clientId}. Returning empty config.`);
                     return { mcpServers: {} }; // Return empty if no path
                 }
                 console.log(`Falling back to original client config: ${originalPath}`);
                 return readManagedConfigFile(clientId, originalPath); // Recursive call with override
            } else {
                 // If main config or original client config not found, return empty
                 console.log(`Returning empty config for ${filePath}`);
                 return { mcpServers: {} };
            }
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
    console.log('Merging configs:');
    console.log('Saved servers:', Object.keys(savedConfig.mcpServers || {}));
    console.log('Default servers:', Object.keys(defaultConfig));
    
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
    console.log('GET /api/settings');
    // Return a copy to prevent accidental modification
    res.json({ ...settings });
});

// Endpoint to update settings
router.post('/api/settings', async (req, res) => {
    console.log('POST /api/settings with data:', req.body);
    const newSettings = req.body;
    // Basic validation
    if (!newSettings || typeof newSettings !== 'object') {
        return res.status(400).json({ error: 'Invalid settings format' });
    }

    // Validate specific settings (example)
    if (typeof newSettings.syncClients !== 'boolean') {
         return res.status(400).json({ error: 'Invalid syncClients value' });
    }
    // Add more validation as needed for clients, maxBackups etc.


    try {
        // Update the settings object
        settings = { ...settings, ...newSettings }; // Simple merge, consider deep merge if needed

        // Persist updated settings
        await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        console.log('Settings updated successfully:', settings);
        res.json({ success: true, settings: settings });
    } catch (error) {
        console.error('Failed to update settings:', error);
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
        if (!settings.syncClients) {
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


// GET MCP config
router.get('/api/config', async (req, res) => {
    const clientId = req.query.clientId; // Get clientId if provided (for non-sync mode)
    console.log(`GET /api/config - Client ID: ${clientId}, Sync Mode: ${settings.syncClients}`);

    try {
        // 1. Read the full server registry
        const serverRegistry = await readServerRegistry();

        // 2. Read the currently active configuration file
        const activeConfig = await readManagedConfigFile(clientId);
        // Store the initial state for comparison, only the mcpServers part
        initialActiveConfig = { mcpServers: _.cloneDeep(activeConfig.mcpServers || {}) }; 

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
                    // Optional: Update registry entry details from active config?
                    // Let's overwrite registry details with active ones IF they differ significantly, 
                    // but prioritize just setting the enabled flag.
                    // For now, simple enable flag setting.
                } else {
                    // Server exists in active config but not registry? Add it to the combined view.
                    console.warn(`Server '${serverKey}' found in active config but not in registry. Adding to combined view.`);
                    combinedConfig.mcpServers[serverKey] = { ...activeServerData, enabled: true };
                    // We should probably add this to the actual registry file on save (POST)
                }
            });
        }
        
        // Log the initial active config for debugging comparison issues
        console.log("Initial active config stored:", JSON.stringify(initialActiveConfig.mcpServers || {}, null, 2));

        res.json(combinedConfig); // Return the combined view
    } catch (error) {
        console.error("Error fetching combined config:", error);
        res.status(500).send(`Failed to get configuration: ${error.message}`);
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

// POST MCP config - Updates registry AND active config file
router.post('/api/config', async (req, res) => {
    const receivedConfig = req.body; // This should contain the FULL config from the client (with enabled flags)
    const clientId = req.query.clientId;
    console.log(`POST /api/config - Client ID: ${clientId}, Sync Mode: ${settings.syncClients}`);
    // console.log("Received config data:", JSON.stringify(receivedConfig, null, 2)); // Debugging

    if (!receivedConfig || typeof receivedConfig.mcpServers !== 'object') {
        return res.status(400).send('Invalid configuration data format received.');
    }

    try {
        // 1. Update the Server Registry
        const serverRegistry = await readServerRegistry();
        if (!serverRegistry.mcpServers) serverRegistry.mcpServers = {};

        Object.entries(receivedConfig.mcpServers).forEach(([key, serverDataFromClient]) => {
             // Add or update the server in the registry
             // Remove the 'enabled' flag before saving to registry
             const { enabled, ...serverDetailsToSave } = serverDataFromClient;
             serverRegistry.mcpServers[key] = serverDetailsToSave; 
             // console.log(`Updating registry for ${key}:`, serverDetailsToSave); // Debug
        });
        await writeServerRegistry(serverRegistry);

        // 2. Prepare the configuration to be saved to the active file (only enabled servers)
        const activeConfigToSave = { mcpServers: {} };
        Object.entries(receivedConfig.mcpServers).forEach(([key, serverDataFromClient]) => {
            if (serverDataFromClient.enabled === true) {
                // Only include enabled servers in the active config file
                const { enabled, ...serverDetailsToSave } = serverDataFromClient; // Remove transient 'enabled' flag
                activeConfigToSave.mcpServers[key] = serverDetailsToSave;
            }
        });

        // 3. Determine the target file path for the active config
        let targetPath;
        let targetDescription;
         if (!settings.syncClients && clientId) {
            // Sync OFF: Save to client-specific config file in ./configs/
            targetPath = getClientSpecificConfigPath(clientId);
            targetDescription = `client-specific config (${targetPath})`;
            // We also need to write to the ORIGINAL client path if it exists and client is enabled?
            // Let's simplify: When sync is OFF, we ONLY manage the ./configs/<client>.json file.
            // The original files become read-only sources unless explicitly synced.
        } else {
            // Sync ON: Save to main config file
            targetPath = CONFIG_PATH;
            targetDescription = `main config (${targetPath})`;
        }

        // 4. Create backup and save the active configuration file
        if (targetPath) {
            await createBackup(targetPath); // Backup before overwriting
            await fs.writeFile(targetPath, JSON.stringify(activeConfigToSave, null, 2));
            console.log(`Configuration saved successfully to ${targetDescription}`);

             // If sync is ON, also update all *enabled* original client config files
             if (settings.syncClients) {
                 console.log("Sync is ON: Propagating changes to enabled client original configs...");
                 const enabledClientPaths = getEnabledClientConfigPaths(); // Gets original paths
                 for (const clientPath of enabledClientPaths) {
                     // Ensure clientPath is valid and not the same as the main config path we just wrote
                     if (clientPath && clientPath !== CONFIG_PATH) { 
                         try {
                             await createBackup(clientPath); // Backup client file
                             await fs.writeFile(clientPath, JSON.stringify(activeConfigToSave, null, 2));
                             console.log(`Synced configuration to original client path: ${clientPath}`);
                         } catch (syncError) {
                             console.error(`Failed to sync configuration to ${clientPath}:`, syncError);
                             // Log error but continue trying others
                         }
                     }
                 }
             }

             // Update the initial state for future comparisons after successful save
             // Store only the mcpServers part
             initialActiveConfig = { mcpServers: _.cloneDeep(activeConfigToSave.mcpServers || {}) }; 
             console.log("Updated initial active config after save:", JSON.stringify(initialActiveConfig.mcpServers || {}, null, 2));

             res.send('Configuration saved successfully.');

        } else {
             console.error("Could not determine target path for saving configuration.");
             res.status(500).send("Internal error: Could not determine save location.");
        }

    } catch (error) {
        console.error('Failed to save configuration:', error);
        res.status(500).send(`Failed to save configuration: ${error.message}`);
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
     if (!settings.syncClients) {
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
    if (!settings.syncClients) {
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
    if (!settings.syncClients) {
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
