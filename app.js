let mcpServers = {};
let originalConfig = {};
let clientConfigs = {}; // Store individual client configs
let configsDiffer = false; // Flag to track if configs differ
let initialFileMetadata = {};
let toolsList = [];
let currentPreset = null;
let originalPresetConfig = {};
let clientSettings = {};
let activeClients = [];
let currentLoadedClientId = null; // Track which client's config is currently loaded (null if sync ON and main loaded)

// Global state variables
let currentConfig = { mcpServers: {} }; // Holds the configuration currently being edited/displayed
let presets = {};
let settings = {};
let initialActiveConfig = { mcpServers: {} }; // Store the initially loaded ACTIVE servers (structure only) for comparison
let allServersConfig = { mcpServers: {} }; // Store the full registry state loaded from server, including enabled flags
let selectedClientId = null; // Track the currently selected client ID in non-sync mode
// let currentConfigFilePath = ''; // Likely redundant now, path determined by selectedClientId/syncMode
let hasUnsavedChanges = false; // Track unsaved changes in the current editor session
let lastLoadedClientId = null; // Remember the last client loaded when sync is off

// API endpoints
const API = {
    CONFIG: '/api/config', // Gets main or client-specific based on query param and sync setting
    CLIENTS: '/api/clients',
    SAVE_CONFIGS: '/api/save-configs',
    SETTINGS: '/api/settings',
    SETTINGS_SAVE: '/api/settings',
    CHECK_CONFIGS: '/api/check-configs', // Checks for diffs between *original* client files (only relevant in sync mode)
    RESET_CONFIG: '/api/reset-config' // Endpoint for resetting
};

