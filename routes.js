import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import _ from 'lodash'; // Import lodash for deep comparison

// Get __dirname equivalent in ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS_DIR = path.join(__dirname, 'configs'); // Directory for client-specific configs

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

// Ensure configs directory exists
async function ensureConfigsDir() {
    try {
        await fs.mkdir(CONFIGS_DIR, { recursive: true });
        console.log(`Ensured configs directory exists: ${CONFIGS_DIR}`);
    } catch (error) {
        console.error(`Failed to create configs directory ${CONFIGS_DIR}:`, error);
    }
}

// Load settings on startup
async function loadSettings() {
    try {
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
        if (error.code === 'ENOENT') {
            console.error('settings.json not found, creating with defaults');
            // Ensure client paths are set in defaults
            const defaultPaths = getDefaultConfigPaths();
            settings.clients.claude.configPath = defaultPaths.CLAUDE_CONFIG_PATH;
            settings.clients.cursor.configPath = defaultPaths.CURSOR_CONFIG_PATH;
            settings.syncClients = false; // Ensure syncClients is off by default

            await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        } else {
            console.error('Failed to load settings.json, using defaults:', error);
            // Fallback to default settings might be needed here, ensure paths are set
             const defaultPaths = getDefaultConfigPaths();
             if (!settings.clients?.claude?.configPath) settings.clients.claude.configPath = defaultPaths.CLAUDE_CONFIG_PATH;
             if (!settings.clients?.cursor?.configPath) settings.clients.cursor.configPath = defaultPaths.CURSOR_CONFIG_PATH;
        }
    }

    // Ensure presets.json exists
    try {
        await fs.access(PRESETS_PATH);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('presets.json not found, creating with default preset');
            await fs.writeFile(PRESETS_PATH, JSON.stringify({ "Default": {} }, null, 2));
        }
    }

    // Ensure config.json exists
    try {
        await fs.access(CONFIG_PATH);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('config.json not found, creating empty config');
            await fs.writeFile(CONFIG_PATH, JSON.stringify({ "mcpServers": {} }, null, 2));
        }
    }

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
async function readManagedConfigFile(clientId = null) {
    let filePath;
    let configSource = 'unknown'; // For logging

    try { // Outer try for overall operation
        if (!settings.syncClients && clientId) {
            // Sync OFF: Try reading the client-specific config first
            filePath = getClientSpecificConfigPath(clientId);
            configSource = `client-specific (${filePath})`;
            try {
                const data = await fs.readFile(filePath, 'utf8');
                console.log(`Reading config for client '${clientId}' from ${configSource}`);
                try {
                     return JSON.parse(data);
                } catch (parseError) {
                     console.error(`Error parsing JSON from client-specific file ${filePath}:`, parseError);
                     throw new Error(`Invalid JSON in client-specific file: ${filePath}`);
                }
            } catch (error) {
                if (error.code === 'ENOENT') {
                    console.log(`No client-specific config found at ${filePath}. Falling back to original.`);
                    // Fallback: Read the original client config file
                    const originalPath = getClientConfigPath(clientId);
                    if (!originalPath) {
                        console.error(`No original config path defined for client ${clientId}`);
                        return { mcpServers: {} }; // Return empty if no path
                    }
                    filePath = originalPath;
                    configSource = `original client (${filePath})`;
                    try {
                        const originalData = await fs.readFile(filePath, 'utf8');
                        let config;
                        try {
                            config = JSON.parse(originalData);
                        } catch (parseError) {
                             console.error(`Error parsing JSON from original file ${filePath}:`, parseError);
                             throw new Error(`Invalid JSON in original file: ${filePath}`);
                        }

                        // IMPORTANT: Save a copy to the client-specific path for future reads
                        const clientSpecificPath = getClientSpecificConfigPath(clientId);
                        try {
                            await fs.writeFile(clientSpecificPath, JSON.stringify(config, null, 2));
                            console.log(`Saved initial client-specific config to ${clientSpecificPath}`);
                        } catch (writeError) {
                            console.error(`Failed to write initial client-specific config to ${clientSpecificPath}:`, writeError);
                            // Continue returning the original data even if write fails
                        }
                        console.log(`Reading config for client '${clientId}' from ${configSource} (and copied to client-specific)`);
                        return config;
                    } catch (originalError) {
                        if (originalError.code === 'ENOENT') {
                            console.log(`Original config file ${filePath} not found for client ${clientId}. Using empty config.`);
                            // Also write an empty config to the client-specific path?
                            const clientSpecificPath = getClientSpecificConfigPath(clientId);
                            try {
                                await fs.writeFile(clientSpecificPath, JSON.stringify({ mcpServers: {} }, null, 2));
                                console.log(`Created empty client-specific config at ${clientSpecificPath}`);
                            } catch (writeError) {
                                console.error(`Failed to write empty client-specific config to ${clientSpecificPath}:`, writeError);
                            }
                            return { mcpServers: {} };
                        }
                        console.error(`Error reading original config ${filePath}:`, originalError);
                        throw originalError; // Rethrow other read errors
                    }
                } else {
                    // Other error reading client-specific file
                    console.error(`Error reading client-specific config ${filePath}:`, error);
                    throw error;
                }
            }
        } else {
            // Sync ON or no clientId: Read from main config.json
            filePath = CONFIG_PATH;
            configSource = `main config (${filePath})`;
            try {
                console.log(`Reading config from ${configSource}`);
                const data = await fs.readFile(filePath, 'utf8');
                try {
                    return JSON.parse(data);
                 } catch (parseError) {
                     console.error(`Error parsing JSON from main config file ${filePath}:`, parseError);
                     throw new Error(`Invalid JSON in main config file: ${filePath}`);
                 }
            } catch (error) {
                if (error.code === 'ENOENT') {
                    console.log(`Main config file ${filePath} not found. Using empty config.`);
                    return { mcpServers: {} };
                }
                console.error(`Error reading main config ${filePath}:`, error);
                throw error; // Rethrow other read errors
            }
        }
    } catch (operationError) {
         console.error(`Failed to manage/read config file for client ${clientId || 'main'}:`, operationError);
         // Instead of throwing, return an error structure or empty config?
         // Throwing will cause a 500, let's throw a specific error maybe?
         // For now, rethrow to ensure the endpoint catches it.
         throw operationError;
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
    // Use lodash's isEqual for deep comparison
    // Ensure mcpServers exists in both, defaulting to empty object
    const servers1 = config1?.mcpServers || {};
    const servers2 = config2?.mcpServers || {};
    return _.isEqual(servers1, servers2);
}

// Endpoint to fetch current settings
router.get('/settings', (req, res) => {
    console.log('GET /api/settings');
    // Return a copy to prevent accidental modification
    res.json({ ...settings });
});

// Endpoint to update settings
router.post('/settings', async (req, res) => {
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
router.get('/clients', async (req, res) => {
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


// Endpoint to fetch configuration (main or client-specific)
router.get('/config/:clientId?', async (req, res) => {
    const clientId = req.params.clientId;
    console.log(`GET /api/config/${clientId || ''} (syncClients: ${settings.syncClients})`);
    try {
        const config = await readManagedConfigFile(clientId);

        // Update main config.json to reflect the last loaded config (for editor consistency)
        try {
            await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
            console.log(`Updated main config.json with content from last loaded config.`);
        } catch(writeError) {
            console.error(`Failed to update main config.json after loading:`, writeError);
            // Non-fatal, continue request
        }

        res.json(config);
    } catch (error) {
        console.error(`Error fetching config for ${clientId || 'main'}:`, error);
        // Send a more specific error message if possible
        const errorMessage = error.message || 'Failed to read configuration';
        res.status(500).json({ error: errorMessage });
    }
});


// Endpoint to save configurations
router.post('/save-configs', async (req, res) => {
    const { configData, targetClients } = req.body; // targetClients is an array of client IDs
    console.log('POST /api/save-configs');
    console.log(`Sync Mode: ${settings.syncClients}`);
    console.log('Target Clients:', targetClients);
    // console.log('Config Data:', JSON.stringify(configData, null, 2)); // Potentially very large


    if (!configData || typeof configData !== 'object') {
        return res.status(400).json({ error: 'Invalid configuration data format.' });
    }
     if (!Array.isArray(targetClients)) {
        return res.status(400).json({ error: 'Invalid targetClients format. Expected an array.' });
    }


    try {
        if (settings.syncClients) {
            // Sync ON: Save to main config.json and all enabled original client files
            console.log('Sync ON: Saving to main config and enabled original client files');

            // 1. Save to main config.json
            await createBackup(CONFIG_PATH);
            await fs.writeFile(CONFIG_PATH, JSON.stringify(configData, null, 2));
            console.log(`Saved main config to ${CONFIG_PATH}`);

            // 2. Save to original config files of enabled clients
            const savePromises = Object.entries(settings.clients)
                .filter(([id, client]) => client.enabled && client.configPath)
                .map(async ([id, client]) => {
                    try {
                        await createBackup(client.configPath);
                        await fs.writeFile(client.configPath, JSON.stringify(configData, null, 2));
                        console.log(`Saved synced config to ${client.name} (${client.configPath})`);
                    } catch (err) {
                        console.error(`Failed to save synced config for ${client.name} (${client.configPath}):`, err);
                        // Decide if one failure should abort all? For now, log and continue.
                        // We could collect errors and return them.
                        throw new Error(`Failed to save to ${client.name}: ${err.message}`); // Propagate error
                    }
                });
             await Promise.all(savePromises);


        } else {
            // Sync OFF: Save ONLY to the target client's specific config file
            if (targetClients.length !== 1) {
                 console.error(`Sync OFF: Expected exactly one target client, but got ${targetClients.length}`, targetClients);
                 return res.status(400).json({ error: 'In non-sync mode, exactly one target client must be specified.' });
            }
            const clientId = targetClients[0];
            const client = settings.clients[clientId];

            if (!client) {
                 console.error(`Sync OFF: Invalid client ID provided: ${clientId}`);
                 return res.status(400).json({ error: `Invalid client ID: ${clientId}` });
            }

            const clientSpecificPath = getClientSpecificConfigPath(clientId);
            console.log(`Sync OFF: Saving config for client '${clientId}' to ${clientSpecificPath}`);

            await createBackup(clientSpecificPath);
            await fs.writeFile(clientSpecificPath, JSON.stringify(configData, null, 2));
             console.log(`Saved client-specific config for ${clientId} to ${clientSpecificPath}`);

            // Also update the main config.json to reflect this last save?
            // Let's do this for consistency with the read logic.
            try {
                await createBackup(CONFIG_PATH); // Backup main config too
                await fs.writeFile(CONFIG_PATH, JSON.stringify(configData, null, 2));
                 console.log(`Updated main config.json to reflect last saved client '${clientId}'.`);
            } catch(writeError) {
                 console.error(`Failed to update main config.json after saving client-specific config:`, writeError);
                 // Non-fatal, continue request
            }
        }

        res.json({ success: true, message: 'Configurations saved successfully.' });

    } catch (error) {
        console.error('Error saving configurations:', error);
        res.status(500).json({ error: `Failed to save configurations: ${error.message}` });
    }
});

// Endpoint to reset configuration
// If sync is ON, resets main config (and optionally syncs to clients?) from first enabled client's original file.
// If sync is OFF, resets the specified client's config from their original file.
router.post('/reset-config', async (req, res) => {
    const { clientId } = req.body; // Optional: client ID for non-sync mode reset
    console.log('POST /api/reset-config');
    console.log(`Sync Mode: ${settings.syncClients}`);
    console.log(`Target Client (if sync off): ${clientId}`);

    try {
        if (settings.syncClients) {
            // Sync ON: Reset main config.json from the first enabled client's *original* config
             console.log("Sync ON: Resetting main config.json from first enabled client's original config.");
            const firstEnabledClient = Object.entries(settings.clients).find(([id, client]) => client.enabled && client.configPath);

            if (!firstEnabledClient) {
                return res.status(400).json({ error: 'Cannot reset: No enabled clients with a valid config path found.' });
            }

            const [id, client] = firstEnabledClient;
            const originalPath = client.configPath;
            console.log(`Resetting from original config of client '${id}': ${originalPath}`);

            let originalConfig;
            try {
                originalConfig = await readConfigFile(originalPath); // Use the simple reader here
            } catch(readError) {
                 if (readError.code === 'ENOENT') {
                     console.log(`Original config file not found at ${originalPath}. Resetting to empty.`);
                     originalConfig = { mcpServers: {} };
                 } else {
                     throw readError; // Rethrow other read errors
                 }
            }


            await createBackup(CONFIG_PATH);
            await fs.writeFile(CONFIG_PATH, JSON.stringify(originalConfig, null, 2));
            console.log(`Main config.json reset successfully from ${originalPath}`);

            // Optionally: Force push this reset config to all other enabled clients?
            // Let's NOT do this automatically for now. Resetting main should be enough. User can save to sync later.

            res.json({ success: true, message: 'Main configuration reset successfully.', resetConfig: originalConfig });

        } else {
            // Sync OFF: Reset the specified client's specific config from their original file
            if (!clientId || !settings.clients[clientId]) {
                return res.status(400).json({ error: 'Client ID is required for reset in non-sync mode.' });
            }

            const client = settings.clients[clientId];
            const originalPath = client.configPath;
            const clientSpecificPath = getClientSpecificConfigPath(clientId);

            if (!originalPath) {
                 return res.status(400).json({ error: `Cannot reset: No original config path defined for client ${clientId}.` });
            }

            console.log(`Sync OFF: Resetting client '${clientId}' specific config (${clientSpecificPath}) from original (${originalPath})`);

            let originalConfig;
             try {
                originalConfig = await readConfigFile(originalPath); // Simple reader for original
            } catch(readError) {
                 if (readError.code === 'ENOENT') {
                     console.log(`Original config file not found at ${originalPath}. Resetting client-specific config to empty.`);
                     originalConfig = { mcpServers: {} };
                 } else {
                     throw readError; // Rethrow other read errors
                 }
            }


            await createBackup(clientSpecificPath);
            await fs.writeFile(clientSpecificPath, JSON.stringify(originalConfig, null, 2));
            console.log(`Client-specific config for '${clientId}' reset successfully from ${originalPath}`);

             // Also update main config.json to reflect this reset? Yes, for consistency.
             try {
                 await createBackup(CONFIG_PATH);
                 await fs.writeFile(CONFIG_PATH, JSON.stringify(originalConfig, null, 2));
                 console.log(`Updated main config.json to reflect reset of client '${clientId}'.`);
             } catch(writeError) {
                 console.error(`Failed to update main config.json after resetting client-specific config:`, writeError);
                 // Non-fatal
             }

            res.json({ success: true, message: `Configuration for ${client.name} reset successfully.`, resetConfig: originalConfig });
        }

    } catch (error) {
        console.error('Error resetting configuration:', error);
        res.status(500).json({ error: `Failed to reset configuration: ${error.message}` });
    }
});


// Endpoint to get presets
router.get('/presets', async (req, res) => {
    console.log('GET /api/presets');
    try {
        const presets = await readPresetsFile();
        // Return keys (names) as an array
        res.json(Object.keys(presets));
    } catch (error) {
        console.error('Failed to read presets:', error);
        res.status(500).json({ error: 'Failed to read presets file' });
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
