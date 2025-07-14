const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Initialize database
async function initDatabase() {
  try {
    await pool.query(`
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
    
    await pool.query(`
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

// Initialize database on startup
initDatabase();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Get all contacts
app.get('/api/contacts', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM contacts ORDER BY created_at DESC');
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contacts'
    });
  }
});

// Get new contacts (from last N days)
app.get('/api/contacts/new', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  
  try {
    const result = await pool.query(
      'SELECT * FROM contacts WHERE created_at >= NOW() - INTERVAL \'$1 days\' ORDER BY created_at DESC',
      [days]
    );
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length,
      days
    });
  } catch (error) {
    console.error('Error fetching new contacts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch new contacts'
    });
  }
});

// Manual sync endpoint (mock for now)
app.post('/api/sync', async (req, res) => {
  try {
    console.log('Manual sync requested (mock implementation)');
    
    const result = {
      newContacts: [],
      totalContacts: 0,
      eventsProcessed: 0
    };
    
    // Get total contacts count
    const contacts = await pool.query('SELECT COUNT(*) FROM contacts');
    result.totalContacts = parseInt(contacts.rows[0].count);
    
    res.json({
      success: true,
      data: result,
      message: `Sync completed: ${result.newContacts.length} new contacts found`
    });
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({
      success: false,
      error: 'Sync failed',
      details: error.message
    });
  }
});

// Basic web interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>CRM Calendar Sync</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .container { max-width: 800px; margin: 0 auto; }
        button { padding: 10px 20px; margin: 10px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #0056b3; }
        .contacts { margin-top: 20px; }
        .contact { padding: 10px; border: 1px solid #ddd; margin: 5px 0; border-radius: 4px; }
        .loading { color: #666; }
        .error { color: #dc3545; }
        .success { color: #28a745; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚀 CRM Calendar Sync</h1>
        
        <button onclick="syncContacts()">Sync Now</button>
        <button onclick="loadContacts()">Load Contacts</button>
        
        <div id="status"></div>
        
        <div class="contacts">
          <h2>Contacts</h2>
          <div id="contactsList"></div>
        </div>
      </div>

      <script>
        async function syncContacts() {
          const status = document.getElementById('status');
          status.innerHTML = '<div class="loading">Syncing contacts...</div>';
          
          try {
            const response = await fetch('/api/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ days: 7 })
            });
            
            const result = await response.json();
            
            if (result.success) {
              status.innerHTML = '<div class="success">Sync completed! ' + result.message + '</div>';
              loadContacts();
            } else {
              status.innerHTML = '<div class="error">Sync failed: ' + result.error + '</div>';
            }
          } catch (error) {
            status.innerHTML = '<div class="error">Error: ' + error.message + '</div>';
          }
        }
        
        async function loadContacts() {
          const contactsList = document.getElementById('contactsList');
          contactsList.innerHTML = '<div class="loading">Loading contacts...</div>';
          
          try {
            const response = await fetch('/api/contacts');
            const result = await response.json();
            
            if (result.success) {
              if (result.data.length === 0) {
                contactsList.innerHTML = '<div class="contact">No contacts found. Try syncing with Google Calendar first.</div>';
              } else {
                contactsList.innerHTML = result.data.map(contact => 
                  '<div class="contact">' +
                    '<strong>' + contact.email + '</strong>' +
                    (contact.name ? ' (' + contact.name + ')' : '') +
                    '<br><small>' + contact.meeting_count + ' meetings | Last seen: ' + contact.last_seen + '</small>' +
                  '</div>'
                ).join('');
              }
            } else {
              contactsList.innerHTML = '<div class="error">Failed to load contacts</div>';
            }
          } catch (error) {
            contactsList.innerHTML = '<div class="error">Error loading contacts</div>';
          }
        }
        
        // Load contacts on page load
        loadContacts();
      </script>
    </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 CRM Server running on port ${PORT}`);
  console.log(`📱 Web interface: http://localhost:${PORT}`);
  console.log(`🔗 API endpoints:`);
  console.log(`   GET  /api/contacts - Get all contacts`);
  console.log(`   GET  /api/contacts/new - Get new contacts`);
  console.log(`   POST /api/sync - Manual sync`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

module.exports = app;