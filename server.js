import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import compression from 'compression';
import pg from 'pg';
const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Enable gzip compression
app.use(compression());
app.use(express.json());

// Validate required environment variables
const requiredEnvVars = [
  'VITE_AZURE_DB_HOST',
  'VITE_AZURE_DB_NAME',
  'VITE_AZURE_DB_USER',
  'VITE_AZURE_DB_PASSWORD'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars);
  // Continue without database connection
}

// Database connection management
let pool = null;
let isConnected = false;
let connectionRetries = 0;
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000;
const KEEPALIVE_INTERVAL = 30000; // 30 seconds

const createPool = () => {
  if (missingEnvVars.length > 0) {
    return null;
  }

  return new Pool({
    host: process.env.VITE_AZURE_DB_HOST,
    database: process.env.VITE_AZURE_DB_NAME,
    user: process.env.VITE_AZURE_DB_USER,
    password: process.env.VITE_AZURE_DB_PASSWORD,
    port: 5432,
    ssl: {
      rejectUnauthorized: false
    },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
  });
};

const connectDB = async () => {
  if (isConnected) return true;
  if (missingEnvVars.length > 0) return false;

  try {
    if (pool) {
      await pool.end().catch(() => {});
    }

    pool = createPool();
    if (!pool) return false;
    
    // Test the connection
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    
    isConnected = true;
    connectionRetries = 0;
    console.log('Connected to database');
    
    // Set up keepalive
    setInterval(async () => {
      try {
        if (!pool) return;
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
      } catch (error) {
        console.error('Keepalive query failed:', error);
        isConnected = false;
        connectDB();
      }
    }, KEEPALIVE_INTERVAL);
    
    return true;
  } catch (error) {
    console.error('Database connection error:', error);
    isConnected = false;
    pool = null;

    if (connectionRetries < MAX_RETRIES) {
      connectionRetries++;
      console.log(`Retrying connection (${connectionRetries}/${MAX_RETRIES}) in ${RETRY_DELAY}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return connectDB();
    } else {
      console.log('Max connection retries reached, continuing without database');
      return false;
    }
  }
};

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: isConnected ? 'connected' : 'disconnected',
      environment: {
        nodeEnv: process.env.NODE_ENV,
        port: PORT,
        hasDbConfig: !missingEnvVars.length
      }
    };

    if (isConnected && pool) {
      try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        health.database = 'connected';
      } catch (dbError) {
        console.error('Database health check failed:', dbError);
        health.database = 'error';
        health.databaseError = dbError.message;
        isConnected = false;
        connectDB();
      }
    }

    res.status(200).json(health);
  } catch (error) {
    res.status(200).json({
      status: 'degraded',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Database query endpoint
app.post('/api/query', async (req, res) => {
  if (!isConnected || !pool) {
    return res.status(503).json({
      error: true,
      message: 'Database not connected'
    });
  }

  let client;
  try {
    const { text, params } = req.body;
    
    if (!text) {
      return res.status(400).json({
        error: true,
        message: 'Query text is required'
      });
    }

    client = await pool.connect();
    const result = await client.query(text, params);
    res.json({
      rows: result.rows,
      rowCount: result.rowCount,
      fields: result.fields
    });
  } catch (error) {
    console.error('Query error:', error);
    
    if (error.code === 'ECONNRESET' || error.code === '57P01') {
      isConnected = false;
      connectDB();
    }
    
    res.status(500).json({ 
      error: true,
      message: error.message
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Serve static files
app.use(express.static(join(__dirname, 'dist')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down gracefully...');
  if (pool) {
    try {
      await pool.end();
      console.log('Database connection closed');
    } catch (error) {
      console.error('Error closing database connection:', error);
    }
  }
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Initialize server
const startServer = async () => {
  try {
    // Start the server first
    const server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Health check available at: http://localhost:${PORT}/api/health`);
      console.log('Environment:', {
        nodeEnv: process.env.NODE_ENV,
        port: PORT,
        hasDbConfig: !missingEnvVars.length
      });
    });

    // Then attempt database connection
    const dbConnected = await connectDB();
    if (!dbConnected) {
      console.log('Server started without database connection');
    }

    return server;
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();