function showMessage(message, isError = true, type = null) {
    // Default type based on isError if not specified
    const messageType = type || (isError ? 'error' : 'success');
    
    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast ${messageType}`;
    toast.textContent = message;
    
    // Add to container
    const container = document.getElementById('toastContainer');
    container.appendChild(toast);
    
    // Auto-remove after animation completes (5 seconds)
    setTimeout(() => {
        toast.remove();
    }, 5000);
}

function showWarning(message) {
    showMessage(message, false, 'warning');
}

// Add showToast function that was missing
function showToast(message, type = 'success') {
    showMessage(message, type === 'error', type);
}

async function fetchWithTimeout(url, options = {}) {
    const timeout = options.timeout || 5000;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    console.log('Fetching:', url, options);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        
        console.log('Response status:', response.status);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('Response data:', data);
        return data;
    } catch (error) {
        clearTimeout(id);
        console.error('Fetch error:', error);
        throw error;
    }
}

// Function to display warning dialog when configs differ
function showConfigWarning(message) {
    const warningDiv = document.getElementById('configWarning');
    const warningMessage = document.getElementById('configWarningMessage');
    
    if (warningDiv && warningMessage) {
        warningMessage.textContent = message;
        warningDiv.style.display = 'block';
    }
    
    // Also show as a toast warning
    showWarning(message);
}

// Function to hide warning dialog
function hideConfigWarning() {
    const warningDiv = document.getElementById('configWarning');
    if (warningDiv) {
        warningDiv.style.display = 'none';
    }
}

// Function to manage floating buttons visibility
function updateFloatingButtonsVisibility(show) {
    const buttonsContainer = document.getElementById('floatingButtons');
    if (buttonsContainer) {
        console.log(`${show ? 'Showing' : 'Hiding'} floating buttons`);
        buttonsContainer.style.display = show ? 'flex' : 'none';
    } else {
        console.error('Floating buttons container not found in the DOM');
    }
}

// Show save buttons only when changes have been made
function updateSaveButtonVisibility(show) {
    const saveButton = document.getElementById('saveChangesBtn');
    if (saveButton) {
        saveButton.style.display = show ? 'inline-block' : 'none';
    }
}

// Updated compareConfigs to use lodash deep comparison
function compareConfigs(config1, config2) {
    // console.log('Comparing configs using lodash deep comparison'); // Can be noisy
    return _.isEqual(config1, config2);
}

async function loadConfigForClient(clientId) {
    currentLoadedClientId = clientId; // Track which client is loaded
    console.log(`Loading config specifically for client: ${clientId}`);
    showLoadingIndicator(true, 'Loading client config...');
    try {
        // Fetch config using the specific client ID
        const config = await fetchWithTimeout(`${API.CONFIG}/${clientId}`);

        if (config && config.mcpServers !== undefined) { // Check for existence of mcpServers key
            mcpServers = config.mcpServers;
            originalConfig = JSON.parse(JSON.stringify(mcpServers)); // Deep copy
            console.log(`Loaded config for client '${clientId}':`, Object.keys(mcpServers));
            renderServers();
            hideConfigWarning(); // No cross-client warnings in non-sync mode
            configChanged(); // Check if editor matches loaded config (should be false initially)
        } else {
            throw new Error('Invalid config format received');
        }
    } catch (error) {
        console.error(`Error loading config for client ${clientId}:`, error);
        showWarning(`Failed to load configuration for ${clientSettings.clients[clientId]?.name || clientId}. Displaying empty config.`);
        mcpServers = {}; // Fallback to empty
        originalConfig = {};
        renderServers();
        configChanged();
    } finally {
        showLoadingIndicator(false);
    }
}

async function loadMainConfig() {
    currentLoadedClientId = null; // Track that main config is loaded
    console.log('Loading main config (sync mode or initial load)');
    showLoadingIndicator(true, 'Loading main config...');
    try {
        // Fetch config without client ID
        const config = await fetchWithTimeout(API.CONFIG);

        if (config && config.mcpServers !== undefined) {
            mcpServers = config.mcpServers;
            originalConfig = JSON.parse(JSON.stringify(mcpServers)); // Deep copy
            console.log('Loaded main config:', Object.keys(mcpServers));
            renderServers();
            configChanged(); // Check if editor matches loaded config

            // If sync is ON, check for differences between original client files
            if (clientSettings.syncClients) {
                 await checkOriginalConfigDifferences();
            } else {
                 hideConfigWarning(); // No warnings needed if sync is off
            }
        } else {
            throw new Error('Invalid config format received');
        }
    } catch (error) {
        console.error('Error loading main config:', error);
        showWarning('Failed to load main configuration. Displaying empty config.');
        mcpServers = {}; // Fallback to empty
        originalConfig = {};
        renderServers();
        configChanged();
        hideConfigWarning();
    } finally {
        showLoadingIndicator(false);
    }
}

// Checks for differences between the actual client config files (only relevant in sync mode)
async function checkOriginalConfigDifferences() {
     console.log("Checking for differences between original client configs (sync mode)...");
     if (!clientSettings.syncClients) {
         console.log("Sync OFF - Skipping original config difference check.");
         hideConfigWarning();
         return;
     }
     try {
        const result = await fetchWithTimeout(API.CHECK_CONFIGS);
        if (result.configsDiffer) {
             console.warn("Original client configurations differ.", result.differences);
             const diffMessages = result.differences.map(d => d.message).join(' ');
             showConfigWarning(`Warning: Sync is ON, but the original configuration files for some enabled clients differ. (${diffMessages}) Saving changes will overwrite them with the current editor state.`);
             // configsDiffer = true; // This global flag is for editor changes vs original load
        } else {
             console.log("Original client configurations are consistent.");
             hideConfigWarning();
             // configsDiffer = false;
        }
     } catch (error) {
         console.error('Error checking config differences:', error);
         showWarning('Could not check if client configurations are in sync.');
     }
}

function showView(view, clickedTab) {
    console.log('Switching view to:', view);
    // Update tabs
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    if (clickedTab) { // Add check if clickedTab exists
         clickedTab.classList.add('active');
    } else {
        // Fallback if called without a clickedTab (e.g. initial load)
        const fallbackTab = document.querySelector(`.tab[onclick*="showView('${view}'"]`);
        fallbackTab?.classList.add('active');
    }

    // Update views
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none'); // Hide all views
    const targetView = document.getElementById(view + 'View');
    if (targetView) {
        // Use appropriate display type (grid for servers, block for others)
        targetView.style.display = (view === 'servers') ? 'grid' : 'block';
    } else {
        console.error('View not found:', view + 'View');
    }

    // Refresh content if needed
    if (view === 'tools') {
        renderTools();
    }
    if (view === 'backups') {
        renderBackups(); // Fetch and render backups when tab is clicked
    }
}

function renderServers() {
    const serversView = document.getElementById('serversView');
    if (!serversView) return;
    
    // Create HTML for server grid
    let serversHTML = '<div class="grid">';
    
    // Sort servers alphabetically
    const serverNames = Object.keys(mcpServers).sort();
    
    serverNames.forEach(name => {
        const server = mcpServers[name];
        const isEnabled = server.enabled !== false; // Default to true if not specified
        
        // Create server card
        serversHTML += `
            <div class="server-card" data-server-name="${name}">
                <div class="server-header">
                    <div class="server-name">${name}</div>
                    <label class="toggle-switch">
                        <input type="checkbox" onchange="toggleServer('${name}', this.checked)" ${isEnabled ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="server-path">${server.command} ${(server.args || []).join(' ')}</div>
                ${renderEnvironmentVars(server.env || {})}
            </div>
        `;
    });
    
    // Add a message if no servers
    if (serverNames.length === 0) {
        serversHTML += '<div class="no-servers">No MCP servers configured. Click "Edit Server Configuration" to add a server.</div>';
    }
    
    serversHTML += '</div>';
    
    // Add an "Add Server" button
    serversHTML += '<button class="add-server-button" onclick="openServerConfig(\'new\')">+ Add Server</button>';
    
    // Update the view
    serversView.innerHTML = serversHTML;
    
    // Call configChanged to update floating buttons visibility
    configChanged();
}

// New function to render masked environment variables with interactions
function renderEnvironmentVars(env) {
    if (!env || Object.keys(env).length === 0) return '';

    let html = '<div class="env-vars"><h4>Environment Variables</h4>';

    Object.entries(env).forEach(([key, value]) => {
        // Updated regex to catch KEY, TOKEN, SECRET, PASS, PASSWORD variations, including underscores
        const isSensitive = /(\b|_)(KEY|TOKEN|SECRET|PASS|PASSWORD)(\b|_)/i.test(key);
        const maskedValue = isSensitive ? '******' : value;
        const valueId = `env-val-${key}-${Math.random().toString(36).substring(2, 9)}`; // Unique ID
        const keyId = `env-key-${key}-${Math.random().toString(36).substring(2, 9)}`; // Unique ID for key span

        html += `
            <div class="env-var-pair" 
                 data-sensitive="${isSensitive}" 
                 data-key="${key}" 
                 data-value="${value}">
                <span class="env-key">${key}:</span>
                <span class="env-value" 
                      id="${valueId}" 
                      title="${isSensitive ? 'Hold Shift to reveal / Click to copy' : value}"
                      onclick="copyEnvVarToClipboard(this, '${value}', ${isSensitive})">
                    ${maskedValue}
                </span>
                <span class="copy-feedback" id="feedback-${valueId}">Copied!</span>
            </div>
        `;
    });

    html += '</div>';
    return html;
}

// Function to copy env var value to clipboard
async function copyEnvVarToClipboard(element, value, isSensitive) {
    if (isShiftPressed && isSensitive) { // Only copy if revealed
        try {
            await navigator.clipboard.writeText(value);
            console.log('Copied to clipboard:', value);
            // Show feedback
            const feedbackId = `feedback-${element.id}`;
            const feedbackElement = document.getElementById(feedbackId);
            if (feedbackElement) {
                feedbackElement.classList.add('visible');
                setTimeout(() => feedbackElement.classList.remove('visible'), 1500);
            }
        } catch (err) {
            console.error('Failed to copy: ', err);
            showWarning('Failed to copy value to clipboard.');
        }
    } else if (!isSensitive) {
         try {
            await navigator.clipboard.writeText(value);
            console.log('Copied to clipboard:', value);
            const feedbackId = `feedback-${element.id}`;
            const feedbackElement = document.getElementById(feedbackId);
            if (feedbackElement) {
                feedbackElement.classList.add('visible');
                setTimeout(() => feedbackElement.classList.remove('visible'), 1500);
            }
        } catch (err) {
             console.error('Failed to copy: ', err);
             showWarning('Failed to copy value to clipboard.');
        }
    } else {
        // Optionally show a message that Shift must be held for sensitive values
        // console.log('Hold Shift while clicking to copy sensitive values.');
         showWarning('Hold Shift while clicking to copy sensitive values.');
    }
}

// Global state for Shift key
let isShiftPressed = false;

document.addEventListener('keydown', (event) => {
    if (event.key === 'Shift' && !isShiftPressed) {
        isShiftPressed = true;
        document.body.classList.add('shift-pressed'); // Add class to body
        // Reveal all sensitive values
        document.querySelectorAll('.env-var-pair[data-sensitive="true"]').forEach(pair => {
            const valueElement = pair.querySelector('.env-value');
            if (valueElement) {
                valueElement.textContent = pair.dataset.value;
                 valueElement.title = pair.dataset.value; // Update title
            }
        });
    }
});

document.addEventListener('keyup', (event) => {
    if (event.key === 'Shift') {
        isShiftPressed = false;
        document.body.classList.remove('shift-pressed'); // Remove class from body
        // Re-mask all sensitive values
        document.querySelectorAll('.env-var-pair[data-sensitive="true"]').forEach(pair => {
            const valueElement = pair.querySelector('.env-value');
            if (valueElement) {
                valueElement.textContent = '******';
                valueElement.title = 'Hold Shift to reveal / Click to copy'; // Reset title
            }
        });
    }
});

// Handle mouse hover for individual reveal (only when Shift is NOT pressed)
document.addEventListener('mouseover', (event) => {
    if (!isShiftPressed) {
        const targetPair = event.target.closest('.env-var-pair[data-sensitive="true"]');
        if (targetPair) {
            const valueElement = targetPair.querySelector('.env-value');
            if (valueElement) {
                valueElement.textContent = targetPair.dataset.value;
                 valueElement.title = targetPair.dataset.value; // Update title
            }
        }
    }
});

document.addEventListener('mouseout', (event) => {
    if (!isShiftPressed) {
         const targetPair = event.target.closest('.env-var-pair[data-sensitive="true"]');
         if (targetPair) {
            const valueElement = targetPair.querySelector('.env-value');
            if (valueElement) {
                // Check if the mouse is *really* leaving the pair, not just moving between spans
                 if (!targetPair.contains(event.relatedTarget)) {
                     valueElement.textContent = '******';
                     valueElement.title = 'Hold Shift to reveal / Click to copy'; // Reset title
                 }
            }
        }
    }
});

function renderTools() {
    console.log('Rendering tools view');
    const toolsView = document.getElementById('toolsView');
    toolsView.innerHTML = '';

    if (!toolsList || toolsList.length === 0) {
        toolsView.innerHTML = '<div class="no-tools">No tools available or still loading...</div>';
        return;
    }

    // Group tools by server
    const toolsByServer = toolsList.reduce((acc, tool) => {
        if (!acc[tool.server]) {
            acc[tool.server] = [];
        }
        acc[tool.server].push(tool);
        return acc;
    }, {});

    // Create server sections
    Object.entries(toolsByServer).forEach(([server, tools]) => {
        const serverSection = document.createElement('div');
        serverSection.className = 'server-tools';
        
        const content = `
            <h2>${server}</h2>
            <div class="tools-grid">
                ${tools.map(tool => `
                    <div class="tool-card">
                        <div class="tool-name">${tool.name}</div>
                        <div class="tool-description">${tool.description || 'No description available'}</div>
                        <div class="tool-schema">
                            ${JSON.stringify(tool.inputSchema || {}, null, 2)}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
        
        serverSection.innerHTML = content;
        toolsView.appendChild(serverSection);
    });
}

function toggleServer(name, enabled) {
    console.log(`Toggling server ${name} to ${enabled ? 'enabled' : 'disabled'}`);
    
    // Update the mcpServers object (for backwards compatibility with older code)
    if (mcpServers[name]) {
        mcpServers[name].enabled = enabled;
    } else {
        console.error(`Server ${name} not found in mcpServers object`);
    }
    
    // Also update currentConfig to ensure all state objects are in sync
    if (currentConfig.mcpServers && currentConfig.mcpServers[name]) {
        currentConfig.mcpServers[name].enabled = enabled;
    }
    
    // Update allServersConfig for completeness
    if (allServersConfig.mcpServers && allServersConfig.mcpServers[name]) {
        allServersConfig.mcpServers[name].enabled = enabled;
    }
    
    // Check for changes and update UI state
    checkForChanges();
    
    // Re-render the servers display to reflect the new state
    displayMCPConfig();
}

async function renderBackups() {
    console.log('Rendering backups view');
    const backupsView = document.getElementById('backupsView');
    backupsView.innerHTML = '<div class="loading-message">Loading backups...</div>'; // Show loading state

    try {
        const backups = await fetchWithTimeout(API.BACKUPS);
        console.log('Received backups:', backups);

        if (!backups || backups.length === 0) {
            backupsView.innerHTML = '<div class="no-tools">No backups found.</div>'; // Re-use no-tools style
            return;
        }

        const list = document.createElement('ul');
        list.className = 'backup-list';

        backups.forEach(backup => {
            const item = document.createElement('li');
            item.className = 'backup-item';
            
            // Format timestamp nicely
            const timestamp = new Date(backup.timestamp).toLocaleString();
            // Format size nicely
            const sizeKB = (backup.size / 1024).toFixed(1);

            item.innerHTML = `
                <div>
                    <span class="backup-filename">${backup.filename}</span>
                    <span class="backup-timestamp">(${timestamp})</span>
                </div>
                <span class="backup-size">${sizeKB} KB</span>
            `;
            list.appendChild(item);
            // Future: Add restore/delete buttons here
        });

        backupsView.innerHTML = ''; // Clear loading message
        backupsView.appendChild(list);
    } catch (error) {
        console.error('Error fetching backups:', error);
        backupsView.innerHTML = '<div class="message error">Failed to load backups.</div>';
    }
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'block';
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'none';
    }
}

async function saveChanges() {
    console.log('Save Changes initiated');
    let clientsToSave = [];

    if (clientSettings.syncClients) {
        // Sync ON: Save to all enabled clients
        clientsToSave = Object.entries(clientSettings.clients)
            .filter(([id, client]) => client.enabled)
            .map(([id, client]) => id);
        console.log('Sync ON: Targeting enabled clients:', clientsToSave);
        if (clientsToSave.length === 0) {
            showWarning("Cannot save: Sync is ON, but no clients are enabled.");
            return;
        }
    } else {
        // Sync OFF: Save only to the currently active/loaded client
        if (currentLoadedClientId) {
            clientsToSave = [currentLoadedClientId];
            console.log('Sync OFF: Targeting active client:', clientsToSave);
        } else {
            showWarning("Cannot save: Sync is OFF, but no client configuration is currently loaded.");
            return;
        }
    }

    // Pass the current editor state and target clients
    await performSave(clientsToSave, mcpServers);
}

async function performSave(targetClientIds, configDataToSave) {
    console.log('Performing save for clients:', targetClientIds);
    showLoadingIndicator(true, 'Saving...');

    // Add safety check for empty mcpServers object
    const dataToSend = { mcpServers: configDataToSave || {} };

    try {
        const response = await fetchWithTimeout(API.SAVE_CONFIGS, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                configData: dataToSend, // Send the whole structure expected by backend
                targetClients: targetClientIds
            }),
            timeout: 15000 // Increased timeout for saving
        });

        if (response.success) {
            showMessage('Configuration saved successfully.', false);
            // Update originalConfig to reflect the saved state
            originalConfig = JSON.parse(JSON.stringify(mcpServers));
            configChanged(); // Update button visibility (should hide them)

            // If sync was ON, re-check differences (should now be consistent)
            if (clientSettings.syncClients) {
                await checkOriginalConfigDifferences();
            }

        } else {
            throw new Error(response.error || 'Unknown error during save.');
        }
    } catch (error) {
        console.error('Error saving configuration:', error);
        showWarning(`Failed to save configuration: ${error.message}`);
    } finally {
        showLoadingIndicator(false);
    }
}

// Reset configuration to the initial loaded state
async function resetConfiguration() {
    // No confirmation needed anymore
    showLoadingIndicator(true, 'Resetting configuration...');
    try {
        // Fetch the definitive initial active configuration structure from the server
        const response = await fetch('/api/config/initial'); // Use the dedicated endpoint
        if (!response.ok) {
             const errorData = await response.json().catch(() => ({ error: 'Failed to parse error response' }));
            throw new Error(`Failed to fetch initial configuration state: ${errorData.error || response.statusText}`);
        }
        const fetchedInitialActiveConfig = await response.json();
        
        // Update our local reference for initial state
        initialActiveConfig = _.cloneDeep(fetchedInitialActiveConfig);
        console.log("Refreshed initial active config for reset:", JSON.stringify(initialActiveConfig.mcpServers || {}, null, 2));
        
        // Reset currentConfig: Start with the full registry state (allServersConfig) 
        // and apply the just-fetched initial active flags.
        currentConfig = _.cloneDeep(allServersConfig); // Get all servers from registry memory
        
        // Apply the correct 'enabled' flags based on the initial active state
         if (currentConfig.mcpServers && initialActiveConfig.mcpServers) {
             Object.keys(currentConfig.mcpServers).forEach(key => {
                 // Enable if the key exists in the initial active config, disable otherwise
                 currentConfig.mcpServers[key].enabled = !!initialActiveConfig.mcpServers[key]; 
             });
         } else if (currentConfig.mcpServers) {
             // If initial active config was empty, disable all
              Object.keys(currentConfig.mcpServers).forEach(key => {
                 currentConfig.mcpServers[key].enabled = false;
             });
         }

        console.log("Configuration reset to initial state using fetched initial active config.");
        displayMCPConfig(); // Re-render with the reset state
        hasUnsavedChanges = false; // Reset flag
        updateFloatingButtonsVisibility(); // Hide buttons
        showToast('Changes reverted to the last saved state.', 'success');
    } catch (error) {
        console.error('Error resetting configuration:', error);
        showToast(`Error resetting configuration: ${error.message}`, 'error');
    } finally {
        showLoadingIndicator(false);
    }
}

// Save current configuration
async function saveConfiguration() {
    // No confirmation needed anymore
    showLoadingIndicator(true, 'Saving configuration...');
    try {
        // Prepare the data to send: the entire currentConfig (which includes enabled flags)
        const configToSave = currentConfig; 

        // Determine the URL (include clientId if sync is off and a client is selected)
        let url = '/api/config';
        if (!settings.syncClients && selectedClientId) { // Use selectedClientId which tracks UI selection
            url += `?clientId=${selectedClientId}`;
             console.log(`Saving config for specific client: ${selectedClientId}`);
        } else {
             console.log(`Saving config (Sync Mode: ${settings.syncClients})`);
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(configToSave), // Send the whole working state
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Save failed: ${errorText || response.statusText}`);
        }

        const successMessage = await response.text();

        // --- Post-Save State Update --- 
        // The server has updated the registry and the active file.
        // Now, update the local state variables to match the new baseline.

        // 1. Update initialActiveConfig: Rebuild it from the just saved currentConfig (enabled servers only)
        initialActiveConfig = { mcpServers: {} };
        if (currentConfig.mcpServers) {
            Object.entries(currentConfig.mcpServers).forEach(([key, server]) => {
                if (server.enabled) {
                    const serverDetails = _.omit(server, 'enabled');
                    initialActiveConfig.mcpServers[key] = _.cloneDeep(serverDetails);
                }
            });
        }
        
        // 2. Update allServersConfig: It should now reflect the currentConfig state 
        // (since currentConfig was sent to the server, which updated the registry)
        allServersConfig = _.cloneDeep(currentConfig);

        console.log("Configuration saved successfully.");
        console.log("Updated local initial active state:", JSON.stringify(initialActiveConfig.mcpServers || {}, null, 2));
        // console.log("Updated local all servers state:", JSON.stringify(allServersConfig.mcpServers || {}, null, 2));


        hasUnsavedChanges = false; // Mark changes as saved
        updateFloatingButtonsVisibility(); // Hide buttons
        showToast(successMessage || 'Configuration saved successfully.', 'success');
        
        // Check sync status again after saving, as backend might have updated original client files
        await checkSyncStatus(); 

    } catch (error) {
        console.error('Error saving configuration:', error);
        showToast(`Error saving configuration: ${error.message}`, 'error');
    } finally {
        showLoadingIndicator(false);
    }
}

