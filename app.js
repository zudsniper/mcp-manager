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
let isServersMode = true; // Default to server configuration mode
let jsonEditor = null; // Monaco editor instance
let currentEditorTab = 'form'; // Current tab in the server config modal
let hasModalChanges = false; // Track unsaved changes in the server config modal
let isShiftPressed = false; // Track if shift key is pressed
let modalOriginalConfig = {}; // Track the config state when the modal was opened
let syncCandidate = null; // Track the first client selected for potential sync

// API endpoints
const API = {
    CONFIG: '/api/config', // Gets main or client-specific based on query param and sync setting
    CLIENTS: '/api/clients',
    SAVE_CONFIGS: '/api/save-configs',
    SETTINGS: '/api/settings',
    SETTINGS_SAVE: '/api/settings',
    CHECK_CONFIGS: '/api/check-configs', // Checks for diffs between *original* client files (only relevant in sync mode)
    RESET_CONFIG: '/api/reset-config', // Endpoint for resetting
    PRESETS: '/api/presets',
    SYNC_GROUP: '/api/sync-groups' // POST to create/update group
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
            updateConfigModeIndicator(); // Update mode indicator
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
        updateConfigModeIndicator(); // Update mode indicator
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
            updateConfigModeIndicator(); // Update mode indicator

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
        updateConfigModeIndicator(); // Update mode indicator
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

// Function to render environment variables for server cards
function renderEnvironmentVars(env) {
    if (!env || Object.keys(env).length === 0) {
        return '';
    }

    // Function to check if a key is for sensitive data
    function isSensitiveEnvVar(key) {
        const lowerKey = key.toLowerCase();
        return lowerKey.includes('key') || lowerKey.includes('token') || lowerKey.includes('secret');
    }

    // Function to mask value
    function maskValue(value) {
        return '********'; // Always mask initially
    }

    return Object.entries(env).map(([key, value]) => {
        const isSensitive = isSensitiveEnvVar(key);
        // Use data attribute to store the real value for reveal/copy
        return `
            <div class="env-var-pair" data-key="${key}" data-value="${value}" data-sensitive="${isSensitive}" title="${isSensitive ? 'Hover to reveal, SHIFT + Click to copy' : ''}">
                <span class="env-key">${key}:</span>
                <span class="env-value" data-value="${value}">${isSensitive ? maskValue(value) : value}</span>
                <span class="copy-feedback" style="display: none;">Copied!</span>
            </div>
        `;
    }).join('');
}

// Function to render the list of servers
function renderServers() {
    const serversView = document.getElementById('serversView');
    
    // Clear existing content first
    serversView.innerHTML = '';
    
    // Container for server cards
    const grid = document.createElement('div');
    grid.className = 'grid'; // Changed from 'servers-grid' to match styles.css

    // Get server names and sort them alphabetically
    const serverNames = Object.keys(mcpServers);
    const sortedServerNames = serverNames.filter(name => !name.startsWith('_')).sort();
    
    if (sortedServerNames.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'empty-state';
        emptyState.innerHTML = `
            <p>No server configurations found</p>
            <button class="add-server-button" onclick="openServerConfig('new')">+ Add Server</button>
        `;
        serversView.appendChild(emptyState);
        return;
    }

    sortedServerNames.forEach(serverName => {
        const serverData = mcpServers[serverName];
        const card = document.createElement('div');
        card.className = 'server-card';
        card.dataset.serverKey = serverName;

        // Determine source text for conflicting servers
        let sourceText = '';
        if (isServersMode && serverData._conflicts && serverData._sources) {
            sourceText = `<div class="server-source">(${serverData._sources.join(', ')})</div>`;
        } else if (isServersMode && serverData._sources && serverData._sources.length === 1) {
            // Optionally show single source if needed, or leave blank
             // sourceText = `<div class="server-source">(${serverData._sources[0]})</div>`;
        }
        
        // Build full command string with args
        let fullCommand = serverData.command || 'Not set';
        if (serverData.args && serverData.args.length > 0) {
            fullCommand += ' ' + serverData.args.join(' ');
        }
        
        // Truncate command if too long
        const maxCommandLength = 50; // Maximum characters before truncation
        let displayCommand = fullCommand;
        if (fullCommand.length > maxCommandLength) {
            displayCommand = fullCommand.substring(0, maxCommandLength) + '...';
        }

        // Create the server actions based on mode
        let serverActions = '';
        if (isServersMode) {
            // In Server Configuration mode, show edit/delete buttons
            serverActions = `
                <div class="server-actions">
                    <button class="icon-button edit-button" title="Edit Server" onclick="openServerConfig('${serverName}')">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="icon-button delete-button" title="Delete Server" onclick="confirmDeleteServer('${serverName}')">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `;
        } else {
            // In Client mode, show toggle switch
            const isEnabled = serverData.enabled ? 'checked' : '';
            serverActions = `
                <div class="server-actions">
                    <label class="toggle-switch" title="Enable/Disable Server">
                        <input type="checkbox" ${isEnabled} onchange="toggleServerEnabled('${serverName}', this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="server-header">
                <div>
                    <span class="server-name">${serverName}</span>
                    ${sourceText}
                </div>
                ${serverActions}
            </div>
            <div class="server-path" title="${fullCommand}">Command: ${displayCommand}</div>
            <div class="env-vars">
                <h4>Environment Variables</h4>
                ${renderEnvironmentVars(serverData.env)}
            </div>
        `;
        grid.appendChild(card);
    });

    serversView.appendChild(grid);
    
    // Add the "Add Server" button at the bottom if in Servers Mode
    if (isServersMode) {
        const addButton = document.createElement('button');
        addButton.className = 'add-server-button';
        addButton.textContent = '+ Add Server';
        addButton.onclick = () => openServerConfig('new');
        serversView.appendChild(addButton);
    }

    // Re-apply event listeners for hover/copy after re-rendering
    setupEnvVarInteraction();
}

// Function to confirm server deletion
function confirmDeleteServer(serverName) {
    // Create or reuse a confirmation modal
    let modal = document.getElementById('deleteServerModal');
    if (!modal) {
        // Create modal if it doesn't exist
        modal = document.createElement('div');
        modal.id = 'deleteServerModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <span class="close-button" onclick="closeModal('deleteServerModal')">&times;</span>
                <h2>Confirm Delete</h2>
                <p>Are you sure you want to delete the server "<span id="deleteServerName"></span>"?</p>
                <p class="warning-text">This cannot be undone!</p>
                <div class="modal-buttons">
                    <button onclick="closeModal('deleteServerModal')">Cancel</button>
                    <button id="confirmDeleteBtn" class="delete-button">Delete</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    
    // Set the server name in the modal
    document.getElementById('deleteServerName').textContent = serverName;
    
    // Setup the delete confirmation button
    const deleteBtn = document.getElementById('confirmDeleteBtn');
    // Remove previous event listeners to prevent multiple bindings
    const newDeleteBtn = deleteBtn.cloneNode(true);
    deleteBtn.parentNode.replaceChild(newDeleteBtn, deleteBtn);
    newDeleteBtn.addEventListener('click', () => {
        deleteServer(serverName);
        closeModal('deleteServerModal');
    });
    
    // Show the modal
    modal.style.display = 'block';
}

// Function to delete a server
function deleteServer(serverName) {
    if (!serverName || !mcpServers[serverName]) {
        showWarning('Server not found');
        return;
    }
    
    // Delete the server from the configuration
    delete mcpServers[serverName];
    
    // Update UI
    renderServers();
    
    // Mark as changed
    configChanged();
    
    // Show success notification
    showToast(`Server "${serverName}" deleted. Click Save Changes to persist.`, 'success');
}

// Function to show/hide the view
function showView(view, clickedTab) {
    console.log('Switching view to:', view);
    
    // Update tabs
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    if (clickedTab) {
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
        targetView.style.display = 'block';
    } else {
        console.warn(`View ${view} not found`);
    }
    
    // Update top add server button visibility - only show in servers view AND in serversMode
    const topAddButton = document.getElementById('topAddServerButton');
    if (topAddButton) {
        topAddButton.style.display = (view === 'servers' && isServersMode) ? 'flex' : 'none';
    }
    
    // Special case for servers view - update based on mode
    if (view === 'servers' && isServersMode) {
        // We're showing the server config in servers mode
        document.getElementById('serversOption').classList.add('active');
        document.querySelectorAll('.client-item').forEach(item => {
            item.classList.remove('active');
        });
        
        // Re-render servers to ensure correct button visibility
        renderServers();
    } else if (view === 'servers' && !isServersMode) {
        // Re-render servers to hide add buttons in client mode
        renderServers();
    } else if (view !== 'servers') {
        // For other views, we can leave the selection as is
    }
    
    // Refresh content if needed
    if (view === 'tools') {
        renderTools();
    }
    if (view === 'backups') {
        renderBackups();
    }
}

// Function to open a modal
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'block';
        
        // Add click event listener to close modal when clicking outside
        modal.addEventListener('click', function(event) {
            // If the click is directly on the modal background (not on modal content)
            if (event.target === modal) {
                closeModal(modalId);
            }
        });
    }
}

// Function to close a modal
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    
    // If trying to close the server config modal with unsaved changes
    if (modalId === 'serverConfigModal' && hasModalChanges) {
        // Create shake animation
        modal.querySelector('.modal-content').classList.add('shake-animation');
        
        // Show warning
        showWarning('Please save or reset your changes before closing');
            
        // Remove shake class after animation completes
        setTimeout(() => {
            const content = modal.querySelector('.modal-content');
            if (content) content.classList.remove('shake-animation');
        }, 500);
        
        return; // Don't close the modal
    }
    
    // For all other modals or when no unsaved changes
    modal.style.display = 'none';
    
    // Reset modal state if it's the server config modal
    if (modalId === 'serverConfigModal') {
        hasModalChanges = false;
    }
    
    // Clean up event listeners (note: this doesn't actually work as written due to anonymous function)
    // A better approach would be to use named functions or store references
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

// Improved loadPresetsList with better error handling
async function loadPresetsList() {
    console.log('Loading presets list...');
    try {
        // Add a timestamp to prevent caching
        const timestamp = new Date().getTime();
        const response = await fetchWithTimeout(`${API.PRESETS}?_=${timestamp}`);
        
        if (response && typeof response === 'object') {
            presets = response;
            updatePresetSelector();
        } else {
            console.warn('Received invalid presets data:', response);
            presets = {}; // Set empty object as fallback
            updatePresetSelector();
        }
    } catch (error) {
        console.error('Failed to load presets list:', error);
        // Continue with empty presets rather than blocking the app
        presets = {};
        updatePresetSelector();
        
        // Show warning to user but don't block the app flow
        showWarning(`Error loading presets: ${error.message}`);
    }
}

// Add a helper function to update the preset selector
function updatePresetSelector() {
    const selector = document.getElementById('presetSelector');
    if (!selector) return;
    
    // Clear existing options
    selector.innerHTML = '';
    
    // Add empty option
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = Object.keys(presets).length > 0 ? '-- Select a preset --' : '-- No presets available --';
    selector.appendChild(emptyOption);
    
    // Add options for each preset
    Object.keys(presets).forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        selector.appendChild(option);
    });
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
    
    // Check if preset exists in the presets object first
    if (!presets[presetName]) {
        console.error(`Preset '${presetName}' does not exist in the loaded presets list`);
        showWarning(`Cannot load preset '${presetName}': Preset not found`);
        
        // Reset the dropdown to blank option
        const presetSelector = document.getElementById('presetSelector');
        if (presetSelector) presetSelector.value = '';
        
        currentPreset = null;
        originalPresetConfig = {};
        updatePresetButtons(false);
        return;
    }
    
    console.log(`Loading preset: ${presetName}`);
    try {
        const response = await fetchWithTimeout(`${API.PRESETS}/${encodeURIComponent(presetName)}`);
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
        showWarning(`Failed to load preset '${presetName}': ${error.message}`);
        
        // Reset the dropdown to blank option
        const presetSelector = document.getElementById('presetSelector');
        if (presetSelector) presetSelector.value = '';
        
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
        const response = await fetchWithTimeout(API.PRESETS, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                name: newPresetName,
                mcpServers 
            })
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
        const response = await fetchWithTimeout(`${API.PRESETS}/${encodeURIComponent(currentPreset)}`, {
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
        const response = await fetchWithTimeout(`${API.PRESETS}/${encodeURIComponent(currentPreset)}`, {
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
function renderClientSidebar(activeClientId = null) {
    console.log('Rendering client sidebar with active client:', activeClientId);
    
    const clientList = document.getElementById('clientList');
    if (!clientList) return;
    
    clientList.innerHTML = '';
    
    // Servers option is handled separately in HTML
    
    // Render each client
    Object.entries(clientSettings.clients || {}).forEach(([clientId, client]) => {
        const clientItem = document.createElement('div');
        clientItem.className = 'client-item';
        clientItem.dataset.clientId = clientId;
        clientItem.dataset.builtIn = 'true'; // All clients are built-in for now
        
        // Add active class if this is the active client and we're not in servers mode
        if (activeClientId === clientId && !isServersMode) {
            clientItem.classList.add('active');
        }
        
        // Create client name span
        const nameSpan = document.createElement('span');
        nameSpan.className = 'client-name';
        nameSpan.textContent = client.name || clientId;
        clientItem.appendChild(nameSpan);
        
        // Add click event
        clientItem.addEventListener('click', function() {
            selectClient(clientId, this);
        });
        
        clientList.appendChild(clientItem);
    });
    
    // Update the servers option active state
    const serversOption = document.getElementById('serversOption');
    if (serversOption) {
        serversOption.classList.toggle('active', isServersMode);
    }
}

// Handle client selection in the sidebar
async function selectClient(clientId, element) {
    console.log(`Selecting client: ${clientId}`);
    isServersMode = false; // We're now in client mode
    
    // Deactivate servers option
    document.getElementById('serversOption').classList.remove('active');
    
    // Update client items
    document.querySelectorAll('.client-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Activate the clicked client
    if (element) {
        element.classList.add('active');
    } else {
        // Try to find and activate by ID if element not provided
        const clientElement = document.querySelector(`.client-item[data-client-id="${clientId}"]`);
        if (clientElement) {
            clientElement.classList.add('active');
        }
    }
    
    selectedClientId = clientId;
    
    // Load the client-specific configuration
    await loadConfigForClient(clientId);
    
    // Ensure we're showing the servers view
    showView('servers');
}

// Simplified toggleClientSync - just updates setting and saves
async function toggleClientSync() {
    const syncToggle = document.getElementById('syncClientsToggle');
    clientSettings.syncClients = syncToggle.checked;
    
    await saveAppSettings();
    
    // When toggling sync ON/OFF, reload the configuration
    if (isServersMode || !selectedClientId) {
        await loadMainConfig(); // Always load main config in servers mode
    } else {
        await loadConfigForClient(selectedClientId);
    }
    
    showToast(`Client sync mode ${clientSettings.syncClients ? 'enabled' : 'disabled'}`);
}

// --- SERVER CONFIGURATION EDITOR ---

// Current server being edited
let currentServerName = null;

// Opens the server configuration editor modal
function openServerConfig(serverKey) {
    const modal = document.getElementById('serverConfigModal');
    const form = document.getElementById('serverConfigForm');
    const serverNameInput = document.getElementById('serverName');
    initMonacoEditor(); // Ensure editor is ready
    
    let serverData = {};
    if (serverKey === 'new') {
        // Provide a default structure for a new server
        serverNameInput.value = `newServer${Date.now()}`;
        serverNameInput.readOnly = false; // Allow editing name for new server
        serverData = {
            command: '', 
            args: [], 
            env: {},
            sseUrl: '',
            enableInspector: false,
            inspectorPort: 7860
        }; 
        document.getElementById('serverConfigForm').reset(); // Clear form
        document.getElementById('serverArgs').innerHTML = ''; // Clear dynamic fields
        document.getElementById('serverEnv').innerHTML = '';
        document.getElementById('serverType').value = 'subprocess';
        document.getElementById('sseUrlContainer').style.display = 'none';
        document.getElementById('enableInspector').checked = false;
        document.getElementById('inspectorOptionsContainer').style.display = 'none';
        if(jsonEditor) jsonEditor.setValue(''); // Clear JSON editor
    } else {
        serverNameInput.value = serverKey;
        serverNameInput.readOnly = true; // Cannot rename existing server via modal
        // Deep clone the specific server config to edit
        serverData = _.cloneDeep(mcpServers[serverKey] || {});
        populateServerForm(serverData);
    }

    // Store the initial state of the config being edited in the modal
    modalOriginalConfig = _.cloneDeep(serverData);
    hasModalChanges = false; // Reset change tracking
    updateModalButtons(); // Show/hide buttons based on initial state (should be hidden)
    
    // Attach listeners for change detection within the modal
    setupModalChangeListeners();

    modal.style.display = 'block';
    switchEditorTab('form'); // Default to form view
}

// Populate the form with server data
function populateServerForm(serverData) {
    document.getElementById('serverCommand').value = serverData.command || '';
    
    // Populate args
    const argsContainer = document.getElementById('serverArgs');
    argsContainer.innerHTML = '';
    if (serverData.args && Array.isArray(serverData.args)) {
        serverData.args.forEach(arg => addServerArg(arg));
    }
    
    // Populate env vars
    const envContainer = document.getElementById('serverEnv');
    envContainer.innerHTML = '';
    if (serverData.env && typeof serverData.env === 'object') {
        Object.entries(serverData.env).forEach(([key, value]) => addServerEnv(key, value));
    }

    // Populate connection type
    const serverType = serverData.sseUrl ? 'sse' : 'subprocess';
    document.getElementById('serverType').value = serverType;
    document.getElementById('sseUrlContainer').style.display = serverType === 'sse' ? 'block' : 'none';
    if (serverData.sseUrl) {
        document.getElementById('sseUrl').value = serverData.sseUrl;
    }

    // Populate inspector settings
    document.getElementById('enableInspector').checked = !!serverData.enableInspector;
    document.getElementById('inspectorOptionsContainer').style.display = serverData.enableInspector ? 'block' : 'none';
    if (serverData.inspectorPort) {
        document.getElementById('inspectorPort').value = serverData.inspectorPort;
    }

    // Update JSON editor if it exists
    if (jsonEditor) {
        jsonEditor.setValue(JSON.stringify(serverData, null, 2));
    }
}

// Setup listeners for input changes within the modal
function setupModalChangeListeners() {
    const form = document.getElementById('serverConfigForm');
    // Remove previous listeners to avoid duplicates
    form.removeEventListener('input', modalContentChanged);
    form.removeEventListener('change', modalContentChanged); // For checkboxes/selects
    if (jsonEditor) {
         // Assuming monaco editor has a change listener mechanism
         jsonEditor.getModel()?.onDidChangeContent(modalContentChanged);
    }

    // Add new listeners
    form.addEventListener('input', modalContentChanged);
    form.addEventListener('change', modalContentChanged);
     if (jsonEditor) {
         jsonEditor.getModel()?.onDidChangeContent(modalContentChanged);
    }
}

// Function called when modal content might have changed
function modalContentChanged() {
    // Get current state from the active editor tab
    let currentModalState = {};
    if (currentEditorTab === 'form') {
        currentModalState = getCurrentFormState();
    } else if (jsonEditor) {
        try {
            currentModalState = JSON.parse(jsonEditor.getValue());
        } catch (e) {
            // Invalid JSON, consider it changed or handle differently
            hasModalChanges = true;
            updateModalButtons();
            return;
        }
    }

    // Compare current state with the state when the modal was opened
    hasModalChanges = !_.isEqual(currentModalState, modalOriginalConfig);
    updateModalButtons();
}

// Helper to get the current state from the form
function getCurrentFormState() {
    const config = {
        command: document.getElementById('serverCommand').value || '',
        args: [],
        env: {}
    };
    document.querySelectorAll('#serverArgs .arg-item input').forEach(input => {
        if (input.value.trim()) config.args.push(input.value.trim());
    });
    document.querySelectorAll('#serverEnv .env-item').forEach(item => {
        const keyInput = item.querySelector('.env-key-input');
        const valueInput = item.querySelector('.env-value-input');
        if (keyInput && valueInput && keyInput.value.trim()) {
            config.env[keyInput.value.trim()] = valueInput.value;
        }
    });
    const serverType = document.getElementById('serverType').value;
    if (serverType === 'sse') {
        config.sseUrl = document.getElementById('sseUrl').value || '';
    }
    if (document.getElementById('enableInspector').checked) {
        config.enableInspector = true;
        config.inspectorPort = parseInt(document.getElementById('inspectorPort').value) || 7860;
    }
    return config;
}

// Update visibility of Save/Reset buttons inside the modal
function updateModalButtons() {
    const resetButton = document.getElementById('serverConfigModal').querySelector('.reset-button');
    // Save button is always visible, but could be disabled
    // const saveButton = document.getElementById('serverConfigModal').querySelector('.save-button'); 

    if (resetButton) {
        resetButton.style.display = hasModalChanges ? 'inline-block' : 'none';
    }
    // If you want to disable the save button when no changes:
    // if (saveButton) { saveButton.disabled = !hasModalChanges; }
}

// Close any modal
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        if (modalId === 'serverConfigModal' && hasModalChanges) {
            // Shake animation and warning (already handled by click outside listener, but good to have here too)
            const modalContent = modal.querySelector('.modal-content');
            modalContent.classList.add('shake-animation');
            showWarning("You have unsaved changes. Please save or reset.");
            setTimeout(() => modalContent.classList.remove('shake-animation'), 500);
            return; // Don't close if changes exist
        }
        modal.style.display = 'none';
        // Clean up modal-specific state if needed
        if (modalId === 'serverConfigModal') {
             modalOriginalConfig = {}; // Clear original config
             hasModalChanges = false;
        }
    }
}

// Save the server configuration from the modal
function saveServerConfig() {
    const serverName = document.getElementById('serverName').value;
    if (!serverName) {
        showWarning('Server name cannot be empty');
        return;
    }
    
    let configData = {};
    try {
        if (currentEditorTab === 'form') {
             configData = getCurrentFormState();
        } else if (jsonEditor) {
            configData = JSON.parse(jsonEditor.getValue());
        }
    } catch (e) {
        showWarning('Cannot save: Invalid JSON format. ' + e.message);
        return;
    }

    console.log(`Saving config for server: ${serverName}`, configData);

    // Update the main mcpServers object
    if (!mcpServers[serverName]) { // It's a new server
        // Make sure the name isn't already taken (case-insensitive check maybe?)
        if (Object.keys(mcpServers).some(key => key.toLowerCase() === serverName.toLowerCase())) {
            showWarning(`Server name "${serverName}" already exists. Choose a unique name.`);
            return;
        }
    }
    mcpServers[serverName] = configData;
    
    // Trigger global change detection
    configChanged(); 
    
    renderServers(); // Re-render the server list
    closeModal('serverConfigModal');
    showToast(`Configuration for ${serverName} updated locally. Click Save Changes to persist.`, 'success');
}

// Reset the server configuration in the modal to its original state
function resetServerConfig() {
    console.log('Resetting modal content to original');
    populateServerForm(modalOriginalConfig); // Repopulate form and JSON editor
    hasModalChanges = false;
    updateModalButtons();
}

// Function to add a new argument row to the form
function addServerArg(value = '') {
    const container = document.getElementById('serverArgs');
    const row = document.createElement('div');
    row.className = 'arg-item';
    
    row.innerHTML = `
        <input type="text" value="${value}" placeholder="Argument value" onchange="modalContentChanged()">
        <button type="button" class="remove-button" onclick="removeElement(this.parentNode)">&times;</button>
    `;
    
    container.appendChild(row);
}

// Add a new environment variable input row
function addServerEnv(key = '', value = '') {
    const container = document.getElementById('serverEnv');
    const row = document.createElement('div');
    row.className = 'env-item';
    
    row.innerHTML = `
        <input type="text" class="env-key-input" value="${key}" placeholder="KEY" onchange="modalContentChanged()">
        <input type="text" class="env-value-input" value="${value}" placeholder="Value" onchange="modalContentChanged()">
        <button type="button" class="remove-button" onclick="removeElement(this.parentNode)">&times;</button>
    `;
    
    container.appendChild(row);
}

// Remove an element from the DOM and track changes
function removeElement(element) {
    if (element && element.parentNode) {
        element.parentNode.removeChild(element);
        modalContentChanged();
    }
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
    console.log("Initializing MCP Server Manager...");

    // Setup event listeners for tabs
    document.querySelectorAll('.tabs .tab').forEach(tab => {
        // Only add listener if not disabled
        if (!tab.classList.contains('disabled')) {
            tab.addEventListener('click', () => {
                showView(tab.textContent.toLowerCase().trim(), tab);
            });
        }
    });

    // Load initial data
    await loadAppSettings(); // Load settings first
    renderClientSidebar(); // Render sidebar based on loaded settings
    
    // Explicitly select servers mode on startup
    selectServersMode();
    
    // Load presets
    await loadPresetsList();

    // Setup listeners for save/reset buttons
    document.getElementById('saveChangesBtn').addEventListener('click', saveChanges);
    document.getElementById('resetChangesBtn').addEventListener('click', resetConfiguration);

    // Setup listeners for modal interactions (close button, save, reset)
    document.getElementById('serverConfigModal').querySelector('.close-button').addEventListener('click', () => closeModal('serverConfigModal'));
    
    // Setup hover/click listeners for env vars
    setupEnvVarInteraction();

    console.log("MCP Server Manager Initialized.");
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

// Function to handle shift keydown globally
document.addEventListener('keydown', (event) => {
    if (event.key === 'Shift') {
        isShiftPressed = true;
        document.body.classList.add('shift-pressed');
        // Rerender servers to show keys if needed, or just rely on CSS
        // Could optimize by only updating env var visibility
    }
});

// Function to handle shift keyup globally
document.addEventListener('keyup', (event) => {
    if (event.key === 'Shift') {
        isShiftPressed = false;
        document.body.classList.remove('shift-pressed');
        // Rerender or update visibility
    }
});

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
window.openClientModal = openClientModal;

// Export server config functions
window.openServerConfig = openServerConfig;
window.addServerArg = addServerArg;
window.addServerEnv = addServerEnv;
window.removeElement = removeElement;
window.saveServerConfig = saveServerConfig;
window.confirmDeleteServer = confirmDeleteServer;
window.deleteServer = deleteServer;

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
        
        // Check if the config is empty and we need to auto-populate from clients
        if (!combinedServerState || !combinedServerState.mcpServers || Object.keys(combinedServerState.mcpServers).length === 0) {
            console.log("Empty configuration detected, attempting to auto-populate from clients...");
            showToast("Empty configuration detected, automatically populating from available clients...", "info");
            
            // Auto-populate from clients
            await aggregateClientConfigs();
            
            // After aggregation, try to fetch the updated config
            const refreshResponse = await fetch(url);
            if (refreshResponse.ok) {
                const refreshedText = await refreshResponse.text();
                try {
                    combinedServerState = JSON.parse(refreshedText);
                    console.log("Successfully loaded aggregated configuration from clients");
                } catch (parseError) {
                    console.error("Failed to parse refreshed config:", parseError);
                }
            }
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

// New function to aggregate configurations from all available clients
async function aggregateClientConfigs() {
    try {
        // First, get the list of clients
        const clientsResponse = await fetch(API.CLIENTS);
        if (!clientsResponse.ok) {
            throw new Error(`Failed to fetch clients: ${clientsResponse.statusText}`);
        }
        
        const clientsData = await clientsResponse.json();
        const availableClients = clientsData?.clients || {};
        
        // Prepare an aggregated config object
        const aggregatedConfig = { mcpServers: {} };
        
        // For each enabled client, try to fetch its configuration
        const clientFetchPromises = Object.entries(availableClients)
            .filter(([_, client]) => client.enabled && client.configPath)
            .map(async ([clientId, client]) => {
                try {
                    console.log(`Fetching config for client: ${client.name} (${clientId})`);
                    const clientConfigUrl = `${API.CONFIG}?clientId=${clientId}`;
                    const response = await fetch(clientConfigUrl);
                    
                    if (!response.ok) {
                        console.warn(`Failed to fetch config for client ${client.name}: ${response.statusText}`);
                        return null;
                    }
                    
                    const clientConfig = await response.json();
                    
                    // If client has MCP servers configured, add them to the aggregated config
                    if (clientConfig && clientConfig.mcpServers) {
                        Object.entries(clientConfig.mcpServers).forEach(([serverKey, serverData]) => {
                            // If server already exists in aggregatedConfig, merge but don't overwrite
                            if (!aggregatedConfig.mcpServers[serverKey]) {
                                aggregatedConfig.mcpServers[serverKey] = {
                                    ...serverData,
                                    enabled: true,
                                    _sources: [clientId]
                                };
                            } else {
                                // Track that multiple clients have this server
                                if (!aggregatedConfig.mcpServers[serverKey]._sources) {
                                    aggregatedConfig.mcpServers[serverKey]._sources = [clientId];
                                } else if (!aggregatedConfig.mcpServers[serverKey]._sources.includes(clientId)) {
                                    aggregatedConfig.mcpServers[serverKey]._sources.push(clientId);
                                }
                                
                                // Mark conflicts if data differs
                                if (!_.isEqual(_.omit(aggregatedConfig.mcpServers[serverKey], ['enabled', '_sources']), 
                                              _.omit(serverData, ['enabled']))) {
                                    aggregatedConfig.mcpServers[serverKey]._conflicts = true;
                                }
                            }
                        });
                    }
                    return clientId;
                } catch (error) {
                    console.error(`Error fetching config for client ${client.name}:`, error);
                    return null;
                }
            });
        
        // Wait for all client config fetches to complete
        await Promise.all(clientFetchPromises);
        
        // If we found any configurations, save them to the server
        if (Object.keys(aggregatedConfig.mcpServers).length > 0) {
            console.log("Saving aggregated configuration:", aggregatedConfig);
            
            const saveResponse = await fetch(API.SAVE_CONFIGS, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    clients: [],  // Save to main config only
                    config: aggregatedConfig
                })
            });
            
            if (!saveResponse.ok) {
                throw new Error(`Failed to save aggregated config: ${saveResponse.statusText}`);
            }
            
            console.log("Successfully saved aggregated configuration from clients");
            return true;
        } else {
            console.log("No MCP server configurations found from any clients");
            return false;
        }
    } catch (error) {
        console.error("Error aggregating client configurations:", error);
        showToast(`Failed to aggregate client configurations: ${error.message}`, "error");
        return false;
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

// Global variables for Monaco Editor (moved to the top of the file)
// let jsonEditor = null;
// let currentEditorTab = 'form';

// Update the configuration mode indicator based on the current state
function updateConfigModeIndicator() {
    const badge = document.getElementById('modeBadge');
    const modeText = document.getElementById('currentConfigMode');
    const description = document.getElementById('configModeDescription');
    const backButton = document.getElementById('backToServerEditor');
    
    if (clientSettings.syncClients) {
        // Global mode (sync ON)
        badge.textContent = 'Global';
        badge.className = 'mode-badge global';
        modeText.textContent = 'Global Configuration';
        description.textContent = 'Changes will affect all enabled clients';
        backButton.style.display = 'none'; // No back button in global mode
    } else if (currentLoadedClientId) {
        // Client-specific mode
        const clientName = clientSettings.clients[currentLoadedClientId]?.name || currentLoadedClientId;
        badge.textContent = clientName;
        badge.className = 'mode-badge client';
        modeText.textContent = `Client: ${clientName}`;
        description.textContent = 'Editing configuration specifically for this client';
        backButton.style.display = 'inline-block'; // Show back button in client mode
    } else {
        // Fallback for any other state
        badge.textContent = 'Unknown';
        badge.className = 'mode-badge';
        modeText.textContent = 'Unknown';
        description.textContent = 'Select a client from the sidebar or enable sync mode';
        backButton.style.display = 'none';
    }
}

// Return to the server editor from any other view
function returnToServerEditor() {
    showView('servers');
    // Make sure we're showing the server editor, not another view
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelector('.tab[onclick*="showView(\'servers\'"]').classList.add('active');
}

// Switch between form and JSON editors
function switchEditorTab(tabName) {
    // Update tab UI
    document.getElementById('formEditorTab').classList.toggle('active', tabName === 'form');
    document.getElementById('jsonEditorTab').classList.toggle('active', tabName === 'json');
    
    // Toggle panel visibility
    document.getElementById('formEditorPanel').style.display = tabName === 'form' ? 'block' : 'none';
    document.getElementById('jsonEditorPanel').style.display = tabName === 'json' ? 'block' : 'none';
    
    currentEditorTab = tabName;
    
    if (tabName === 'json' && jsonEditor) {
        // When switching to JSON, sync from form if that's where we came from
        if (jsonEditor.getValue() === '') {
            updateJSONFromForm();
        }
        // Need to explicitly layout in case container size changed
        jsonEditor.layout();
    } else if (tabName === 'form') {
        // When switching to form, sync from JSON
        if (jsonEditor && jsonEditor.getValue()) {
            try {
                updateFormFromJSON();
            } catch (e) {
                console.error('Error updating form from JSON:', e);
                showWarning('Error updating form from JSON: ' + e.message);
            }
        }
    }
}

// Initialize the Monaco editor
function initMonacoEditor() {
    if (jsonEditor) return; // Already initialized
    
    try {
        jsonEditor = monaco.editor.create(document.getElementById('monacoContainer'), {
            value: '',
            language: 'json',
            theme: 'vs',
            automaticLayout: true,
            formatOnPaste: true,
            formatOnType: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbers: 'on',
            renderIndentGuides: true,
            matchBrackets: 'always',
            scrollbar: {
                useShadows: false,
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10
            }
        });
        
        // Add format document button
        const formatAction = jsonEditor.addAction({
            id: 'format-json',
            label: 'Format JSON',
            keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KEY_F],
            run: () => {
                jsonEditor.getAction('editor.action.formatDocument').run();
                return null;
            }
        });
        
        console.log('Monaco editor initialized');
    } catch (e) {
        console.error('Error initializing Monaco editor:', e);
        showWarning('Failed to initialize JSON editor. Falling back to form view.');
        currentEditorTab = 'form';
    }
}

// Update the JSON editor content from the form values
function updateJSONFromForm() {
    if (!jsonEditor) return;
    
    try {
        const serverName = document.getElementById('serverName').value;
        const config = {
            command: document.getElementById('serverCommand').value,
            args: [],
            env: {}
        };
        
        // Get arguments
        document.querySelectorAll('#serverArgs .arg-item').forEach(item => {
            const input = item.querySelector('input');
            if (input && input.value.trim()) {
                config.args.push(input.value.trim());
            }
        });
        
        // Get environment variables
        document.querySelectorAll('#serverEnv .env-item').forEach(item => {
            const keyInput = item.querySelector('.env-key-input');
            const valueInput = item.querySelector('.env-value-input');
            if (keyInput && valueInput && keyInput.value.trim()) {
                config.env[keyInput.value.trim()] = valueInput.value;
            }
        });
        
        // Add connection type (subprocess/sse)
        const serverType = document.getElementById('serverType').value;
        if (serverType === 'sse') {
            config.sseUrl = document.getElementById('sseUrl').value;
        }
        
        // Add inspector settings if enabled
        if (document.getElementById('enableInspector').checked) {
            config.enableInspector = true;
            config.inspectorPort = parseInt(document.getElementById('inspectorPort').value);
        }
        
        // Format the JSON and set editor value
        const formattedJson = JSON.stringify(config, null, 2);
        jsonEditor.setValue(formattedJson);
    } catch (e) {
        console.error('Error updating JSON from form:', e);
        showWarning('Error updating JSON from form');
    }
}

// Update the form with values from the JSON editor
function updateFormFromJSON() {
    if (!jsonEditor) return;
    
    try {
        const jsonText = jsonEditor.getValue();
        if (!jsonText.trim()) return;
        
        const config = JSON.parse(jsonText);
        
        // Set basic fields
        document.getElementById('serverCommand').value = config.command || '';
        
        // Clear existing args and add new ones
        const argsContainer = document.getElementById('serverArgs');
        argsContainer.innerHTML = '';
        if (config.args && Array.isArray(config.args)) {
            config.args.forEach(arg => {
                addServerArg(arg);
            });
        }
        
        // Clear existing env vars and add new ones
        const envContainer = document.getElementById('serverEnv');
        envContainer.innerHTML = '';
        if (config.env && typeof config.env === 'object') {
            Object.entries(config.env).forEach(([key, value]) => {
                addServerEnv(key, value);
            });
        }
        
        // Set connection type
        const serverType = config.sseUrl ? 'sse' : 'subprocess';
        document.getElementById('serverType').value = serverType;
        document.getElementById('sseUrlContainer').style.display = serverType === 'sse' ? 'block' : 'none';
        if (config.sseUrl) {
            document.getElementById('sseUrl').value = config.sseUrl;
        }
        
        // Set inspector settings
        document.getElementById('enableInspector').checked = !!config.enableInspector;
        document.getElementById('inspectorOptionsContainer').style.display = config.enableInspector ? 'block' : 'none';
        if (config.inspectorPort) {
            document.getElementById('inspectorPort').value = config.inspectorPort;
        }
    } catch (e) {
        console.error('Error updating form from JSON:', e);
        showWarning('Invalid JSON: ' + e.message);
    }
}

// Resolve executable paths for npm, npx, node in the configuration
async function resolveExecutablePaths() {
    if (!jsonEditor) return;
    
    const pathInfo = document.getElementById('pathInfo');
    pathInfo.innerHTML = '<div>Resolving paths...</div>';
    
    try {
        const config = JSON.parse(jsonEditor.getValue());
        
        // Check if command is npm, npx, or node
        const command = config.command;
        if (!command) {
            pathInfo.innerHTML = '<div class="path-warning">No command found in configuration</div>';
            return;
        }
        
        // Send command to server for path resolution
        const response = await fetchWithTimeout('/api/resolve-path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command })
        });
        
        if (response.path) {
            // Display the resolved path
            pathInfo.innerHTML = `
                <div class="path-resolved">
                    <strong>Resolved path:</strong> ${response.path}
                </div>
                <div>
                    <small>Using absolute paths can help avoid issues with Node.js version conflicts.</small>
                </div>
            `;
            
            // Ask user if they want to update the command
            if (confirm(`Replace "${command}" with resolved path "${response.path}"?`)) {
                config.command = response.path;
                jsonEditor.setValue(JSON.stringify(config, null, 2));
                showToast('Command updated with resolved path');
            }
        } else {
            pathInfo.innerHTML = `<div class="path-warning">Could not resolve path for "${command}"</div>`;
        }
    } catch (e) {
        console.error('Error resolving paths:', e);
        pathInfo.innerHTML = `<div class="path-warning">Error: ${e.message}</div>`;
    }
}

// Global variable to track the view mode
// let isServersMode = true; // Default to server configuration mode

// Function to select servers mode
function selectServersMode() {
    console.log('Switching to servers mode');
    isServersMode = true;
    
    // Update UI
    document.getElementById('serversOption').classList.add('active');
    document.querySelectorAll('.client-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Show servers view
    showView('servers');
    
    // Load main config
    loadMainConfig();
    
    // Update any other UI elements as needed
    selectedClientId = null;
    
    // Make sure we're showing the servers tab
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelector('.tab[onclick*="showView(\'servers\'"]').classList.add('active');
    
    // Show the add server buttons
    const topAddButton = document.getElementById('topAddServerButton');
    if (topAddButton) {
        topAddButton.style.display = 'flex';
    }
    
    // Update config mode indicator
    updateConfigModeIndicator();
    
    // Make sure servers are correctly displayed
    renderServers();
}

// Function to toggle server enabled state
function toggleServer(name, enabled) {
    console.log(`Toggling server ${name} to ${enabled ? 'enabled' : 'disabled'}`);
    
    if (mcpServers[name]) {
        mcpServers[name].enabled = enabled;
        
        // Also update the original objects for consistency
        if (currentConfig.mcpServers && currentConfig.mcpServers[name]) {
            currentConfig.mcpServers[name].enabled = enabled;
        }
        
        if (allServersConfig.mcpServers && allServersConfig.mcpServers[name]) {
            allServersConfig.mcpServers[name].enabled = enabled;
        }
        
        // Check if this causes changes compared to the original config
        configChanged();
        
        // No need to re-render, as the checkbox state will be updated by the browser
    } else {
        console.error(`Server ${name} not found in mcpServers object`);
    }
}

// Function to copy an environment variable to clipboard
function copyEnvVarToClipboard(key, value, element) {
    if (!isShiftPressed) {
        console.log('Shift not pressed, copy cancelled.');
        return; // Only copy if shift is pressed
    }
    
    navigator.clipboard.writeText(value).then(() => {
        console.log(`Copied ${key} to clipboard`);
        const feedback = element.querySelector('.copy-feedback');
        if (feedback) {
            feedback.style.display = 'inline';
            setTimeout(() => {
                feedback.style.display = 'none';
            }, 1500); // Hide after 1.5 seconds
        }
    }).catch(err => {
        console.error('Failed to copy text: ', err);
        showWarning('Could not copy to clipboard.');
    });
}

// Event delegation for hover and click on env vars within serversView
// Do this once in initializeApp
function setupEnvVarInteraction() {
    const serversView = document.getElementById('serversView');
    if (!serversView) return;

    serversView.addEventListener('mouseover', (event) => {
        const envValueSpan = event.target.closest('.env-value');
        if (envValueSpan) {
            const realValue = envValueSpan.dataset.value;
            // For sensitive values, only show when hover
            if (envValueSpan.parentElement.dataset.sensitive === 'true') {
                envValueSpan.textContent = realValue; // Reveal on hover
            }
            // No need to change display for non-sensitive values as they expand via CSS
        }
    });

    serversView.addEventListener('mouseout', (event) => {
        const envValueSpan = event.target.closest('.env-value');
        // Only re-mask sensitive values
        if (envValueSpan && envValueSpan.parentElement.dataset.sensitive === 'true' && !isShiftPressed) {
            envValueSpan.textContent = '********'; // Re-mask when not hovering
        }
    });

    serversView.addEventListener('click', (event) => {
        const envPairDiv = event.target.closest('.env-var-pair');
        if (envPairDiv && isShiftPressed) {
            const key = envPairDiv.dataset.key;
            const value = envPairDiv.dataset.value;
            copyEnvVarToClipboard(key, value, envPairDiv); // Pass the element for feedback
        }
    });
}

// Function to open the client modal for adding new or editing existing client
function openClientModal(clientId) {
    const modal = document.getElementById('clientModal');
    const title = document.getElementById('clientModalTitle');
    const nameInput = document.getElementById('clientModalName');
    const pathInput = document.getElementById('clientModalConfigPath');
    const idInput = document.getElementById('clientModalId');
    const deleteButton = document.getElementById('deleteClientButton');
    
    // Clear previous values
    nameInput.value = '';
    pathInput.value = '';
    idInput.value = '';
    
    if (clientId === 'new') {
        // Adding a new client
        title.textContent = 'Add Custom MCP Client';
        deleteButton.style.display = 'none';
    } else {
        // Editing existing client
        const client = clientSettings.clients[clientId];
        if (client) {
            title.textContent = 'Edit MCP Client';
            nameInput.value = client.name || '';
            pathInput.value = client.configPath || '';
            idInput.value = clientId;
            deleteButton.style.display = 'block';
        }
    }
    
    modal.style.display = 'block';
}
