import { Client, Pool } from 'pg';
import { DatabaseConfig } from './types';

const config: DatabaseConfig = {
  host: process.env.PGHOST || 'tender-tracking-db2.postgres.database.azure.com',
  database: process.env.PGDATABASE || 'postgres',
  user: process.env.PGUSER || 'abouefletouhm',
  port: parseInt(process.env.PGPORT || '5432', 10),
  password: process.env.PGPASSWORD || '',
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
};

class AzureDatabase {
  private pool: Pool;
  private static instance: AzureDatabase;
  private isConnected: boolean = false;
  private connectionListeners: Set<(isConnected: boolean) => void> = new Set();

  private constructor() {
    this.pool = new Pool(config);
    this.setupPoolErrorHandling();
  }

  private setupPoolErrorHandling() {
    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
      this.isConnected = false;
      this.notifyListeners(false);
    });
  }

  static getInstance() {
    if (!AzureDatabase.instance) {
      AzureDatabase.instance = new AzureDatabase();
    }
    return AzureDatabase.instance;
  }

  async connect() {
    if (this.isConnected) return true;

    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      this.isConnected = true;
      this.notifyListeners(true);
      console.log('Connected to Azure Database');
      return true;
    } catch (error) {
      this.isConnected = false;
      this.notifyListeners(false);
      console.error('Failed to connect to Azure Database:', error);
      throw error;
    }
  }

  async query(text: string, params?: any[]) {
    try {
      const result = await this.pool.query(text, params);
      return result;
    } catch (error) {
      console.error('Query error:', error);
      throw error;
    }
  }

  onConnectionChange(listener: (isConnected: boolean) => void) {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  private notifyListeners(isConnected: boolean) {
    this.connectionListeners.forEach(listener => listener(isConnected));
  }

  async end() {
    await this.pool.end();
    this.isConnected = false;
    this.notifyListeners(false);
  }

  getIsConnected() {
    return this.isConnected;
  }
}

export const db = AzureDatabase.getInstance();