// --- PRESET MANAGEMENT FUNCTIONS ---

// Fetch and populate preset dropdown
async function loadPresetsList() {
    console.log('Loading presets list...');
    try {
        const presetNames = await fetchWithTimeout(API.PRESETS);
        console.log('Available presets:', presetNames);
        
        const presetSelector = document.getElementById('presetSelector');
        presetSelector.innerHTML = ''; // Clear existing options
        
        // Add a blank option first 
        const blankOption = document.createElement('option');
        blankOption.value = '';
        blankOption.textContent = '-- Select Preset --';
        presetSelector.appendChild(blankOption);
        
        // Add each preset
        presetNames.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            presetSelector.appendChild(option);
        });
        
        return presetNames;
    } catch (error) {
        console.error('Failed to load presets list:', error);
        showMessage('Failed to load presets. Some features may be unavailable.');
        return [];
    }
}

// Load a specific preset
async function loadPreset(presetName) {
    if (!presetName || presetName === '') {
        // If blank option or invalid name, do nothing
        console.log('No preset selected, keeping current config');
        currentPreset = null;
        originalPresetConfig = {};
        updatePresetButtons(false);
        return;
    }
    
    console.log(`Loading preset: ${presetName}`);
    try {
        const response = await fetchWithTimeout(`${API.PRESET_GET}${encodeURIComponent(presetName)}`);
        console.log('Loaded preset:', response);
        
        if (!response.mcpServers) {
            throw new Error('Invalid preset format: missing mcpServers');
        }
        
        // Store the preset name and backup current config to detect changes
        currentPreset = presetName;
        originalPresetConfig = JSON.parse(JSON.stringify(response.mcpServers));
        
        // Update the UI with the preset's servers
        mcpServers = response.mcpServers;
        renderServers();
        
        // Turn on save/cancel buttons since we're now in a preset editing mode
        updatePresetButtons(true);
        
        showMessage(`Loaded preset '${presetName}'. Use "Save Changes to Preset" to update, or "Save Changes to Claude/Cursor" to apply.`, false);
    } catch (error) {
        console.error(`Failed to load preset '${presetName}':`, error);
        showMessage(`Failed to load preset '${presetName}': ${error.message}`);
        currentPreset = null;
        originalPresetConfig = {};
        updatePresetButtons(false);
    }
}

