import { fileURLToPath } from 'url';
import path from 'path';
import express from 'express';
import apiRoutes from './routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3456;

// Configure middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure static file serving from current directory
console.log(`Setting up static file serving from: ${__dirname}`);
app.use(express.static(__dirname));

// Log all incoming API requests
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`${req.method} ${req.path}`);
  }
  next();
});

// Configure API routes
console.log('Mounting API routes');
app.use(apiRoutes);

// Fallback route for SPA
app.get('*', (req, res) => {
  console.log(`Serving index.html for: ${req.path}`);
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`MCP Server Manager running on http://localhost:${PORT}`);
  console.log('Current directory:', __dirname);
  console.log('Available routes:');
  console.log('  GET  /api/config');
  console.log('  GET  /api/config/initial');
  console.log('  GET  /api/clients');
  console.log('  GET  /api/settings');
});
