let mcpServers = {};
let originalConfig = {};
let toolsList = [];

// API endpoints
const API = {
    CURSOR_CONFIG: '/api/cursor-config',
    CLAUDE_CONFIG: '/api/claude-config',
    TOOLS: '/api/tools',
    SAVE_CONFIGS: '/api/save-configs'
};

function showMessage(message, isError = true) {
    const messageDiv = document.getElementById(isError ? 'errorMessage' : 'successMessage');
    const otherDiv = document.getElementById(isError ? 'successMessage' : 'errorMessage');
    
    messageDiv.textContent = message;
    messageDiv.style.display = 'block';
    otherDiv.style.display = 'none';
    
    setTimeout(() => {
        messageDiv.style.display = 'none';
    }, 10000); // Show for 10 seconds
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

async function loadConfigs() {
    console.log('Loading configurations...');
    try {
        // Load cursor config first
        console.log('Fetching cursor config from:', API.CURSOR_CONFIG);
        const cursorConfig = await fetchWithTimeout(API.CURSOR_CONFIG);
        console.log('Received cursor config:', cursorConfig);
        
        if (!cursorConfig.mcpServers) {
            throw new Error('Invalid config format: missing mcpServers');
        }
        
        mcpServers = cursorConfig.mcpServers;
        originalConfig = JSON.parse(JSON.stringify(mcpServers));
        
        console.log('Loaded servers:', Object.keys(mcpServers));
        
        // Render initial view
        renderServers();

        // Load tools in background
        try {
            console.log('Fetching tools from:', API.TOOLS);
            toolsList = await fetchWithTimeout(API.TOOLS);
            console.log('Loaded tools:', toolsList);
            renderTools();
        } catch (error) {
            console.error('Error loading tools:', error);
            showMessage('Failed to load tools. Server list may be incomplete.');
        }
    } catch (error) {
        console.error('Error loading configs:', error);
        showMessage('Failed to load server configurations. Please refresh the page.');
    }
}

function showView(view, clickedTab) {
    console.log('Switching view to:', view);
    // Update tabs
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    clickedTab.classList.add('active');

    // Update views
    document.getElementById('serversView').style.display = view === 'servers' ? 'grid' : 'none';
    document.getElementById('toolsView').style.display = view === 'tools' ? 'block' : 'none';

    // Refresh tools view when switching to it
    if (view === 'tools') {
        renderTools();
    }
}

function renderServers() {
    console.log('Rendering servers view with servers:', Object.keys(mcpServers));
    const grid = document.getElementById('serversView');
    grid.innerHTML = '';

    // Sort servers alphabetically
    const sortedServers = Object.entries(mcpServers).sort(([a], [b]) => a.localeCompare(b));

    sortedServers.forEach(([name, config]) => {
        console.log('Rendering server:', name, config);
        const card = document.createElement('div');
        card.className = 'server-card';
        
        const serverPath = Array.isArray(config.args) ? config.args[0] : '';
        const envVars = config.env || {};

        card.innerHTML = `
            <div class="server-header">
                <span class="server-name">${name}</span>
                <label class="toggle-switch">
                    <input type="checkbox" ${config.disabled ? '' : 'checked'} 
                           onchange="toggleServer('${name}', this.checked)">
                    <span class="slider"></span>
                </label>
            </div>
            <div class="server-details">
                <div class="server-path">${serverPath}</div>
                ${Object.keys(envVars).length > 0 ? '<div class="env-vars">' + 
                    Object.entries(envVars).map(([key]) => 
                        `<div class="env-var">
                            <span>${key}</span>
                            <span>********</span>
                        </div>`
                    ).join('') + '</div>' : ''}
            </div>
        `;
        
        grid.appendChild(card);
    });
}

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
    console.log('Toggling server:', name, enabled);
    if (mcpServers[name]) {
        mcpServers[name].disabled = !enabled;
    }
}

async function saveChanges() {
    console.log('Saving changes...');
    try {
        const result = await fetchWithTimeout(API.SAVE_CONFIGS, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ mcpServers })
        });

        originalConfig = JSON.parse(JSON.stringify(mcpServers));
        showMessage(result.message || 'Configurations saved successfully. Please restart Claude to apply changes.', false);
        
        // Refresh tools list to reflect enabled/disabled servers
        const updatedTools = await fetchWithTimeout(API.TOOLS);
        toolsList = updatedTools;
        if (document.getElementById('toolsView').style.display !== 'none') {
            renderTools();
        }
    } catch (error) {
        console.error('Error saving configs:', error);
        showMessage('Error saving configurations: ' + error.message);
    }
}

// Initialize the app
console.log('Initializing MCP Manager...');
window.onload = loadConfigs;

// Export functions for global access
window.showView = showView;
window.toggleServer = toggleServer;
window.saveChanges = saveChanges;