// Save current configuration as a new preset
async function saveCurrentAsPreset() {
    const newPresetName = document.getElementById('newPresetName').value.trim();
    if (!newPresetName) {
        showMessage('Please enter a name for the new preset.');
        return;
    }
    
    console.log(`Saving new preset: ${newPresetName}`);
    try {
        const response = await fetchWithTimeout(`${API.PRESET_SAVE}${encodeURIComponent(newPresetName)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mcpServers })
        });
        
        console.log('Save preset response:', response);
        
        // Clear the input field
        document.getElementById('newPresetName').value = '';
        
        // Reload presets list to include the new one
        await loadPresetsList();
        
        // Select the new preset
        const presetSelector = document.getElementById('presetSelector');
        presetSelector.value = newPresetName;
        
        // Update current preset state
        currentPreset = newPresetName;
        originalPresetConfig = JSON.parse(JSON.stringify(mcpServers));
        updatePresetButtons(true);
        
        showMessage(`Preset '${newPresetName}' saved successfully.`, false);
    } catch (error) {
        console.error(`Failed to save preset '${newPresetName}':`, error);
        showMessage(`Failed to save preset '${newPresetName}': ${error.message}`);
    }
}

// Save changes to the current preset
async function saveToCurrentPreset() {
    if (!currentPreset) {
        showMessage('No preset is currently selected.');
        return;
    }
    
    console.log(`Saving changes to preset: ${currentPreset}`);
    try {
        const response = await fetchWithTimeout(`${API.PRESET_SAVE}${encodeURIComponent(currentPreset)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mcpServers })
        });
        
        console.log('Update preset response:', response);
        
        // Update the backup of the preset config
        originalPresetConfig = JSON.parse(JSON.stringify(mcpServers));
        
        // Hide the save/cancel buttons since we're now in sync
        updatePresetButtons(true, false);
        
        showMessage(`Preset '${currentPreset}' updated successfully.`, false);
    } catch (error) {
        console.error(`Failed to update preset '${currentPreset}':`, error);
        showMessage(`Failed to update preset '${currentPreset}': ${error.message}`);
    }
}

// Cancel changes to the current preset
function cancelPresetChanges() {
    if (!currentPreset || !originalPresetConfig) {
        return;
    }
    
    console.log(`Reverting changes to preset: ${currentPreset}`);
    
    // Restore the original config
    mcpServers = JSON.parse(JSON.stringify(originalPresetConfig));
    
    // Re-render the UI
    renderServers();
    
    // Hide the save/cancel buttons
    updatePresetButtons(true, false);
    
    showMessage(`Changes to preset '${currentPreset}' have been reverted.`, false);
}

// Delete the current preset
async function deleteCurrentPreset() {
    if (!currentPreset) {
        showMessage('No preset is currently selected.');
        return;
    }
    
    if (!confirm(`Are you sure you want to delete the preset '${currentPreset}'?`)) {
        return;
    }
    
    console.log(`Deleting preset: ${currentPreset}`);
    try {
        const response = await fetchWithTimeout(`${API.PRESET_DELETE}${encodeURIComponent(currentPreset)}`, {
            method: 'DELETE'
        });
        
        console.log('Delete preset response:', response);
        
        // Reset the current preset
        currentPreset = null;
        originalPresetConfig = {};
        
        // Hide the buttons
        updatePresetButtons(false);
        
        // Reload the presets list
        await loadPresetsList();
        
        // Clear the dropdown selection
        document.getElementById('presetSelector').value = '';
        
        showMessage(`Preset deleted successfully.`, false);
    } catch (error) {
        console.error(`Failed to delete preset:`, error);
        showMessage(`Failed to delete preset: ${error.message}`);
    }
}

// Update the visibility of preset buttons
function updatePresetButtons(presetSelected, showChangeButtons = null) {
    console.log(`Updating preset buttons - presetSelected: ${presetSelected}, showChangeButtons: ${showChangeButtons}`);
    
    const applyBtn = document.getElementById('applyPresetBtn');
    const saveAsBtn = document.getElementById('savePresetAsBtn');
    const saveBtn = document.getElementById('saveToPresetBtn');
    const deleteBtn = document.getElementById('deletePresetBtn');
    const cancelBtn = document.getElementById('cancelPresetChangesBtn');
    
    if (presetSelected) {
        // Show apply and delete buttons
        if (applyBtn) applyBtn.style.display = 'inline-block';
        if (deleteBtn) deleteBtn.style.display = 'inline-block';
        
        // Show save to preset and cancel buttons only if there are changes 
        // and a specific request to show or hide them wasn't made
        const showSaveButtons = (showChangeButtons !== null) 
            ? showChangeButtons 
            : JSON.stringify(mcpServers) !== JSON.stringify(originalPresetConfig);
        
        if (saveBtn) saveBtn.style.display = showSaveButtons ? 'inline-block' : 'none';
        if (cancelBtn) cancelBtn.style.display = showSaveButtons ? 'inline-block' : 'none';
    } else {
        // Hide all preset-specific buttons
        if (applyBtn) applyBtn.style.display = 'none';
        if (saveBtn) saveBtn.style.display = 'none';
        if (deleteBtn) deleteBtn.style.display = 'none';
        if (cancelBtn) cancelBtn.style.display = 'none';
    }
    
    // Always show "Save As..." button
    if (saveAsBtn) saveAsBtn.style.display = 'inline-block';
}

// --- CLIENT SETTINGS MANAGEMENT ---

// Load app settings (client configuration, etc)
async function loadAppSettings() {
    console.log('Loading app settings...');
    try {
        clientSettings = await fetchWithTimeout(API.SETTINGS);
        console.log('Loaded settings:', clientSettings);

        // Update UI elements based on settings
        const syncToggle = document.getElementById('syncClientsToggle');
        if (syncToggle) {
            syncToggle.checked = clientSettings.syncClients;
        }
        // Render client list in sidebar
        renderClientSidebar();

    } catch (error) {
        console.error('Failed to load app settings:', error);
        showWarning('Could not load application settings. Using defaults.');
        // Fallback to some defaults?
        clientSettings = { clients: {}, syncClients: false };
        renderClientSidebar(); // Render empty sidebar
    }
}

// Save app settings
async function saveAppSettings() {
    console.log('Saving app settings...');
    showLoadingIndicator(true, 'Saving settings...');
    try {
        // Prepare settings data (e.g., read from UI controls if needed)
        // For now, just saving the current clientSettings object state
        const syncToggle = document.getElementById('syncClientsToggle');
        if (syncToggle) {
            clientSettings.syncClients = syncToggle.checked;
        }
        // Update client enabled status from UI checkboxes if they exist (currently removed)
        // ... need to re-evaluate how client enablement is controlled ...

        const response = await fetchWithTimeout(API.SETTINGS_SAVE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientSettings)
        });

        if (response.success && response.settings) {
            clientSettings = response.settings; // Update local settings with saved version
            showMessage('Settings saved successfully.', false);
            renderClientSidebar(); // Re-render sidebar to reflect saved state
            // Decide whether to reload config based on sync change
            if (clientSettings.syncClients) {
                await loadMainConfig(); // Load main config if sync turned ON
            } else {
                // If sync turned OFF, load the first active client's config? Or keep current?
                // Let's load the first *selected* client if one exists
                if (activeClients.length > 0) {
                    await selectClient(activeClients[0], document.querySelector(`.client-item[data-client-id="${activeClients[0]}"]`));
                } else {
                    // Or load the first available client?
                    const firstClient = Object.keys(clientSettings.clients || {})[0];
                    if (firstClient) {
                        await selectClient(firstClient, document.querySelector(`.client-item[data-client-id="${firstClient}"]`));
                    } else {
                        await loadMainConfig(); // Fallback if no clients exist
                    }
                }
            }
        } else {
            throw new Error(response.error || 'Failed to save settings.');
        }
    } catch (error) {
        console.error('Error saving settings:', error);
        showWarning(`Failed to save settings: ${error.message}`);
    } finally {
        showLoadingIndicator(false);
    }
}

// Render the client sidebar based on current settings
function renderClientSidebar() {
    const clientList = document.getElementById('clientList');
    if (!clientList) return;
    clientList.innerHTML = ''; // Clear existing list

    if (!clientSettings || !clientSettings.clients) {
        console.warn('No client settings found to render sidebar.');
        return;
    }

    const syncEnabled = clientSettings.syncClients;

    Object.entries(clientSettings.clients).forEach(([id, client]) => {
        const listItem = document.createElement('div');
        listItem.className = 'client-item';
        listItem.dataset.clientId = id;

        // Highlight if active
        if (activeClients.includes(id)) {
            listItem.classList.add('active');
        }

        // Client Name
        const nameSpan = document.createElement('span');
        nameSpan.textContent = client.name || id;
        listItem.appendChild(nameSpan);

        // Add click listener for selection
        listItem.addEventListener('click', () => selectClient(id, listItem));

        // Add enabled/disabled status indicator (visual only for now)
        const statusIndicator = document.createElement('span');
        statusIndicator.className = `status-indicator ${client.enabled ? 'enabled' : 'disabled'}`;
        statusIndicator.title = client.enabled ? 'Enabled' : 'Disabled';
        listItem.appendChild(statusIndicator);

        clientList.appendChild(listItem);
    });

    // Update sync toggle state
    const syncToggle = document.getElementById('syncClientsToggle');
    if (syncToggle) {
        syncToggle.checked = syncEnabled;
        // Disable toggle interaction if needed based on future logic
    }
    // Show/hide warning based on sync state
    if (syncEnabled) {
        checkOriginalConfigDifferences(); // Check for diffs when rendering in sync mode
    } else {
        hideConfigWarning();
    }
}

