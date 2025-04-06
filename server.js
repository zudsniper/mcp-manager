import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRoutes from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3456;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes - Mount directly without the /api prefix since routes already include it
console.log('Mounting API routes');
app.use(apiRoutes);

// Static file serving
const staticDir = __dirname;
console.log('Setting up static file serving from:', staticDir);
app.use(express.static(staticDir));

// Serve index.html for all other routes
app.get('*', (req, res) => {
    console.log('Serving index.html for:', req.path);
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(port, () => {
    console.log(`MCP Manager running at http://localhost:${port}`);
    console.log('Current directory:', __dirname);
    console.log('Available routes:');
    console.log('  GET  /api/config');
    console.log('  GET  /api/config/initial');
    console.log('  GET  /api/clients');
    console.log('  GET  /api/settings');
});
