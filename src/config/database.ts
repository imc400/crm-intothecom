import { Pool, PoolClient } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

export class Database {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    
    this.init();
  }

  private async init() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS contacts (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          name VARCHAR(255),
          first_seen DATE NOT NULL,
          last_seen DATE NOT NULL,
          meeting_count INTEGER DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS events (
          id SERIAL PRIMARY KEY,
          google_event_id VARCHAR(255) UNIQUE NOT NULL,
          summary TEXT,
          start_time TIMESTAMP,
          end_time TIMESTAMP,
          attendees_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      console.log('Database initialized successfully');
    } catch (error) {
      console.error('Database initialization error:', error);
    }
  }

  async addContact(email: string, name?: string): Promise<boolean> {
    const client = await this.pool.connect();
    
    try {
      const today = new Date().toISOString().split('T')[0];
      
      const result = await client.query(
        `INSERT INTO contacts (email, name, first_seen, last_seen, meeting_count) 
         VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (email) 
         DO UPDATE SET 
           name = COALESCE($2, contacts.name),
           last_seen = $4,
           meeting_count = contacts.meeting_count + 1
         RETURNING *`,
        [email, name, today, today]
      );
      
      return result.rows.length > 0;
    } catch (error) {
      console.error('Error adding contact:', error);
      return false;
    } finally {
      client.release();
    }
  }

  async getContact(email: string): Promise<any> {
    const client = await this.pool.connect();
    
    try {
      const result = await client.query('SELECT * FROM contacts WHERE email = $1', [email]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error getting contact:', error);
      return null;
    } finally {
      client.release();
    }
  }

  async getAllContacts(): Promise<any[]> {
    const client = await this.pool.connect();
    
    try {
      const result = await client.query('SELECT * FROM contacts ORDER BY created_at DESC');
      return result.rows;
    } catch (error) {
      console.error('Error getting all contacts:', error);
      return [];
    } finally {
      client.release();
    }
  }

  async getNewContacts(days: number = 7): Promise<any[]> {
    const client = await this.pool.connect();
    
    try {
      const result = await client.query(
        'SELECT * FROM contacts WHERE created_at >= NOW() - INTERVAL \'$1 days\' ORDER BY created_at DESC',
        [days]
      );
      return result.rows;
    } catch (error) {
      console.error('Error getting new contacts:', error);
      return [];
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}