// Handle client selection in the sidebar
async function selectClient(clientId, element) {
    console.log(`Client selected: ${clientId}`);
    const syncEnabled = clientSettings.syncClients;

    // Update the configuration mode indicator
    const modeSpan = document.getElementById('currentConfigMode');
    const modeDescription = document.getElementById('configModeDescription');
    
    if (syncEnabled) {
        // Sync ON: Multiple selection (toggle) - CURRENTLY NOT SUPPORTED BY SAVE/LOAD LOGIC
        // For now, treat sync ON as meaning "use main config"
        console.warn("Client selection ignored in Sync mode. Using main config.");
        // Deselect all visually and load main config?
        activeClients = [];
        document.querySelectorAll('.client-item.active').forEach(el => el.classList.remove('active'));
        
        // Update mode indicator
        if (modeSpan) modeSpan.textContent = "Global Sync Mode";
        if (modeDescription) modeDescription.textContent = "Changes will be applied to all enabled clients.";
        
        await loadMainConfig();
        // OR allow selection but don't load client-specific? Let's do the former.

    } else {
        // Sync OFF: Single selection
        // Deselect previously active client (if any)
        const previouslyActive = document.querySelector('.client-item.active');
        if (previouslyActive && previouslyActive !== element) {
            previouslyActive.classList.remove('active');
        }

        // Toggle selection for the clicked element
        if (element.classList.contains('active')) {
            // Deselecting the currently selected one - load nothing? Or main? Let's load main.
            element.classList.remove('active');
            activeClients = [];
            
            // Update mode indicator
            if (modeSpan) modeSpan.textContent = "No Client Selected";
            if (modeDescription) modeDescription.textContent = "Select a client from the sidebar to edit its configuration.";
            
            await loadMainConfig(); // Load main as a neutral state
        } else {
            // Selecting a new one
            element.classList.add('active');
            activeClients = [clientId]; // Only one active client
            
            // Update mode indicator
            if (modeSpan) modeSpan.textContent = `${clientSettings.clients[clientId]?.name || clientId}`;
            if (modeDescription) modeDescription.textContent = `Editing configuration for ${clientSettings.clients[clientId]?.name || clientId}.`;
            
            // Load the config for this specific client
            await loadConfigForClient(clientId);
        }
    }
    console.log('Active clients:', activeClients);
}

// Simplified toggleClientSync - just updates setting and saves
async function toggleClientSync() {
    const syncToggle = document.getElementById('syncClientsToggle');
    const syncEnabled = syncToggle.checked;
    console.log(`Toggling client sync to: ${syncEnabled}`);
    clientSettings.syncClients = syncEnabled;
    await saveAppSettings(); // Save settings will handle reloading config if necessary
}

// --- SERVER CONFIGURATION EDITOR ---

// Current server being edited
let currentServerName = null;

// Opens the server configuration editor modal
function openServerConfig(serverName) {
    console.log(`Opening config for server: ${serverName}`);
    currentServerName = serverName;
    
    // Get the server config
    const config = mcpServers[serverName] || {};
    
    // Reset form
    document.getElementById('serverConfigForm').reset();
    
    // Clear dynamic containers
    document.getElementById('serverArgs').innerHTML = '';
    document.getElementById('serverEnv').innerHTML = '';
    
    // Fill in the form fields
    document.getElementById('serverName').value = serverName;
    document.getElementById('serverCommand').value = config.command || '';
    
    // Connection type
    const serverType = config.sse ? 'sse' : 'subprocess';
    document.getElementById('serverType').value = serverType;
    document.getElementById('sseUrlContainer').style.display = serverType === 'sse' ? 'block' : 'none';
    document.getElementById('sseUrl').value = config.sse || '';
    
    // Add arguments
    if (Array.isArray(config.args)) {
        config.args.forEach(arg => addServerArg(arg));
    }
    
    // Add environment variables
    if (config.env) {
        Object.entries(config.env).forEach(([key, value]) => addServerEnv(key, value));
    }
    
    // MCP Inspector settings
    const hasInspector = config.inspector || false;
    document.getElementById('enableInspector').checked = hasInspector;
    document.getElementById('inspectorOptionsContainer').style.display = hasInspector ? 'block' : 'none';
    
    if (hasInspector && config.inspectorPort) {
        document.getElementById('inspectorPort').value = config.inspectorPort;
    } else {
        document.getElementById('inspectorPort').value = '7860';
    }
    
    // Add event listener for inspector checkbox
    document.getElementById('enableInspector').onchange = function() {
        document.getElementById('inspectorOptionsContainer').style.display = 
            this.checked ? 'block' : 'none';
    };
    
    // Add event listener for server type
    document.getElementById('serverType').onchange = function() {
        document.getElementById('sseUrlContainer').style.display = 
            this.value === 'sse' ? 'block' : 'none';
    };
    
    // Open the modal
    openModal('serverConfigModal');
}

// Add a new argument input row
function addServerArg(value = '') {
    const container = document.getElementById('serverArgs');
    const row = document.createElement('div');
    row.className = 'arg-row';
    
    row.innerHTML = `
        <input type="text" value="${value}" placeholder="Argument value">
        <button type="button" class="remove-button" onclick="removeElement(this.parentNode)">&times;</button>
    `;
    
    container.appendChild(row);
}

// Add a new environment variable input row
function addServerEnv(key = '', value = '') {
    const container = document.getElementById('serverEnv');
    const row = document.createElement('div');
    row.className = 'env-row';
    
    row.innerHTML = `
        <input type="text" value="${key}" placeholder="KEY">
        <input type="text" value="${value}" placeholder="Value">
        <button type="button" class="remove-button" onclick="removeElement(this.parentNode)">&times;</button>
    `;
    
    container.appendChild(row);
}

// Remove an element from the DOM
function removeElement(element) {
    if (element && element.parentNode) {
        element.parentNode.removeChild(element);
    }
}

// Save the server configuration
function saveServerConfig() {
    const serverName = document.getElementById('configServerName').value.trim();
    const originalName = document.getElementById('configServerName').getAttribute('data-original-name');
    
    // Basic validation
    if (!serverName) {
        alert('Server name cannot be empty');
        return;
    }
    
    // Get command and args
    const command = document.getElementById('configServerCommand').value.trim();
    const argsContainer = document.getElementById('configServerArgs');
    const args = Array.from(argsContainer.querySelectorAll('input')).map(input => input.value.trim());
    
    // Get environment variables
    const envContainer = document.getElementById('configServerEnv');
    const envInputs = envContainer.querySelectorAll('.env-pair');
    const env = {};
    
    Array.from(envInputs).forEach(pair => {
        const keyInput = pair.querySelector('input[placeholder="Key"]');
        const valueInput = pair.querySelector('input[placeholder="Value"]');
        if (keyInput && valueInput && keyInput.value.trim()) {
            env[keyInput.value.trim()] = valueInput.value.trim();
        }
    });
    
    // Get disabled state
    const disabled = !document.getElementById('serverEnabledToggle').checked;
    
    // Get inspector settings
    const inspectorEnabled = document.getElementById('inspectorEnabledToggle').checked;
    const inspectorHost = document.getElementById('inspectorHost').value.trim();
    const inspectorPort = parseInt(document.getElementById('inspectorPort').value, 10) || 9229;
    
    // Create the server config object
    const serverConfig = {
        command,
        args,
        env,
        disabled
    };
    
    // Add inspector settings if enabled
    if (inspectorEnabled) {
        serverConfig.inspector = {
            enabled: true,
            host: inspectorHost || 'localhost',
            port: inspectorPort
        };
    }
    
    console.log('Updated server config:', serverConfig);
    
    // Handle rename scenario
    if (originalName && serverName !== originalName) {
        console.log(`Renaming server from ${originalName} to ${serverName}`);
        delete mcpServers[originalName];
    }
    
    // Update the server configuration
    mcpServers[serverName] = serverConfig;
    
    // Trigger config changed to update UI state
    configChanged();
    
    // Rerender and close modal
    renderServers();
    closeModal('configModal');
}

// Track changes to the configuration
function configChanged() {
    // Compare current state with original
    const currentJSON = JSON.stringify(mcpServers);
    const originalJSON = JSON.stringify(originalConfig);
    
    // Check if data has changed
    const hasChanges = currentJSON !== originalJSON;
    
    console.log('Config changed check:', 
        'Has changes:', hasChanges,
        'Current servers:', Object.keys(mcpServers),
        'Original servers:', Object.keys(originalConfig)
    );
    
    // Update floating buttons visibility
    updateFloatingButtonsVisibility(hasChanges);
    
    // If we're editing a preset, also show/hide preset-specific buttons
    if (currentPreset) {
        const presetChanges = currentJSON !== JSON.stringify(originalPresetConfig);
        updatePresetButtons(true, presetChanges);
    }
    
    return hasChanges;
}

