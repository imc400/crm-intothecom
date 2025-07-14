import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { SyncService } from './services/syncService';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Get all contacts
app.get('/api/contacts', async (req, res) => {
  const syncService = new SyncService();
  
  try {
    const contacts = await syncService.getContacts();
    res.json({
      success: true,
      data: contacts,
      count: contacts.length
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contacts'
    });
  } finally {
    await syncService.close();
  }
});

// Get new contacts (from last N days)
app.get('/api/contacts/new', async (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  const syncService = new SyncService();
  
  try {
    const contacts = await syncService.getNewContacts(days);
    res.json({
      success: true,
      data: contacts,
      count: contacts.length,
      days
    });
  } catch (error) {
    console.error('Error fetching new contacts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch new contacts'
    });
  } finally {
    await syncService.close();
  }
});

// Manual sync endpoint
app.post('/api/sync', async (req, res) => {
  const days = parseInt(req.body.days) || 7;
  const syncService = new SyncService();
  
  try {
    console.log(`Starting manual sync for last ${days} days...`);
    
    const result = await syncService.syncContacts(days);
    
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
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  } finally {
    await syncService.close();
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
              contactsList.innerHTML = result.data.map(contact => 
                '<div class="contact">' +
                  '<strong>' + contact.email + '</strong>' +
                  (contact.name ? ' (' + contact.name + ')' : '') +
                  '<br><small>' + contact.meeting_count + ' meetings | Last seen: ' + contact.last_seen + '</small>' +
                '</div>'
              ).join('');
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

export default app;