async function initializeApp() {
    console.log('Initializing MCP Manager App');
    showLoadingIndicator(true, 'Initializing...');

    // Load settings first
    await loadAppSettings();

    // Add event listener for sync toggle AFTER settings are loaded
    const syncToggle = document.getElementById('syncClientsToggle');
    if (syncToggle) {
        // Remove existing listener first to prevent duplicates
        syncToggle.removeEventListener('change', toggleClientSync);
        syncToggle.addEventListener('change', toggleClientSync);
    }

    // Set initial configuration mode indicator
    const modeSpan = document.getElementById('currentConfigMode');
    const modeDescription = document.getElementById('configModeDescription');
    
    if (settings?.syncClients) {
        if (modeSpan) modeSpan.textContent = "Global Sync Mode";
        if (modeDescription) modeDescription.textContent = "Changes will be applied to all enabled clients.";
    } else {
        // When starting in non-sync mode, we'll set this based on the selected client in loadInitialConfiguration
        if (modeSpan) modeSpan.textContent = "Loading...";
        if (modeDescription) modeDescription.textContent = "Select a client from the sidebar to edit its configuration.";
    }

    // Initial config load: Load main config by default.
    // Client selection will trigger client-specific loads if sync is off.
    await loadInitialConfiguration();

    // Add event listeners (ensure they are added only once)
    const saveBtn = document.getElementById('saveChangesBtn');
    saveBtn?.removeEventListener('click', saveChanges); // Remove first
    saveBtn?.addEventListener('click', saveChanges);

    const resetBtn = document.getElementById('resetChangesBtn');
    resetBtn?.removeEventListener('click', resetConfig); // Remove first
    resetBtn?.addEventListener('click', resetConfig);

    // Setup other listeners (presets, modals, etc.)
    document.getElementById('savePresetBtn')?.addEventListener('click', saveCurrentAsPreset);
    document.getElementById('saveToPresetBtn')?.addEventListener('click', saveToCurrentPreset);
    document.getElementById('cancelPresetBtn')?.addEventListener('click', cancelPresetChanges);
    document.getElementById('deletePresetBtn')?.addEventListener('click', deleteCurrentPreset);
    document.getElementById('presetSelector')?.addEventListener('change', (e) => loadPreset(e.target.value));

    // Server modal listeners
    document.getElementById('addServerBtn')?.addEventListener('click', () => openServerConfig(null)); // null indicates new server
    document.getElementById('cancelServerConfig')?.addEventListener('click', () => closeModal('serverConfigModal'));
    document.getElementById('saveServerConfigBtn')?.addEventListener('click', saveServerConfig);
    document.getElementById('addArgumentBtn')?.addEventListener('click', () => addServerArg());
    document.getElementById('addEnvVarBtn')?.addEventListener('click', () => addServerEnv());

    console.log('Initialization complete');
    showLoadingIndicator(false);

    // Set initial view - Fix selector
    const initialTab = document.querySelector(".tab[onclick*=\"showView('servers\"]");
    showView('servers', initialTab);
}

// Helper for loading indicator
function showLoadingIndicator(show, message = 'Loading...') {
    const indicator = document.getElementById('loadingIndicator');
    const messageElement = document.getElementById('loadingMessage');
    if (indicator && messageElement) {
        messageElement.textContent = message;
        indicator.style.display = show ? 'flex' : 'none';
    }
}

// DOMContentLoaded ensures the DOM is ready before running the script
document.addEventListener('DOMContentLoaded', initializeApp);

// Export functions for global access
window.showView = showView;
window.toggleServer = toggleServer;
window.saveChanges = saveChanges;
window.resetChanges = resetConfig;
window.closeModal = closeModal;
window.openModal = openModal;

// Export preset functions
window.loadPreset = loadPreset;
window.saveCurrentAsPreset = saveCurrentAsPreset;
window.saveToCurrentPreset = saveToCurrentPreset;
window.cancelPresetChanges = cancelPresetChanges;
window.deleteCurrentPreset = deleteCurrentPreset;

// Export client functions
window.toggleClientSync = toggleClientSync;

// Export server config functions
window.openServerConfig = openServerConfig;
window.addServerArg = addServerArg;
window.addServerEnv = addServerEnv;
window.removeElement = removeElement;
window.saveServerConfig = saveServerConfig;

// Add new export for clipboard copy
window.copyEnvVarToClipboard = copyEnvVarToClipboard;

// Debounce function
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

// Add resetConfig function that was missing
function resetConfig() {
    resetConfiguration();
}

// Add updateClientSelectionUI function that was missing
function updateClientSelectionUI() {
    // This function should update the UI to reflect the current client selection
    // based on the selectedClientId
    console.log('Updating client selection UI - selectedClientId:', selectedClientId);
    
    // First, remove 'active' class from all client items
    const clientItems = document.querySelectorAll('.client-item');
    clientItems.forEach(item => {
        item.classList.remove('active');
    });
    
    // If a client is selected, add 'active' class to that client
    if (selectedClientId) {
        const selectedItem = document.querySelector(`.client-item[data-client-id="${selectedClientId}"]`);
        if (selectedItem) {
            selectedItem.classList.add('active');
        }
    }
}

// Fetch initial configuration based on sync status and selected client
async function loadInitialConfiguration(clientId = null) {
    showLoadingIndicator(true, 'Loading configuration...'); // Correct function call
    hasUnsavedChanges = false; // Reset unsaved changes flag on load
    currentLoadedClientId = null; // Reset loaded client ID initially
    try {
        let url = API.CONFIG; // Use the defined API constant instead of a string
        // Determine which config state to request based on sync mode
        if (!settings?.syncClients) { // Safe access for syncClients
            // If sync is off, request state for a specific client
            // Use provided clientId, or last loaded, or find first enabled
            // Add check for settings.clients before using Object.keys
            const availableClients = settings?.clients ? Object.keys(settings.clients) : [];
            const targetClientId = clientId || 
                                 settings?.lastSelectedClient || 
                                 availableClients.find(id => settings.clients[id]?.enabled && settings.clients[id]?.configPath) ||
                                 (availableClients.length > 0 ? availableClients[0] : null); // Default to first client if none selected
            
            if (targetClientId) {
                url += `?clientId=${targetClientId}`;
                selectedClientId = targetClientId; // Set the *selected* client ID (for UI)
                lastLoadedClientId = targetClientId; // Remember this client was loaded
                currentLoadedClientId = targetClientId; // Track that this specific client's state is loaded
                console.log(`Sync OFF: Requesting state for client: ${selectedClientId}`);
                
                // Update the configuration mode indicator
                const modeSpan = document.getElementById('currentConfigMode');
                const modeDescription = document.getElementById('configModeDescription');
                if (modeSpan) modeSpan.textContent = `${settings?.clients[targetClientId]?.name || targetClientId}`;
                if (modeDescription) modeDescription.textContent = `Editing configuration for ${settings?.clients[targetClientId]?.name || targetClientId}.`;
                
                // Ensure client is highlighted in the sidebar immediately
                setTimeout(() => {
                    const clientElement = document.querySelector(`.client-item[data-client-id="${targetClientId}"]`);
                    if (clientElement) {
                        clientElement.classList.add('active');
                        activeClients = [targetClientId]; // Update active clients array
                    }
                }, 100);
                
                // Load client-specific config instead of main config
                await loadConfigForClient(targetClientId);
                return; // Exit early as we've handled the client-specific load
            } else {
                 console.log("Sync OFF: No client specified or enabled/found. Requesting default state (likely main config).");
                 selectedClientId = null; // Ensure no client is marked as selected UI-wise
                 // Requesting default state without clientId might load main config.json
            }
        } else {
            console.log("Sync ON: Requesting combined state (main active config + registry).");
            selectedClientId = null; // No specific client selected in sync mode
            currentLoadedClientId = null; // Indicates main config is the source
        }

        const response = await fetch(url);
        
        // Get response text first
        const responseText = await response.text();
        
        if (!response.ok) {
            console.error(`Server returned ${response.status}: ${responseText}`);
            throw new Error(`Failed to load configuration state: ${response.statusText}`);
        }
        
        // Safely parse the JSON with better error handling
        let combinedServerState;
        try {
            combinedServerState = JSON.parse(responseText);
        } catch (parseError) {
            console.error("JSON Parse Error:", parseError, "Response was:", responseText.substring(0, 200) + "...");
            throw new Error(`Failed to parse server response: ${parseError.message}`);
        }
        
        // 1. Store the full state including enabled flags
        allServersConfig = combinedServerState || { mcpServers: {} }; 

        // 2. Store the initial ACTIVE config structure (for comparison)
        initialActiveConfig = { mcpServers: {} };
        if (allServersConfig.mcpServers) {
            Object.entries(allServersConfig.mcpServers).forEach(([key, server]) => {
                if (server.enabled) {
                    // Deep clone server data, remove the transient 'enabled' flag before storing for comparison
                    const serverDetails = _.omit(server, 'enabled'); 
                    initialActiveConfig.mcpServers[key] = _.cloneDeep(serverDetails);
                }
            });
        }

        // 3. Current working config starts as a deep clone of the full loaded state
        currentConfig = _.cloneDeep(allServersConfig); 
        
        console.log("Full Server State Loaded (Registry + Active Flags):", JSON.stringify(allServersConfig.mcpServers || {}, null, 2));
        console.log("Initial Active Config Structure Stored (For Comparison):", JSON.stringify(initialActiveConfig.mcpServers || {}, null, 2));

        displayMCPConfig(); // Render based on currentConfig
        updateClientSelectionUI(); // Update client selection highlight based on selectedClientId
        checkForChanges(); // Initial check (should be false)
        updateFloatingButtonsVisibility(); // Hide buttons initially

    } catch (error) {
        console.error('Error loading configuration state:', error);
        showToast(`Error loading configuration state: ${error.message}`, 'error');
        // Display empty state if load fails
        currentConfig = { mcpServers: {} };
        initialActiveConfig = { mcpServers: {} };
        allServersConfig = { mcpServers: {} };
        displayMCPConfig(); // Display empty
        updateFloatingButtonsVisibility(); // Ensure buttons hidden
    } finally {
        showLoadingIndicator(false); // Correct function call
    }
}

// Check if current configuration differs from the initial active configuration
function checkForChanges() {
     // Get only the enabled servers from the current working config
     const currentEnabledServers = {};
     if (currentConfig.mcpServers) {
         Object.entries(currentConfig.mcpServers).forEach(([key, server]) => {
             if (server.enabled) {
                 // Clone server data, remove transient 'enabled' flag for comparison
                 const serverDetails = _.omit(server, 'enabled');
                 currentEnabledServers[key] = serverDetails;
             }
         });
     }

    // Deep compare the current *enabled* structure with the initial *active* structure
    // console.log("Checking for changes...");
    // console.log("Current Enabled Structure:", JSON.stringify(currentEnabledServers, null, 2));
    // console.log("Initial Active Structure:", JSON.stringify(initialActiveConfig.mcpServers || {}, null, 2));
    
    hasUnsavedChanges = !_.isEqual(currentEnabledServers, initialActiveConfig.mcpServers || {});
    // console.log("Has Unsaved Changes:", hasUnsavedChanges);
    
    updateFloatingButtonsVisibility(); // Update button visibility based on the check
}

// Update visibility of Save/Reset buttons
function updateFloatingButtonsVisibility() {
    const buttonsContainer = document.getElementById('floatingButtons');
    if (hasUnsavedChanges) {
        buttonsContainer.classList.remove('hidden');
    } else {
        buttonsContainer.classList.add('hidden');
    }
}

// Load and display MCP config
function displayMCPConfig() {
    const configDisplay = document.getElementById('configDisplay');
    
    // Check if configDisplay exists, if not, create it inside serversView
    if (!configDisplay) {
        console.log('Creating missing configDisplay element');
        const serversView = document.getElementById('serversView');
        if (serversView) {
            const newConfigDisplay = document.createElement('div');
            newConfigDisplay.id = 'configDisplay';
            newConfigDisplay.className = 'config-display';
            serversView.appendChild(newConfigDisplay);
            // Now try to get it again
            const reQueryConfigDisplay = document.getElementById('configDisplay');
            if (!reQueryConfigDisplay) {
                console.error('Failed to create configDisplay element');
                return; // Exit if we still can't create it
            }
            // Continue with the newly created element
            return displayMCPConfig(); // Recursive call now that element exists
        } else {
            console.error('Cannot create configDisplay: serversView element not found');
            return; // Exit if serversView doesn't exist
        }
    }
    
    configDisplay.innerHTML = ''; // Clear previous display
    const statusDiv = document.getElementById('statusMessages');
    // statusDiv.innerHTML = ''; // Don't clear toasts here

    // Use currentConfig which holds the working state (including enabled flags)
    if (!currentConfig || !currentConfig.mcpServers || Object.keys(currentConfig.mcpServers).length === 0) {
        configDisplay.innerHTML = '<p class="text-gray-500 text-center py-8">No MCP servers configured. Click "Add Server" to get started.</p>';
        updateFloatingButtonsVisibility(); // Ensure buttons are hidden if empty
        return;
    }

    // Get servers from the working copy (currentConfig)
    const servers = currentConfig.mcpServers;
    const filterInput = document.getElementById('filterInput');
    const filterText = filterInput ? filterInput.value.toLowerCase() : '';

    // Separate enabled and disabled servers based on the 'enabled' flag in currentConfig
    const enabledServers = Object.entries(servers)
        .filter(([key, server]) => server.enabled)
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));
    
    const disabledServers = Object.entries(servers)
        .filter(([key, server]) => !server.enabled)
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

    // Combine, putting enabled servers first
    const sortedServers = [...enabledServers, ...disabledServers];

    if (sortedServers.length === 0 && filterText) {
        configDisplay.innerHTML = '<p class="text-gray-500 text-center py-8">No MCP servers match the current filter.</p>';
    } else if (sortedServers.length === 0) {
        // This case should be handled by the initial check, but as a fallback:
        configDisplay.innerHTML = '<p class="text-gray-500 text-center py-8">No MCP servers configured.</p>';
    }

    sortedServers.forEach(([key, serverData]) => {
        // Apply filtering based on key or JSON content
        const serverJsonString = JSON.stringify(_.omit(serverData, 'enabled')).toLowerCase(); // Exclude 'enabled' from filter search
        if (filterText && !key.toLowerCase().includes(filterText) && !serverJsonString.includes(filterText)) {
            return; // Skip if filter doesn't match key or content
        }
        
        const serverElement = createServerElement(key, serverData);
        // Add subtle visual distinction for disabled servers
        if (!serverData.enabled) {
            serverElement.classList.add('opacity-60'); // Example: reduce opacity
            serverElement.classList.add('border-dashed'); 
        }
        configDisplay.appendChild(serverElement);
    });

    // Add event listeners for dynamically created elements 
    configDisplay.querySelectorAll('.remove-server-btn').forEach(button => {
        // Check if listener already exists to prevent duplicates if displayMCPConfig is called often
        if (!button.dataset.listenerAttached) {
             button.addEventListener('click', (event) => {
                const serverKey = event.target.closest('.server-container').dataset.serverKey;
                removeMCPServer(serverKey);
             });
             button.dataset.listenerAttached = 'true';
        }
    });

     configDisplay.querySelectorAll('.server-toggle').forEach(toggle => {
        if (!toggle.dataset.listenerAttached) {
            toggle.addEventListener('change', (event) => {
                const serverKey = event.target.closest('.server-container').dataset.serverKey;
                const isEnabled = event.target.checked;
                toggleServerEnabled(serverKey, isEnabled);
            });
             toggle.dataset.listenerAttached = 'true';
        }
    });
    
    configDisplay.querySelectorAll('.server-title-input').forEach(input => {
        if (!input.dataset.listenerAttached) {
            input.addEventListener('change', handleServerRename); // Use existing handler
            input.dataset.listenerAttached = 'true';
        }
    });
    
    configDisplay.querySelectorAll('.server-content').forEach(textarea => {
         if (!textarea.dataset.listenerAttached) {
            // Use debounced input handler for textareas to avoid excessive checks
             textarea.addEventListener('input', debounce(handleInputChange, 500)); 
             textarea.dataset.listenerAttached = 'true';
         }
     });

    // Initial check for button visibility after display
    // updateFloatingButtonsVisibility(); // Called by functions that modify config
}

function createServerElement(key, serverData) {
     const container = document.createElement('div');
    // Basic classes + add border for structure
    container.classList.add('server-container', 'bg-white', 'dark:bg-gray-700', 'p-4', 'rounded-lg', 'shadow', 'mb-4', 'border', 'border-gray-200', 'dark:border-gray-600');
    container.dataset.serverKey = key;

    // Header with Toggle, Title, and Remove button
    const header = document.createElement('div');
    header.classList.add('flex', 'justify-between', 'items-center', 'mb-3'); // Increased bottom margin

    // Left side: Toggle + Title
    const leftSide = document.createElement('div');
    leftSide.classList.add('flex', 'items-center', 'flex-grow', 'mr-2');

    // Toggle Switch - visually improved
    const toggleLabel = document.createElement('label');
    toggleLabel.classList.add('relative', 'inline-flex', 'items-center', 'cursor-pointer', 'mr-4'); // Added right margin
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = serverData.enabled === true; // Set based on the server's state in currentConfig
    toggleInput.classList.add('sr-only', 'peer', 'server-toggle');
    const toggleDiv = document.createElement('div');
    // Tailwind classes for a standard toggle switch appearance
    toggleDiv.classList.add(
        'w-11', 'h-6', 'bg-gray-200', 'peer-focus:outline-none', 'peer-focus:ring-2', 
        'peer-focus:ring-blue-300', 'dark:peer-focus:ring-blue-800', 'rounded-full', 'peer', 
        'dark:bg-gray-600', 'peer-checked:after:translate-x-full', 'rtl:peer-checked:after:-translate-x-full', 
        'peer-checked:after:border-white', 'after:content-[""]', 'after:absolute', 'after:top-[2px]', 
        'after:start-[2px]', 'after:bg-white', 'after:border-gray-300', 'after:border', 
        'after:rounded-full', 'after:h-5', 'after:w-5', 'after:transition-all', 
        'dark:border-gray-500', 'peer-checked:bg-blue-600'
    );
    toggleLabel.appendChild(toggleInput);
    toggleLabel.appendChild(toggleDiv);
    
    // Server Title (Editable Input)
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = key;
    // Styling for the input field
    titleInput.classList.add(
        'server-title-input', // Add class for event delegation
        'text-lg', 'font-semibold', 'text-gray-900', 'dark:text-white',
        'flex-grow', 'p-1', 'bg-transparent', // Make background transparent initially
        'border-b-2', 'border-transparent', // Bottom border, transparent initially
        'focus:outline-none', 'focus:border-blue-500', // Blue border on focus
        'hover:border-gray-300', 'dark:hover:border-gray-500' // Subtle border on hover
    );
    titleInput.dataset.originalKey = key; // Store original key for renaming logic
    // Listener added in displayMCPConfig using delegation

    leftSide.appendChild(toggleLabel);
    leftSide.appendChild(titleInput);

    // Right side: Remove Button
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    // Consistent button styling
    removeBtn.classList.add(
        'remove-server-btn', 
        'bg-red-600', 'hover:bg-red-700', 'dark:bg-red-700', 'dark:hover:bg-red-800', 
        'text-white', 'font-medium', // Changed font weight
        'py-1', 'px-3', // Adjusted padding
        'rounded-md', // Rounded corners
        'text-sm', 'transition', 'duration-150', 'ease-in-out', 
        'focus:outline-none', 'focus:ring-2', 'focus:ring-red-500', 'focus:ring-offset-2', 'dark:focus:ring-offset-gray-800'
    );
    // Listener added in displayMCPConfig using delegation

    header.appendChild(leftSide);
    header.appendChild(removeBtn);

    // Server Content (Textarea)
    const content = document.createElement('textarea');
    content.classList.add(
        'server-content', 'w-full', 'h-48', 'p-3', // Increased padding and height
        'border', 'border-gray-300', 'dark:border-gray-600',
        'rounded-md', // Rounded corners
        'font-mono', 'text-sm', 
        'bg-gray-50', 'dark:bg-gray-800', 
        'text-gray-900', 'dark:text-gray-200', 
        'focus:outline-none', 'focus:ring-1', 'focus:ring-blue-500', 'focus:border-blue-500' // Focus styling
    );
    // Stringify everything EXCEPT the 'enabled' flag for the editor
    content.value = JSON.stringify(_.omit(serverData, 'enabled'), null, 2);
    content.dataset.serverKey = key; // Link content to the server key
    // Listener added in displayMCPConfig using delegation

    container.appendChild(header);
    container.appendChild(content);

    return container;
}

// Handle server renaming
function handleServerRename(event) {
    const newKey = event.target.value.trim();
    const originalKey = event.target.dataset.originalKey;
    const serverContainer = event.target.closest('.server-container');
    // const contentTextarea = serverContainer.querySelector('.server-content');

    if (!newKey || newKey === originalKey) {
        event.target.value = originalKey; // Revert if empty or unchanged
        return;
    }

    // Check for conflicts in the working configuration
    if (currentConfig.mcpServers[newKey]) {
        showToast(`Server name "${newKey}" already exists. Please choose a different name.`, 'error');
        event.target.value = originalKey; // Revert
        return;
    }

    // Update the key in the currentConfig
    // Make sure to preserve the entire server object, including 'enabled' status
    const serverData = _.cloneDeep(currentConfig.mcpServers[originalKey]);
    currentConfig.mcpServers[newKey] = serverData;
    delete currentConfig.mcpServers[originalKey];

    // Update dataset attributes on the relevant elements
    serverContainer.dataset.serverKey = newKey;
    event.target.dataset.originalKey = newKey; // Update original key reference for the input itself
    // Find other elements within this container that need their key updated
    serverContainer.querySelectorAll(`[data-server-key="${originalKey}"]`).forEach(el => {
        if (el !== event.target) { // Don't re-update the input that triggered the event
             el.dataset.serverKey = newKey;
        }
    });
    
    console.log(`Server renamed locally from "${originalKey}" to "${newKey}"`);
    showToast(`Server renamed to "${newKey}". Save changes to make permanent.`, 'info');
    checkForChanges(); // Check if changes were made
}


// Handle input changes in textareas
function handleInputChange(event) {
    if (event.target.classList.contains('server-content')) {
        const serverKey = event.target.dataset.serverKey;
        if (!currentConfig.mcpServers[serverKey]) {
            console.error(`Attempting to edit content for non-existent server key: ${serverKey}`);
            showToast(`Error: Server data for ${serverKey} not found.`, 'error');
            return;
        }

        try {
            const updatedData = JSON.parse(event.target.value);
            // Preserve the existing enabled status from currentConfig
            const wasEnabled = currentConfig.mcpServers[serverKey]?.enabled || false;
            // Update the server data, merging new content with the existing enabled status
            currentConfig.mcpServers[serverKey] = { ...updatedData, enabled: wasEnabled };
            // console.log(`Updated data for server: ${serverKey}`);
            checkForChanges(); // Check if this change resulted in a difference from initial state
        } catch (error) {
            // Provide feedback but don't necessarily revert the text immediately
            showToast(`Invalid JSON format for server ${serverKey}. Please correct the syntax.`, 'error');
            // Optionally add a visual indicator to the textarea
            event.target.classList.add('border-red-500'); 
        }
    } else if (event.target.classList.contains('server-title-input')) {
        // Title changes are handled by handleServerRename on 'change' event
    }
}

// Toggle server enabled state in currentConfig
function toggleServerEnabled(serverKey, isEnabled) {
    console.log(`Toggling server ${serverKey} to ${isEnabled ? 'enabled' : 'disabled'}`);
    if (currentConfig.mcpServers && currentConfig.mcpServers[serverKey]) {
        currentConfig.mcpServers[serverKey].enabled = isEnabled;
        
        // Also update allServersConfig to keep everything in sync
        if (allServersConfig.mcpServers && allServersConfig.mcpServers[serverKey]) {
            allServersConfig.mcpServers[serverKey].enabled = isEnabled;
        }
        
        // Check for changes and update UI state
        checkForChanges();
        
        // If we're toggling a server in client-specific mode, update the mcpServers object
        if (currentLoadedClientId) {
            if (mcpServers[serverKey]) {
                mcpServers[serverKey].enabled = isEnabled;
            }
        }
        
        // Re-render the servers display to reflect the new state
        displayMCPConfig();
        
        // Also update the renderServers view if it's being used
        renderServers();
    } else {
        console.error(`Server ${serverKey} not found in current configuration`);
    }
}

// Add a new MCP server to currentConfig
function addMCPServer() {
    // Ensure mcpServers object exists
    if (!currentConfig.mcpServers) {
        currentConfig.mcpServers = {};
    }
    
    // Find a unique default key
    let i = 1;
    let newServerKey = `newServer${i}`;
    while (currentConfig.mcpServers[newServerKey]) {
        i++;
        newServerKey = `newServer${i}`;
    }

    currentConfig.mcpServers[newServerKey] = { 
        enabled: true, // New servers start enabled
        description: "New Server",
        server_type: "generic",
        config: {
            port: 8080,
            api_key: "YOUR_API_KEY",
            base_url: "http://localhost"
        },
        environment: {},
        status: "unknown",
        last_checked: null,
        url: "http://localhost:8080", 
        // Do NOT include the enabled flag within the editable JSON structure
    };
    console.log(`Added server ${newServerKey} locally`);
    showToast(`Server "${newServerKey}" added. Edit details and save changes.`, 'success');
    displayMCPConfig(); // Re-render the list with the new server
    checkForChanges(); // Check for changes (adding always causes changes)

    // Scroll to the new server and focus its title input
    const newServerElement = document.querySelector(`.server-container[data-server-key="${newServerKey}"]`);
    if (newServerElement) {
        newServerElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const titleInput = newServerElement.querySelector('.server-title-input');
        if (titleInput) {
            titleInput.focus();
            titleInput.select();
        }
    }
}

// Remove an MCP server from currentConfig
function removeMCPServer(serverKey) {
    if (currentConfig.mcpServers && currentConfig.mcpServers[serverKey]) {
        // Confirm before removing (optional, but good UX for deletion)
        // if (!confirm(`Are you sure you want to remove the server "${serverKey}"? This cannot be undone easily after saving.`)) {
        //     return;
        // }
        
        delete currentConfig.mcpServers[serverKey];
        console.log(`Removed server ${serverKey} locally`);
        showToast(`Server "${serverKey}" removed locally. Save changes to make permanent.`, 'success');
        displayMCPConfig(); // Re-render the list
        checkForChanges(); // Check if removal caused changes from initial state
    } else {
        showToast(`Error: Cannot remove server "${serverKey}", it was not found.`, 'error');
        console.error(`Attempted to remove non-existent server: ${serverKey}`);
    }
}
