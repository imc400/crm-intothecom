const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
console.log('Environment:', process.env.NODE_ENV);
console.log('Database URL exists:', !!process.env.DATABASE_URL);
console.log('Port:', PORT);

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
        tags TEXT[] DEFAULT '{}',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Check if tags column exists, if not add it
    try {
      await pool.query(`
        SELECT tags FROM contacts LIMIT 1
      `);
    } catch (columnError) {
      if (columnError.code === '42703') { // Column does not exist
        console.log('Adding tags column to contacts table...');
        await pool.query(`
          ALTER TABLE contacts ADD COLUMN tags TEXT[] DEFAULT '{}'
        `);
        console.log('Tags column added successfully');
      }
    }
    
    // Check if notes column exists, if not add it
    try {
      await pool.query(`
        SELECT notes FROM contacts LIMIT 1
      `);
    } catch (columnError) {
      if (columnError.code === '42703') { // Column does not exist
        console.log('Adding notes column to contacts table...');
        await pool.query(`
          ALTER TABLE contacts ADD COLUMN notes TEXT
        `);
        console.log('Notes column added successfully');
      }
    }
    
    // Check if created_at column exists, if not add it
    try {
      await pool.query(`
        SELECT created_at FROM contacts LIMIT 1
      `);
    } catch (columnError) {
      if (columnError.code === '42703') { // Column does not exist
        console.log('Adding created_at column to contacts table...');
        await pool.query(`
          ALTER TABLE contacts ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `);
        console.log('Created_at column added successfully');
      }
    }
    
    // Check if updated_at column exists, if not add it
    try {
      await pool.query(`
        SELECT updated_at FROM contacts LIMIT 1
      `);
    } catch (columnError) {
      if (columnError.code === '42703') { // Column does not exist
        console.log('Adding updated_at column to contacts table...');
        await pool.query(`
          ALTER TABLE contacts ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `);
        console.log('Updated_at column added successfully');
      }
    }
    
    // Add new CRM fields
    const newColumns = [
      { name: 'phone', type: 'VARCHAR(50)', description: 'Phone number' },
      { name: 'company', type: 'VARCHAR(255)', description: 'Company name' },
      { name: 'position', type: 'VARCHAR(255)', description: 'Job position' },
      { name: 'website', type: 'VARCHAR(255)', description: 'Company website' },
      { name: 'industry', type: 'VARCHAR(100)', description: 'Industry' },
      { name: 'status', type: 'VARCHAR(50) DEFAULT \'New Lead\'', description: 'Lead status' },
      { name: 'priority', type: 'VARCHAR(20) DEFAULT \'Medium\'', description: 'Lead priority' }
    ];
    
    for (const column of newColumns) {
      try {
        await pool.query('SELECT ' + column.name + ' FROM contacts LIMIT 1');
      } catch (columnError) {
        if (columnError.code === '42703') { // Column does not exist
          console.log('Adding ' + column.name + ' column to contacts table...');
          await pool.query('ALTER TABLE contacts ADD COLUMN ' + column.name + ' ' + column.type);
          console.log(column.name + ' column added successfully');
        }
      }
    }
    
    // Create tags table for dynamic tag management
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tags (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        color VARCHAR(7) DEFAULT '#FF6B00',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Insert default "New Lead" tag if it doesn't exist
    await pool.query(`
      INSERT INTO tags (name, color) 
      VALUES ('New Lead', '#FF6B00')
      ON CONFLICT (name) DO NOTHING
    `);
    
    // Create google_tokens table for token persistence
    await pool.query(`
      CREATE TABLE IF NOT EXISTS google_tokens (
        id INTEGER PRIMARY KEY DEFAULT 1,
        tokens JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Initialize Google Auth and load stored tokens if they exist
    initializeGoogleAuth();
    
    try {
      const tokenResult = await pool.query('SELECT tokens FROM google_tokens WHERE id = 1');
      if (tokenResult.rows.length > 0) {
        storedTokens = tokenResult.rows[0].tokens;
        if (oAuth2Client && storedTokens) {
          oAuth2Client.setCredentials(storedTokens);
          console.log('Loaded stored Google tokens from database');
        }
      }
    } catch (tokenError) {
      console.error('Error loading stored tokens:', tokenError);
    }
    
    // Create trigger to update updated_at timestamp
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);
    
    await pool.query(`
      DROP TRIGGER IF EXISTS update_contacts_updated_at ON contacts;
      CREATE TRIGGER update_contacts_updated_at
        BEFORE UPDATE ON contacts
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        google_event_id VARCHAR(255) UNIQUE NOT NULL,
        summary TEXT,
        description TEXT,
        start_time TIMESTAMP,
        end_time TIMESTAMP,
        attendees_count INTEGER DEFAULT 0,
        attendees_emails TEXT,
        hangout_link TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Check if notes column exists in events table, if not add it
    try {
      await pool.query(`
        SELECT notes FROM events LIMIT 1
      `);
    } catch (columnError) {
      if (columnError.code === '42703') { // Column does not exist
        console.log('Adding notes column to events table...');
        await pool.query(`
          ALTER TABLE events ADD COLUMN notes TEXT
        `);
        console.log('Notes column added to events table successfully');
      }
    }
    
    // Create contact_attachments table if it doesn't exist
    console.log('Creating contact_attachments table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contact_attachments (
        id SERIAL PRIMARY KEY,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
        filename VARCHAR(255) NOT NULL,
        original_filename VARCHAR(255) NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        file_size INTEGER NOT NULL,
        file_type VARCHAR(100) NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('contact_attachments table created successfully');
    
    // Create contact_tag_history table for tracking when tags are assigned
    console.log('Creating contact_tag_history table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contact_tag_history (
        id SERIAL PRIMARY KEY,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
        tag_name VARCHAR(255) NOT NULL,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(contact_id, tag_name)
      )
    `);
    console.log('contact_tag_history table created successfully');

    // Add financial fields to contacts table
    console.log('Adding financial fields to contacts table...');
    const financialColumns = [
      { name: 'monthly_price', type: 'DECIMAL(10,2)' },
      { name: 'currency', type: 'VARCHAR(10) DEFAULT \'CLP\'' },
      { name: 'contract_start_date', type: 'DATE' },
      { name: 'is_active_client', type: 'BOOLEAN DEFAULT FALSE' }
    ];

    for (const column of financialColumns) {
      try {
        await pool.query('SELECT ' + column.name + ' FROM contacts LIMIT 1');
        console.log(column.name + ' column already exists');
      } catch (columnError) {
        if (columnError.code === '42703') { // Column does not exist
          console.log('Adding ' + column.name + ' column to contacts table...');
          await pool.query('ALTER TABLE contacts ADD COLUMN ' + column.name + ' ' + column.type);
          console.log(column.name + ' column added successfully');
        }
      }
    }
    console.log('Financial fields added to contacts table successfully');
    
    // Create client_contracts table
    console.log('Creating client_contracts table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_contracts (
        id SERIAL PRIMARY KEY,
        contact_id INTEGER UNIQUE REFERENCES contacts(id),
        base_monthly_price DECIMAL(10,2),
        base_currency VARCHAR(10) DEFAULT 'CLP',
        contract_start_date DATE,
        contract_end_date DATE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('client_contracts table created successfully');
    
    // Create monthly_billing table
    console.log('Creating monthly_billing table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monthly_billing (
        id SERIAL PRIMARY KEY,
        contact_id INTEGER REFERENCES contacts(id),
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        adjusted_price DECIMAL(10,2),
        currency VARCHAR(10) DEFAULT 'CLP',
        adjustment_reason TEXT,
        adjustment_type VARCHAR(20) DEFAULT 'manual',
        base_price DECIMAL(10,2),
        adjustment_amount DECIMAL(10,2),
        billing_status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(contact_id, year, month)
      )
    `);
    console.log('monthly_billing table created successfully');
    
    // Create projects table
    console.log('Creating projects table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        contact_id INTEGER REFERENCES contacts(id),
        project_name VARCHAR(255) NOT NULL,
        description TEXT,
        total_amount DECIMAL(10,2),
        currency VARCHAR(10) DEFAULT 'CLP',
        project_status VARCHAR(20) DEFAULT 'active',
        start_date DATE,
        estimated_end_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('projects table created successfully');
    
    // Create project_payments table
    console.log('Creating project_payments table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_payments (
        id SERIAL PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id),
        amount DECIMAL(10,2),
        currency VARCHAR(10) DEFAULT 'CLP',
        payment_date DATE,
        payment_month INTEGER,
        payment_year INTEGER,
        payment_status VARCHAR(20) DEFAULT 'pending',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('project_payments table created successfully');
    
    // Migrate existing financial data to new structure
    console.log('Migrating existing financial data...');
    await migrateFinancialData();
    
    console.log('Database initialized successfully');
    
    // Force check contact_attachments table
    try {
      const checkTable = await pool.query("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'contact_attachments')");
      console.log('contact_attachments table exists:', checkTable.rows[0].exists);
    } catch (checkError) {
      console.error('Error checking table existence:', checkError);
    }
    
    // Log current table schemas for debugging
    console.log('Starting schema logging...');
    
    // Check contacts table schema
    try {
      const contactsSchemaResult = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'contacts'
        ORDER BY ordinal_position
      `);
      console.log('Current contacts table schema:', contactsSchemaResult.rows);
    } catch (contactsError) {
      console.error('Error checking contacts schema:', contactsError);
    }
    
    // Check events table schema
    try {
      const eventsSchemaResult = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'events'
        ORDER BY ordinal_position
      `);
      console.log('Current events table schema:', eventsSchemaResult.rows);
    } catch (eventsError) {
      console.error('Error checking events schema:', eventsError);
    }
    
    // Check contact_attachments table schema
    try {
      console.log('Checking contact_attachments schema...');
      const attachmentsSchemaResult = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'contact_attachments'
        ORDER BY ordinal_position
      `);
      console.log('Current contact_attachments table schema:', attachmentsSchemaResult.rows);
      
      if (attachmentsSchemaResult.rows.length === 0) {
        console.log('WARNING: contact_attachments table appears to be empty or not found!');
      }
    } catch (attachmentsError) {
      console.error('Error checking contact_attachments schema:', attachmentsError);
    }
    
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Function to migrate existing financial data to new structure
async function migrateFinancialData() {
  try {
    // Get all contacts with financial data
    const contactsResult = await pool.query(`
      SELECT id, monthly_price, currency, contract_start_date, is_active_client 
      FROM contacts 
      WHERE is_active_client = true AND monthly_price IS NOT NULL
    `);
    
    for (const contact of contactsResult.rows) {
      // Create contract record
      await pool.query(`
        INSERT INTO client_contracts (
          contact_id, base_monthly_price, base_currency, 
          contract_start_date, is_active
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (contact_id) DO NOTHING
      `, [
        contact.id,
        contact.monthly_price,
        contact.currency || 'CLP',
        contact.contract_start_date,
        contact.is_active_client
      ]);
      
      // Create current month billing record
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      
      await pool.query(`
        INSERT INTO monthly_billing (
          contact_id, year, month, adjusted_price, currency, 
          adjustment_reason, base_price, adjustment_amount
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (contact_id, year, month) DO NOTHING
      `, [
        contact.id,
        currentYear,
        currentMonth,
        contact.monthly_price,
        contact.currency || 'CLP',
        'Precio base del contrato',
        contact.monthly_price,
        0
      ]);
    }
    
    console.log('Financial data migration completed successfully');
  } catch (error) {
    console.error('Error migrating financial data:', error);
  }
}

// Initialize database on startup
initDatabase();

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads', 'contacts');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename: timestamp-randomnumber-originalname
    const timestamp = Date.now();
    const randomNum = Math.floor(Math.random() * 1000);
    const sanitizedOriginalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const uniqueFilename = timestamp + '-' + randomNum + '-' + sanitizedOriginalName;
    cb(null, uniqueFilename);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow common file types
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|zip|rar/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido'));
    }
  }
});

// Error handling middleware for multer
app.use((error, req, res, next) => {
  console.log('=== ERROR MIDDLEWARE TRIGGERED ===');
  console.log('Error:', error);
  console.log('Request URL:', req.url);
  console.log('Request method:', req.method);
  
  if (error) {
    console.error('Multer error:', error);
    
    let errorMessage = 'File upload error: ' + error.message;
    let statusCode = 400;
    
    if (error.code === 'LIMIT_FILE_SIZE') {
      errorMessage = 'El archivo es demasiado grande. Tamaño máximo permitido: 50MB';
      statusCode = 413;
    } else if (error.code === 'LIMIT_FILE_COUNT') {
      errorMessage = 'Demasiados archivos. Solo se permite un archivo a la vez';
    } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      errorMessage = 'Campo de archivo inesperado';
    }
    
    return res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
  next();
});

// Global request logging middleware
app.use((req, res, next) => {
  if (req.path.includes('/attachments/')) {
    console.log('=== ATTACHMENT REQUEST ===');
    console.log('Method:', req.method);
    console.log('Path:', req.path);
    console.log('Params:', req.params);
    console.log('Query:', req.query);
  }
  next();
});

// Debug endpoint to check attachments
app.get('/debug/attachments/:contactId', async (req, res) => {
  const { contactId } = req.params;
  try {
    const result = await pool.query('SELECT * FROM contact_attachments WHERE contact_id = $1', [contactId]);
    res.json({
      success: true,
      attachments: result.rows,
      message: 'Debug info for contact ' + contactId
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message
    });
  }
});

// Simple test endpoint
app.get('/test', (req, res) => {
  res.json({ message: 'Server is working', timestamp: new Date().toISOString() });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Get current UF value from Chilean API
app.get('/api/uf-value', async (req, res) => {
  try {
    const response = await fetch('https://mindicador.cl/api/uf');
    const data = await response.json();
    
    if (data && data.serie && data.serie.length > 0) {
      const latestUF = data.serie[0];
      res.json({
        success: true,
        data: {
          value: latestUF.valor,
          date: latestUF.fecha,
          currency: 'CLP'
        }
      });
    } else {
      res.json({
        success: false,
        error: 'No UF data available'
      });
    }
  } catch (error) {
    console.error('Error fetching UF value:', error);
    res.json({
      success: false,
      error: 'Failed to fetch UF value',
      fallback: 37000 // Fallback value in case of API failure
    });
  }
});

// Get all contacts
app.get('/api/contacts', async (req, res) => {
  try {
    const { activeClients } = req.query;
    
    // Build WHERE clause for active clients filter
    const whereClause = activeClients === 'true' ? 'WHERE c.is_active_client = true' : '';
    
    // Get contacts with days since 'propuesta enviada' tag was assigned
    const result = await pool.query(`
      SELECT 
        c.*,
        CASE 
          WHEN c.tags @> ARRAY['propuesta enviada']::text[] THEN 
            EXTRACT(days FROM NOW() - COALESCE(th.assigned_at, c.updated_at))::integer
          ELSE NULL 
        END as days_since_proposal
      FROM contacts c
      LEFT JOIN contact_tag_history th ON c.id = th.contact_id AND th.tag_name = 'propuesta enviada'
      ${whereClause}
      ORDER BY 
        CASE WHEN c.tags @> ARRAY['propuesta enviada']::text[] THEN days_since_proposal END DESC NULLS LAST,
        c.created_at DESC
    `);
    
    res.json({
      success: true,
      contacts: result.rows || [],
      data: result.rows || [],
      count: result.rows ? result.rows.length : 0
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    // Fallback to simple query if the complex one fails
    try {
      const { activeClients } = req.query;
      const whereClause = activeClients === 'true' ? 'WHERE is_active_client = true' : '';
      
      const fallbackResult = await pool.query(`SELECT * FROM contacts ${whereClause} ORDER BY created_at DESC`);
      res.json({
        success: true,
        contacts: fallbackResult.rows || [],
        data: fallbackResult.rows || [],
        count: fallbackResult.rows ? fallbackResult.rows.length : 0
      });
    } catch (fallbackError) {
      console.error('Fallback query also failed:', fallbackError);
      res.json({
        success: true,
        contacts: [],
        data: [],
        count: 0
      });
    }
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

// Create new contact
app.post('/api/contacts', async (req, res) => {
  const { email, name, tags, notes } = req.body;
  
  try {
    // Validate required fields
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }
    
    // Ensure tags is an array
    let tagsArray = [];
    if (Array.isArray(tags)) {
      tagsArray = tags;
    } else if (typeof tags === 'string') {
      tagsArray = [tags];
    }
    
    const result = await pool.query(
      'INSERT INTO contacts (email, name, first_seen, last_seen, tags, notes) VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, $3, $4) RETURNING *',
      [email, name || email.split('@')[0], tagsArray, notes || '']
    );
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Contact created successfully'
    });
  } catch (error) {
    console.error('Error creating contact:', error);
    if (error.code === '23505') { // Unique constraint violation
      // Try to get the existing contact and return it
      try {
        const existingResult = await pool.query(
          'SELECT * FROM contacts WHERE email = $1',
          [email]
        );
        if (existingResult.rows.length > 0) {
          res.status(409).json({
            success: false,
            error: 'Contact with this email already exists',
            data: existingResult.rows[0]
          });
        } else {
          res.status(409).json({
            success: false,
            error: 'Contact with this email already exists'
          });
        }
      } catch (getError) {
        res.status(409).json({
          success: false,
          error: 'Contact with this email already exists'
        });
      }
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to create contact: ' + error.message
      });
    }
  }
});

// Update contact tags
app.post('/api/contacts/:contactId/tags', async (req, res) => {
  const { contactId } = req.params;
  const { tags, notes } = req.body;
  
  try {
    // Validate tags array
    if (!Array.isArray(tags)) {
      return res.status(400).json({
        success: false,
        error: 'Tags must be an array'
      });
    }
    
    // Validate that intothecom emails don't get lead tags
    const contact = await pool.query('SELECT email FROM contacts WHERE id = $1', [contactId]);
    if (contact.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }
    
    const email = contact.rows[0].email;
    const isIntothecomEmail = email.includes('@intothecom.com') || email.includes('@intothecom');
    
    if (isIntothecomEmail && tags.includes('New Lead')) {
      return res.status(400).json({
        success: false,
        error: 'Cannot mark IntoTheCom emails as leads'
      });
    }
    
    // Get current tags to compare
    const currentContact = await pool.query('SELECT tags FROM contacts WHERE id = $1', [contactId]);
    const currentTags = currentContact.rows[0]?.tags || [];
    
    // Update contact tags
    const result = await pool.query(
      'UPDATE contacts SET tags = $1, notes = $2 WHERE id = $3 RETURNING *',
      [tags, notes || '', contactId]
    );
    
    // Track new tag assignments
    const newTags = tags.filter(tag => !currentTags.includes(tag));
    for (const tag of newTags) {
      try {
        await pool.query(
          'INSERT INTO contact_tag_history (contact_id, tag_name) VALUES ($1, $2) ON CONFLICT (contact_id, tag_name) DO NOTHING',
          [contactId, tag]
        );
      } catch (tagError) {
        console.error('Error recording tag history:', tagError);
        // Don't fail the whole operation if tag history fails
      }
    }
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Contact tags updated successfully'
    });
  } catch (error) {
    console.error('Error updating contact tags:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update contact tags'
    });
  }
});

// Update contact with full CRM information
app.post('/api/contacts/:contactId/update', async (req, res) => {
  const { contactId } = req.params;
  const { 
    name, 
    phone, 
    company, 
    position, 
    website, 
    industry, 
    status, 
    priority, 
    notes, 
    tags,
    monthly_price,
    currency,
    contract_start_date,
    active_client
  } = req.body;
  
  try {
    // Validate tags array
    if (tags && !Array.isArray(tags)) {
      return res.status(400).json({
        success: false,
        error: 'Tags must be an array'
      });
    }
    
    // Validate financial fields
    if (monthly_price && (isNaN(monthly_price) || monthly_price < 0)) {
      return res.status(400).json({
        success: false,
        error: 'Monthly price must be a valid positive number'
      });
    }
    
    if (currency && !['CLP', 'UF', 'USD', 'EUR'].includes(currency)) {
      return res.status(400).json({
        success: false,
        error: 'Currency must be one of: CLP, UF, USD, EUR'
      });
    }
    
    if (contract_start_date && !Date.parse(contract_start_date)) {
      return res.status(400).json({
        success: false,
        error: 'Contract start date must be a valid date'
      });
    }
    
    // Update contact in database
    const updateQuery = `
      UPDATE contacts 
      SET name = $1, 
          phone = $2, 
          company = $3, 
          position = $4, 
          website = $5, 
          industry = $6, 
          status = $7, 
          priority = $8, 
          notes = $9, 
          tags = $10,
          monthly_price = $11,
          currency = $12,
          contract_start_date = $13,
          is_active_client = $14,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $15
      RETURNING *
    `;
    
    const values = [
      name || null,
      phone || null,
      company || null,
      position || null,
      website || null,
      industry || null,
      status || 'New Lead',
      priority || 'Medium',
      notes || null,
      tags || [],
      monthly_price || null,
      currency || 'CLP',
      contract_start_date || null,
      active_client || false,
      contactId
    ];
    
    const result = await pool.query(updateQuery, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Contact updated successfully'
    });
    
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update contact: ' + error.message
    });
  }
});

// Get contacts by tag
app.get('/api/contacts/tag/:tag', async (req, res) => {
  const { tag } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT * FROM contacts WHERE $1 = ANY(tags) ORDER BY updated_at DESC',
      [tag]
    );
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length,
      tag: tag
    });
  } catch (error) {
    console.error('Error fetching contacts by tag:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contacts by tag'
    });
  }
});

// Update contact tags for funnel stage management
app.put('/api/contacts/:email/tags', async (req, res) => {
  const { email } = req.params;
  const { tags } = req.body;
  
  try {
    // Validate input
    if (!email || !Array.isArray(tags)) {
      return res.status(400).json({
        success: false,
        error: 'Email and tags array are required'
      });
    }
    
    // Update contact tags
    const result = await pool.query(
      'UPDATE contacts SET tags = $1, updated_at = CURRENT_TIMESTAMP WHERE email = $2 RETURNING *',
      [tags, email]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Contact tags updated successfully'
    });
    
  } catch (error) {
    console.error('Error updating contact tags:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update contact tags'
    });
  }
});

// CONTACT ATTACHMENTS ENDPOINTS

// Download attachment (MUST be before general attachments route)
app.get('/api/contacts/:contactId/attachments/:attachmentId/download', (req, res, next) => {
  console.log('=== DOWNLOAD MIDDLEWARE HIT ===');
  console.log('URL:', req.url);
  console.log('Path:', req.path);
  console.log('Method:', req.method);
  next();
}, async (req, res) => {
  console.log('=== DOWNLOAD ENDPOINT HIT ===');
  console.log('Params:', req.params);
  
  const { contactId, attachmentId } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT * FROM contact_attachments WHERE id = $1 AND contact_id = $2',
      [attachmentId, contactId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Attachment not found'
      });
    }
    
    const attachment = result.rows[0];
    const filePath = attachment.file_path;
    
    console.log('=== DOWNLOAD ATTACHMENT ===');
    console.log('Attachment ID:', attachmentId);
    console.log('Contact ID:', contactId);
    console.log('Attachment data:', attachment);
    console.log('Expected file path:', filePath);
    console.log('File exists:', fs.existsSync(filePath));
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error('File not found at path:', filePath);
      return res.status(404).json({
        success: false,
        error: 'File not found on server'
      });
    }
    
    // Set headers for file download
    res.setHeader('Content-Disposition', 'attachment; filename="' + attachment.original_filename + '"');
    res.setHeader('Content-Type', attachment.file_type);
    
    // Stream file to client
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
  } catch (error) {
    console.error('Error downloading attachment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to download attachment'
    });
  }
});

// Delete attachment (MUST be before general attachments route)
app.delete('/api/contacts/:contactId/attachments/:attachmentId', async (req, res) => {
  const { contactId, attachmentId } = req.params;
  
  try {
    // Get attachment info first
    const attachmentResult = await pool.query(
      'SELECT * FROM contact_attachments WHERE id = $1 AND contact_id = $2',
      [attachmentId, contactId]
    );
    
    if (attachmentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Attachment not found'
      });
    }
    
    const attachment = attachmentResult.rows[0];
    
    // Delete from database
    await pool.query(
      'DELETE FROM contact_attachments WHERE id = $1 AND contact_id = $2',
      [attachmentId, contactId]
    );
    
    // Delete file from filesystem
    if (fs.existsSync(attachment.file_path)) {
      fs.unlink(attachment.file_path, (err) => {
        if (err) console.error('Error deleting file:', err);
      });
    }
    
    res.json({
      success: true,
      message: 'Attachment deleted successfully'
    });
    
  } catch (error) {
    console.error('Error deleting attachment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete attachment'
    });
  }
});

// Get attachments for a contact
app.get('/api/contacts/:contactId/attachments', async (req, res) => {
  const { contactId } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT * FROM contact_attachments WHERE contact_id = $1 ORDER BY uploaded_at DESC',
      [contactId]
    );
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching attachments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch attachments'
    });
  }
});

// Upload attachment for a contact
app.post('/api/contacts/:contactId/attachments', (req, res, next) => {
  console.log('=== BEFORE MULTER MIDDLEWARE ===');
  console.log('Request received for attachments upload');
  next();
}, upload.single('file'), async (req, res) => {
  console.log('=== ATTACHMENT UPLOAD ENDPOINT CALLED ===');
  console.log('ContactId:', req.params.contactId);
  console.log('Body:', req.body);
  console.log('File:', req.file ? 'File uploaded' : 'No file');
  
  const { contactId } = req.params;
  const { displayName } = req.body;
  
  try {
    // Validate that contact exists
    const contactCheck = await pool.query('SELECT id FROM contacts WHERE id = $1', [contactId]);
    if (contactCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }
    
    // Validate file was uploaded
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }
    
    // Validate display name
    if (!displayName || displayName.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Display name is required'
      });
    }
    
    // Insert attachment record
    const result = await pool.query(
      `INSERT INTO contact_attachments 
       (contact_id, filename, original_filename, file_path, file_size, file_type, display_name) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING *`,
      [
        contactId,
        req.file.filename,
        req.file.originalname,
        req.file.path,
        req.file.size,
        req.file.mimetype,
        displayName.trim()
      ]
    );
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Archivo subido exitosamente'
    });
    
  } catch (error) {
    console.error('Error uploading attachment:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      contactId: contactId,
      displayName: displayName,
      file: req.file ? {
        filename: req.file.filename,
        originalname: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype
      } : 'No file'
    });
    
    // Delete uploaded file if database operation failed
    if (req.file) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Error deleting file:', err);
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to upload attachment: ' + error.message
    });
  }
});

// MONTHLY BILLING ENDPOINTS

// Get monthly billing data for a specific month
app.get('/api/monthly-billing/:year/:month', async (req, res) => {
  const { year, month } = req.params;
  
  try {
    // Get all active client contracts
    const contractsResult = await pool.query(`
      SELECT 
        c.id as contact_id,
        c.name,
        c.email,
        c.company,
        cc.base_monthly_price,
        cc.base_currency,
        cc.contract_start_date,
        mb.adjusted_price,
        mb.currency,
        mb.adjustment_reason,
        mb.adjustment_type,
        mb.adjustment_amount,
        mb.billing_status,
        COALESCE(mb.adjusted_price, cc.base_monthly_price) as final_price,
        COALESCE(mb.currency, cc.base_currency) as final_currency
      FROM contacts c
      INNER JOIN client_contracts cc ON c.id = cc.contact_id
      LEFT JOIN monthly_billing mb ON c.id = mb.contact_id 
        AND mb.year = $1 AND mb.month = $2
      WHERE cc.is_active = true
      ORDER BY COALESCE(c.company, c.name)
    `, [year, month]);
    
    res.json({
      success: true,
      data: contractsResult.rows,
      year: parseInt(year),
      month: parseInt(month)
    });
  } catch (error) {
    console.error('Error fetching monthly billing:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch monthly billing data'
    });
  }
});

// Update monthly billing for a specific contact and month
app.post('/api/monthly-billing/:contactId/:year/:month', async (req, res) => {
  const { contactId, year, month } = req.params;
  const { 
    adjusted_price, 
    currency, 
    adjustment_reason, 
    adjustment_type,
    billing_status 
  } = req.body;
  
  try {
    // Get the base contract data
    const contractResult = await pool.query(`
      SELECT base_monthly_price, base_currency 
      FROM client_contracts 
      WHERE contact_id = $1 AND is_active = true
    `, [contactId]);
    
    if (contractResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No active contract found for this contact'
      });
    }
    
    const contract = contractResult.rows[0];
    const basePrice = contract.base_monthly_price;
    const adjustmentAmount = adjusted_price - basePrice;
    
    // Insert or update monthly billing record
    const result = await pool.query(`
      INSERT INTO monthly_billing (
        contact_id, year, month, adjusted_price, currency, 
        adjustment_reason, adjustment_type, base_price, 
        adjustment_amount, billing_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (contact_id, year, month) 
      DO UPDATE SET 
        adjusted_price = $4,
        currency = $5,
        adjustment_reason = $6,
        adjustment_type = $7,
        adjustment_amount = $9,
        billing_status = $10,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      contactId, year, month, adjusted_price, currency,
      adjustment_reason, adjustment_type, basePrice,
      adjustmentAmount, billing_status || 'pending'
    ]);
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating monthly billing:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update monthly billing'
    });
  }
});

// Get contract details for a specific contact
app.get('/api/contracts/:contactId', async (req, res) => {
  const { contactId } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT 
        cc.*,
        c.name,
        c.email
      FROM client_contracts cc
      INNER JOIN contacts c ON cc.contact_id = c.id
      WHERE cc.contact_id = $1 AND cc.is_active = true
    `, [contactId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No contract found for this contact'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching contract:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contract data'
    });
  }
});

// PROJECT MANAGEMENT ENDPOINTS

// Get all projects
app.get('/api/projects', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.*,
        c.name as contact_name,
        c.email as contact_email,
        c.company,
        COALESCE(SUM(pp.amount), 0) as total_paid,
        COUNT(pp.id) as payment_count
      FROM projects p
      INNER JOIN contacts c ON p.contact_id = c.id
      LEFT JOIN project_payments pp ON p.id = pp.project_id AND pp.payment_status = 'received'
      GROUP BY p.id, c.name, c.email, c.company
      ORDER BY p.created_at DESC
    `);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch projects'
    });
  }
});

// Get projects for a specific month
app.get('/api/projects/:year/:month', async (req, res) => {
  const { year, month } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT 
        p.*,
        c.name as client_name,
        c.email as client_email,
        c.company,
        COALESCE(SUM(CASE WHEN pp.payment_status = 'received' THEN pp.amount ELSE 0 END), 0) as paid_amount,
        COALESCE(SUM(CASE WHEN pp.payment_status = 'pending' THEN pp.amount ELSE 0 END), 0) as pending_amount,
        COUNT(pp.id) as payment_count
      FROM projects p
      INNER JOIN contacts c ON p.contact_id = c.id
      LEFT JOIN project_payments pp ON p.id = pp.project_id
      WHERE p.project_status = 'active'
      GROUP BY p.id, c.name, c.email, c.company
      ORDER BY p.created_at DESC
    `);
    
    const projects = result.rows.map(project => ({
      ...project,
      paid_amount: parseFloat(project.paid_amount),
      pending_amount: parseFloat(project.pending_amount),
      total_amount: parseFloat(project.total_amount)
    }));
    
    // Get month-specific data
    const monthlyIncomeResult = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as monthly_income
      FROM project_payments
      WHERE payment_year = $1 AND payment_month = $2
    `, [year, month]);
    
    const pendingPaymentsResult = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as pending_payments
      FROM project_payments
      WHERE payment_status = 'pending'
    `);
    
    res.json({
      success: true,
      data: {
        projects: projects,
        activeProjects: projects.length,
        monthlyIncome: parseFloat(monthlyIncomeResult.rows[0].monthly_income),
        pendingPayments: parseFloat(pendingPaymentsResult.rows[0].pending_payments)
      },
      year: parseInt(year),
      month: parseInt(month)
    });
  } catch (error) {
    console.error('Error fetching monthly projects:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch monthly projects'
    });
  }
});

// Create new project
app.post('/api/projects', async (req, res) => {
  const { 
    contact_id, 
    project_name, 
    description, 
    total_amount, 
    currency,
    project_status,
    start_date,
    estimated_end_date
  } = req.body;
  
  try {
    const result = await pool.query(`
      INSERT INTO projects (
        contact_id, project_name, description, total_amount, 
        currency, project_status, start_date, estimated_end_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      contact_id, project_name, description, total_amount,
      currency || 'CLP', project_status || 'active',
      start_date, estimated_end_date
    ]);
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create project'
    });
  }
});

// Update project
app.put('/api/projects/:id', async (req, res) => {
  const { id } = req.params;
  const { 
    project_name, 
    description, 
    total_amount, 
    currency,
    project_status,
    start_date,
    estimated_end_date
  } = req.body;
  
  try {
    const result = await pool.query(`
      UPDATE projects 
      SET project_name = $1, description = $2, total_amount = $3, 
          currency = $4, project_status = $5, start_date = $6, 
          estimated_end_date = $7, updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
    `, [
      project_name, description, total_amount, currency,
      project_status, start_date, estimated_end_date, id
    ]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update project'
    });
  }
});

// Delete project
app.delete('/api/projects/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    // Delete associated payments first
    await pool.query('DELETE FROM project_payments WHERE project_id = $1', [id]);
    
    // Delete project
    const result = await pool.query('DELETE FROM projects WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Project deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete project'
    });
  }
});

// Get project payments
app.get('/api/projects/:id/payments', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT * FROM project_payments 
      WHERE project_id = $1 
      ORDER BY payment_date DESC
    `, [id]);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching project payments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch project payments'
    });
  }
});

// Add project payment
app.post('/api/projects/:id/payments', async (req, res) => {
  const { id } = req.params;
  const { 
    amount, 
    currency, 
    payment_date, 
    payment_status, 
    notes 
  } = req.body;
  
  try {
    const paymentDateObj = new Date(payment_date);
    const payment_year = paymentDateObj.getFullYear();
    const payment_month = paymentDateObj.getMonth() + 1;
    
    const result = await pool.query(`
      INSERT INTO project_payments (
        project_id, amount, currency, payment_date, 
        payment_month, payment_year, payment_status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      id, amount, currency || 'CLP', payment_date,
      payment_month, payment_year, payment_status || 'pending', notes
    ]);
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error adding project payment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add project payment'
    });
  }
});

// Get financial summary
app.get('/api/financial-summary/:year/:month', async (req, res) => {
  const { year, month } = req.params;
  
  try {
    // Get current UF value first
    let currentUFValue = 37000; // Default fallback
    try {
      const ufResponse = await pool.query('SELECT value FROM uf_values ORDER BY date DESC LIMIT 1');
      if (ufResponse.rows.length > 0) {
        currentUFValue = parseFloat(ufResponse.rows[0].value);
      }
    } catch (ufError) {
      console.log('UF value not found in database, using fallback:', currentUFValue);
    }
    
    // Get monthly billing data directly from database
    const monthlyBillingResult = await pool.query(`
      SELECT 
        c.id as contact_id,
        c.name,
        c.email,
        c.company,
        cc.base_monthly_price,
        cc.base_currency,
        cc.contract_start_date,
        mb.adjusted_price,
        mb.currency,
        mb.adjustment_reason,
        mb.adjustment_type,
        mb.adjustment_amount,
        mb.billing_status,
        COALESCE(mb.adjusted_price, cc.base_monthly_price) as final_price,
        COALESCE(mb.currency, cc.base_currency) as final_currency
      FROM contacts c
      INNER JOIN client_contracts cc ON c.id = cc.contact_id
      LEFT JOIN monthly_billing mb ON c.id = mb.contact_id AND mb.year = $1 AND mb.month = $2
      WHERE cc.is_active = true
      ORDER BY COALESCE(c.company, c.name)
    `, [year, month]);
    
    let monthlyTotalCLP = 0;
    let monthlyTotalUF = 0;
    const monthlyClients = monthlyBillingResult.rows;
    
    monthlyClients.forEach(client => {
      if (client.final_price) {
        if (client.final_currency === 'UF') {
          monthlyTotalUF += parseFloat(client.final_price);
          monthlyTotalCLP += parseFloat(client.final_price) * currentUFValue;
        } else {
          monthlyTotalCLP += parseFloat(client.final_price);
        }
      }
    });
    
    // Get project payments for the month
    const projectPaymentsResult = await pool.query(`
      SELECT 
        pp.*,
        p.project_name,
        c.name as client_name,
        c.email as client_email,
        c.company
      FROM project_payments pp
      INNER JOIN projects p ON pp.project_id = p.id
      INNER JOIN contacts c ON p.contact_id = c.id
      WHERE pp.payment_year = $1 AND pp.payment_month = $2
      ORDER BY pp.payment_date DESC
    `, [year, month]);
    
    let projectsTotalCLP = 0;
    const projectPayments = projectPaymentsResult.rows;
    
    projectPayments.forEach(payment => {
      if (payment.currency === 'UF') {
        projectsTotalCLP += parseFloat(payment.amount) * currentUFValue;
      } else {
        projectsTotalCLP += parseFloat(payment.amount);
      }
    });
    
    res.json({
      success: true,
      data: {
        monthlyBilling: {
          totalCLP: monthlyTotalCLP,
          totalUF: monthlyTotalUF,
          clients: monthlyClients
        },
        projects: {
          totalCLP: projectsTotalCLP,
          payments: projectPayments
        },
        currentUFValue: currentUFValue,
        year: parseInt(year),
        month: parseInt(month)
      }
    });
  } catch (error) {
    console.error('Error fetching financial summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch financial summary'
    });
  }
});

// Sync event attendee tags with contact tags
app.post('/api/sync-attendee-tags', async (req, res) => {
  const { eventId, attendeeEmail, tags } = req.body;
  
  try {
    // Validate input
    if (!eventId || !attendeeEmail || !Array.isArray(tags)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: eventId, attendeeEmail, tags'
      });
    }
    
    // Check if the email is an IntoTheCom email
    const isIntothecomEmail = attendeeEmail.includes('@intothecom.com') || attendeeEmail.includes('@intothecom');
    
    if (isIntothecomEmail && tags.includes('New Lead')) {
      return res.status(400).json({
        success: false,
        error: 'Cannot mark IntoTheCom emails as leads'
      });
    }
    
    // Find or create contact
    let contact = await pool.query('SELECT * FROM contacts WHERE email = $1', [attendeeEmail]);
    
    if (contact.rows.length === 0) {
      // Create new contact if doesn't exist
      const name = attendeeEmail.split('@')[0];
      const insertResult = await pool.query(
        'INSERT INTO contacts (email, name, first_seen, last_seen, tags) VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, $3) RETURNING *',
        [attendeeEmail, name, tags]
      );
      contact = insertResult;
    } else {
      // Update existing contact with new tags
      const updateResult = await pool.query(
        'UPDATE contacts SET tags = $1, updated_at = CURRENT_TIMESTAMP WHERE email = $2 RETURNING *',
        [tags, attendeeEmail]
      );
      contact = updateResult;
    }
    
    res.json({
      success: true,
      data: contact.rows[0],
      message: 'Attendee tags synchronized successfully'
    });
    
  } catch (error) {
    console.error('Error syncing attendee tags:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to sync attendee tags: ' + error.message
    });
  }
});

// Get available tags
app.get('/api/tags', async (req, res) => {
  try {
    // Get all tags from tags table with usage count
    const result = await pool.query(`
      SELECT 
        t.name as tag,
        t.color,
        t.id,
        COALESCE(contact_counts.count, 0) as count
      FROM tags t
      LEFT JOIN (
        SELECT 
          tag,
          COUNT(*) as count
        FROM (
          SELECT UNNEST(tags) as tag
          FROM contacts
          WHERE tags IS NOT NULL AND array_length(tags, 1) > 0
        ) as all_tags
        GROUP BY tag
      ) contact_counts ON t.name = contact_counts.tag
      ORDER BY count DESC, t.name ASC
    `);
    
    const tags = result.rows.map(row => ({
      id: row.id,
      tag: row.tag,
      color: row.color,
      count: parseInt(row.count) || 0
    }));
    
    res.json({
      success: true,
      data: tags
    });
  } catch (error) {
    console.error('Error fetching tags:', error);
    
    // Fallback response
    res.json({
      success: true,
      data: [
        { id: 1, tag: 'New Lead', color: '#FF6B00', count: 0 }
      ]
    });
  }
});

// Create new tag
app.post('/api/tags', async (req, res) => {
  const { name, color } = req.body;
  
  if (!name || !name.trim()) {
    return res.status(400).json({
      success: false,
      error: 'Tag name is required'
    });
  }
  
  try {
    const result = await pool.query(`
      INSERT INTO tags (name, color) 
      VALUES ($1, $2) 
      RETURNING *
    `, [name.trim(), color || '#FF6B00']);
    
    res.json({
      success: true,
      data: {
        id: result.rows[0].id,
        tag: result.rows[0].name,
        color: result.rows[0].color,
        count: 0
      },
      message: 'Tag created successfully'
    });
  } catch (error) {
    console.error('Error creating tag:', error);
    
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({
        success: false,
        error: 'Tag already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to create tag'
    });
  }
});

// Update tag
app.put('/api/tags/:tagId', async (req, res) => {
  const { tagId } = req.params;
  const { name, color } = req.body;
  
  if (!name || !name.trim()) {
    return res.status(400).json({
      success: false,
      error: 'Name is required'
    });
  }
  
  try {
    // Get current tag data
    const currentTagResult = await pool.query('SELECT name FROM tags WHERE id = $1', [tagId]);
    
    if (currentTagResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Tag not found'
      });
    }
    
    const currentTagName = currentTagResult.rows[0].name;
    const newTagName = name.trim();
    
    // Check if new name already exists (if different from current)
    if (currentTagName !== newTagName) {
      const existingTagResult = await pool.query('SELECT id FROM tags WHERE name = $1 AND id != $2', [newTagName, tagId]);
      
      if (existingTagResult.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Tag name already exists'
        });
      }
    }
    
    // Update tag in database
    const result = await pool.query(`
      UPDATE tags 
      SET name = $1, color = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [newTagName, color || '#FF6B00', tagId]);
    
    // If tag name changed, update all contacts that have this tag
    if (currentTagName !== newTagName) {
      await pool.query(`
        UPDATE contacts 
        SET tags = array_remove(tags, $1) || ARRAY[$2],
            updated_at = CURRENT_TIMESTAMP
        WHERE tags @> ARRAY[$1]
      `, [currentTagName, newTagName]);
    }
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Tag updated successfully'
    });
  } catch (error) {
    console.error('Error updating tag:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update tag'
    });
  }
});

// Delete tag
app.delete('/api/tags/:tagId', async (req, res) => {
  const { tagId } = req.params;
  
  try {
    // First, get the tag name to remove it from contacts
    const tagResult = await pool.query('SELECT name FROM tags WHERE id = $1', [tagId]);
    
    if (tagResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Tag not found'
      });
    }
    
    const tagName = tagResult.rows[0].name;
    
    // Don't allow deleting "New Lead" tag
    if (tagName === 'New Lead') {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete the default "New Lead" tag'
      });
    }
    
    // Remove tag from all contacts
    await pool.query(`
      UPDATE contacts 
      SET tags = array_remove(tags, $1),
          updated_at = CURRENT_TIMESTAMP
      WHERE tags @> ARRAY[$1]
    `, [tagName]);
    
    // Delete the tag
    await pool.query('DELETE FROM tags WHERE id = $1', [tagId]);
    
    res.json({
      success: true,
      message: 'Tag deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting tag:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete tag'
    });
  }
});

// Get event details
app.get('/api/events/:eventId', async (req, res) => {
  const { eventId } = req.params;
  
  try {
    if (!oAuth2Client) {
      return res.status(500).json({
        success: false,
        error: 'Google Calendar client not configured'
      });
    }
    
    if (!storedTokens) {
      return res.status(401).json({
        success: false,
        error: 'Google Calendar not authenticated'
      });
    }
    
    // Set credentials to ensure they're current
    oAuth2Client.setCredentials(storedTokens);
    
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
    const response = await calendar.events.get({
      calendarId: 'primary',
      eventId: eventId
    });
    
    const event = response.data;
    
    // Get notes from local database with fallback
    try {
      const dbResult = await pool.query('SELECT notes FROM events WHERE google_event_id = $1', [eventId]);
      if (dbResult.rows.length > 0) {
        event.notes = dbResult.rows[0].notes;
      } else {
        event.notes = '';
      }
    } catch (dbError) {
      console.log('Could not fetch notes from database:', dbError.message);
      event.notes = '';
    }
    
    res.json({
      success: true,
      data: event
    });
  } catch (error) {
    console.error('Error fetching event details:', error);
    if (error.code === 401 || error.code === 403) {
      // Clear expired tokens
      storedTokens = null;
      if (oAuth2Client) {
        oAuth2Client.setCredentials({});
      }
      res.status(401).json({
        success: false,
        error: 'Google Calendar authentication expired'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch event details: ' + error.message
      });
    }
  }
});

// Delete event
app.delete('/api/events/:eventId', async (req, res) => {
  const { eventId } = req.params;
  
  try {
    if (!oAuth2Client) {
      return res.status(500).json({
        success: false,
        error: 'Google Calendar client not configured'
      });
    }
    
    if (!storedTokens) {
      return res.status(401).json({
        success: false,
        error: 'Google Calendar not authenticated'
      });
    }
    
    // Set credentials to ensure they're current
    oAuth2Client.setCredentials(storedTokens);

    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
    
    // Delete the event from Google Calendar
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: eventId
    });
    
    // Delete from local database
    await pool.query('DELETE FROM events WHERE google_event_id = $1', [eventId]);
    
    res.json({
      success: true,
      message: 'Reunión eliminada exitosamente'
    });
    
  } catch (error) {
    console.error('Error deleting event:', error);
    
    if (error.code === 401 || error.code === 403) {
      // Clear expired tokens
      storedTokens = null;
      if (oAuth2Client) {
        oAuth2Client.setCredentials({});
      }
      res.status(401).json({
        success: false,
        error: 'Google Calendar authentication expired'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Error al eliminar la reunión'
      });
    }
  }
});

// Update event
app.post('/api/events/:eventId', async (req, res) => {
  const { eventId } = req.params;
  const { summary, description, attendees, notes, start, end } = req.body;
  
  try {
    if (!oAuth2Client) {
      return res.status(500).json({
        success: false,
        error: 'Google Calendar client not configured'
      });
    }
    
    if (!storedTokens) {
      return res.status(401).json({
        success: false,
        error: 'Google Calendar not authenticated'
      });
    }
    
    // Set credentials to ensure they're current
    oAuth2Client.setCredentials(storedTokens);
    
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
    
    // Get current event
    const currentEvent = await calendar.events.get({
      calendarId: 'primary',
      eventId: eventId
    });
    
    // Build update data
    const updateData = {
      summary: summary || currentEvent.data.summary,
      description: description || currentEvent.data.description,
      attendees: attendees || currentEvent.data.attendees
    };
    
    // Add date/time if provided
    if (start) {
      updateData.start = start;
    }
    if (end) {
      updateData.end = end;
    }
    
    console.log('Updating event with data:', JSON.stringify(updateData, null, 2));
    
    const response = await calendar.events.update({
      calendarId: 'primary',
      eventId: eventId,
      requestBody: updateData
    });
    
    // Update local database
    try {
      await pool.query(
        'UPDATE events SET notes = $1, summary = $2, description = $3, start_time = $4, end_time = $5 WHERE google_event_id = $6',
        [
          notes || '', 
          summary || '', 
          description || '',
          start && start.dateTime ? start.dateTime : start?.date,
          end && end.dateTime ? end.dateTime : end?.date,
          eventId
        ]
      );
    } catch (dbError) {
      console.error('Error updating local database:', dbError);
      // Don't fail the entire request if database update fails
    }
    
    res.json({
      success: true,
      data: response.data,
      message: 'Event updated successfully'
    });
  } catch (error) {
    console.error('Error updating event:', error);
    console.error('Error details:', error.response?.data || error.message);
    
    if (error.code === 401 || error.code === 403) {
      // Clear expired tokens
      storedTokens = null;
      if (oAuth2Client) {
        oAuth2Client.setCredentials({});
      }
      res.status(401).json({
        success: false,
        error: 'Google Calendar authentication expired'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to update event: ' + (error.response?.data?.error?.message || error.message)
      });
    }
  }
});

// Real sync endpoint with Google Calendar
app.post('/api/sync', async (req, res) => {
  try {
    console.log('Real sync requested with Google Calendar');
    
    if (!oAuth2Client || !storedTokens) {
      return res.status(401).json({
        success: false,
        error: 'Google Calendar not authenticated'
      });
    }
    
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
    
    // Get events from the last 30 days
    const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const timeMax = new Date();
    
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 1000
    });
    
    const events = response.data.items || [];
    console.log('Processing ' + events.length + ' events for contact sync');
    
    const result = {
      newContacts: [],
      totalContacts: 0,
      eventsProcessed: events.length,
      errors: []
    };
    
    // Process each event
    for (const event of events) {
      try {
        if (event.attendees && event.attendees.length > 0) {
          for (const attendee of event.attendees) {
            if (attendee.email && attendee.email.includes('@')) {
              await processContactFromEvent(attendee, event, result, null);
            }
          }
        }
        
        // Store event in database
        await storeEventInDatabase(event);
        
      } catch (eventError) {
        console.error('Error processing event:', event.id, eventError);
        result.errors.push('Event ' + event.id + ': ' + eventError.message);
      }
    }
    
    // Get total contacts count
    const contacts = await pool.query('SELECT COUNT(*) FROM contacts');
    result.totalContacts = parseInt(contacts.rows[0].count);
    
    res.json({
      success: true,
      data: result,
      message: 'Sync completed: ' + result.newContacts.length + ' new contacts, ' + result.eventsProcessed + ' events processed'
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

// Helper function to process contacts from events
async function processContactFromEvent(attendee, event, result, attendeeTags = null) {
  const email = attendee.email.toLowerCase();
  const name = attendee.displayName || attendee.email.split('@')[0];
  const eventDate = new Date(event.start.dateTime || event.start.date);
  
  try {
    // Check if contact already exists
    const existingContact = await pool.query(
      'SELECT * FROM contacts WHERE email = $1',
      [email]
    );
    
    // Get tags for this attendee
    let contactTags = [];
    if (attendeeTags && attendeeTags[email]) {
      contactTags = Array.isArray(attendeeTags[email]) ? attendeeTags[email] : [attendeeTags[email]];
    } else if (!email.includes('@intothecom.com') && !email.includes('@intothecom')) {
      // Default tag for external attendees
      contactTags = ['New Lead'];
    }
    
    if (existingContact.rows.length > 0) {
      // Update existing contact
      if (contactTags.length > 0) {
        await pool.query(
          'UPDATE contacts SET last_seen = $1, meeting_count = meeting_count + 1, name = COALESCE(NULLIF($2, \'\'), name), tags = $4 WHERE email = $3',
          [eventDate.toISOString().split('T')[0], name, email, contactTags]
        );
      } else {
        await pool.query(
          'UPDATE contacts SET last_seen = $1, meeting_count = meeting_count + 1, name = COALESCE(NULLIF($2, \'\'), name) WHERE email = $3',
          [eventDate.toISOString().split('T')[0], name, email]
        );
      }
    } else {
      // Create new contact
      await pool.query(
        'INSERT INTO contacts (email, name, first_seen, last_seen, meeting_count, tags) VALUES ($1, $2, $3, $4, 1, $5)',
        [email, name, eventDate.toISOString().split('T')[0], eventDate.toISOString().split('T')[0], contactTags]
      );
      
      result.newContacts.push({
        email: email,
        name: name,
        first_seen: eventDate.toISOString().split('T')[0],
        tags: contactTags
      });
    }
  } catch (error) {
    console.error('Error processing contact:', email, error);
    throw error;
  }
}

// Helper function to store events in database
async function storeEventInDatabase(event) {
  const eventId = event.id;
  const summary = event.summary || '';
  const description = event.description || '';
  const startTime = event.start.dateTime || event.start.date;
  const endTime = event.end.dateTime || event.end.date;
  const attendeesCount = event.attendees ? event.attendees.length : 0;
  const attendeesEmails = event.attendees ? event.attendees.map(a => a.email).join(', ') : '';
  const hangoutLink = event.hangoutLink || '';
  
  try {
    await pool.query(
      `INSERT INTO events (google_event_id, summary, description, start_time, end_time, attendees_count, attendees_emails, hangout_link) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (google_event_id) DO UPDATE SET
       summary = EXCLUDED.summary,
       description = EXCLUDED.description,
       start_time = EXCLUDED.start_time,
       end_time = EXCLUDED.end_time,
       attendees_count = EXCLUDED.attendees_count,
       attendees_emails = EXCLUDED.attendees_emails,
       hangout_link = EXCLUDED.hangout_link`,
      [eventId, summary, description, startTime, endTime, attendeesCount, attendeesEmails, hangoutLink]
    );
  } catch (error) {
    console.error('Error storing event in database:', eventId, error);
    throw error;
  }
}

// Google Calendar Authentication
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
let oAuth2Client = null;
let storedTokens = null;

// Initialize Google OAuth2 client
function initializeGoogleAuth() {
  if (process.env.NODE_ENV === 'production') {
    // In production, we need to configure OAuth2 with environment variables
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      oAuth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI || 'https://crm-intothecom-production.up.railway.app/api/auth/google/callback'
      );
    }
  } else {
    // In development, use the credentials file
    const CREDENTIALS_PATH = path.join(__dirname, 'client_secret_419586581117-g9jfcu1hk0sr757gkp9cukbu148b90d8.apps.googleusercontent.com.json');
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      const { client_secret, client_id, redirect_uris } = credentials.installed;
      
      oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
      );
    }
  }
}

// Google Auth will be initialized in initDatabase() function

// Google Authentication endpoints
app.get('/api/auth/google', (req, res) => {
  if (!oAuth2Client) {
    return res.status(500).json({
      success: false,
      error: 'Google authentication not configured'
    });
  }

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  res.json({
    success: true,
    authUrl: authUrl
  });
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).send(
      '<html>' +
        '<head><title>Authentication Error</title></head>' +
        '<body>' +
          '<h2>❌ Authentication Error</h2>' +
          '<p>Authorization code missing. Please try again.</p>' +
          '<script>' +
            'console.log("Callback error page loaded");' +
            'if (window.opener) {' +
              'console.log("Found opener window, sending error message");' +
              'window.opener.postMessage({type: "google-auth-error", error: "Authorization code missing"}, "*");' +
              'console.log("Error message sent, closing window");' +
              'setTimeout(function() {' +
                'window.close();' +
              '}, 3000);' +
            '} else {' +
              'console.log("No opener window found");' +
            '}' +
          '</script>' +
        '</body>' +
      '</html>'
    );
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    storedTokens = tokens;
    
    // Log token details for debugging
    console.log('🔐 Received tokens:', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      tokenType: tokens.token_type,
      expiryDate: tokens.expiry_date,
      scopes: tokens.scope
    });
    
    if (!tokens.refresh_token) {
      console.log('⚠️  WARNING: No refresh_token received! This may cause authentication issues.');
    }
    
    // Persist tokens to database
    try {
      await pool.query(`
        INSERT INTO google_tokens (id, tokens, created_at, updated_at) 
        VALUES (1, $1, NOW(), NOW())
        ON CONFLICT (id) 
        DO UPDATE SET tokens = $1, updated_at = NOW()
      `, [JSON.stringify(tokens)]);
      console.log('✅ Tokens persisted to database');
    } catch (dbError) {
      console.error('❌ Error persisting tokens to database:', dbError);
    }
    
    console.log('🎉 Google Calendar authentication successful');
    
    res.send(
      '<html>' +
        '<head><title>Authentication Successful</title></head>' +
        '<body>' +
          '<h2>✅ Authentication Successful!</h2>' +
          '<p>You can now close this window and return to your CRM.</p>' +
          '<script>' +
            'console.log("Callback page loaded");' +
            'if (window.opener) {' +
              'console.log("Found opener window, sending message");' +
              'window.opener.postMessage({type: "google-auth-success"}, "*");' +
              'console.log("Message sent, closing window");' +
              'setTimeout(function() {' +
                'window.close();' +
              '}, 2000);' +
            '} else {' +
              'console.log("No opener window found");' +
            '}' +
          '</script>' +
        '</body>' +
      '</html>'
    );
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).send(
      '<html>' +
        '<head><title>Authentication Error</title></head>' +
        '<body>' +
          '<h2>❌ Authentication Error</h2>' +
          '<p>Authentication failed. Please try again.</p>' +
          '<script>' +
            'console.log("Callback error page loaded");' +
            'if (window.opener) {' +
              'console.log("Found opener window, sending error message");' +
              'window.opener.postMessage({type: "google-auth-error", error: "Authentication failed"}, "*");' +
              'console.log("Error message sent, closing window");' +
              'setTimeout(function() {' +
                'window.close();' +
              '}, 3000);' +
            '} else {' +
              'console.log("No opener window found");' +
            '}' +
          '</script>' +
        '</body>' +
      '</html>'
    );
  }
});

// DEBUG: Temporary endpoint to check OAuth configuration
app.get('/api/auth/debug', async (req, res) => {
  try {
    // Get tokens from database
    const tokenResult = await pool.query('SELECT tokens, created_at, updated_at FROM google_tokens ORDER BY created_at DESC LIMIT 1');
    const dbTokens = tokenResult.rows.length > 0 ? tokenResult.rows[0] : null;
    
    res.json({
      environment: process.env.NODE_ENV,
      hasGoogleClientId: !!process.env.GOOGLE_CLIENT_ID,
      hasGoogleClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
      googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || 'https://crm-intothecom-production.up.railway.app/api/auth/google/callback',
      hasOAuthClient: !!oAuth2Client,
      hasStoredTokens: !!storedTokens,
      storedTokensKeys: storedTokens ? Object.keys(storedTokens) : null,
      databaseTokens: dbTokens ? {
        hasAccessToken: !!dbTokens.tokens?.access_token,
        hasRefreshToken: !!dbTokens.tokens?.refresh_token,
        tokenType: dbTokens.tokens?.token_type,
        expiryDate: dbTokens.tokens?.expiry_date,
        isExpired: dbTokens.tokens?.expiry_date ? Date.now() > dbTokens.tokens.expiry_date : 'unknown',
        createdAt: dbTokens.created_at,
        updatedAt: dbTokens.updated_at,
        availableKeys: dbTokens.tokens ? Object.keys(dbTokens.tokens) : null
      } : null
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    res.status(500).json({
      error: 'Failed to get debug info',
      message: error.message
    });
  }
});

// Disconnect Google Calendar authentication
app.post('/api/auth/disconnect', async (req, res) => {
  try {
    // Clear stored tokens
    storedTokens = null;
    
    // Clear tokens from database
    await pool.query('DELETE FROM google_tokens');
    
    // Reset OAuth2 client
    if (oAuth2Client) {
      oAuth2Client.setCredentials({});
    }
    
    res.json({
      success: true,
      message: 'Google Calendar disconnected successfully'
    });
  } catch (error) {
    console.error('Error disconnecting Google Calendar:', error);
    res.status(500).json({
      success: false,
      error: 'Error disconnecting Google Calendar'
    });
  }
});

// Check authentication status
app.get('/api/auth/status', async (req, res) => {
  try {
    console.log('Auth status check - oAuth2Client exists:', !!oAuth2Client);
    console.log('Auth status check - storedTokens exists:', !!storedTokens);
    
    const isAuthenticated = !!(oAuth2Client && storedTokens);
    
    if (isAuthenticated) {
      console.log('Testing tokens validity...');
      try {
        // Verify tokens are still valid by making a test request
        const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
        await calendar.calendarList.list({ maxResults: 1 });
        console.log('Tokens are valid');
      } catch (tokenError) {
        console.log('Token validation failed, but keeping authentication state:', tokenError.message);
        // Don't invalidate authentication immediately - tokens might be temporarily invalid
        // Let the user stay authenticated and handle token refresh in actual API calls
      }
    }
    
    res.json({
      success: true,
      authenticated: isAuthenticated,
      message: isAuthenticated ? 'Google Calendar conectado' : 'Google Calendar desconectado'
    });
  } catch (error) {
    // Tokens are invalid or expired
    console.error('Auth verification failed:', error);
    storedTokens = null;
    if (oAuth2Client) {
      oAuth2Client.setCredentials({});
    }
    
    res.json({
      success: true,
      authenticated: false,
      message: 'Google Calendar desconectado'
    });
  }
});

// Google Calendar Events endpoint
app.get('/api/calendar/events', async (req, res) => {
  
  if (!oAuth2Client) {
    return res.status(500).json({
      success: false,
      error: 'Google authentication not configured'
    });
  }

  if (!storedTokens) {
    console.log('ERROR: storedTokens not found, attempting to reload from database');
    // Try to reload tokens from database
    try {
      const tokenResult = await pool.query('SELECT tokens FROM google_tokens ORDER BY created_at DESC LIMIT 1');
      if (tokenResult.rows.length > 0) {
        storedTokens = tokenResult.rows[0].tokens;
        console.log('Tokens reloaded from database');
      } else {
        console.log('No tokens found in database');
        return res.status(401).json({
          success: false,
          error: 'Google Calendar not authenticated'
        });
      }
    } catch (dbError) {
      console.log('Database error loading tokens:', dbError);
      return res.status(500).json({
        success: false,
        error: 'Database error loading authentication tokens'
      });
    }
  }

  try {
    // Set credentials to ensure they're current
    oAuth2Client.setCredentials(storedTokens);
    
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
    const view = req.query.view || 'week';
    const dateParam = req.query.date;
    
    console.log('View:', view, 'Date param:', dateParam);
    
    const now = dateParam ? new Date(dateParam) : new Date();
    console.log('Parsed date:', now, 'Is valid:', !isNaN(now.getTime()));
    
    // Validate date parameter
    if (dateParam && isNaN(now.getTime())) {
      console.log('ERROR: Invalid date parameter');
      return res.status(400).json({
        success: false,
        error: 'Invalid date parameter provided'
      });
    }
    
    let timeMin, timeMax;
    
    switch (view) {
      case 'day':
        timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
        break;
      case 'week':
        const startOfWeek = new Date(now.getTime() - (now.getDay() * 24 * 60 * 60 * 1000));
        timeMin = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate(), 0, 0, 0);
        timeMax = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate() + 6, 23, 59, 59);
        break;
      case 'month':
      default:
        // For month view, we need to include days from adjacent weeks
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        
        // Start from the first day of the week containing the first day of the month
        const startOfMonthView = new Date(firstDayOfMonth);
        startOfMonthView.setDate(startOfMonthView.getDate() - firstDayOfMonth.getDay());
        startOfMonthView.setHours(0, 0, 0, 0);
        
        // End on the last day of the week containing the last day of the month
        const endOfMonthView = new Date(lastDayOfMonth);
        endOfMonthView.setDate(endOfMonthView.getDate() + (6 - lastDayOfMonth.getDay()));
        endOfMonthView.setHours(23, 59, 59, 999);
        
        timeMin = startOfMonthView;
        timeMax = endOfMonthView;
        
        console.log('Month view range:', {
          requestedDate: dateParam || 'current',
          firstDay: firstDayOfMonth.toDateString(),
          lastDay: lastDayOfMonth.toDateString(),
          startView: startOfMonthView.toDateString(),
          endView: endOfMonthView.toDateString(),
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString()
        });
        break;
    }
    
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];
    console.log('Events fetched for ' + view + ' view:', {
      count: events.length,
      firstEvent: events[0] ? {
        summary: events[0].summary,
        start: events[0].start?.dateTime || events[0].start?.date
      } : null,
      lastEvent: events[events.length - 1] ? {
        summary: events[events.length - 1].summary,
        start: events[events.length - 1].start?.dateTime || events[events.length - 1].start?.date
      } : null
    });

    res.json({
      success: true,
      data: events,
      view: view,
      timeRange: {
        start: timeMin.toISOString(),
        end: timeMax.toISOString()
      }
    });
  } catch (error) {
    console.error('Calendar events error:', error);
    
    // Handle authentication errors with automatic token refresh
    if (error.code === 401 || error.code === 403 || error.message.includes('No refresh token')) {
      console.log('Authentication error, attempting to refresh tokens...');
      
      try {
        // Try to get fresh tokens from database
        const tokenResult = await pool.query('SELECT tokens FROM google_tokens ORDER BY created_at DESC LIMIT 1');
        if (tokenResult.rows.length > 0) {
          const dbTokens = tokenResult.rows[0].tokens;
          
          // If we have a refresh token in database, try to refresh
          if (dbTokens.refresh_token) {
            console.log('🔄 Attempting automatic token refresh...');
            console.log('🔐 Current tokens state:', {
              hasAccessToken: !!dbTokens.access_token,
              hasRefreshToken: !!dbTokens.refresh_token,
              expiryDate: dbTokens.expiry_date,
              isExpired: dbTokens.expiry_date ? Date.now() > dbTokens.expiry_date : 'unknown'
            });
            
            oAuth2Client.setCredentials(dbTokens);
            
            // Force token refresh
            const newTokens = await oAuth2Client.refreshAccessToken();
            storedTokens = newTokens.credentials;
            
            console.log('🔐 New tokens received:', {
              hasAccessToken: !!storedTokens.access_token,
              hasRefreshToken: !!storedTokens.refresh_token,
              expiryDate: storedTokens.expiry_date
            });
            
            // Save refreshed tokens back to database
            await pool.query(
              'UPDATE google_tokens SET tokens = $1, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM google_tokens ORDER BY created_at DESC LIMIT 1)',
              [JSON.stringify(storedTokens)]
            );
            
            console.log('✅ Tokens refreshed automatically and saved to database');
            
            // Retry the original request
            const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
            const response = await calendar.events.list({
              calendarId: 'primary',
              timeMin: timeMin.toISOString(),
              timeMax: timeMax.toISOString(),
              singleEvents: true,
              orderBy: 'startTime',
            });
            
            const events = response.data.items || [];
            return res.json({
              success: true,
              data: events,
              view: view,
              timeRange: {
                start: timeMin.toISOString(),
                end: timeMax.toISOString()
              }
            });
          } else {
            console.log('❌ No refresh token available in database');
            console.log('🔐 Available tokens:', Object.keys(dbTokens));
          }
        }
      } catch (refreshError) {
        console.error('❌ Token refresh failed:', refreshError);
      }
      
      // If refresh fails, clear tokens and require re-authentication
      storedTokens = null;
      if (oAuth2Client) {
        oAuth2Client.setCredentials({});
      }
      
      return res.status(401).json({
        success: false,
        error: 'Google Calendar authentication expired. Please reconnect.',
        requiresReauth: true
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch calendar events',
      details: error.message
    });
  }
});

// Create new calendar event
app.post('/api/events', async (req, res) => {
  if (!oAuth2Client) {
    return res.status(500).json({
      success: false,
      error: 'Google authentication not configured'
    });
  }

  const { summary, description, start, end, attendees, notes, attendeeTags } = req.body;
  
  // Validate required fields
  if (!summary || !start || !end) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: summary, start, end'
    });
  }

  try {
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
    
    // Prepare event data
    const eventData = {
      summary: summary,
      description: description + (notes ? '\n\n--- Internal Notes ---\n' + notes : ''),
      start: {
        dateTime: start,
        timeZone: 'America/New_York'
      },
      end: {
        dateTime: end,
        timeZone: 'America/New_York'
      },
      conferenceData: {
        createRequest: {
          requestId: 'meet-' + Date.now(),
          conferenceSolutionKey: {
            type: 'hangoutsMeet'
          }
        }
      }
    };

    // Add attendees if provided
    if (attendees && Array.isArray(attendees) && attendees.length > 0) {
      eventData.attendees = attendees.map(email => ({ email: email.trim() }));
    }

    // Create the event
    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: eventData,
      conferenceDataVersion: 1, // Required for Google Meet
      sendUpdates: 'all' // Send email invitations to attendees
    });

    const createdEvent = response.data;
    console.log('Event created successfully:', {
      id: createdEvent.id,
      summary: createdEvent.summary,
      start: createdEvent.start?.dateTime || createdEvent.start?.date,
      attendees: createdEvent.attendees?.length || 0
    });

    // Process attendees for contact sync if they exist
    if (createdEvent.attendees && createdEvent.attendees.length > 0) {
      try {
        for (const attendee of createdEvent.attendees) {
          if (attendee.email) {
            await processContactFromEvent(attendee, createdEvent, { newContacts: [] }, attendeeTags);
          }
        }
        console.log('Attendees processed for contact sync with tags:', attendeeTags);
      } catch (syncError) {
        console.error('Error processing attendees for contact sync:', syncError);
      }
    }

    // Debug: Log basic info
    console.log('Sending to client - Event ID:', createdEvent.id);
    
    res.json({
      success: true,
      data: createdEvent,
      message: 'Event created successfully'
    });

  } catch (error) {
    console.error('Error creating calendar event:', error);
    
    if (error.code === 401) {
      res.status(401).json({
        success: false,
        error: 'Authentication required. Please connect to Google Calendar first.'
      });
    } else if (error.code === 403) {
      res.status(403).json({
        success: false,
        error: 'Permission denied. Check your Google Calendar access.'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to create calendar event: ' + (error.message || 'Unknown error')
      });
    }
  }
});

// Serve static files
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Main app route
app.get('/', (req, res) => {
  res.send(String.raw`<!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>IntoTheCom CRM</title>
      <script>
        console.log('=== CRITICAL AUTH SCRIPT LOADING ===');
        
        window.startGoogleAuth = function() {
          console.log('startGoogleAuth called');
          fetch('/api/auth/google')
            .then(response => response.json())
            .then(result => {
              console.log('Auth result:', result);
              if (result.success && result.authUrl) {
                console.log('Opening auth window...');
                const authWindow = window.open(result.authUrl, '_blank', 'width=600,height=600');
                console.log('Auth window opened:', authWindow);
                if (!authWindow) {
                  alert('No se pudo abrir la ventana de autenticación. Verifique que no esté bloqueada por el navegador.');
                }
              } else {
                alert('Error: ' + (result.error || 'Unknown error'));
              }
            })
            .catch(error => {
              console.error('Auth error:', error);
              alert('Error de conexión');
            });
        };
        
        window.authenticateGoogle = window.startGoogleAuth;
        
        // Disconnect Google Calendar function
        window.disconnectGoogle = function() {
          if (confirm('¿Estás seguro que quieres desconectar Google Calendar?')) {
            fetch('/api/auth/disconnect', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              }
            })
            .then(response => response.json())
            .then(result => {
              if (result.success) {
                alert('Google Calendar desconectado exitosamente');
                // Update UI to show disconnected state
                updateAuthButton(false);
                // Clear calendar grid
                const calendarGrid = document.querySelector('.calendar-grid');
                if (calendarGrid) {
                  calendarGrid.innerHTML = '<div class="auth-prompt"><h3>Conecta tu Google Calendar</h3><p>Para ver tus eventos, necesitas conectar tu cuenta de Google Calendar.</p><button class="btn btn-primary" onclick="authenticateGoogle()">Conectar Google Calendar</button></div>';
                }
              } else {
                alert('Error al desconectar: ' + result.error);
              }
            })
            .catch(error => {
              console.error('Error disconnecting:', error);
              alert('Error de conexión al desconectar');
            });
          }
        };
        
        console.log('=== AUTH FUNCTIONS DEFINED ===');
      </script>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
        
        :root {
          --primary-orange: #FF6B00;
          --primary-color: #FF6B00;
          --primary-hover: #FF8533;
          --primary-gradient: linear-gradient(135deg, #FF6B00 0%, #FF8533 100%);
          --secondary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          --dark-gradient: linear-gradient(135deg, #0c0c0c 0%, #1a1a1a 100%);
          --glass-bg: rgba(255, 255, 255, 0.1);
          --glass-border: rgba(255, 255, 255, 0.2);
          --shadow-soft: 0 8px 32px rgba(0, 0, 0, 0.1);
          --shadow-medium: 0 12px 48px rgba(0, 0, 0, 0.15);
          --shadow-hard: 0 20px 60px rgba(0, 0, 0, 0.2);
          --text-primary: #1a202c;
          --text-secondary: #4a5568;
          --text-muted: #718096;
          --surface-primary: #ffffff;
          --surface-secondary: #f8fafc;
          --surface-elevated: #edf2f7;
          --border-light: #e2e8f0;
          --border-medium: #cbd5e0;
          --border-color: #e2e8f0;
          --card-bg: rgba(255, 255, 255, 0.8);
          --header-bg: rgba(255, 255, 255, 0.9);
          --success: #48bb78;
          --success-light: rgba(72, 187, 120, 0.1);
          --success-dark: #2f855a;
          --warning: #ed8936;
          --warning-light: rgba(237, 137, 54, 0.1);
          --warning-dark: #c05621;
          --error: #f56565;
          --error-dark: #c53030;
          --info: #4299e1;
          --info-light: rgba(66, 153, 225, 0.1);
          --info-dark: #2b6cb0;
        }
        
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-weight: 400;
          line-height: 1.6;
          color: var(--text-primary);
          background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
          min-height: 100vh;
          overflow-x: hidden;
        }
        
        .app-container {
          display: flex;
          min-height: 100vh;
        }
        
        .sidebar {
          width: 280px;
          background: var(--dark-gradient);
          position: fixed;
          height: 100vh;
          left: 0;
          top: 0;
          overflow-y: auto;
          border-right: 1px solid rgba(255, 255, 255, 0.1);
          box-shadow: var(--shadow-hard);
          z-index: 1000;
          backdrop-filter: blur(20px);
        }
        
        .sidebar::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(180deg, 
            rgba(255, 107, 0, 0.1) 0%, 
            rgba(255, 107, 0, 0.05) 20%, 
            transparent 100%);
          pointer-events: none;
        }
        
        .sidebar-header {
          padding: 30px 25px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          position: relative;
        }
        
        .logo {
          color: #fff;
          font-size: 28px;
          font-weight: 800;
          display: flex;
          align-items: center;
          gap: 12px;
          text-decoration: none;
          letter-spacing: -0.5px;
        }
        
        .logo::before {
          content: '';
          width: 12px;
          height: 12px;
          background: var(--primary-gradient);
          border-radius: 50%;
          box-shadow: 0 0 20px rgba(255, 107, 0, 0.5);
        }
        
        .logo img {
          height: 48px;
          width: auto;
        }
        
        .nav-menu {
          padding: 20px 0;
        }
        
        .nav-item {
          display: flex;
          align-items: center;
          gap: 15px;
          padding: 16px 25px;
          color: rgba(255, 255, 255, 0.7);
          text-decoration: none;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          border-left: 3px solid transparent;
          margin: 4px 0;
          position: relative;
          cursor: pointer;
          font-weight: 500;
        }
        
        .nav-item::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          width: 0;
          height: 100%;
          background: var(--primary-gradient);
          transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          border-radius: 0 4px 4px 0;
        }
        
        .nav-item:hover::before {
          width: 4px;
        }
        
        .nav-item:hover {
          color: rgba(255, 255, 255, 0.9);
          background: rgba(255, 255, 255, 0.08);
          transform: translateX(4px);
        }
        
        .nav-item.active {
          color: #FF6B00;
          background: rgba(255, 107, 0, 0.15);
          border-left-color: #FF6B00;
          box-shadow: inset 0 0 0 1px rgba(255, 107, 0, 0.2);
        }
        
        .nav-item.active::before {
          width: 4px;
        }
        
        .nav-icon {
          font-size: 20px;
          width: 24px;
          text-align: center;
          opacity: 0.8;
        }
        
        .main-content {
          flex: 1;
          margin-left: 280px;
          padding: 40px;
          min-height: 100vh;
          overflow-x: hidden;
        }
        
        .header {
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          padding: 24px 32px;
          border-radius: 20px;
          box-shadow: var(--shadow-soft);
          margin-bottom: 32px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          position: relative;
          overflow: hidden;
        }
        
        .header::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(135deg, 
            rgba(255, 255, 255, 0.2) 0%, 
            rgba(255, 255, 255, 0.1) 100%);
          pointer-events: none;
        }
        
        .header h1 {
          font-size: 32px;
          font-weight: 700;
          color: var(--text-primary);
          margin: 0;
          letter-spacing: -1px;
          position: relative;
        }
        
        .header-actions {
          display: flex;
          gap: 16px;
          position: relative;
        }
        
        .btn {
          background: var(--primary-gradient);
          color: white;
          border: none;
          padding: 14px 28px;
          border-radius: 12px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 600;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          position: relative;
          overflow: hidden;
          box-shadow: 0 4px 16px rgba(255, 107, 0, 0.3);
        }
        
        .btn::before {
          content: '';
          position: absolute;
          top: 0;
          left: -100%;
          width: 100%;
          height: 100%;
          background: linear-gradient(90deg, 
            transparent, 
            rgba(255, 255, 255, 0.3), 
            transparent);
          transition: left 0.5s;
        }
        
        .btn:hover::before {
          left: 100%;
        }
        
        .btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(255, 107, 0, 0.4);
        }
        
        .btn:active {
          transform: translateY(0);
        }
        
        .btn-primary {
          background: var(--primary-gradient);
          box-shadow: 0 4px 16px rgba(255, 107, 0, 0.3);
        }
        
        .btn-primary:hover {
          box-shadow: 0 8px 24px rgba(255, 107, 0, 0.4);
        }
        
        .btn-outline {
          background: transparent;
          color: #FF6B00;
          border: 2px solid #FF6B00;
          box-shadow: 0 4px 16px rgba(255, 107, 0, 0.15);
        }
        
        .btn-outline:hover {
          background: var(--primary-gradient);
          color: white;
          box-shadow: 0 8px 24px rgba(255, 107, 0, 0.3);
        }
        
        .btn-secondary {
          background: var(--secondary-gradient);
          box-shadow: 0 4px 16px rgba(102, 126, 234, 0.3);
        }
        
        .btn-secondary:hover {
          box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4);
        }
        
        .btn-create-event {
          background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);
          color: white;
          border: none;
          padding: 12px 20px;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 4px 16px rgba(76, 175, 80, 0.3);
          position: relative;
          overflow: hidden;
        }
        
        .btn-create-event:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(76, 175, 80, 0.4);
        }
        
        .btn-create-event::before {
          content: '';
          position: absolute;
          top: 0;
          left: -100%;
          width: 100%;
          height: 100%;
          background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
          transition: left 0.5s;
        }
        
        .btn-create-event:hover::before {
          left: 100%;
        }
        
        .btn-success {
          background: linear-gradient(135deg, var(--success) 0%, #38a169 100%);
          box-shadow: 0 4px 16px rgba(72, 187, 120, 0.3);
        }
        
        .btn-success:hover {
          box-shadow: 0 8px 24px rgba(72, 187, 120, 0.4);
        }
        
        .connection-status {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 20px;
          border-radius: 8px;
          font-weight: 500;
        }
        
        .connection-status.connected {
          background: #f0fff4;
          color: #22543d;
          border: 1px solid #68d391;
        }
        
        .content-area {
          background: #fff;
          border-radius: 12px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          min-height: 600px;
        }
        
        .tab-content {
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          border-radius: 24px;
          padding: 40px;
          box-shadow: var(--shadow-medium);
          min-height: 600px;
          position: relative;
          overflow: hidden;
        }
        
        #funnel-tab {
          overflow: visible;
        }
        
        .tab-content::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(135deg, 
            rgba(255, 255, 255, 0.1) 0%, 
            rgba(255, 255, 255, 0.05) 100%);
          pointer-events: none;
        }
        
        .calendar-container {
          height: 600px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          position: relative;
          overflow: hidden;
        }
        
        .calendar-header {
          background: #f7fafc;
          padding: 20px;
          border-bottom: 1px solid #e2e8f0;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .calendar-date-nav {
          display: flex;
          align-items: center;
          gap: 15px;
        }
        
        .nav-btn {
          background: #FF6B00;
          color: white;
          border: none;
          border-radius: 50%;
          width: 32px;
          height: 32px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          font-weight: bold;
          transition: background 0.2s;
        }
        
        .nav-btn:hover {
          background: #E55A00;
        }
        
        .today-btn {
          background: #4CAF50;
          color: white;
          border: none;
          border-radius: 6px;
          padding: 8px 16px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          margin-left: 10px;
        }
        
        .today-btn:hover {
          background: #45a049;
        }
        
        .calendar-title {
          font-size: 18px;
          font-weight: 600;
          color: #2d3748;
        }
        
        .calendar-nav {
          display: flex;
          gap: 10px;
        }
        
        .calendar-nav button {
          padding: 8px 12px;
          border: 1px solid #e2e8f0;
          background: white;
          border-radius: 6px;
          cursor: pointer;
          color: #4a5568;
          margin-right: 8px;
        }
        
        .calendar-nav button:hover {
          background: #f7fafc;
        }
        
        .view-btn.active {
          background: #FF6B00;
          color: white;
          border-color: #FF6B00;
        }
        
        .view-btn.active:hover {
          background: #E55A00;
        }
        
        .calendar-grid {
          padding: 20px;
          height: calc(100% - 80px);
          overflow-y: auto;
        }
        
        .week-view {
          display: flex;
          flex-direction: column;
          background: #e2e8f0;
          border: 1px solid #e2e8f0;
          height: 100%;
        }
        
        .week-header {
          display: grid;
          grid-template-columns: 60px repeat(7, 1fr);
          gap: 1px;
          background: #e2e8f0;
          position: sticky;
          top: 0;
          z-index: 10;
        }
        
        .week-body {
          display: grid;
          grid-template-columns: 60px repeat(7, 1fr);
          gap: 1px;
          background: #e2e8f0;
          flex: 1;
          overflow-y: auto;
        }
        
        .time-slot {
          background: #f8fafc;
          padding: 8px;
          font-size: 12px;
          color: #718096;
          border-right: 1px solid #e2e8f0;
          text-align: center;
        }
        
        .day-column {
          background: white;
          min-height: 60px;
          position: relative;
          border-right: 1px solid #e2e8f0;
          transition: all 0.3s ease;
          cursor: pointer;
        }
        
        .day-column:hover {
          background: linear-gradient(135deg, 
            rgba(255, 107, 0, 0.08) 0%, 
            rgba(255, 133, 51, 0.04) 100%);
        }
        
        .day-column:hover:not(:has(.event-block))::after {
          content: '+ Crear reunión';
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          font-size: 12px;
          color: #FF6B00;
          font-weight: 500;
          opacity: 0.8;
          pointer-events: none;
        }
        
        .day-column.current-day-column {
          background: linear-gradient(135deg, 
            rgba(255, 107, 0, 0.04) 0%, 
            rgba(255, 133, 51, 0.02) 100%);
          border-right: 1px solid rgba(255, 107, 0, 0.2);
          position: relative;
        }
        
        .day-column.current-day-column::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 2px;
          background: linear-gradient(180deg, 
            rgba(255, 107, 0, 0.6), 
            rgba(255, 133, 51, 0.4));
          z-index: 1;
        }
        
        .day-header {
          background: #f7fafc;
          padding: 8px;
          font-weight: 600;
          text-align: center;
          border-bottom: 1px solid #e2e8f0;
          font-size: 14px;
          transition: all 0.3s ease;
        }
        
        .day-header.current-day {
          background: linear-gradient(135deg, 
            rgba(255, 107, 0, 0.12) 0%, 
            rgba(255, 133, 51, 0.08) 100%);
          color: #FF6B00;
          font-weight: 700;
          position: relative;
          border: 1px solid rgba(255, 107, 0, 0.3);
          box-shadow: 0 2px 8px rgba(255, 107, 0, 0.15);
        }
        
        .day-header.current-day::after {
          content: '';
          position: absolute;
          bottom: -1px;
          left: 50%;
          transform: translateX(-50%);
          width: 20px;
          height: 2px;
          background: linear-gradient(90deg, #FF6B00, #FF8533);
          border-radius: 2px;
        }
        
        .event-block {
          background: #FF6B00;
          color: white;
          padding: 4px 8px;
          margin: 2px;
          border-radius: 4px;
          font-size: 12px;
          cursor: pointer;
          position: relative;
        }
        
        .event-block:hover {
          background: #E55A00;
        }
        
        .month-view {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 1px;
          background: #e2e8f0;
          border: 1px solid #e2e8f0;
        }
        
        .month-day {
          background: white;
          min-height: 80px;
          padding: 8px;
          position: relative;
          border: 1px solid #e2e8f0;
        }
        
        .month-day-number {
          font-weight: 600;
          color: #2d3748;
          margin-bottom: 4px;
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
          transition: background-color 0.2s;
        }
        
        .month-day-number:hover {
          background: #FF6B00;
          color: white;
        }
        
        .month-day.other-month {
          background: #f8fafc;
          color: #a0aec0;
        }
        
        .month-day.current-day-month {
          background: linear-gradient(135deg, 
            rgba(255, 107, 0, 0.06) 0%, 
            rgba(255, 133, 51, 0.03) 100%);
          border: 1px solid rgba(255, 107, 0, 0.2);
          position: relative;
          box-shadow: 0 2px 8px rgba(255, 107, 0, 0.1);
        }
        
        .month-day.current-day-month::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 2px;
          background: linear-gradient(90deg, #FF6B00, #FF8533);
          border-radius: 0 0 2px 2px;
        }
        
        .month-day-number.today-number {
          background: linear-gradient(135deg, #FF6B00, #FF8533);
          color: white;
          font-weight: 700;
          border-radius: 8px;
          box-shadow: 0 2px 8px rgba(255, 107, 0, 0.3);
          transform: scale(1.05);
        }
        
        .month-day-number.today-number:hover {
          background: linear-gradient(135deg, #FF8533, #FF6B00);
          color: white;
          transform: scale(1.1);
        }
        
        .month-event {
          background: #FF6B00;
          color: white;
          padding: 2px 4px;
          margin: 1px 0;
          border-radius: 2px;
          font-size: 10px;
          cursor: pointer;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        
        .month-event:hover {
          background: #E55A00;
        }
        
        .auth-prompt {
          text-align: center;
          padding: 60px 20px;
          color: #718096;
        }
        
        .auth-prompt h3 {
          margin-bottom: 15px;
          font-size: 20px;
          color: #2d3748;
        }
        
        .status {
          margin: 20px 0;
          padding: 15px;
          border-radius: 8px;
          text-align: center;
        }
        
        .status.loading {
          background: #e6fffa;
          color: #00a3c4;
          border: 1px solid #b8f5ff;
        }
        
        .status.success {
          background: #f0fff4;
          color: #22543d;
          border: 1px solid #68d391;
        }
        
        .status.error {
          background: #fed7d7;
          color: #822727;
          border: 1px solid #feb2b2;
        }
        
        .event-item {
          background: #f7fafc;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 15px;
          margin-bottom: 10px;
          transition: all 0.2s;
        }
        
        .event-item:hover {
          background: #edf2f7;
          border-color: #cbd5e0;
        }
        
        .event-time {
          color: #FF6B00;
          font-weight: 500;
          font-size: 14px;
          margin-bottom: 5px;
        }
        
        .event-title {
          font-weight: 600;
          color: #2d3748;
          margin-bottom: 5px;
        }
        
        .event-attendees {
          color: #718096;
          font-size: 14px;
        }
        
        .event-actions {
          margin-top: 10px;
          display: flex;
          gap: 8px;
        }
        
        .event-join-btn {
          background: #FF6B00;
          color: white;
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          font-size: 12px;
          cursor: pointer;
          text-decoration: none;
        }
        
        .event-join-btn:hover {
          background: #E55A00;
        }
        
        .event-item.event-clickable {
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          position: relative;
          overflow: hidden;
        }
        
        .event-item.event-clickable:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 32px rgba(255, 107, 0, 0.2);
          border-color: rgba(255, 107, 0, 0.3);
        }
        
        .event-item.event-clickable::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 4px;
          background: linear-gradient(180deg, #FF6B00, #FF8533);
          transform: scaleY(0);
          transform-origin: bottom;
          transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .event-item.event-clickable:hover::before {
          transform: scaleY(1);
        }
        
        /* CRM Modal Styles */
        .crm-modal {
          width: 95%;
          max-width: 1000px;
          max-height: 90vh;
          overflow-y: auto;
        }
        
        .crm-section {
          margin-bottom: 32px;
          padding: 24px;
          background: linear-gradient(135deg, 
            rgba(255, 255, 255, 0.1) 0%, 
            rgba(255, 255, 255, 0.05) 100%);
          border: 1px solid var(--border-light);
          border-radius: 16px;
          backdrop-filter: blur(20px);
        }
        
        .section-title {
          color: var(--primary-orange);
          font-size: 18px;
          font-weight: 700;
          margin-bottom: 20px;
          padding-bottom: 8px;
          border-bottom: 2px solid rgba(255, 107, 0, 0.1);
          display: flex;
          align-items: center;
        }
        
        .section-title::before {
          content: '';
          width: 4px;
          height: 20px;
          background: linear-gradient(135deg, #FF6B00, #FF8533);
          margin-right: 12px;
          border-radius: 2px;
        }
        
        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 16px;
        }
        
        .form-group {
          display: flex;
          flex-direction: column;
        }
        
        .form-label {
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 8px;
          font-size: 14px;
        }
        
        .form-input, .form-select {
          padding: 12px 16px;
          border: 1px solid var(--border-light);
          border-radius: 10px;
          font-size: 14px;
          background: var(--surface-primary);
          color: var(--text-primary);
          transition: all 0.3s ease;
        }
        
        .form-input:focus, .form-select:focus {
          outline: none;
          border-color: var(--primary-orange);
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
        }
        
        .form-textarea {
          padding: 12px 16px;
          border: 1px solid var(--border-light);
          border-radius: 10px;
          font-size: 14px;
          background: var(--surface-primary);
          color: var(--text-primary);
          resize: vertical;
          min-height: 100px;
          transition: all 0.3s ease;
        }
        
        .form-textarea:focus {
          outline: none;
          border-color: var(--primary-orange);
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
        }
        
        .status-select {
          background: linear-gradient(135deg, 
            rgba(255, 107, 0, 0.05) 0%, 
            rgba(255, 133, 51, 0.02) 100%);
          font-weight: 600;
        }
        
        .priority-select {
          background: linear-gradient(135deg, 
            rgba(255, 107, 0, 0.05) 0%, 
            rgba(255, 133, 51, 0.02) 100%);
          font-weight: 600;
        }
        
        @media (max-width: 768px) {
          .form-row {
            grid-template-columns: 1fr;
            gap: 16px;
          }
          
          .crm-modal {
            width: 100%;
            margin: 10px;
          }
          
          .crm-section {
            padding: 16px;
          }
        }
        
        /* Tag Management Styles */
        .tag-filter-container {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        
        .btn-create-tag {
          background: linear-gradient(135deg, #FF6B00, #FF8533);
          color: white;
          border: none;
          padding: 10px 16px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          white-space: nowrap;
        }
        
        .btn-create-tag:hover {
          background: linear-gradient(135deg, #FF8533, #FFB366);
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(255, 107, 0, 0.3);
        }
        
        .tag-management-buttons {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        
        .btn-edit-tags {
          background: linear-gradient(135deg, #4A90E2, #357ABD);
          color: white;
          border: none;
          padding: 10px 16px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.3s ease;
          white-space: nowrap;
        }
        
        .btn-edit-tags:hover {
          background: linear-gradient(135deg, #357ABD, #2E6DA4);
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(74, 144, 226, 0.3);
        }
        
        .tag-management-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          max-height: 400px;
          overflow-y: auto;
          padding: 10px;
        }
        
        .tag-management-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 12px;
          backdrop-filter: blur(20px);
          transition: all 0.3s ease;
        }
        
        .tag-management-item:hover {
          background: rgba(255, 255, 255, 0.15);
          border-color: rgba(255, 255, 255, 0.3);
          transform: translateY(-1px);
        }
        
        .tag-management-info {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        
        .tag-management-actions {
          display: flex;
          gap: 8px;
        }
        
        .btn-edit-tag,
        .btn-delete-tag {
          padding: 6px 12px;
          border: none;
          border-radius: 6px;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.3s ease;
        }
        
        .btn-edit-tag {
          background: linear-gradient(135deg, #28a745, #20c997);
          color: white;
        }
        
        .btn-edit-tag:hover {
          background: linear-gradient(135deg, #20c997, #17a2b8);
          transform: translateY(-1px);
        }
        
        .btn-delete-tag {
          background: linear-gradient(135deg, #dc3545, #c82333);
          color: white;
        }
        
        .btn-delete-tag:hover {
          background: linear-gradient(135deg, #c82333, #bd2130);
          transform: translateY(-1px);
        }
        
        /* Contact Tags Display */
        .contact-tags-display {
          min-height: 60px;
          padding: 12px;
          border: 2px dashed rgba(255, 255, 255, 0.2);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.05);
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
          margin-bottom: 16px;
          transition: all 0.3s ease;
        }
        
        .contact-tags-display:hover {
          border-color: rgba(255, 107, 0, 0.4);
          background: rgba(255, 107, 0, 0.05);
        }
        
        .contact-tags-display.empty::before {
          content: 'Sin etiquetas asignadas';
          color: #9ca3af;
          font-style: italic;
        }
        
        .contact-tag-item {
          background: linear-gradient(135deg, var(--primary-orange), #ff8533);
          color: white;
          padding: 8px 16px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 8px;
          transition: all 0.3s ease;
        }
        
        .contact-tag-item:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(255, 107, 0, 0.3);
        }
        
        .contact-tag-remove {
          background: rgba(255, 255, 255, 0.2);
          border: none;
          color: white;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          font-size: 12px;
          line-height: 1;
          transition: all 0.3s ease;
        }
        
        .contact-tag-remove:hover {
          background: rgba(255, 255, 255, 0.3);
          transform: scale(1.1);
        }
        
        .tags-management-controls {
          display: flex;
          gap: 16px;
          align-items: center;
          flex-wrap: wrap;
        }
        
        .tag-selector-dropdown {
          display: flex;
          gap: 8px;
          align-items: center;
          flex: 1;
        }
        
        .btn-add-tag {
          background: linear-gradient(135deg, #28a745, #20c997);
          color: white;
          border: none;
          padding: 8px 16px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          white-space: nowrap;
        }
        
        .btn-add-tag:hover {
          background: linear-gradient(135deg, #20c997, #17a2b8);
          transform: translateY(-1px);
        }
        
        .btn-add-tag:disabled {
          background: #6c757d;
          cursor: not-allowed;
          transform: none;
        }
        
        .btn-manage-tags {
          background: linear-gradient(135deg, #6f42c1, #5a2d91);
          color: white;
          border: none;
          padding: 8px 16px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          white-space: nowrap;
        }
        
        .btn-manage-tags:hover {
          background: linear-gradient(135deg, #5a2d91, #4c1d7a);
          transform: translateY(-1px);
        }
        
        .color-picker-container {
          display: flex;
          gap: 12px;
          align-items: center;
          margin-top: 8px;
        }
        
        .form-color-input {
          width: 50px;
          height: 40px;
          border: 2px solid var(--border-light);
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.3s ease;
        }
        
        .form-color-input:hover {
          border-color: var(--primary-orange);
        }
        
        .color-preview {
          flex: 1;
          padding: 10px 16px;
          border: 1px solid var(--border-light);
          border-radius: 8px;
          background: var(--surface-primary);
          display: flex;
          align-items: center;
        }
        
        .tag-preview {
          margin-top: 8px;
          padding: 12px;
          border: 1px solid var(--border-light);
          border-radius: 8px;
          background: var(--surface-primary);
          display: flex;
          align-items: center;
        }
        
        .tag-badge {
          background: var(--primary-gradient);
          color: white;
          padding: 6px 14px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
          box-shadow: 0 2px 8px rgba(255, 107, 0, 0.3);
          transition: all 0.3s ease;
        }

        /* Modal styles */
        .modal {
          display: none;
          position: fixed;
          z-index: 1000;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          background-color: rgba(0,0,0,0.5);
        }
        
        .modal-content {
          background-color: #fff;
          margin: 5% auto;
          padding: 0;
          border-radius: 12px;
          width: 90%;
          max-width: 600px;
          max-height: 90vh;
          overflow-y: auto;
          box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        
        .modal-header {
          background: #f7fafc;
          padding: 20px 30px;
          border-bottom: 1px solid #e2e8f0;
          border-radius: 12px 12px 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .modal-title {
          font-size: 24px;
          font-weight: 600;
          color: #1a202c;
          margin: 0;
        }
        
        .close-btn {
          background: none;
          border: none;
          font-size: 24px;
          cursor: pointer;
          color: #718096;
          padding: 0;
          width: 30px;
          height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          transition: all 0.2s;
        }
        
        .close-btn:hover {
          background: #e2e8f0;
          color: #2d3748;
        }
        
        .modal-body {
          padding: 30px;
        }
        
        .form-group {
          margin-bottom: 20px;
        }
        
        .form-label {
          display: block;
          margin-bottom: 8px;
          font-weight: 500;
          color: #2d3748;
        }
        
        .form-input {
          width: 100%;
          padding: 12px;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          font-size: 14px;
          color: #2d3748;
        }
        
        .form-input:focus {
          outline: none;
          border-color: #FF6B00;
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
        }
        
        .form-textarea {
          width: 100%;
          padding: 12px;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          font-size: 14px;
          color: #2d3748;
          min-height: 100px;
          resize: vertical;
        }
        
        .form-textarea:focus {
          outline: none;
          border-color: #FF6B00;
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
        }
        
        .attendees-list {
          background: #f7fafc;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 15px;
          margin-bottom: 15px;
          min-height: 50px;
          max-height: 150px;
          overflow-y: auto;
        }
        
        .form-control {
          width: 100%;
          padding: 12px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          font-size: 14px;
          color: #2d3748;
          background: rgba(255, 255, 255, 0.9);
          transition: all 0.3s ease;
        }
        
        .form-control:focus {
          outline: none;
          border-color: #FF6B00;
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
          background: rgba(255, 255, 255, 1);
        }
        
        .form-row {
          display: flex;
          gap: 15px;
          margin-bottom: 20px;
        }
        
        .form-group.half {
          flex: 1;
        }
        
        .attendees-input-container {
          display: flex;
          gap: 10px;
          margin-bottom: 15px;
        }
        
        .attendees-input-container .form-control {
          flex: 1;
        }
        
        
        .attendee-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          background: rgba(255, 255, 255, 0.8);
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          margin-bottom: 8px;
          transition: all 0.2s ease;
        }
        
        .attendee-item:hover {
          background: rgba(255, 255, 255, 1);
          border-color: #FF6B00;
        }
        
        .attendee-email {
          font-size: 14px;
          color: #4a5568;
        }
        
        .remove-attendee {
          background: #e53e3e;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 4px 8px;
          cursor: pointer;
          font-size: 12px;
          transition: background 0.2s ease;
        }
        
        .remove-attendee:hover {
          background: #c53030;
        }
        
        .tags-container {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 10px;
        }
        
        .tag-item {
          position: relative;
          display: inline-block;
        }
        
        .tag-badge {
          display: inline-block;
          padding: 6px 12px;
          background: var(--primary-gradient);
          color: white;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        
        .tag-item:hover .tag-badge {
          transform: scale(1.05);
        }
        
        .tag-checkbox {
          position: absolute;
          opacity: 0;
          cursor: pointer;
        }
        
        .tag-checkbox:checked + .tag-badge {
          background: var(--primary-gradient);
          box-shadow: 0 0 0 2px rgba(255, 107, 0, 0.3);
        }
        
        .tag-checkbox:not(:checked) + .tag-badge {
          background: #e2e8f0;
          color: #718096;
        }
        
        .datetime-dropdown {
          font-size: 16px;
          padding: 15px;
          border: 2px solid #e2e8f0;
          border-radius: 12px;
          background: white;
          max-height: 200px;
          overflow-y: auto;
        }
        
        .datetime-dropdown:focus {
          border-color: #FF6B00;
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
        }
        
        .duration-options {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 10px;
          margin-top: 10px;
        }
        
        .duration-btn {
          padding: 12px 16px;
          background: #f8fafc;
          border: 2px solid #e2e8f0;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          color: #4a5568;
          cursor: pointer;
          transition: all 0.2s ease;
          text-align: center;
        }
        
        .duration-btn:hover {
          background: #fff;
          border-color: #FF6B00;
          color: #FF6B00;
          transform: translateY(-1px);
        }
        
        .duration-btn.active {
          background: #FF6B00;
          border-color: #FF6B00;
          color: white;
          box-shadow: 0 4px 12px rgba(255, 107, 0, 0.3);
        }
        
        .form-group label {
          font-size: 16px;
          font-weight: 600;
          color: #2d3748;
          margin-bottom: 8px;
          display: block;
        }
        
        .attendee-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 0;
          border-bottom: 1px solid #e2e8f0;
        }
        
        .attendee-item:last-child {
          border-bottom: none;
        }
        
        .attendee-email {
          font-weight: 500;
          color: #2d3748;
        }
        
        .attendee-name {
          color: #718096;
          font-size: 14px;
        }
        
        .lead-badge {
          background: #FF6B00;
          color: white;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
        }
        
        .domain-badge {
          background: #e2e8f0;
          color: #4a5568;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
        }
        
        .tags-container {
          margin-top: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        
        .tag-selector {
          position: relative;
          display: inline-block;
        }
        
        .tag-dropdown {
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 8px;
          background: white;
          cursor: pointer;
          min-width: 120px;
          font-size: 14px;
        }
        
        .tag-dropdown:hover {
          border-color: #FF6B00;
        }
        
        .tag-dropdown-content {
          display: none;
          position: absolute;
          background-color: white;
          min-width: 160px;
          box-shadow: 0px 8px 16px rgba(0,0,0,0.2);
          z-index: 1;
          border-radius: 6px;
          border: 1px solid #e2e8f0;
          max-height: 200px;
          overflow-y: auto;
        }
        
        .tag-dropdown-content.show {
          display: block;
        }
        
        .tag-option {
          padding: 8px 12px;
          cursor: pointer;
          border-bottom: 1px solid #f7fafc;
          font-size: 14px;
        }
        
        .tag-option:hover {
          background-color: #f7fafc;
        }
        
        .tag-option:last-child {
          border-bottom: none;
        }
        
        .tag-option.selected {
          background-color: #FF6B00;
          color: white;
        }
        
        .contact-tags {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          margin-top: 8px;
        }
        
        .tag-badge {
          background: #FF6B00;
          color: white;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        
        .tag-badge.hot-lead {
          background: #e53e3e;
        }
        
        .tag-badge.cold-lead {
          background: #4299e1;
        }
        
        .tag-badge.client {
          background: #38a169;
        }
        
        .tag-badge.partner {
          background: #805ad5;
        }
        
        .tag-badge.prospect {
          background: #d69e2e;
        }
        
        .tag-remove {
          cursor: pointer;
          margin-left: 4px;
          font-size: 12px;
          opacity: 0.7;
        }
        
        .tag-remove:hover {
          opacity: 1;
        }
        
        .modal-footer {
          background: #f7fafc;
          padding: 20px 30px;
          border-top: 1px solid #e2e8f0;
          border-radius: 0 0 12px 12px;
          display: flex;
          justify-content: flex-end;
          gap: 12px;
        }
        
        .btn-cancel {
          background: #e2e8f0;
          color: #4a5568;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
        }
        
        .btn-cancel:hover {
          background: #cbd5e0;
        }
        
        .btn-delete {
          background: #e53e3e;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
          transition: all 0.2s ease;
        }
        
        .btn-delete:hover {
          background: #c53030;
          transform: translateY(-1px);
        }
        
        .btn-save {
          background: #FF6B00;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
        }
        
        .btn-save:hover {
          background: #E55A00;
        }
        
        @media (max-width: 768px) {
          .sidebar {
            width: 100%;
            position: relative;
            height: auto;
          }
          
          .main-content {
            margin-left: 0;
          }
          
          .header {
            flex-direction: column;
            gap: 15px;
            text-align: center;
          }
        }
        
        /* Enhanced Contact Components */
        .filter-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 24px;
          position: relative;
        }
        
        .filter-title {
          margin: 0;
          color: var(--text-primary);
          font-size: 22px;
          font-weight: 700;
          position: relative;
        }
        
        .btn-sm {
          padding: 8px 16px;
          font-size: 13px;
          border-radius: 8px;
        }
        
        .filter-input,
        .filter-select {
          padding: 14px 18px;
          border: 1px solid var(--border-light);
          border-radius: 14px;
          font-size: 14px;
          background: var(--surface-primary);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
          font-weight: 500;
        }
        
        .filter-input:focus,
        .filter-select:focus {
          outline: none;
          border-color: #FF6B00;
          box-shadow: 0 0 0 4px rgba(255, 107, 0, 0.12),
                      0 8px 20px rgba(255, 107, 0, 0.2);
          transform: translateY(-2px);
        }
        
        .filter-input {
          flex: 1;
          min-width: 280px;
        }
        
        .filter-select {
          min-width: 180px;
        }
        
        .active-filters {
          margin-top: 16px;
          padding: 12px 16px;
          background: rgba(255, 107, 0, 0.1);
          border-radius: 12px;
          border: 1px solid rgba(255, 107, 0, 0.2);
          font-size: 14px;
          color: var(--text-secondary);
          font-weight: 500;
        }
        
        /* Funnel Kanban Styles */
        .funnel-container {
          padding: 0;
          width: 100%;
          overflow: hidden;
        }
        
        .funnel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 32px;
          padding: 24px;
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          border-radius: 18px;
          box-shadow: var(--shadow-soft);
        }
        
        .funnel-header h3 {
          margin: 0;
          color: var(--text-primary);
          font-size: 24px;
          font-weight: 700;
        }
        
        .funnel-actions {
          display: flex;
          gap: 12px;
        }
        
        .funnel-metrics {
          display: flex;
          gap: 20px;
          margin-bottom: 32px;
          flex-wrap: wrap;
        }
        
        .metric-card {
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          border-radius: 16px;
          padding: 24px;
          min-width: 160px;
          text-align: center;
          box-shadow: var(--shadow-soft);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .metric-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.15);
        }
        
        .metric-value {
          display: block;
          font-size: 32px;
          font-weight: 700;
          color: #FF6B00;
          margin-bottom: 8px;
        }
        
        .metric-label {
          font-size: 14px;
          color: var(--text-secondary);
          font-weight: 500;
        }
        
        .kanban-board {
          display: flex;
          gap: 24px;
          overflow-x: auto;
          overflow-y: hidden;
          padding: 8px 8px 24px 8px;
          min-height: 70vh;
          width: 100%;
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 107, 0, 0.3) rgba(255, 255, 255, 0.1);
        }
        
        .kanban-board::-webkit-scrollbar {
          height: 8px;
        }
        
        .kanban-board::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 4px;
        }
        
        .kanban-board::-webkit-scrollbar-thumb {
          background: rgba(255, 107, 0, 0.3);
          border-radius: 4px;
        }
        
        .kanban-board::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 107, 0, 0.5);
        }
        
        .kanban-column {
          min-width: 320px;
          max-width: 320px;
          flex: 0 0 320px;
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          border-radius: 16px;
          padding: 20px;
          box-shadow: var(--shadow-soft);
          display: flex;
          flex-direction: column;
        }
        
        .kanban-column-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          padding-bottom: 16px;
          border-bottom: 2px solid var(--glass-border);
        }
        
        .kanban-column-title {
          font-size: 18px;
          font-weight: 600;
          color: var(--text-primary);
          display: flex;
          align-items: center;
          gap: 8px;
        }
        
        .kanban-column-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        
        .kanban-column-count {
          background: rgba(255, 107, 0, 0.1);
          color: #FF6B00;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 14px;
          font-weight: 600;
        }
        
        .kanban-column-remove {
          background: rgba(239, 68, 68, 0.1);
          color: #EF4444;
          border: none;
          border-radius: 6px;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          font-size: 16px;
          font-weight: 600;
          transition: all 0.2s ease;
        }
        
        .kanban-column-remove:hover {
          background: rgba(239, 68, 68, 0.2);
          transform: scale(1.1);
        }
        
        .module-preview {
          margin-top: 16px;
          border: 2px dashed var(--border-light);
          border-radius: 12px;
          padding: 16px;
          background: rgba(255, 255, 255, 0.02);
        }
        
        .kanban-cards {
          flex: 1;
          min-height: 400px;
          max-height: 60vh;
          display: flex;
          flex-direction: column;
          gap: 12px;
          transition: all 0.3s ease;
          overflow-y: auto;
          overflow-x: hidden;
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 107, 0, 0.3) rgba(255, 255, 255, 0.1);
        }
        
        .kanban-cards::-webkit-scrollbar {
          width: 6px;
        }
        
        .kanban-cards::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 3px;
        }
        
        .kanban-cards::-webkit-scrollbar-thumb {
          background: rgba(255, 107, 0, 0.3);
          border-radius: 3px;
        }
        
        .kanban-cards::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 107, 0, 0.5);
        }
        
        .kanban-cards.drag-over {
          background: rgba(255, 107, 0, 0.05);
          border: 2px dashed rgba(255, 107, 0, 0.3);
          border-radius: 12px;
        }
        
        .kanban-card {
          background: var(--surface-primary);
          border: 1px solid var(--border-light);
          border-radius: 12px;
          padding: 16px;
          cursor: grab;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
        }
        
        .kanban-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
          border-color: #FF6B00;
        }
        
        .kanban-card:active {
          cursor: grabbing;
          transform: rotate(2deg);
        }
        
        .kanban-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 12px;
        }
        
        .kanban-card-name {
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 4px;
        }
        
        .kanban-card-email {
          font-size: 14px;
          color: var(--text-secondary);
        }
        
        .kanban-card-proposal-days {
          font-size: 12px;
          color: #e53e3e;
          background: rgba(229, 62, 62, 0.1);
          padding: 4px 8px;
          border-radius: 6px;
          margin-top: 8px;
          font-weight: 500;
          text-align: center;
        }
        
        .contact-proposal-days {
          font-size: 12px;
          color: #e53e3e;
          background: rgba(229, 62, 62, 0.1);
          padding: 3px 6px;
          border-radius: 4px;
          margin-top: 4px;
          font-weight: 500;
          display: inline-block;
        }
        
        .kanban-card-meetings {
          font-size: 12px;
          color: #FF6B00;
          background: rgba(255, 107, 0, 0.1);
          padding: 2px 8px;
          border-radius: 8px;
          font-weight: 500;
        }
        
        .kanban-card-notes {
          font-size: 14px;
          color: var(--text-secondary);
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid var(--border-light);
          line-height: 1.4;
        }
        
        .kanban-drop-zone {
          min-height: 60px;
          border: 2px dashed var(--border-light);
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-secondary);
          font-size: 14px;
          transition: all 0.3s ease;
          margin-top: auto;
        }
        
        .kanban-drop-zone.drag-over {
          border-color: #FF6B00;
          background: rgba(255, 107, 0, 0.05);
          color: #FF6B00;
        }
        
        .empty-column-message {
          text-align: center;
          padding: 40px 20px;
          color: var(--text-secondary);
          font-size: 14px;
          font-style: italic;
          border: 2px dashed rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          margin: 20px 0;
          background: rgba(255, 255, 255, 0.02);
        }
        
        /* Enhanced Calendar Components */
        .calendar-controls {
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          border-radius: 18px;
          padding: 24px;
          margin-bottom: 32px;
          box-shadow: var(--shadow-soft);
          position: relative;
          overflow: hidden;
        }
        
        .calendar-controls::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(135deg, 
            rgba(255, 255, 255, 0.15) 0%, 
            rgba(255, 255, 255, 0.05) 100%);
          pointer-events: none;
          border-radius: 18px;
        }
        
        .calendar-date {
          font-size: 28px;
          font-weight: 800;
          color: var(--text-primary);
          letter-spacing: -0.5px;
          position: relative;
        }
        
        .calendar-nav {
          display: flex;
          align-items: center;
          gap: 12px;
          position: relative;
        }
        
        .view-btn {
          background: var(--surface-primary);
          border: 1px solid var(--border-light);
          padding: 12px 20px;
          border-radius: 12px;
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          font-weight: 600;
          font-size: 14px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
        }
        
        .view-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
          border-color: var(--primary-gradient);
        }
        
        .view-btn.active {
          background: var(--primary-gradient);
          color: white;
          box-shadow: 0 4px 16px rgba(255, 107, 0, 0.3);
          border-color: transparent;
        }
        
        /* Enhanced Event Items */
        .event-item {
          background: var(--surface-primary);
          border: 1px solid var(--border-light);
          border-radius: 14px;
          padding: 20px;
          margin-bottom: 12px;
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
          position: relative;
          overflow: hidden;
        }
        
        .event-item::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          width: 4px;
          height: 100%;
          background: var(--primary-gradient);
          transform: scaleY(0);
          transform-origin: bottom;
          transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          pointer-events: none;
        }
        
        .event-item:hover::before {
          transform: scaleY(1);
        }
        
        .event-item:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.15);
          border-color: rgba(255, 107, 0, 0.3);
        }
        
        .event-title {
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 8px;
          font-size: 16px;
        }
        
        .event-time {
          color: var(--text-muted);
          font-size: 13px;
          margin-bottom: 6px;
          font-weight: 500;
        }
        
        .event-attendees {
          color: var(--text-secondary);
          font-size: 14px;
          margin-bottom: 8px;
        }
        
        /* Enhanced Authentication Section */
        .auth-prompt {
          text-align: center;
          padding: 80px 40px;
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          border-radius: 20px;
          box-shadow: var(--shadow-soft);
          position: relative;
          overflow: hidden;
        }
        
        .auth-prompt::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(135deg, 
            rgba(255, 255, 255, 0.1) 0%, 
            rgba(255, 255, 255, 0.05) 100%);
          pointer-events: none;
          border-radius: 20px;
        }
        
        .auth-prompt h3 {
          font-size: 32px;
          margin-bottom: 16px;
          color: var(--text-primary);
          font-weight: 700;
          position: relative;
        }
        
        .auth-prompt p {
          font-size: 16px;
          margin-bottom: 32px;
          color: var(--text-muted);
          position: relative;
        }
        
        /* Enhanced Calendar Grid */
        .calendar-grid {
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          border-radius: 20px;
          padding: 24px;
          box-shadow: var(--shadow-soft);
          position: relative;
          height: calc(100% - 80px);
          overflow-y: auto;
        }
        
        .calendar-grid > * {
          position: relative;
          z-index: 2;
        }
        
        .calendar-grid::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(135deg, 
            rgba(255, 255, 255, 0.08) 0%, 
            rgba(255, 255, 255, 0.03) 100%);
          pointer-events: none;
          border-radius: 20px;
          z-index: 1;
        }
        
        /* Enhanced Tag Badges */
        .tag-badge {
          background: var(--primary-gradient);
          color: white;
          padding: 6px 14px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
          display: inline-block;
          margin-right: 8px;
          margin-bottom: 4px;
          transition: all 0.3s ease;
        }
        
        .tag-badge:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }
        
        /* Section Header Styles */
        .section-header:hover {
          background: rgba(255, 255, 255, 0.08) !important;
          transform: translateY(-1px);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
        }
        
        .section-icon {
          font-size: 12px;
          transition: transform 0.3s ease;
          margin-right: 8px;
        }
        
        .section-content {
          transition: all 0.3s ease;
          overflow: hidden;
        }
        
        /* Enhanced Status Messages */
        .status {
          padding: 20px 24px;
          border-radius: 16px;
          margin-bottom: 24px;
          display: flex;
          align-items: center;
          gap: 12px;
          font-weight: 500;
          position: relative;
          overflow: hidden;
          backdrop-filter: blur(10px);
        }
        
        .status::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          width: 4px;
          height: 100%;
          background: currentColor;
        }
        
        .status.success {
          background: linear-gradient(135deg, 
            rgba(72, 187, 120, 0.15) 0%, 
            rgba(72, 187, 120, 0.08) 100%);
          color: #22543d;
          border: 1px solid rgba(72, 187, 120, 0.3);
        }
        
        .status.error {
          background: linear-gradient(135deg, 
            rgba(245, 101, 101, 0.15) 0%, 
            rgba(245, 101, 101, 0.08) 100%);
          color: #742a2a;
          border: 1px solid rgba(245, 101, 101, 0.3);
        }
        
        .status.loading {
          background: linear-gradient(135deg, 
            rgba(66, 153, 225, 0.15) 0%, 
            rgba(66, 153, 225, 0.08) 100%);
          color: #2c5282;
          border: 1px solid rgba(66, 153, 225, 0.3);
        }
        
        /* Enhanced Modal Components */
        .modal {
          display: none;
          position: fixed;
          z-index: 2000;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(12px);
          animation: fadeIn 0.3s ease-out;
        }
        
        .modal-content {
          background: var(--surface-primary);
          margin: 40px auto;
          border-radius: 24px;
          width: 90%;
          max-width: 700px;
          max-height: 90vh;
          overflow-y: auto;
          box-shadow: var(--shadow-hard);
          position: relative;
          animation: slideIn 0.3s ease-out;
        }
        
        .modal-header {
          padding: 32px 40px 24px;
          border-bottom: 1px solid var(--border-light);
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border-radius: 24px 24px 0 0;
        }
        
        .modal-title {
          margin: 0;
          color: var(--text-primary);
          font-size: 26px;
          font-weight: 700;
          letter-spacing: -0.5px;
        }
        
        .close-btn {
          background: none;
          border: none;
          font-size: 32px;
          cursor: pointer;
          color: var(--text-muted);
          padding: 8px;
          border-radius: 12px;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          width: 48px;
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .close-btn:hover {
          color: var(--text-primary);
          background: var(--surface-elevated);
          transform: scale(1.1);
        }
        
        .modal-body {
          padding: 32px 40px;
        }
        
        .form-group {
          margin-bottom: 28px;
        }
        
        .form-label {
          display: block;
          margin-bottom: 8px;
          font-weight: 600;
          color: var(--text-primary);
          font-size: 15px;
        }
        
        .form-input,
        .form-textarea {
          width: 100%;
          padding: 16px 20px;
          border: 1px solid var(--border-light);
          border-radius: 14px;
          font-size: 15px;
          background: var(--surface-primary);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
          font-family: inherit;
        }
        
        .form-input:focus,
        .form-textarea:focus {
          outline: none;
          border-color: #FF6B00;
          box-shadow: 0 0 0 4px rgba(255, 107, 0, 0.12),
                      0 8px 20px rgba(255, 107, 0, 0.2);
          transform: translateY(-2px);
        }
        
        .form-textarea {
          resize: vertical;
          min-height: 120px;
        }

        /* Attachments Styles */
        .file-upload-container {
          display: flex;
          gap: 10px;
          align-items: center;
          margin-bottom: 10px;
          flex-wrap: wrap;
        }
        
        .file-size-info {
          color: var(--text-muted);
          font-size: 12px;
          width: 100%;
          margin-top: 5px;
        }

        .file-input {
          flex: 1;
          padding: 10px;
          border: 1px solid var(--border-light);
          border-radius: 8px;
          background: var(--surface-primary);
          color: var(--text-primary);
          font-size: 14px;
        }

        .file-input:focus {
          outline: none;
          border-color: var(--primary-orange);
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
        }

        .attachments-list {
          background: var(--surface-primary);
          border: 1px solid var(--border-light);
          border-radius: 10px;
          padding: 15px;
          max-height: 200px;
          overflow-y: auto;
        }

        .attachment-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          margin-bottom: 8px;
          transition: all 0.3s ease;
        }

        .attachment-item:hover {
          background: rgba(255, 107, 0, 0.05);
          border-color: rgba(255, 107, 0, 0.2);
          transform: translateY(-1px);
        }

        .attachment-info {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .attachment-name {
          font-weight: 600;
          color: var(--text-primary);
          font-size: 14px;
        }

        .attachment-details {
          font-size: 12px;
          color: var(--text-secondary);
        }

        .attachment-actions {
          display: flex;
          gap: 5px;
        }

        .btn-attachment {
          padding: 5px 10px;
          border: none;
          border-radius: 5px;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .btn-download {
          background: var(--primary-orange);
          color: white;
        }

        .btn-download:hover {
          background: #e55a00;
          transform: translateY(-1px);
        }

        .btn-delete {
          background: #dc3545;
          color: white;
        }

        .btn-delete:hover {
          background: #c82333;
          transform: translateY(-1px);
        }

        .no-attachments {
          text-align: center;
          color: var(--text-secondary);
          font-style: italic;
          padding: 20px;
        }
        
        .form-row {
          display: flex;
          gap: 20px;
        }
        
        .form-row .form-group {
          flex: 1;
        }
        
        .form-checkbox {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }
        
        .form-checkbox input {
          width: 20px;
          height: 20px;
          cursor: pointer;
        }
        
        .form-checkbox label {
          cursor: pointer;
          margin-bottom: 0;
          font-weight: 500;
        }
        
        .modal-footer {
          padding: 24px 40px 32px;
          border-top: 1px solid var(--border-light);
          display: flex;
          justify-content: flex-end;
          gap: 16px;
          background: var(--surface-secondary);
          border-radius: 0 0 24px 24px;
        }
        
        /* Enhanced Attendee Components */
        .attendee-list {
          max-height: 300px;
          overflow-y: auto;
          border: 1px solid var(--border-light);
          border-radius: 14px;
          padding: 16px;
          background: var(--surface-secondary);
        }
        
        .attendee-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-light);
          border-radius: 12px;
          margin-bottom: 8px;
          background: var(--surface-primary);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .attendee-item:last-child {
          border-bottom: none;
          margin-bottom: 0;
        }
        
        .attendee-item:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
        }
        
        .attendee-email {
          font-weight: 600;
          color: var(--text-primary);
          font-size: 15px;
        }
        
        .attendee-info {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        
        .attendee-tags {
          margin-top: 4px;
        }
        
        .attendee-tag-select {
          background: rgba(255, 255, 255, 0.9);
          border: 1px solid rgba(255, 107, 0, 0.3);
          border-radius: 6px;
          padding: 4px 8px;
          font-size: 12px;
          color: #4a5568;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        
        .attendee-tag-select:focus {
          outline: none;
          border-color: #FF6B00;
          box-shadow: 0 0 0 2px rgba(255, 107, 0, 0.2);
        }
        
        .attendee-tag-select:hover {
          border-color: #FF6B00;
        }
        
        .internal-badge {
          background: linear-gradient(135deg, #68d391, #48bb78);
          color: white;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        
        .attendee-actions {
          display: flex;
          gap: 12px;
        }
        
        .add-attendee-form {
          display: flex;
          gap: 12px;
          margin-top: 16px;
        }
        
        .add-attendee-form input {
          flex: 1;
          padding: 12px 16px;
          border: 1px solid var(--border-light);
          border-radius: 10px;
          font-size: 14px;
          background: var(--surface-primary);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .add-attendee-form input:focus {
          outline: none;
          border-color: #FF6B00;
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
        }
        
        .add-attendee-form button {
          padding: 12px 20px;
          background: var(--primary-gradient);
          color: white;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 600;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 2px 8px rgba(255, 107, 0, 0.3);
        }
        
        .add-attendee-form button:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 16px rgba(255, 107, 0, 0.4);
        }
        
        /* Enhanced Tag Components */
        .tag-section {
          margin-top: 16px;
          padding: 20px;
          background: var(--surface-secondary);
          border-radius: 16px;
          border: 1px solid var(--border-light);
        }
        
        .tag-section h4 {
          margin: 0 0 16px 0;
          color: var(--text-primary);
          font-size: 16px;
          font-weight: 600;
        }
        
        .tag-options {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-bottom: 16px;
        }
        
        .tag-option {
          background: var(--surface-primary);
          border: 1px solid var(--border-light);
          padding: 10px 16px;
          border-radius: 12px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
        }
        
        .tag-option:hover {
          border-color: #FF6B00;
          background: rgba(255, 107, 0, 0.1);
          transform: translateY(-2px);
        }
        
        .tag-option.selected {
          background: var(--primary-gradient);
          color: white;
          border-color: #FF6B00;
          box-shadow: 0 4px 16px rgba(255, 107, 0, 0.3);
        }
        
        /* Animation keyframes */
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        
        @keyframes slideIn {
          from { 
            transform: translateY(30px);
            opacity: 0;
          }
          to { 
            transform: translateY(0);
            opacity: 1;
          }
        }
        
        /* Finance Tab Styles */
        .finance-container {
          padding: 20px;
          max-width: 1200px;
          margin: 0 auto;
        }
        
        /* Finance Sub-tabs */
        .finance-sub-tabs {
          display: flex;
          gap: 0;
          margin-bottom: 20px;
          border-bottom: 2px solid var(--border-color);
        }
        
        .finance-sub-tab {
          padding: 12px 24px;
          background: transparent;
          border: none;
          color: var(--text-secondary);
          cursor: pointer;
          font-size: 1rem;
          font-weight: 500;
          transition: all 0.3s ease;
          border-bottom: 2px solid transparent;
          position: relative;
        }
        
        .finance-sub-tab:hover {
          color: var(--primary-color);
          background: var(--card-bg);
        }
        
        .finance-sub-tab.active {
          color: var(--primary-color);
          border-bottom-color: var(--primary-color);
          font-weight: 600;
        }
        
        .finance-sub-content {
          display: none;
        }
        
        .finance-sub-content.active {
          display: block;
        }
        
        .finance-header {
          margin-bottom: 30px;
        }
        
        .finance-title-nav {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }
        
        .finance-header h3 {
          color: var(--text-primary);
          margin: 0;
          font-size: 1.5rem;
          font-weight: 600;
        }
        
        .month-navigation {
          display: flex;
          align-items: center;
          gap: 15px;
        }
        
        .month-navigation .nav-btn {
          background: var(--card-bg);
          border: 1px solid var(--border-color);
          color: var(--text-primary);
          width: 40px;
          height: 40px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.3s ease;
          font-size: 1.2rem;
          font-weight: 600;
        }
        
        .month-navigation .nav-btn:hover {
          background: var(--primary-color);
          color: white;
          transform: scale(1.05);
        }
        
        .current-month {
          color: var(--text-primary);
          font-size: 1.1rem;
          font-weight: 600;
          min-width: 120px;
          text-align: center;
          padding: 8px 16px;
          background: var(--card-bg);
          border: 1px solid var(--border-color);
          border-radius: 8px;
        }
        
        .finance-summary {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 20px;
          margin-bottom: 30px;
        }
        
        .summary-card {
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.9) 0%, rgba(255, 255, 255, 0.8) 100%);
          border: 1px solid rgba(255, 107, 0, 0.2);
          border-radius: 16px;
          padding: 24px;
          text-align: center;
          backdrop-filter: blur(15px);
          transition: all 0.3s ease;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
        }
        
        .summary-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 40px rgba(255, 107, 0, 0.15);
          border-color: rgba(255, 107, 0, 0.4);
        }
        
        .summary-title {
          color: var(--text-secondary);
          font-size: 0.85rem;
          margin-bottom: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        
        .summary-amount {
          color: var(--primary-color);
          font-size: 2rem;
          font-weight: 800;
          margin-bottom: 0;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
        }
        
        .finance-table-container {
          background: var(--card-bg);
          border: 1px solid var(--border-color);
          border-radius: 12px;
          overflow: hidden;
          backdrop-filter: blur(10px);
        }
        
        .finance-table {
          width: 100%;
          border-collapse: collapse;
          background: transparent;
          border-radius: 12px;
          overflow: hidden;
        }
        
        .finance-table th {
          background: linear-gradient(135deg, var(--primary-color) 0%, var(--primary-hover) 100%);
          color: white;
          font-weight: 600;
          padding: 18px 15px;
          text-align: left;
          border: none;
          font-size: 0.9rem;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        
        .finance-table td {
          padding: 16px 15px;
          border-bottom: 1px solid var(--border-color);
          color: var(--text-primary);
          font-size: 0.9rem;
          vertical-align: middle;
        }
        
        .finance-table tr:hover {
          background: rgba(255, 107, 0, 0.05);
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(255, 107, 0, 0.1);
        }
        
        .finance-table tbody tr {
          transition: all 0.3s ease;
        }
        
        .finance-table tbody tr:last-child td {
          border-bottom: none;
        }
        
        .finance-table .no-data {
          text-align: center;
          color: var(--text-secondary);
          font-style: italic;
          padding: 40px;
        }
        
        .finance-actions {
          display: flex;
          gap: 8px;
        }
        
        .finance-actions .btn {
          padding: 4px 8px;
          font-size: 0.8rem;
          border-radius: 4px;
        }
        
        .currency-badge {
          display: inline-block;
          padding: 6px 12px;
          border-radius: 20px;
          font-size: 0.75rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        
        .currency-badge.clp {
          background: linear-gradient(135deg, #48bb78 0%, #38a169 100%);
          color: white;
        }
        
        .currency-badge.uf {
          background: linear-gradient(135deg, #ed8936 0%, #dd6b20 100%);
          color: white;
        }
        
        .currency-badge.usd {
          background: linear-gradient(135deg, #4299e1 0%, #3182ce 100%);
          color: white;
        }
        
        .currency-badge.eur {
          background: linear-gradient(135deg, #805ad5 0%, #6b46c1 100%);
          color: white;
        }
        
        .months-active {
          font-weight: 600;
          color: var(--primary-color);
        }
        
        .billing-status {
          display: inline-block;
          padding: 6px 12px;
          border-radius: 20px;
          font-size: 0.75rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        
        .billing-status.pending {
          background: linear-gradient(135deg, #ed8936 0%, #dd6b20 100%);
          color: white;
        }
        
        .billing-status.billed {
          background: linear-gradient(135deg, #4299e1 0%, #3182ce 100%);
          color: white;
        }
        
        .billing-status.paid {
          background: linear-gradient(135deg, #48bb78 0%, #38a169 100%);
          color: white;
        }
        
        .adjustment-amount {
          font-weight: 600;
          padding: 4px 8px;
          border-radius: 6px;
          font-size: 0.85rem;
        }
        
        .adjustment-amount.positive {
          color: var(--success-dark);
          background: var(--success-light);
        }
        
        .adjustment-amount.negative {
          color: var(--error-dark);
          background: rgba(245, 101, 101, 0.1);
        }
        
        .adjustment-amount.zero {
          color: var(--text-secondary);
          background: rgba(113, 128, 150, 0.1);
        }
        
        /* Monthly Billing Modal Styles */
        .billing-modal {
          max-width: 600px;
          width: 90%;
        }
        
        .billing-info-section {
          background: var(--surface-secondary);
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 25px;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 20px;
        }
        
        .billing-client-info h3 {
          color: var(--text-primary);
          margin: 0 0 8px 0;
          font-size: 1.3rem;
          font-weight: 600;
        }
        
        .billing-client-info p {
          color: var(--text-secondary);
          margin: 0 0 5px 0;
          font-size: 0.9rem;
        }
        
        .billing-summary {
          text-align: right;
          min-width: 200px;
        }
        
        .billing-summary-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
          padding: 8px 0;
        }
        
        .billing-summary-item.final-price {
          border-top: 2px solid var(--border-color);
          padding-top: 12px;
          margin-top: 12px;
          font-weight: 600;
        }
        
        .summary-label {
          color: var(--text-secondary);
          font-size: 0.9rem;
          margin-right: 15px;
        }
        
        .summary-value {
          color: var(--text-primary);
          font-weight: 600;
          font-size: 1rem;
        }
        
        .billing-form-section {
          background: var(--card-bg);
          border-radius: 12px;
          padding: 20px;
          border: 1px solid var(--border-color);
        }
        
        .finance-actions .btn {
          background: var(--primary-color);
          color: white;
          border: none;
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 0.85rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.3s ease;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        
        .finance-actions .btn:hover {
          background: var(--primary-hover);
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(255, 107, 0, 0.3);
        }
        
        .finance-actions .btn:before {
          content: "✏️";
          font-size: 0.8rem;
        }
        
      </style>
    </head>
    <body>
      <div class="app-container">
        <div class="sidebar">
          <div class="sidebar-header">
            <div class="logo">
              <img src="/Blanco sin fondo 72ppi.png" alt="IntoTheCom" onerror="this.style.display='none'">
            </div>
          </div>
          <nav class="nav-menu">
            <a href="#" class="nav-item active" data-tab="calendar">
              <span class="nav-icon">◉</span>
              <span>Calendario</span>
            </a>
            <a href="#" class="nav-item" data-tab="contacts">
              <span class="nav-icon">◎</span>
              <span>Contactos</span>
            </a>
            <a href="#" class="nav-item" data-tab="funnel">
              <span class="nav-icon">⬇</span>
              <span>Embudo</span>
            </a>
            <a href="#" class="nav-item" data-tab="sync">
              <span class="nav-icon">⟲</span>
              <span>Sincronización</span>
            </a>
            <a href="#" class="nav-item" data-tab="finanzas">
              <span class="nav-icon">$</span>
              <span>Finanzas</span>
            </a>
          </nav>
        </div>
        
        <div class="main-content">
          <div class="header">
            <h1 id="pageTitle">Calendario</h1>
            <div class="header-actions">
              <button class="btn btn-secondary" onclick="refreshData()">
                Actualizar
              </button>
              <div id="authButton">
                <button class="btn btn-primary" onclick="authenticateGoogle()">
                  Conectar Google
                </button>
              </div>
            </div>
          </div>
          
          <div class="content-area">
            <div id="calendar-tab" class="tab-content">
              <div class="calendar-container">
                <div class="calendar-header">
                  <div class="calendar-date-nav">
                    <button onclick="navigateDate('prev')" class="nav-btn">‹</button>
                    <div class="calendar-title" id="calendarTitle">Mis Eventos</div>
                    <button onclick="navigateDate('next')" class="nav-btn">›</button>
                    <button onclick="goToToday()" class="today-btn">Hoy</button>
                  </div>
                  <div class="calendar-nav">
                    <button onclick="showDayView()" class="view-btn" data-view="day">Día</button>
                    <button onclick="showWeekView()" class="view-btn active" data-view="week">Semana</button>
                    <button onclick="showMonthView()" class="view-btn" data-view="month">Mes</button>
                    <button onclick="loadCalendarEvents()" class="btn-primary">Cargar Eventos</button>
                    <button onclick="openCreateEventModal()" class="btn-create-event">+ Nueva Reunión</button>
                  </div>
                </div>
                <div class="calendar-grid">
                  <div class="auth-prompt">
                    <h3>Conecta tu Google Calendar</h3>
                    <p>Autoriza el acceso a tu calendario para ver y gestionar eventos</p>
                    <button class="btn btn-primary" onclick="authenticateGoogle()" style="margin-top: 20px;">
                      Conectar Google Calendar
                    </button>
                  </div>
                </div>
              </div>
            </div>
            
            <div id="contacts-tab" class="tab-content" style="display: none;">
              <div id="status"></div>
              
              <!-- Contacts Filter Section -->
              <div class="contacts-filter-section">
                <div class="filter-header">
                  <h3 class="filter-title">Filtros de Contactos</h3>
                  <button class="btn btn-outline btn-sm" onclick="clearContactFilters()">
                    Limpiar Filtros
                  </button>
                </div>
                
                <div class="filter-controls">
                  <input type="text" id="contactSearchInput" placeholder="Buscar por nombre, email o empresa..." 
                         class="filter-input" onkeyup="filterContacts()" />
                  
                  <div class="tag-filter-container">
                    <select id="contactTagFilter" class="filter-select" onchange="filterContacts()">
                      <option value="">Todas las etiquetas</option>
                      <option value="New Lead">● New Lead</option>
                      <option value="Untagged">○ Sin etiquetas</option>
                    </select>
                    <div class="tag-management-buttons">
                      <button class="btn-create-tag" onclick="showCreateTagModal()" title="Crear nueva etiqueta">
                        + Nueva Etiqueta
                      </button>
                      <button class="btn-edit-tags" onclick="showTagManagementModal()" title="Editar etiquetas existentes">
                        ✏️ Editar Etiquetas
                      </button>
                    </div>
                  </div>
                  
                  <select id="contactSortFilter" class="filter-select" onchange="filterContacts()">
                    <option value="recent">Más recientes</option>
                    <option value="name">Por nombre</option>
                  </select>
                </div>
                
                <div id="contactFiltersActive" class="active-filters" style="display: none;">
                  <span>Filtros activos: </span>
                  <span id="activeFiltersText"></span>
                </div>
              </div>
              
              <div id="contactsList"></div>
            </div>
            
            <div id="funnel-tab" class="tab-content" style="display: none;">
              <div class="funnel-container">
                <div class="funnel-header">
                  <h3>Pipeline de Ventas</h3>
                  <div class="funnel-actions">
                    <button class="btn btn-outline btn-sm" onclick="showAddModuleModal()">
                      Agregar Módulo
                    </button>
                    <button class="btn btn-primary btn-sm" onclick="refreshFunnelData()">
                      Actualizar
                    </button>
                  </div>
                </div>
                
                <div class="kanban-board" id="kanbanBoard">
                  <!-- Kanban columns will be populated here -->
                </div>
              </div>
            </div>
            
            <div id="sync-tab" class="tab-content" style="display: none;">
              <h3>Sincronización con Google Calendar</h3>
              <div id="syncStatus"></div>
              <button class="btn btn-primary" onclick="syncContacts()">
                Sincronizar Ahora
              </button>
            </div>
            
            <div id="finanzas-tab" class="tab-content" style="display: none;">
              <div class="finance-container">
                <!-- Sub-tabs Navigation -->
                <div class="finance-sub-tabs">
                  <button class="finance-sub-tab active" onclick="switchFinanceSubTab('resumen')">Resumen General</button>
                  <button class="finance-sub-tab" onclick="switchFinanceSubTab('flujo')">Flujo Mensual</button>
                  <button class="finance-sub-tab" onclick="switchFinanceSubTab('proyectos')">Proyectos</button>
                </div>
                
                <!-- Resumen General Tab -->
                <div id="resumen-content" class="finance-sub-content active">
                  <div class="finance-header">
                    <div class="finance-title-nav">
                      <h3>Resumen General</h3>
                      <div class="month-navigation">
                        <button class="nav-btn" id="prevMonthResumen" onclick="navigateMonthResumen(-1)">‹</button>
                        <div class="current-month" id="currentMonthDisplayResumen">Julio 2025</div>
                        <button class="nav-btn" id="nextMonthResumen" onclick="navigateMonthResumen(1)">›</button>
                      </div>
                    </div>
                    <div class="finance-summary">
                      <div class="summary-card">
                        <div class="summary-title">Flujo Mensual CLP</div>
                        <div class="summary-amount" id="totalCLPResumen">$ 0</div>
                      </div>
                      <div class="summary-card">
                        <div class="summary-title">Flujo Mensual UF</div>
                        <div class="summary-amount" id="totalUFResumen">0 UF</div>
                      </div>
                      <div class="summary-card">
                        <div class="summary-title">Proyectos CLP</div>
                        <div class="summary-amount" id="totalProjectsCLP">$ 0</div>
                      </div>
                      <div class="summary-card">
                        <div class="summary-title">Total Mensual</div>
                        <div class="summary-amount" id="totalMonthlyIncome">$ 0</div>
                      </div>
                    </div>
                  </div>
                  
                  <div class="finance-table-container">
                    <h4 style="color: var(--text-primary); margin-bottom: 15px;">Ingresos del Mes</h4>
                    <table class="finance-table">
                      <thead>
                        <tr>
                          <th>Tipo</th>
                          <th>Descripción</th>
                          <th>Monto</th>
                          <th>Moneda</th>
                          <th>Estado</th>
                        </tr>
                      </thead>
                      <tbody id="resumenTableBody">
                        <tr>
                          <td colspan="5" class="no-data">Cargando datos financieros...</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
                
                <!-- Flujo Mensual Tab -->
                <div id="flujo-content" class="finance-sub-content">
                  <div class="finance-header">
                    <div class="finance-title-nav">
                      <h3>Flujo de Caja Mensual</h3>
                      <div class="month-navigation">
                        <button class="nav-btn" id="prevMonth" onclick="navigateMonth(-1)">‹</button>
                        <div class="current-month" id="currentMonthDisplay">Julio 2025</div>
                        <button class="nav-btn" id="nextMonth" onclick="navigateMonth(1)">›</button>
                      </div>
                    </div>
                    <div class="finance-summary">
                      <div class="summary-card">
                        <div class="summary-title">Total Mensual CLP</div>
                        <div class="summary-amount" id="totalCLP">$ 0</div>
                      </div>
                      <div class="summary-card">
                        <div class="summary-title">Total Mensual UF</div>
                        <div class="summary-amount" id="totalUF">0 UF</div>
                      </div>
                      <div class="summary-card">
                        <div class="summary-title">UF Actual</div>
                        <div class="summary-amount" id="currentUF">Cargando...</div>
                      </div>
                    </div>
                  </div>
                  
                  <div class="finance-table-container">
                    <table class="finance-table">
                      <thead>
                        <tr>
                          <th>Empresa</th>
                          <th>Email</th>
                          <th>Precio Base</th>
                          <th>Ajuste Mensual</th>
                          <th>Precio Final</th>
                          <th>Moneda</th>
                          <th>Acciones</th>
                        </tr>
                      </thead>
                      <tbody id="financeTableBody">
                        <tr>
                          <td colspan="7" class="no-data">Cargando datos financieros...</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
                
                <!-- Proyectos Tab -->
                <div id="proyectos-content" class="finance-sub-content">
                  <div class="finance-header">
                    <div class="finance-title-nav">
                      <h3>Gestión de Proyectos</h3>
                      <div class="month-navigation">
                        <button class="nav-btn" id="prevMonthProyectos" onclick="navigateMonthProyectos(-1)">‹</button>
                        <div class="current-month" id="currentMonthDisplayProyectos">Julio 2025</div>
                        <button class="nav-btn" id="nextMonthProyectos" onclick="navigateMonthProyectos(1)">›</button>
                      </div>
                    </div>
                    <div class="finance-summary">
                      <div class="summary-card">
                        <div class="summary-title">Proyectos Activos</div>
                        <div class="summary-amount" id="activeProjectsCount">0</div>
                      </div>
                      <div class="summary-card">
                        <div class="summary-title">Ingresos del Mes</div>
                        <div class="summary-amount" id="monthlyProjectIncome">$ 0</div>
                      </div>
                      <div class="summary-card">
                        <div class="summary-title">Pendientes</div>
                        <div class="summary-amount" id="pendingProjectPayments">$ 0</div>
                      </div>
                    </div>
                  </div>
                  
                  <div class="finance-table-container">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                      <h4 style="color: var(--text-primary); margin: 0;">Proyectos y Pagos</h4>
                      <button class="btn btn-primary" onclick="showCreateProjectModal()">Nuevo Proyecto</button>
                    </div>
                    <table class="finance-table">
                      <thead>
                        <tr>
                          <th>Proyecto</th>
                          <th>Cliente</th>
                          <th>Monto Total</th>
                          <th>Pagado</th>
                          <th>Pendiente</th>
                          <th>Estado</th>
                          <th>Acciones</th>
                        </tr>
                      </thead>
                      <tbody id="projectsTableBody">
                        <tr>
                          <td colspan="7" class="no-data">Cargando proyectos...</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Contact CRM Modal -->
      <div id="contactModal" class="modal">
        <div class="modal-content crm-modal">
          <div class="modal-header">
            <h2>Gestión de Contacto CRM</h2>
            <span class="close-btn" onclick="closeContactModal()">&times;</span>
          </div>
          
          <div class="modal-body">
            <!-- Personal Information Section -->
            <div class="crm-section">
              <h3 class="section-title">Información Personal</h3>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Nombre *</label>
                  <input type="text" id="contactFirstName" class="form-input" placeholder="Nombre">
                </div>
                <div class="form-group">
                  <label class="form-label">Apellido *</label>
                  <input type="text" id="contactLastName" class="form-input" placeholder="Apellido">
                </div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Email</label>
                  <input type="email" id="contactEmail" class="form-input" readonly style="background: #f7fafc;">
                </div>
                <div class="form-group">
                  <label class="form-label">Teléfono</label>
                  <input type="tel" id="contactPhone" class="form-input" placeholder="+56 9 1234 5678">
                </div>
              </div>
            </div>

            <!-- Company Information Section -->
            <div class="crm-section">
              <h3 class="section-title">Información de Empresa</h3>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Nombre de Empresa</label>
                  <input type="text" id="contactCompany" class="form-input" placeholder="Nombre de la empresa">
                </div>
                <div class="form-group">
                  <label class="form-label">Cargo</label>
                  <input type="text" id="contactPosition" class="form-input" placeholder="CEO, Manager, etc.">
                </div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Sitio Web</label>
                  <input type="url" id="contactWebsite" class="form-input" placeholder="https://ejemplo.com">
                </div>
                <div class="form-group">
                  <label class="form-label">Industria</label>
                  <select id="contactIndustry" class="form-select">
                    <option value="">Seleccionar industria</option>
                    <option value="Tecnología">Tecnología</option>
                    <option value="Marketing">Marketing</option>
                    <option value="Retail">Retail</option>
                    <option value="Salud">Salud</option>
                    <option value="Educación">Educación</option>
                    <option value="Finanzas">Finanzas</option>
                    <option value="Construcción">Construcción</option>
                    <option value="Otro">Otro</option>
                  </select>
                </div>
              </div>
            </div>

            <!-- Tags Management Section -->
            <div class="crm-section">
              <h3 class="section-title">Etiquetas</h3>
              <div class="form-group">
                <label class="form-label">Etiquetas Asignadas</label>
                <div class="contact-tags-display" id="contactTagsDisplay">
                  <!-- Tags will be populated here -->
                </div>
                <div class="tags-management-controls">
                  <div class="tag-selector-dropdown">
                    <select id="contactTagSelector" class="form-select">
                      <option value="">Seleccionar etiqueta</option>
                    </select>
                    <button type="button" class="btn-add-tag" onclick="addTagToContact()">
                      Agregar
                    </button>
                  </div>
                  <div class="tag-quick-actions">
                    <button type="button" class="btn-manage-tags" onclick="showTagManagementModal()">
                      Gestionar Etiquetas
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Activity Information Section -->
            <div class="crm-section">
              <h3 class="section-title">Actividad</h3>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Total Reuniones</label>
                  <input type="number" id="contactMeetingCount" class="form-input" readonly style="background: #f7fafc;">
                </div>
                <div class="form-group">
                  <label class="form-label">Última Reunión</label>
                  <input type="date" id="contactLastSeen" class="form-input" readonly style="background: #f7fafc;">
                </div>
              </div>
            </div>

            <!-- Financial Information Section -->
            <div class="crm-section">
              <h3 class="section-title">Información Financiera</h3>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Precio Mensual</label>
                  <input type="number" id="contactMonthlyPrice" class="form-input" placeholder="0.00" step="0.01" min="0">
                </div>
                <div class="form-group">
                  <label class="form-label">Moneda</label>
                  <select id="contactCurrency" class="form-select">
                    <option value="">Seleccionar moneda</option>
                    <option value="CLP">CLP ($)</option>
                    <option value="UF">UF (Unidad de Fomento)</option>
                    <option value="USD">USD ($)</option>
                    <option value="EUR">EUR (€)</option>
                    <option value="MXN">MXN ($)</option>
                    <option value="ARS">ARS ($)</option>
                    <option value="COP">COP ($)</option>
                    <option value="PEN">PEN (S/)</option>
                  </select>
                </div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Fecha Inicio Contrato</label>
                  <input type="date" id="contactContractStartDate" class="form-input">
                </div>
                <div class="form-group">
                  <label class="form-label">Estado del Cliente</label>
                  <div class="checkbox-container">
                    <input type="checkbox" id="contactActiveClient" class="form-checkbox">
                    <label for="contactActiveClient" class="checkbox-label">Cliente Activo</label>
                  </div>
                </div>
              </div>
            </div>

            <!-- Notes Section -->
            <div class="crm-section">
              <h3 class="section-title">Notas y Observaciones</h3>
              <div class="form-group">
                <label class="form-label">Notas Internas</label>
                <textarea id="contactNotes" class="form-textarea" placeholder="Notas sobre el contacto, seguimiento, observaciones importantes, etc." rows="4"></textarea>
              </div>
            </div>

            <!-- Attachments Section -->
            <div class="crm-section">
              <h3 class="section-title">Archivos Adjuntos</h3>
              
              <!-- Upload Section -->
              <div class="form-group">
                <label class="form-label">Agregar Nuevo Archivo</label>
                <div class="file-upload-container">
                  <input type="file" id="attachmentFile" class="file-input" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.jpg,.jpeg,.png,.gif,.zip,.rar">
                  <input type="text" id="attachmentName" class="form-input" placeholder="Nombre descriptivo (ej: Propuesta comercial)" maxlength="100">
                  <button type="button" class="btn btn-primary btn-small" onclick="uploadAttachment()">Subir Archivo</button>
                  <small class="file-size-info">Tamaño máximo: 50MB</small>
                </div>
              </div>
              
              <!-- Existing Attachments List -->
              <div class="form-group">
                <label class="form-label">Archivos Existentes</label>
                <div id="attachmentsList" class="attachments-list">
                  <!-- Attachments will be loaded here -->
                </div>
              </div>
            </div>
          </div>
          
          <div class="modal-footer">
            <button class="btn-cancel" onclick="closeContactModal()">Cancelar</button>
            <button class="btn-save" onclick="saveContactDetails()">Guardar Cambios</button>
          </div>
        </div>
      </div>
      
      <!-- Monthly Billing Modal -->
      <div id="monthlyBillingModal" class="modal">
        <div class="modal-content billing-modal">
          <div class="modal-header">
            <h2>Ajuste de Facturación Mensual</h2>
            <span class="close-btn" onclick="closeMonthlyBillingModal()">&times;</span>
          </div>
          
          <div class="modal-body">
            <div class="billing-info-section">
              <div class="billing-client-info">
                <h3 id="billingClientName">Empresa</h3>
                <p id="billingClientEmail">email@empresa.com</p>
                <p id="billingPeriod">Julio 2025</p>
              </div>
              
              <div class="billing-summary">
                <div class="billing-summary-item">
                  <span class="summary-label">Precio Base del Contrato:</span>
                  <span class="summary-value" id="billingBasePrice">$0</span>
                </div>
                <div class="billing-summary-item">
                  <span class="summary-label">Ajuste Actual:</span>
                  <span class="summary-value" id="billingCurrentAdjustment">$0</span>
                </div>
                <div class="billing-summary-item final-price">
                  <span class="summary-label">Precio Final:</span>
                  <span class="summary-value" id="billingFinalPrice">$0</span>
                </div>
              </div>
            </div>
            
            <div class="billing-form-section">
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Precio Ajustado</label>
                  <input type="number" id="billingAdjustedPrice" class="form-input" placeholder="0.00" step="0.01" min="0">
                </div>
                <div class="form-group">
                  <label class="form-label">Moneda</label>
                  <select id="billingCurrency" class="form-select">
                    <option value="CLP">CLP ($)</option>
                    <option value="UF">UF (Unidad de Fomento)</option>
                    <option value="USD">USD ($)</option>
                    <option value="EUR">EUR (€)</option>
                  </select>
                </div>
              </div>
              
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Motivo del Ajuste</label>
                  <select id="billingAdjustmentReason" class="form-select">
                    <option value="">Seleccionar motivo</option>
                    <option value="Meta cumplida">Meta cumplida</option>
                    <option value="Bonus por resultados">Bonus por resultados</option>
                    <option value="Descuento temporal">Descuento temporal</option>
                    <option value="Cambio de contrato">Cambio de contrato</option>
                    <option value="Ajuste por inflación">Ajuste por inflación</option>
                    <option value="Servicio adicional">Servicio adicional</option>
                    <option value="Otro">Otro</option>
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label">Estado de Facturación</label>
                  <select id="billingStatus" class="form-select">
                    <option value="pending">Pendiente</option>
                    <option value="billed">Facturado</option>
                    <option value="paid">Pagado</option>
                  </select>
                </div>
              </div>
              
              <div class="form-group">
                <label class="form-label">Motivo Personalizado</label>
                <textarea id="billingCustomReason" class="form-textarea" placeholder="Describe el motivo del ajuste (opcional)" rows="3"></textarea>
              </div>
            </div>
          </div>
          
          <div class="modal-footer">
            <button class="btn-cancel" onclick="closeMonthlyBillingModal()">Cancelar</button>
            <button class="btn-save" onclick="saveMonthlyBilling()">Guardar Cambios</button>
          </div>
        </div>
      </div>
      
      <!-- Create Tag Modal -->
      <div id="createTagModal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h2>Crear Nueva Etiqueta</h2>
            <span class="close-btn" onclick="closeCreateTagModal()">&times;</span>
          </div>
          
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Nombre de la Etiqueta *</label>
              <input type="text" id="newTagName" class="form-input" placeholder="Ej: Cliente Potencial" maxlength="50">
            </div>
            
            <div class="form-group">
              <label class="form-label">Color de la Etiqueta</label>
              <div class="color-picker-container">
                <input type="color" id="newTagColor" class="form-color-input" value="#FF6B00">
                <div class="color-preview">
                  <span id="colorPreviewText">Nueva Etiqueta</span>
                </div>
              </div>
            </div>
            
            <div class="form-group">
              <label class="form-label">Vista Previa</label>
              <div class="tag-preview">
                <span id="tagPreview" class="tag-badge">Nueva Etiqueta</span>
              </div>
            </div>
          </div>
          
          <div class="modal-footer">
            <button class="btn-cancel" onclick="closeCreateTagModal()">Cancelar</button>
            <button class="btn-save" onclick="createNewTag()">Crear Etiqueta</button>
          </div>
        </div>
      </div>
      
      <!-- Edit Tag Modal -->
      <div id="editTagModal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h2>Editar Etiqueta</h2>
            <span class="close-btn" onclick="closeEditTagModal()">&times;</span>
          </div>
          
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Nombre de la Etiqueta *</label>
              <input type="text" id="editTagName" class="form-input" placeholder="Ej: Cliente Potencial" maxlength="50">
            </div>
            
            <div class="form-group">
              <label class="form-label">Color de la Etiqueta</label>
              <div class="color-picker-container">
                <input type="color" id="editTagColor" class="form-color-input" value="#FF6B00">
                <div class="color-preview">
                  <span id="editColorPreviewText">Etiqueta</span>
                </div>
              </div>
            </div>
            
            <div class="form-group">
              <label class="form-label">Vista Previa</label>
              <div class="tag-preview">
                <span id="editTagPreview" class="tag-badge">Etiqueta</span>
              </div>
            </div>
          </div>
          
          <div class="modal-footer">
            <button class="btn-cancel" onclick="closeEditTagModal()">Cancelar</button>
            <button class="btn-save" onclick="updateTag()">Guardar Cambios</button>
          </div>
        </div>
      </div>
      
      <!-- Tag Management Modal -->
      <div id="tagManagementModal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h2>Gestión de Etiquetas</h2>
            <span class="close-btn" onclick="closeTagManagementModal()">&times;</span>
          </div>
          
          <div class="modal-body">
            <div class="tag-management-list" id="tagManagementList">
              <!-- Tag items will be populated here -->
            </div>
          </div>
          
          <div class="modal-footer">
            <button class="btn-cancel" onclick="closeTagManagementModal()">Cerrar</button>
          </div>
        </div>
      </div>
      
      <!-- Event Details Modal -->
      <div id="eventModal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">Detalles del Evento</h3>
            <button class="close-btn" onclick="closeEventModal()">&times;</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Título del Evento</label>
              <input type="text" id="editEventTitle" class="form-input" placeholder="Título del evento">
            </div>
            
            <div class="form-group">
              <label class="form-label">Descripción</label>
              <textarea id="editEventDescription" class="form-textarea" placeholder="Descripción del evento"></textarea>
            </div>
            
            <div class="form-group">
              <label class="form-label">Fecha y Hora</label>
              <div style="display: flex; gap: 10px; align-items: center;">
                <input type="date" id="editEventStartDate" class="form-input" style="width: 150px;">
                <input type="time" id="editEventStartTime" class="form-input" style="width: 100px;">
                <span>hasta</span>
                <input type="time" id="editEventEndTime" class="form-input" style="width: 100px;">
              </div>
              <label style="margin-top: 10px; display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="editEventAllDay"> Todo el día
              </label>
            </div>
            
            <div class="form-group">
              <label class="form-label">Asistentes</label>
              <div id="editAttendeesList" class="attendees-list"></div>
              <div style="margin-top: 10px;">
                <input type="email" id="newAttendeeEmail" class="form-input" placeholder="email@ejemplo.com" style="margin-bottom: 10px;">
                <button class="btn btn-secondary" onclick="addAttendee()">Agregar Asistente</button>
              </div>
            </div>
            
            <div class="form-group">
              <label class="form-label">Notas Internas</label>
              <textarea id="editEventNotes" class="form-textarea" placeholder="Notas sobre esta reunión..."></textarea>
            </div>
            
            <div class="form-group">
              <label class="form-label">Enlace de Reunión</label>
              <div id="meetingLink" style="padding: 10px; background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 6px;"></div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-cancel" onclick="closeEventModal()">Cancelar</button>
            <button class="btn-delete" onclick="deleteEvent()">Eliminar Reunión</button>
            <button class="btn-save" onclick="saveEventChanges()">Guardar Cambios</button>
          </div>
        </div>
      </div>

      <!-- Add Pipeline Module Modal -->
      <div id="addModuleModal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h2>Agregar Módulo al Pipeline</h2>
            <span class="close-btn" onclick="closeAddModuleModal()">&times;</span>
          </div>
          
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Selecciona una etiqueta existente</label>
              <select id="moduleTagSelect" class="form-select">
                <option value="">Selecciona una etiqueta...</option>
                <!-- Options will be populated dynamically -->
              </select>
            </div>
            
            <div class="form-group">
              <label class="form-label">Vista previa del módulo</label>
              <div class="module-preview" id="modulePreview" style="display: none;">
                <div class="kanban-column" style="min-width: 280px; max-width: 280px;">
                  <div class="kanban-column-header">
                    <div class="kanban-column-title" id="previewTitle">
                      Módulo
                    </div>
                    <div class="kanban-column-count">0</div>
                  </div>
                  <div class="kanban-cards" style="min-height: 100px;">
                    <div style="text-align: center; padding: 20px; color: #718096;">
                      Los contactos con esta etiqueta aparecerán aquí
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <div class="modal-footer">
            <button class="btn-cancel" onclick="closeAddModuleModal()">Cancelar</button>
            <button class="btn-save" onclick="addModuleToPipeline()">Agregar Módulo</button>
          </div>
        </div>
      </div>

      <script>
        // Auth function already defined in head
        
        // Helper function to safely escape onclick attributes
        function safeOnclick(funcName, ...args) {
          const escapedArgs = args.map(arg => {
            if (arg === 'this') {
              return 'this';
            }
            if (typeof arg === 'string') {
              // Simple and safe escape - only escape essential characters
              const escaped = arg.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
              return "'" + escaped + "'";
            }
            return String(arg);
          });
          return 'onclick="event.stopPropagation(); ' + funcName + '(' + escapedArgs.join(', ') + ')"';
        }
        
        // Tab switching
        document.querySelectorAll('.nav-item').forEach(item => {
          item.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Update active nav item
            document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            
            // Show/hide tabs
            const tabId = item.getAttribute('data-tab');
            document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
            document.getElementById(tabId + '-tab').style.display = 'block';
            
            // Update page title
            const titles = {
              'calendar': 'Calendario',
              'contacts': 'Contactos',
              'funnel': 'Embudo',
              'sync': 'Sincronización',
              'finanzas': 'Finanzas'
            };
            document.getElementById('pageTitle').textContent = titles[tabId];
            
            // Auto-load data when switching tabs
            if (tabId === 'contacts') {
              loadContacts();
            } else if (tabId === 'funnel') {
              loadFunnelData();
            } else if (tabId === 'finanzas') {
              // Load resumen data by default
              loadResumenData();
            }
          });
        });

        // Simple status function defined first
        function showStatus(message, type) {
          console.log('Status:', message, type);
          const statusDiv = document.getElementById('status') || document.getElementById('syncStatus');
          if (statusDiv) {
            statusDiv.innerHTML = '<div class="status ' + type + '">' + message + '</div>';
          } else {
            const calendarGrid = document.querySelector('.calendar-grid');
            if (calendarGrid && type !== 'loading') {
              calendarGrid.innerHTML = '<div class="status ' + type + '">' + message + '</div>';
            }
          }
        }

        // authenticateGoogle already defined in head

        // Listen for authentication success message
        window.addEventListener('message', function(event) {
          console.log('Message received:', event.data);
          if (event.data && event.data.type === 'google-auth-success') {
            console.log('Auth success received - reloading page');
            // Simply reload the page after a short delay
            setTimeout(function() {
              window.location.reload();
            }, 2000);
          } else if (event.data && event.data.type === 'google-auth-error') {
            console.log('Auth error received:', event.data.error);
            // Show error message to user
            alert('Error de autenticación: ' + event.data.error);
          }
        });

        // CONSOLIDATED: Single robust auth status check
        let authStatusChecked = false;
        async function checkAuthStatus() {
          if (authStatusChecked) {
            console.log('Auth status already checked, skipping...');
            return;
          }
          
          try {
            console.log('=== CHECKING AUTH STATUS ===');
            const response = await fetch('/api/auth/status');
            const result = await response.json();
            
            console.log('Auth status result:', result);
            
            if (result.success && result.authenticated) {
              console.log('✅ User is authenticated, updating UI...');
              updateAuthButton(true);
              authStatusChecked = true;
              
              // Load calendar events automatically if authenticated
              const activeTab = document.querySelector('.nav-item.active')?.getAttribute('data-tab');
              if (activeTab === 'calendar' || !activeTab) {
                console.log('Loading calendar events...');
                loadCalendarEvents('week');
              }
            } else {
              console.log('❌ User is not authenticated');
              updateAuthButton(false);
              authStatusChecked = true;
            }
          } catch (error) {
            console.error('💥 Error checking auth status:', error);
            updateAuthButton(false);
            authStatusChecked = true;
          }
        }
        
        // Remove periodic check - using consolidated approach

        // Check only auth status without reloading events
        async function checkAuthStatusOnly() {
          try {
            const response = await fetch('/api/auth/status');
            const result = await response.json();
            
            if (result.success && result.authenticated) {
              updateAuthButton(true);
            } else {
              updateAuthButton(false);
              // Clear cache if not authenticated
              cachedEvents = null;
              lastFetchTime = null;
            }
          } catch (error) {
            console.error('Error checking auth status:', error);
            updateAuthButton(false);
          }
        }

        // Update authentication button based on status
        function updateAuthButton(isAuthenticated) {
          const authButton = document.getElementById('authButton');
          
          if (!authButton) {
            console.warn('Auth button not found in DOM');
            // Retry after a short delay if DOM is not ready
            setTimeout(() => {
              console.log('Retrying updateAuthButton...');
              updateAuthButton(isAuthenticated);
            }, 500);
            return;
          }
          
          console.log('Updating auth button, isAuthenticated:', isAuthenticated);
          
          if (isAuthenticated) {
            console.log('Setting auth button to authenticated state');
            authButton.innerHTML = '<div class="connection-status connected">&#x2713; Conectado</div>';
            startAutoSync();
          } else {
            console.log('Setting auth button to unauthenticated state');
            authButton.innerHTML = '<button class="btn btn-primary" onclick="authenticateGoogle()">Conectar Google</button>';
            stopAutoSync();
            // Also update calendar grid to show connection prompt
            const calendarGrid = document.querySelector('.calendar-grid');
            const currentTab = document.querySelector('.nav-item.active')?.getAttribute('data-tab');
            
            if (calendarGrid && (currentTab === 'calendar' || !currentTab)) {
              calendarGrid.innerHTML = 
                '<div class="auth-prompt">' +
                  '<h3>Conecta tu Google Calendar</h3>' +
                  '<p>Autoriza el acceso a tu calendario para ver y gestionar eventos</p>' +
                  '<button class="btn btn-primary" onclick="authenticateGoogle()" style="margin-top: 20px;">' +
                    'Conectar Google Calendar' +
                  '</button>' +
                '</div>';
            }
          }
        }

        // Start automatic synchronization
        function startAutoSync() {
          if (autoSyncInterval) return; // Already running
          
          autoSyncInterval = setInterval(async () => {
            // Only sync if calendar tab is active
            const activeTab = document.querySelector('.nav-item.active')?.getAttribute('data-tab');
            if (activeTab === 'calendar') {
              await syncCalendarSilently();
            }
          }, AUTO_SYNC_INTERVAL);
        }

        // Stop automatic synchronization
        function stopAutoSync() {
          if (autoSyncInterval) {
            clearInterval(autoSyncInterval);
            autoSyncInterval = null;
          }
        }

        // Silent sync - updates without showing loading
        async function syncCalendarSilently() {
          try {
            const activeView = document.querySelector('.view-btn.active')?.getAttribute('data-view') || 'week';
            const dateParam = currentDate.toISOString().split('T')[0];
            const response = await fetch('/api/calendar/events?view=' + activeView + '&date=' + dateParam);
            const result = await response.json();
            
            if (result.success && result.data) {
              // Check if there are changes
              const hasChanges = !cachedEvents || JSON.stringify(cachedEvents) !== JSON.stringify(result.data);
              
              if (hasChanges) {
                cachedEvents = result.data;
                lastFetchTime = Date.now();
                renderCalendarView(result.data, activeView);
              }
            }
          } catch (error) {
            console.error('Silent sync error:', error);
          }
        }

        // Cache system for events
        let cachedEvents = null;
        let lastFetchTime = null;
        const CACHE_DURATION = 60000; // 1 minuto
        let autoSyncInterval = null;
        const AUTO_SYNC_INTERVAL = 120000; // 2 minutos
        
        // Current date state for navigation
        let currentDate = new Date();
        let currentView = 'week';
        
        // Prevent concurrent calendar renders
        let isRenderingCalendar = false;
        
        // Check auth status on page load
        document.addEventListener('DOMContentLoaded', () => {
          console.log('DOMContentLoaded event fired');
          updateCalendarTitle();
          
          // CONSOLIDATED: Simple auth check 
          function waitForDOM() {
            const authButton = document.getElementById('authButton');
            if (authButton) {
              console.log('✅ DOM is ready, checking auth status');
              checkAuthStatus();
            } else {
              console.log('❌ DOM not ready, waiting...');
              setTimeout(waitForDOM, 100);
            }
          }
          
          waitForDOM();
        });
        
        // Check auth status when tab becomes visible, but don't reload events unnecessarily
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) {
            checkAuthStatusOnly();
          }
        });
        
        // Force auth check on window load as backup
        // REMOVED: Redundant load event - using consolidated approach only
        
        // Additional check - ensure auth button is properly set up
        function ensureAuthButtonState() {
          const authButton = document.getElementById('authButton');
          if (!authButton) {
            console.log('Auth button still not found, will retry...');
            setTimeout(ensureAuthButtonState, 200);
            return;
          }
          
          console.log('Auth button found, checking current state');
          // Check if button is still in its default state
          if (authButton.innerHTML.includes('Conectar Google')) {
            console.log('Auth button is in default state, checking auth status');
            checkAuthStatus();
          }
        }
        
        // Start the auth button state check
        setTimeout(ensureAuthButtonState, 1500);

        // Clean up on page unload
        window.addEventListener('beforeunload', () => {
          stopAutoSync();
        });

        async function loadCalendarEvents(view = 'week', forceRefresh = false) {
          const calendarGrid = document.querySelector('.calendar-grid');
          
          // Check if we can use cached data
          const now = Date.now();
          if (!forceRefresh && cachedEvents && lastFetchTime && (now - lastFetchTime) < CACHE_DURATION) {
            renderCalendarView(cachedEvents, view);
            return;
          }
          
          calendarGrid.innerHTML = '<div class="status loading">Cargando eventos...</div>';
          
          try {
            const dateParam = getLocalDateString(currentDate);
            console.log('Loading events:', {
              view: view,
              date: dateParam,
              currentDate: currentDate.toDateString(),
              actualDay: currentDate.getDate(),
              forceRefresh: forceRefresh
            });
            const response = await fetch('/api/calendar/events?view=' + view + '&date=' + dateParam);
            const result = await response.json();
            
            // Cache the results
            if (result.success) {
              cachedEvents = result.data;
              lastFetchTime = now;
            }
            
            if (result.success) {
              renderCalendarView(result.data, view);
            } else {
              calendarGrid.innerHTML = '<div class="status error">Error: ' + result.error + '</div>';
              // If authentication error, update button status
              if (result.error.includes('Authentication')) {
                updateAuthButton(false);
              }
            }
          } catch (error) {
            calendarGrid.innerHTML = '<div class="status error">Error de conexión: ' + error.message + '</div>';
            // Check if it's an auth error and update button
            if (error.message.includes('401') || error.message.includes('Authentication')) {
              updateAuthButton(false);
            }
          }
        }

        function formatEventTime(start) {
          if (!start) return 'Hora no especificada';
          const date = new Date(start.dateTime || start.date);
          return date.toLocaleString('es-ES', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: start.dateTime ? '2-digit' : undefined,
            minute: start.dateTime ? '2-digit' : undefined
          });
        }

        function formatAttendees(attendees) {
          if (!attendees || attendees.length === 0) return 'Sin asistentes';
          const names = attendees.map(a => a.displayName || a.email).slice(0, 3);
          return names.join(', ') + (attendees.length > 3 ? ' y ' + (attendees.length - 3) + ' más' : '');
        }

        function showDayView() {
          currentView = 'day';
          updateViewButtons('day');
          updateCalendarTitle();
          loadCalendarEventsForDate();
        }

        function showWeekView() {
          currentView = 'week';
          updateViewButtons('week');
          updateCalendarTitle();
          loadCalendarEventsForDate();
        }

        function showMonthView() {
          currentView = 'month';
          updateViewButtons('month');
          updateCalendarTitle();
          loadCalendarEventsForDate();
        }

        function updateViewButtons(activeView) {
          document.querySelectorAll('.view-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-view') === activeView) {
              btn.classList.add('active');
            }
          });
        }

        let currentEventId = null;
        let currentEventData = null;
        let currentTimeLineInterval = null;

        // Function to update the current time line in week view
        function updateCurrentTimeLine() {
          const weekBody = document.getElementById('week-body');
          if (!weekBody) return;
          
          const now = new Date();
          const currentHour = now.getHours();
          const currentMinutes = now.getMinutes();
          const currentDay = now.getDay();
          
          // Remove existing time line
          const existingLine = document.querySelector('.current-time-line');
          if (existingLine) {
            existingLine.remove();
          }
          
          // Find the current day column for the current hour
          const targetColumn = weekBody.querySelector('[data-day="' + currentDay + '"][data-hour="' + currentHour + '"]');
          if (!targetColumn) return;
          
          // Calculate position within the hour (0-60 minutes = 0-100% of hour slot)
          const minutePercentage = (currentMinutes / 60) * 100;
          
          // Create time line element
          const timeLine = document.createElement('div');
          timeLine.className = 'current-time-line';
          timeLine.style.position = 'absolute';
          timeLine.style.top = minutePercentage + '%';
          timeLine.style.left = '0';
          timeLine.style.right = '0';
          timeLine.style.height = '2px';
          timeLine.style.background = 'linear-gradient(90deg, #FF6B00, #FF8533)';
          timeLine.style.zIndex = '1000';
          timeLine.style.boxShadow = '0 0 8px rgba(255, 107, 0, 0.6)';
          
          // Add a circle at the start of the line
          const circle = document.createElement('div');
          circle.style.position = 'absolute';
          circle.style.left = '-6px';
          circle.style.top = '-4px';
          circle.style.width = '10px';
          circle.style.height = '10px';
          circle.style.borderRadius = '50%';
          circle.style.background = '#FF6B00';
          circle.style.border = '2px solid white';
          circle.style.boxShadow = '0 0 8px rgba(255, 107, 0, 0.6)';
          
          timeLine.appendChild(circle);
          targetColumn.appendChild(timeLine);
          
          // Auto-scroll to current time if it's the first time
          if (!document.querySelector('.current-time-line-scrolled')) {
            setTimeout(() => {
              targetColumn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              document.body.classList.add('current-time-line-scrolled');
            }, 200);
          }
        }

        async function showEventDetails(eventId) {
          try {
            // Prevent multiple calls to the same event
            if (currentEventId === eventId) {
              console.log('Modal already open for this event:', eventId);
              return;
            }
            
            currentEventId = eventId;
            
            // Show loading state
            const modal = document.getElementById('eventModal');
            modal.style.display = 'block';
            
            // Fetch event details
            const response = await fetch('/api/events/' + eventId);
            const result = await response.json();
            
            if (result.success) {
              currentEventData = result.data;
              populateEventModal(result.data);
            } else {
              alert('Error al cargar detalles del evento: ' + result.error);
              closeEventModal();
            }
          } catch (error) {
            console.error('Error loading event details:', error);
            alert('Error de conexión al cargar detalles del evento');
            closeEventModal();
          }
        }

        let availableTags = [{ tag: 'New Lead', count: 0 }];
        let contactsData = {};
        
        // Tag Management Functions
        function showCreateTagModal() {
          document.getElementById('createTagModal').style.display = 'block';
          document.getElementById('newTagName').value = '';
          document.getElementById('newTagColor').value = '#FF6B00';
          updateTagPreview();
        }
        
        function closeCreateTagModal() {
          document.getElementById('createTagModal').style.display = 'none';
        }
        
        // Edit Tag Modal Functions
        let currentEditingTagId = null;
        
        function showEditTagModal(tagId, tagName, tagColor) {
          currentEditingTagId = tagId;
          document.getElementById('editTagModal').style.display = 'block';
          document.getElementById('editTagName').value = tagName;
          document.getElementById('editTagColor').value = tagColor;
          updateEditTagPreview();
        }
        
        function closeEditTagModal() {
          document.getElementById('editTagModal').style.display = 'none';
          currentEditingTagId = null;
        }
        
        function updateEditTagPreview() {
          const name = document.getElementById('editTagName').value || 'Etiqueta';
          const color = document.getElementById('editTagColor').value;
          
          const preview = document.getElementById('editTagPreview');
          const colorPreview = document.getElementById('editColorPreviewText');
          
          if (preview) {
            preview.style.background = color;
            preview.style.color = 'white';
            preview.textContent = name;
          }
          
          if (colorPreview) {
            colorPreview.style.background = color;
            colorPreview.style.color = 'white';
            colorPreview.textContent = name;
          }
        }
        
        function updateTagPreview() {
          const name = document.getElementById('newTagName').value || 'Nueva Etiqueta';
          const color = document.getElementById('newTagColor').value;
          
          const preview = document.getElementById('tagPreview');
          const colorPreview = document.getElementById('colorPreviewText');
          
          preview.textContent = name;
          preview.style.background = color;
          colorPreview.textContent = name;
          colorPreview.style.color = color;
        }
        
        async function createNewTag() {
          const name = document.getElementById('newTagName').value.trim();
          const color = document.getElementById('newTagColor').value;
          
          if (!name) {
            alert('Por favor ingresa un nombre para la etiqueta');
            return;
          }
          
          try {
            const response = await fetch('/api/tags', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                name: name,
                color: color
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert('Etiqueta creada exitosamente');
              closeCreateTagModal();
              // Reload tags for filter
              loadTagsForFilter();
              // Reload available tags for events
              loadTagsAndContacts();
            } else {
              alert('Error al crear etiqueta: ' + result.error);
            }
          } catch (error) {
            console.error('Error creating tag:', error);
            alert('Error de conexión al crear etiqueta');
          }
        }
        
        async function deleteTag(tagId, tagName) {
          if (tagName === 'New Lead') {
            alert('No se puede eliminar la etiqueta "New Lead"');
            return;
          }
          
          if (!confirm('¿Estás seguro de que quieres eliminar la etiqueta "' + tagName + '"? Esta acción no se puede deshacer.')) {
            return;
          }
          
          try {
            const response = await fetch('/api/tags/' + tagId, {
              method: 'DELETE'
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert('Etiqueta eliminada exitosamente');
              // Reload tags for filter
              loadTagsForFilter();
              // Reload available tags for events
              loadTagsAndContacts();
              // Reload contacts to reflect changes
              loadContactsWithFiltering();
              // Reload tag management modal if open
              if (document.getElementById('tagManagementModal').style.display === 'block') {
                loadTagManagementList();
              }
            } else {
              alert('Error al eliminar etiqueta: ' + result.error);
            }
          } catch (error) {
            console.error('Error deleting tag:', error);
            alert('Error de conexión al eliminar etiqueta');
          }
        }
        
        async function updateTag() {
          const name = document.getElementById('editTagName').value.trim();
          const color = document.getElementById('editTagColor').value;
          
          if (!name) {
            alert('Por favor ingresa un nombre para la etiqueta');
            return;
          }
          
          if (!currentEditingTagId) {
            alert('Error: No se ha seleccionado ninguna etiqueta para editar');
            return;
          }
          
          try {
            const response = await fetch('/api/tags/' + currentEditingTagId, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                name: name,
                color: color
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert('Etiqueta actualizada exitosamente');
              closeEditTagModal();
              // Reload tags for filter
              loadTagsForFilter();
              // Reload available tags for events
              loadTagsAndContacts();
              // Reload contacts to reflect changes
              loadContactsWithFiltering();
              // Reload tag management modal if open
              if (document.getElementById('tagManagementModal').style.display === 'block') {
                loadTagManagementList();
              }
            } else {
              alert('Error al actualizar etiqueta: ' + result.error);
            }
          } catch (error) {
            console.error('Error updating tag:', error);
            alert('Error de conexión al actualizar etiqueta');
          }
        }
        
        // Tag Management Modal Functions
        async function showTagManagementModal() {
          document.getElementById('tagManagementModal').style.display = 'block';
          await loadTagManagementList();
        }
        
        function closeTagManagementModal() {
          document.getElementById('tagManagementModal').style.display = 'none';
        }
        
        async function loadTagManagementList() {
          const tagList = document.getElementById('tagManagementList');
          tagList.innerHTML = '<div class="status loading">Cargando etiquetas...</div>';
          
          try {
            const response = await fetch('/api/tags');
            const result = await response.json();
            
            if (result.success && result.data.length > 0) {
              tagList.innerHTML = '';
              result.data.forEach(tag => {
                const tagItem = document.createElement('div');
                tagItem.className = 'tag-management-item';
                tagItem.innerHTML = 
                  '<div class="tag-management-info">' +
                    '<span class="tag-badge" style="background: ' + tag.color + '; color: white; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600;">' +
                      tag.tag +
                    '</span>' +
                    '<span class="tag-count" style="color: #888; font-size: 12px;">' +
                      tag.count + ' contacto' + (tag.count !== 1 ? 's' : '') +
                    '</span>' +
                  '</div>' +
                  '<div class="tag-management-actions">' +
                    '<button class="btn-edit-tag" onclick="editTagFromManagement(\'' + tag.id + '\', \'' + tag.tag.replace(/'/g, "\\'") + '\', \'' + tag.color + '\')">' +
                      '✏️ Editar' +
                    '</button>' +
                    '<button class="btn-delete-tag" onclick="deleteTagFromManagement(\'' + tag.id + '\', \'' + tag.tag.replace(/'/g, "\\'") + '\')">' +
                      '🗑️ Eliminar' +
                    '</button>' +
                  '</div>';
                tagList.appendChild(tagItem);
              });
            } else {
              tagList.innerHTML = '<div class="status info">No hay etiquetas disponibles</div>';
            }
          } catch (error) {
            console.error('Error loading tag management list:', error);
            tagList.innerHTML = '<div class="status error">Error al cargar las etiquetas</div>';
          }
        }
        
        function editTagFromManagement(tagId, tagName, tagColor) {
          closeTagManagementModal();
          showEditTagModal(tagId, tagName, tagColor);
        }
        
        function deleteTagFromManagement(tagId, tagName) {
          deleteTag(tagId, tagName);
        }
        
        // Add event listeners for tag preview
        document.addEventListener('DOMContentLoaded', function() {
          const nameInput = document.getElementById('newTagName');
          const colorInput = document.getElementById('newTagColor');
          
          if (nameInput) {
            nameInput.addEventListener('input', updateTagPreview);
          }
          if (colorInput) {
            colorInput.addEventListener('input', updateTagPreview);
          }
          
          // Add event listeners for edit tag modal
          const editNameInput = document.getElementById('editTagName');
          const editColorInput = document.getElementById('editTagColor');
          
          if (editNameInput) {
            editNameInput.addEventListener('input', updateEditTagPreview);
          }
          if (editColorInput) {
            editColorInput.addEventListener('input', updateEditTagPreview);
          }
        });

        async function populateEventModal(event) {
          document.getElementById('editEventTitle').value = event.summary || '';
          document.getElementById('editEventDescription').value = event.description || '';
          document.getElementById('editEventNotes').value = event.notes || '';
          
          // Format date and time for editing
          const startDate = new Date(event.start.dateTime || event.start.date);
          const endDate = new Date(event.end.dateTime || event.end.date);
          
          // Set date field
          document.getElementById('editEventStartDate').value = startDate.toISOString().split('T')[0];
          
          // Check if it's all day event
          const isAllDay = !event.start.dateTime;
          document.getElementById('editEventAllDay').checked = isAllDay;
          
          if (isAllDay) {
            document.getElementById('editEventStartTime').value = '';
            document.getElementById('editEventEndTime').value = '';
            document.getElementById('editEventStartTime').disabled = true;
            document.getElementById('editEventEndTime').disabled = true;
          } else {
            document.getElementById('editEventStartTime').value = startDate.toTimeString().slice(0, 5);
            document.getElementById('editEventEndTime').value = endDate.toTimeString().slice(0, 5);
            document.getElementById('editEventStartTime').disabled = false;
            document.getElementById('editEventEndTime').disabled = false;
          }
          
          // Add event listener for all day checkbox
          document.getElementById('editEventAllDay').addEventListener('change', function() {
            const isAllDay = this.checked;
            document.getElementById('editEventStartTime').disabled = isAllDay;
            document.getElementById('editEventEndTime').disabled = isAllDay;
            if (isAllDay) {
              document.getElementById('editEventStartTime').value = '';
              document.getElementById('editEventEndTime').value = '';
            } else {
              document.getElementById('editEventStartTime').value = '09:00';
              document.getElementById('editEventEndTime').value = '10:00';
            }
          });
          
          // Load available tags and contacts data FIRST
          await loadTagsAndContacts();
          
          // Populate attendees AFTER tags are loaded
          const attendeesList = document.getElementById('editAttendeesList');
          attendeesList.innerHTML = '';
          
          console.log('Event attendees:', event.attendees);
          console.log('Available tags loaded:', availableTags);
          
          if (event.attendees && event.attendees.length > 0) {
            for (const attendee of event.attendees) {
              const attendeeDiv = document.createElement('div');
              attendeeDiv.className = 'attendee-item';
              
              const email = attendee.email || '';
              const domain = email.includes('@') ? email.split('@')[1] : '';
              const isIntothecomEmail = email.includes('@intothecom.com') || email.includes('@intothecom');
              
              // Get contact data for this email (create if doesn't exist)
              let contactData = contactsData[email];
              if (!contactData) {
                contactData = { tags: [], notes: '', id: null };
                contactsData[email] = contactData;
              }
              
              attendeeDiv.innerHTML = 
                '<div>' +
                  '<div class="attendee-email">' + email + '</div>' +
                  '<div class="attendee-name">' + (attendee.displayName || attendee.email.split('@')[0]) + '</div>' +
                  '<div class="contact-tags" id="tags-' + email.replace(/[^a-zA-Z0-9]/g, '') + '">' +
                    renderContactTags(contactData.tags) +
                  '</div>' +
                '</div>' +
                '<div>' +
                  (!isIntothecomEmail ? '<span class="domain-badge">Externo</span>' : '<span class="domain-badge" style="background: #38a169;">IntoTheCom</span>') +
                  (!isIntothecomEmail ? '<div class="tags-container">' +
                    '<div class="tag-selector">' +
                      '<div class="tag-dropdown" ' + safeOnclick('toggleTagDropdown', email) + '>' +
                        'Agregar etiqueta ▼' +
                      '</div>' +
                      '<div class="tag-dropdown-content" id="dropdown-' + email.replace(/[^a-zA-Z0-9]/g, '') + '">' +
                        renderTagOptions(email, contactData.tags) +
                      '</div>' +
                    '</div>' +
                  '</div>' : '') +
                '</div>';
              
              attendeesList.appendChild(attendeeDiv);
            }
          } else {
            attendeesList.innerHTML = '<div style="text-align: center; color: #718096; padding: 20px;">No hay asistentes registrados</div>';
          }
          
          // Meeting link
          const meetingLink = document.getElementById('meetingLink');
          if (event.hangoutLink) {
            meetingLink.innerHTML = '<a href="' + event.hangoutLink + '" target="_blank" style="color: #FF6B00; text-decoration: none;">🔗 Unirse a la reunión</a>';
          } else {
            meetingLink.innerHTML = '<span style="color: #718096;">No hay enlace de reunión</span>';
          }
        }

        async function loadTagsAndContacts() {
          try {
            // Load available tags with fallback
            try {
              const tagsResponse = await fetch('/api/tags');
              const tagsResult = await tagsResponse.json();
              if (tagsResult.success) {
                availableTags = tagsResult.data;
                // Update tag colors cache with database colors
                tagColorsCache = {};
                tagsResult.data.forEach(tagInfo => {
                  if (tagInfo.tag && tagInfo.color) {
                    tagColorsCache[tagInfo.tag] = tagInfo.color;
                  }
                });
              } else {
                // Fallback to predefined tags
                availableTags = [
                  { tag: 'New Lead', count: 0, color: '#FF6B00' }
                ];
                tagColorsCache = { 'New Lead': '#FF6B00' };
              }
            } catch (tagError) {
              console.error('Error loading tags, using fallback:', tagError);
              // Fallback to predefined tags
              availableTags = [
                { tag: 'New Lead', count: 0, color: '#FF6B00' }
              ];
              tagColorsCache = { 'New Lead': '#FF6B00' };
            }
            
            // Load all contacts to get their current tags
            try {
              const contactsResponse = await fetch('/api/contacts');
              const contactsResult = await contactsResponse.json();
              if (contactsResult.success) {
                contactsData = {};
                contactsResult.data.forEach(contact => {
                  contactsData[contact.email] = {
                    id: contact.id,
                    tags: contact.tags || [],
                    notes: contact.notes || ''
                  };
                });
              }
            } catch (contactError) {
              console.error('Error loading contacts:', contactError);
              contactsData = {};
            }
          } catch (error) {
            console.error('Error loading tags and contacts:', error);
          }
        }

        function renderContactTags(tags) {
          if (!tags || tags.length === 0) return '';
          
          return tags.map(tag => {
            const tagColor = getTagColor(tag);
            const escapedTag = tag.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
            return '<span class="tag-badge" style="background: ' + tagColor + '; color: white; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-right: 8px; display: inline-block;">' + tag + 
                   '<span class="tag-remove" ' + safeOnclick('removeTag', tag, 'this') + '>×</span></span>';
          }).join('');
        }

        function renderTagOptions(email, currentTags) {
          if (!availableTags || !Array.isArray(availableTags) || availableTags.length === 0) {
            console.warn('availableTags is not available or empty, using fallback');
            return '<div class="tag-option-error">Cargando etiquetas...</div>';
          }
          
          return availableTags.map(tagInfo => {
            if (!tagInfo || !tagInfo.tag) {
              console.warn('Invalid tag info:', tagInfo);
              return '';
            }
            
            const tag = tagInfo.tag;
            const isSelected = currentTags.includes(tag);
            const escapedEmail = email.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
            const escapedTag = tag.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
            
            return '<div class="tag-option ' + (isSelected ? 'selected' : '') + '" ' +
                   safeOnclick('toggleTag', email, tag, 'this') + '>' +
                   tag + (isSelected ? ' &#x2713;' : '') +
                   '</div>';
          }).join('');
        }

        function toggleTagDropdown(email) {
          const dropdownId = 'dropdown-' + email.replace(/[^a-zA-Z0-9]/g, '');
          const dropdown = document.getElementById(dropdownId);
          
          if (!dropdown) {
            console.error('Dropdown not found for email:', email, 'ID:', dropdownId);
            return;
          }
          
          // Close all other dropdowns
          document.querySelectorAll('.tag-dropdown-content').forEach(d => {
            if (d.id !== dropdownId) {
              d.classList.remove('show');
            }
          });
          
          dropdown.classList.toggle('show');
        }

        async function toggleTag(email, tag, element) {
          let contactData = contactsData[email] || { tags: [], notes: '' };
          
          const isSelected = element.classList.contains('selected');
          let newTags;
          
          if (isSelected) {
            // Remove tag
            newTags = contactData.tags.filter(t => t !== tag);
            element.classList.remove('selected');
            element.textContent = tag;
          } else {
            // Add tag
            newTags = [...contactData.tags, tag];
            element.classList.add('selected');
            element.innerHTML = tag + ' &#x2713;';
          }
          
          // Always try to create or update contact with simplified approach
          try {
            let contactId = contactData.id;
            
            // If no ID, try to create contact
            if (!contactId) {
              try {
                const createResponse = await fetch('/api/contacts', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    email: email,
                    name: email.split('@')[0],
                    tags: newTags,
                    notes: contactData.notes || ''
                  })
                });
                
                const createResult = await createResponse.json();
                if (createResult.success) {
                  contactId = createResult.data.id;
                  contactData.id = contactId;
                  contactData.tags = newTags;
                  contactsData[email] = contactData;
                  
                  // Update UI
                  const tagsContainer = document.getElementById('tags-' + email.replace(/[^a-zA-Z0-9]/g, ''));
                  if (tagsContainer) {
                    tagsContainer.innerHTML = renderContactTags(newTags);
                  } else {
                    console.warn('Tags container not found for email:', email);
                  }
                  
                  console.log('Contact created and tag added successfully');
                  return;
                } else if (createResponse.status === 409) {
                  // Contact exists, check if the response includes the existing contact data
                  if (createResult.data && createResult.data.id) {
                    contactId = createResult.data.id;
                    contactData.id = contactId;
                    contactData.tags = createResult.data.tags || [];
                    contactsData[email] = contactData;
                    // Continue to update tags below
                  } else {
                    // If no data in response, try to get it from the full contacts list
                    try {
                      const getResponse = await fetch('/api/contacts');
                      const getResult = await getResponse.json();
                      if (getResult.success) {
                        const existingContact = getResult.data.find(c => c.email === email);
                        if (existingContact) {
                          contactId = existingContact.id;
                          contactData.id = contactId;
                          contactData.tags = existingContact.tags || [];
                          contactsData[email] = contactData;
                          // Continue to update tags below
                        }
                      }
                    } catch (getError) {
                      console.error('Error getting existing contact:', getError);
                      alert('Error: El contacto ya existe pero no se pudo obtener su información');
                      return;
                    }
                  }
                } else {
                  console.error('Error creating contact:', createResult.error);
                  console.error('Response status:', createResponse.status);
                  console.error('Full response:', createResult);
                  alert('Error: ' + (createResult.error || 'Unknown error'));
                  // Revert UI changes
                  if (isSelected) {
                    element.classList.add('selected');
                    element.innerHTML = tag + ' &#x2713;';
                  } else {
                    element.classList.remove('selected');
                    element.textContent = tag;
                  }
                  return;
                }
              } catch (createError) {
                console.error('Error in contact creation:', createError);
                alert('Error de conexión: ' + createError.message);
                // Revert UI changes
                if (isSelected) {
                  element.classList.add('selected');
                  element.innerHTML = tag + ' &#x2713;';
                } else {
                  element.classList.remove('selected');
                  element.textContent = tag;
                }
                return;
              }
            }
            
            // Update tags for existing contact
            if (contactId) {
              const updateResponse = await fetch('/api/contacts/' + contactId + '/tags', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  tags: newTags,
                  notes: contactData.notes || ''
                })
              });
              
              const updateResult = await updateResponse.json();
              if (updateResult.success) {
                contactData.tags = newTags;
                contactsData[email] = contactData;
                
                // Sync attendee tags with contact tags
                try {
                  await fetch('/api/sync-attendee-tags', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                      eventId: currentEventId,
                      attendeeEmail: email,
                      tags: newTags
                    })
                  });
                  console.log('Attendee tags synchronized successfully');
                } catch (syncError) {
                  console.error('Error syncing attendee tags:', syncError);
                }
                
                // Update UI
                const tagsContainer = document.getElementById('tags-' + email.replace(/[^a-zA-Z0-9]/g, ''));
                if (tagsContainer) {
                  tagsContainer.innerHTML = renderContactTags(newTags);
                } else {
                  console.warn('Tags container not found for email:', email);
                }
                
                console.log('Tag updated successfully');
              } else {
                console.error('Error updating tag:', updateResult.error);
                alert('Error al actualizar etiqueta: ' + updateResult.error);
              }
            }
          } catch (error) {
            console.error('Error in toggleTag:', error);
            alert('Error de conexión');
          }
        }

        function removeTag(tagToRemove, element) {
          const attendeeItem = element.closest('.attendee-item');
          const email = attendeeItem.querySelector('.attendee-email').textContent;
          const contactData = contactsData[email];
          
          if (!contactData) return;
          
          const newTags = contactData.tags.filter(tag => tag !== tagToRemove);
          
          // Update in backend
          fetch('/api/contacts/' + contactData.id + '/tags', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              tags: newTags,
              notes: contactData.notes
            })
          }).then(response => response.json())
          .then(result => {
            if (result.success) {
              // Update local data
              contactData.tags = newTags;
              
              // Sync attendee tags with contact tags
              fetch('/api/sync-attendee-tags', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  eventId: currentEventId,
                  attendeeEmail: email,
                  tags: newTags
                })
              }).then(syncResponse => {
                console.log('Attendee tags synchronized successfully');
              }).catch(syncError => {
                console.error('Error syncing attendee tags:', syncError);
              });
              
              // Update UI
              const tagsContainer = document.getElementById('tags-' + email.replace(/[^a-zA-Z0-9]/g, ''));
              if (tagsContainer) {
                tagsContainer.innerHTML = renderContactTags(newTags);
              } else {
                console.warn('Tags container not found for email:', email);
              }
              
              // Update dropdown
              const dropdown = document.getElementById('dropdown-' + email.replace(/[^a-zA-Z0-9]/g, ''));
              dropdown.innerHTML = renderTagOptions(email, newTags);
            } else {
              alert('Error al eliminar etiqueta: ' + result.error);
            }
          }).catch(error => {
            console.error('Error removing tag:', error);
            alert('Error de conexión al eliminar etiqueta');
          });
        }

        function closeEventModal() {
          document.getElementById('eventModal').style.display = 'none';
          currentEventId = null;
          currentEventData = null;
        }
        
        // Contact Details Modal Functions
        let currentContactEmail = null;
        let currentContactData = null;
        
        async function showContactDetails(email) {
          try {
            currentContactEmail = email;
            
            // Show modal
            const modal = document.getElementById('contactModal');
            modal.style.display = 'block';
            
            // Load available tags first to ensure colors are available
            try {
              const tagsResponse = await fetch('/api/tags');
              const tagsResult = await tagsResponse.json();
              if (tagsResult.success) {
                availableTags = tagsResult.data;
                // Update tag colors cache with database colors
                tagColorsCache = {};
                tagsResult.data.forEach(tagInfo => {
                  if (tagInfo.tag && tagInfo.color) {
                    tagColorsCache[tagInfo.tag] = tagInfo.color;
                  }
                });
              } else {
                // Fallback to predefined tags
                availableTags = [
                  { tag: 'New Lead', count: 0, color: '#FF6B00' }
                ];
                tagColorsCache = { 'New Lead': '#FF6B00' };
              }
            } catch (tagError) {
              console.error('Error loading tags, using fallback:', tagError);
              // Fallback to predefined tags
              availableTags = [
                { tag: 'New Lead', count: 0, color: '#FF6B00' }
              ];
              tagColorsCache = { 'New Lead': '#FF6B00' };
            }
            
            // Load contact data
            const response = await fetch('/api/contacts');
            const result = await response.json();
            
            if (result.success) {
              const contact = result.data.find(c => c.email === email);
              if (contact) {
                currentContactData = contact;
                populateContactModal(contact);
              } else {
                alert('Contacto no encontrado');
                closeContactModal();
              }
            } else {
              alert('Error al cargar contacto: ' + result.error);
              closeContactModal();
            }
          } catch (error) {
            console.error('Error loading contact details:', error);
            alert('Error de conexión al cargar contacto');
            closeContactModal();
          }
        }
        
        function populateContactModal(contact) {
          // Parse full name into first and last name
          const fullName = contact.name || '';
          const nameParts = fullName.split(' ');
          const firstName = nameParts[0] || '';
          const lastName = nameParts.slice(1).join(' ') || '';
          
          // Personal Information
          document.getElementById('contactFirstName').value = firstName;
          document.getElementById('contactLastName').value = lastName;
          document.getElementById('contactEmail').value = contact.email || '';
          document.getElementById('contactPhone').value = contact.phone || '';
          
          // Company Information
          document.getElementById('contactCompany').value = contact.company || '';
          document.getElementById('contactPosition').value = contact.position || '';
          document.getElementById('contactWebsite').value = contact.website || '';
          document.getElementById('contactIndustry').value = contact.industry || '';
          
          // Tags Management - Populate current tags and available tags
          populateContactTags(contact.tags || []);
          loadAvailableTagsForContact();
          
          // Activity Information
          document.getElementById('contactMeetingCount').value = contact.meeting_count || 0;
          document.getElementById('contactLastSeen').value = contact.last_seen || '';
          
          // Financial Information
          document.getElementById('contactMonthlyPrice').value = contact.monthly_price || '';
          document.getElementById('contactCurrency').value = contact.currency || '';
          document.getElementById('contactContractStartDate').value = contact.contract_start_date || '';
          document.getElementById('contactActiveClient').checked = contact.active_client || false;
          
          // Notes
          document.getElementById('contactNotes').value = contact.notes || '';
          
          // Load attachments
          loadContactAttachments(contact.id);
        }
        
        function toggleContactTagDropdown() {
          const dropdown = document.getElementById('contactTagDropdown');
          dropdown.classList.toggle('show');
        }
        
        function toggleContactTag(tag) {
          if (!currentContactData) return;
          
          const currentTags = currentContactData.tags || [];
          let newTags;
          
          if (currentTags.includes(tag)) {
            newTags = currentTags.filter(t => t !== tag);
          } else {
            newTags = [...currentTags, tag];
          }
          
          // Update local data
          currentContactData.tags = newTags;
          
          // Update UI
          const tagsContainer = document.getElementById('contactTagsContainer');
          tagsContainer.innerHTML = renderContactTags(newTags);
          
          // Update dropdown
          const dropdown = document.getElementById('contactTagDropdown');
          dropdown.innerHTML = availableTags.map(tagInfo => {
            const tagName = tagInfo.tag;
            const isSelected = newTags.includes(tagName);
            return '<div class="tag-option ' + (isSelected ? 'selected' : '') + '" ' + safeOnclick('toggleContactTag', tagName) + '>' +
                   tagName + (isSelected ? ' &#x2713;' : '') +
                   '</div>';
          }).join('');
        }
        
        function closeContactModal() {
          document.getElementById('contactModal').style.display = 'none';
          currentContactEmail = null;
          currentContactData = null;
        }
        
        // Contact Tags Management Functions
        function populateContactTags(tags) {
          const tagsDisplay = document.getElementById('contactTagsDisplay');
          
          if (!tags || tags.length === 0) {
            tagsDisplay.innerHTML = '';
            tagsDisplay.classList.add('empty');
            return;
          }
          
          tagsDisplay.classList.remove('empty');
          tagsDisplay.innerHTML = tags.map(tag => {
            const tagColor = getTagColor(tag);
            return '<div class="contact-tag-item" style="background: ' + tagColor + ';">' +
                     '<span>' + tag + '</span>' +
                     '<button class="contact-tag-remove" onclick="removeTagFromContact(\'' + tag.replace(/'/g, "\\'") + '\')">' +
                       '×' +
                     '</button>' +
                   '</div>';
          }).join('');
        }
        
        async function loadAvailableTagsForContact() {
          try {
            const response = await fetch('/api/tags');
            const result = await response.json();
            
            const selector = document.getElementById('contactTagSelector');
            selector.innerHTML = '<option value="">Seleccionar etiqueta</option>';
            
            if (result.success && result.data) {
              result.data.forEach(tagInfo => {
                const option = document.createElement('option');
                option.value = tagInfo.tag;
                option.textContent = tagInfo.tag;
                selector.appendChild(option);
              });
            }
          } catch (error) {
            console.error('Error loading available tags:', error);
          }
        }
        
        function addTagToContact() {
          const selector = document.getElementById('contactTagSelector');
          const selectedTag = selector.value;
          
          if (!selectedTag) {
            alert('Por favor selecciona una etiqueta');
            return;
          }
          
          // Check if tag already exists
          if (currentContactData && currentContactData.tags && currentContactData.tags.includes(selectedTag)) {
            alert('Esta etiqueta ya está asignada');
            return;
          }
          
          // Add tag to current contact data
          if (!currentContactData.tags) {
            currentContactData.tags = [];
          }
          currentContactData.tags.push(selectedTag);
          
          // Update display
          populateContactTags(currentContactData.tags);
          
          // Reset selector
          selector.value = '';
          
          // Enable save button (could be added later)
          // markModalAsModified();
        }
        
        function removeTagFromContact(tag) {
          if (!currentContactData || !currentContactData.tags) return;
          
          // Remove tag from current contact data
          currentContactData.tags = currentContactData.tags.filter(t => t !== tag);
          
          // Update display
          populateContactTags(currentContactData.tags);
          
          // Enable save button (could be added later)
          // markModalAsModified();
        }
        
        async function saveContactDetails() {
          if (!currentContactData) return;
          
          // Collect all form data
          const firstName = document.getElementById('contactFirstName').value;
          const lastName = document.getElementById('contactLastName').value;
          const name = (firstName + ' ' + lastName).trim();
          const phone = document.getElementById('contactPhone').value;
          const company = document.getElementById('contactCompany').value;
          const position = document.getElementById('contactPosition').value;
          const website = document.getElementById('contactWebsite').value;
          const industry = document.getElementById('contactIndustry').value;
          const notes = document.getElementById('contactNotes').value;
          const tags = currentContactData.tags || [];
          
          // Financial Information
          const monthlyPrice = document.getElementById('contactMonthlyPrice').value;
          const currency = document.getElementById('contactCurrency').value;
          const contractStartDate = document.getElementById('contactContractStartDate').value;
          const activeClient = document.getElementById('contactActiveClient').checked;
          
          try {
            const response = await fetch('/api/contacts/' + currentContactData.id + '/update', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                name: name,
                phone: phone,
                company: company,
                position: position,
                website: website,
                industry: industry,
                notes: notes,
                tags: tags,
                monthly_price: monthlyPrice,
                currency: currency,
                contract_start_date: contractStartDate,
                active_client: activeClient
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              // Sync attendee tags with contact tags
              try {
                await fetch('/api/sync-attendee-tags', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    eventId: currentEventId || 'contact-edit',
                    attendeeEmail: currentContactData.email,
                    tags: tags
                  })
                });
                console.log('Contact tags synchronized successfully');
              } catch (syncError) {
                console.error('Error syncing contact tags:', syncError);
              }
              
              alert('Contacto actualizado exitosamente');
              closeContactModal();
              // Refresh contacts view if we're on contacts tab
              const activeTab = document.querySelector('.nav-item.active')?.getAttribute('data-tab');
              if (activeTab === 'contacts') {
                loadContacts();
              }
            } else {
              alert('Error al actualizar contacto: ' + result.error);
            }
          } catch (error) {
            console.error('Error saving contact:', error);
            alert('Error de conexión al guardar contacto');
          }
        }

        // CONTACT ATTACHMENTS FUNCTIONS
        
        // Load attachments for a contact
        async function loadContactAttachments(contactId) {
          try {
            const response = await fetch('/api/contacts/' + contactId + '/attachments');
            const result = await response.json();
            
            if (result.success) {
              displayAttachments(result.data);
            } else {
              console.error('Error loading attachments:', result.error);
            }
          } catch (error) {
            console.error('Error loading attachments:', error);
          }
        }
        
        // Display attachments in the UI
        function displayAttachments(attachments) {
          const attachmentsList = document.getElementById('attachmentsList');
          
          if (attachments.length === 0) {
            attachmentsList.innerHTML = '<div class="no-attachments">No hay archivos adjuntos</div>';
            return;
          }
          
          attachmentsList.innerHTML = attachments.map(attachment => 
            '<div class="attachment-item">' +
              '<div class="attachment-info">' +
                '<div class="attachment-name">' + attachment.display_name + '</div>' +
                '<div class="attachment-details">' +
                  attachment.original_filename + ' • ' + formatFileSize(attachment.file_size) + ' • ' + formatDate(attachment.uploaded_at) +
                '</div>' +
              '</div>' +
              '<div class="attachment-actions">' +
                '<button class="btn-attachment btn-download" onclick="downloadAttachment(' + attachment.id + ')">' +
                  'Descargar' +
                '</button>' +
                '<button class="btn-attachment btn-delete" onclick="deleteAttachment(' + attachment.id + ')">' +
                  'Eliminar' +
                '</button>' +
              '</div>' +
            '</div>'
          ).join('');
        }
        
        // Upload attachment
        async function uploadAttachment() {
          if (!currentContactData) {
            alert('Error: No se ha seleccionado un contacto');
            return;
          }
          
          const fileInput = document.getElementById('attachmentFile');
          const nameInput = document.getElementById('attachmentName');
          
          if (!fileInput.files[0]) {
            alert('Por favor selecciona un archivo');
            return;
          }
          
          if (!nameInput.value.trim()) {
            alert('Por favor ingresa un nombre descriptivo para el archivo');
            return;
          }
          
          const formData = new FormData();
          formData.append('file', fileInput.files[0]);
          formData.append('displayName', nameInput.value.trim());
          
          try {
            const response = await fetch('/api/contacts/' + currentContactData.id + '/attachments', {
              method: 'POST',
              body: formData
            });
            
            console.log('Upload response status:', response.status);
            console.log('Upload response headers:', response.headers);
            
            if (!response.ok) {
              const errorText = await response.text();
              console.error('Server error response:', errorText);
              alert('Error del servidor: ' + response.status + ' - ' + errorText);
              return;
            }
            
            const result = await response.json();
            
            if (result.success) {
              alert('Archivo subido exitosamente');
              // Clear inputs
              fileInput.value = '';
              nameInput.value = '';
              // Reload attachments
              loadContactAttachments(currentContactData.id);
            } else {
              alert('Error al subir archivo: ' + result.error);
            }
          } catch (error) {
            console.error('Error uploading attachment:', error);
            alert('Error de conexión al subir archivo: ' + error.message);
          }
        }
        
        // Download attachment
        async function downloadAttachment(attachmentId) {
          console.log('=== DOWNLOAD ATTACHMENT CALLED ===');
          console.log('Attachment ID:', attachmentId);
          console.log('Current contact:', currentContactData);
          
          if (!currentContactData) {
            console.error('No current contact data');
            return;
          }
          
          try {
            const downloadUrl = '/api/contacts/' + currentContactData.id + '/attachments/' + attachmentId + '/download';
            console.log('Download URL:', downloadUrl);
            
            // Try fetch first to check if endpoint works
            const response = await fetch(downloadUrl);
            console.log('Download response status:', response.status);
            
            if (!response.ok) {
              const errorText = await response.text();
              console.error('Download failed:', errorText);
              alert('Error al descargar archivo: ' + response.status);
              return;
            }
            
            // If fetch works, use window.open for download
            window.open(downloadUrl, '_blank');
            
          } catch (error) {
            console.error('Error downloading attachment:', error);
            alert('Error al descargar archivo: ' + error.message);
          }
        }
        
        // Delete attachment
        async function deleteAttachment(attachmentId) {
          if (!currentContactData) return;
          
          if (!confirm('¿Estás seguro de que quieres eliminar este archivo?')) {
            return;
          }
          
          try {
            const response = await fetch('/api/contacts/' + currentContactData.id + '/attachments/' + attachmentId, {
              method: 'DELETE'
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert('Archivo eliminado exitosamente');
              // Reload attachments
              loadContactAttachments(currentContactData.id);
            } else {
              alert('Error al eliminar archivo: ' + result.error);
            }
          } catch (error) {
            console.error('Error deleting attachment:', error);
            alert('Error de conexión al eliminar archivo');
          }
        }
        
        // Helper functions
        function formatFileSize(bytes) {
          if (bytes === 0) return '0 Bytes';
          const k = 1024;
          const sizes = ['Bytes', 'KB', 'MB', 'GB'];
          const i = Math.floor(Math.log(bytes) / Math.log(k));
          return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
        
        function formatDate(dateString) {
          const date = new Date(dateString);
          return date.toLocaleDateString('es-ES', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
          });
        }

        async function saveEventChanges() {
          if (!currentEventId) return;
          
          const title = document.getElementById('eventTitle').value;
          const description = document.getElementById('eventDescription').value;
          const notes = document.getElementById('eventNotes').value;
          
          // Get date and time values
          const startDate = document.getElementById('eventStartDate').value;
          const startTime = document.getElementById('eventStartTime').value;
          const endTime = document.getElementById('eventEndTime').value;
          const isAllDay = document.getElementById('eventAllDay').checked;
          
          // Collect attendees
          const attendeeEmails = [];
          const attendeeElements = document.querySelectorAll('.attendee-item');
          attendeeElements.forEach(element => {
            const emailElement = element.querySelector('.attendee-email');
            if (emailElement) {
              const email = emailElement.textContent;
              if (email) attendeeEmails.push({ email: email });
            }
          });
          
          // Build start and end times
          let start, end;
          if (isAllDay) {
            start = { date: startDate };
            end = { date: startDate };
          } else {
            if (!startTime || !endTime) {
              alert('Por favor ingresa las horas de inicio y fin');
              return;
            }
            // Add timezone to avoid Google Calendar API error
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            start = { 
              dateTime: startDate + 'T' + startTime + ':00',
              timeZone: timezone
            };
            end = { 
              dateTime: startDate + 'T' + endTime + ':00',
              timeZone: timezone
            };
          }
          
          try {
            const response = await fetch('/api/events/' + currentEventId, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                summary: title,
                description: description,
                attendees: attendeeEmails,
                notes: notes,
                start: start,
                end: end
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert('Evento actualizado exitosamente');
              closeEventModal();
              // Refresh calendar view
              refreshData();
            } else {
              alert('Error al actualizar evento: ' + result.error);
            }
          } catch (error) {
            console.error('Error saving event:', error);
            alert('Error de conexión al guardar cambios');
          }
        }

        async function deleteEvent() {
          if (!currentEventId) return;
          
          // Confirm deletion
          const confirmed = confirm('¿Estás seguro de que quieres eliminar esta reunión? Esta acción no se puede deshacer.');
          if (!confirmed) return;
          
          try {
            const response = await fetch('/api/events/' + currentEventId, {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json'
              }
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert('Reunión eliminada exitosamente');
              closeEventModal();
              // Refresh calendar view
              refreshData();
            } else {
              alert('Error al eliminar reunión: ' + result.error);
            }
          } catch (error) {
            console.error('Error deleting event:', error);
            alert('Error de conexión al eliminar reunión');
          }
        }

        function addAttendee() {
          const email = document.getElementById('newAttendeeEmail').value.trim();
          if (!email) return;
          
          // Validate email
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(email)) {
            alert('Por favor ingresa un email válido');
            return;
          }
          
          // Check if already exists
          const existingAttendees = document.querySelectorAll('.attendee-email');
          for (let attendee of existingAttendees) {
            if (attendee.textContent === email) {
              alert('Este asistente ya está en la lista');
              return;
            }
          }
          
          // Add to current event data
          if (!currentEventData.attendees) {
            currentEventData.attendees = [];
          }
          currentEventData.attendees.push({ email: email });
          
          // Clear input
          document.getElementById('newAttendeeEmail').value = '';
          
          // Re-populate modal
          populateEventModal(currentEventData);
        }


        // Close modal when clicking outside
        window.onclick = function(event) {
          const modal = document.getElementById('eventModal');
          if (event.target === modal) {
            closeEventModal();
          }
        }

        // Navigation functions
        function navigateDate(direction) {
          const prevDate = new Date(currentDate);
          
          if (currentView === 'day') {
            currentDate.setDate(currentDate.getDate() + (direction === 'next' ? 1 : -1));
          } else if (currentView === 'week') {
            currentDate.setDate(currentDate.getDate() + (direction === 'next' ? 7 : -7));
          } else if (currentView === 'month') {
            currentDate.setMonth(currentDate.getMonth() + (direction === 'next' ? 1 : -1));
          }
          
          console.log('Navigation - Previous date:', prevDate.toDateString(), 'New date:', currentDate.toDateString(), 'View:', currentView);
          
          updateCalendarTitle();
          loadCalendarEventsForDate();
        }

        function goToToday() {
          currentDate = new Date();
          currentView = 'day';
          updateViewButtons('day');
          console.log('Going to today (day view):', currentDate.toDateString());
          updateCalendarTitle();
          loadCalendarEventsForDate();
        }

        function getLocalDateString(date) {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return year + '-' + month + '-' + day;
        }

        function selectDayFromMonth(dateString) {
          // Create date from local string to avoid timezone issues
          const parts = dateString.split('-');
          currentDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          currentView = 'day';
          updateViewButtons('day');
          console.log('Selected day from month view:', {
            dateString: dateString,
            selectedDate: currentDate.toDateString(),
            view: currentView,
            actualDay: currentDate.getDate()
          });
          updateCalendarTitle();
          loadCalendarEventsForDate();
        }

        function updateCalendarTitle() {
          const titleElement = document.getElementById('calendarTitle');
          if (!titleElement) return;
          
          const options = { year: 'numeric', month: 'long', day: 'numeric' };
          
          if (currentView === 'day') {
            titleElement.textContent = currentDate.toLocaleDateString('es-ES', options);
          } else if (currentView === 'week') {
            const startOfWeek = new Date(currentDate.getTime() - (currentDate.getDay() * 24 * 60 * 60 * 1000));
            const endOfWeek = new Date(startOfWeek.getTime() + (6 * 24 * 60 * 60 * 1000));
            titleElement.textContent = startOfWeek.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) + 
                                     ' - ' + endOfWeek.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
          } else if (currentView === 'month') {
            titleElement.textContent = currentDate.toLocaleDateString('es-ES', { year: 'numeric', month: 'long' });
          }
        }

        function loadCalendarEventsForDate() {
          // Clear cache when navigating to different dates
          cachedEvents = null;
          lastFetchTime = null;
          loadCalendarEvents(currentView, true);
        }

        function renderCalendarView(events, view) {
          // Prevent concurrent renders
          if (isRenderingCalendar) {
            console.log('Render already in progress, skipping...');
            return;
          }
          
          isRenderingCalendar = true;
          
          try {
            const calendarGrid = document.querySelector('.calendar-grid');
            
            console.log('Rendering ' + view + ' view with ' + events.length + ' events:', events.map(e => ({
              summary: e.summary,
              start: e.start?.dateTime || e.start?.date,
              date: new Date(e.start?.dateTime || e.start?.date).toDateString()
            })));
            
            if (events.length === 0) {
              calendarGrid.innerHTML = '<div class="auth-prompt"><h3>No hay eventos</h3><p>No se encontraron eventos en tu calendario</p></div>';
              return;
            }
            
            if (view === 'week') {
              calendarGrid.innerHTML = renderWeekView(events);
            } else if (view === 'month') {
              calendarGrid.innerHTML = renderMonthView(events);
            } else {
              // Day view - filter events for selected date only
              const selectedDateStr = currentDate.toDateString();
              
              console.log('Day view filtering:', {
                selectedDate: selectedDateStr,
                selectedDay: currentDate.getDate(),
                totalEvents: events.length,
                eventsData: events.map(e => ({
                  summary: e.summary,
                  start: e.start?.dateTime || e.start?.date,
                  eventDateStr: new Date(e.start?.dateTime || e.start?.date).toDateString()
                }))
              });
              
              const dayEvents = events.filter(event => {
                const eventDate = new Date(event.start.dateTime || event.start.date);
                const matches = eventDate.toDateString() === selectedDateStr;
                if (matches) {
                  console.log('Event matches selected day:', {
                    eventSummary: event.summary,
                    eventDate: eventDate.toDateString(),
                    selectedDate: selectedDateStr
                  });
                }
                return matches;
              });
              
              console.log('Filtered day events:', dayEvents.length);
              
              if (dayEvents.length === 0) {
                calendarGrid.innerHTML = '<div class="auth-prompt"><h3>No hay eventos</h3><p>No tienes eventos programados para este día (' + selectedDateStr + ')</p></div>';
                return;
              }
              
              calendarGrid.innerHTML = dayEvents.map(event => 
                '<div class="event-item event-clickable" ' + safeOnclick('showEventDetails', event.id) + '>' +
                  '<div class="event-time">' + formatEventTime(event.start) + '</div>' +
                  '<div class="event-title">' + (event.summary || 'Sin título') + '</div>' +
                  '<div class="event-attendees">' + formatAttendees(event.attendees) + '</div>' +
                  '<div class="event-actions">' +
                    (event.hangoutLink ? '<a href="' + event.hangoutLink + '" target="_blank" class="event-join-btn" onclick="event.stopPropagation();">Unirse</a>' : '') +
                  '</div>' +
                '</div>'
              ).join('');
            }
          } finally {
            // Always reset the flag, even if an error occurs
            setTimeout(() => {
              isRenderingCalendar = false;
            }, 100);
          }
        }

        function renderWeekView(events) {
          const weekDays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
          
          // Get selected week boundaries
          const selectedDate = new Date(currentDate);
          const startOfWeek = new Date(selectedDate.getTime() - (selectedDate.getDay() * 24 * 60 * 60 * 1000));
          startOfWeek.setHours(0, 0, 0, 0);
          const endOfWeek = new Date(startOfWeek.getTime() + (7 * 24 * 60 * 60 * 1000));
          
          // Get current day info for highlighting
          const today = new Date();
          const todayDay = today.getDay();
          const isCurrentWeek = today >= startOfWeek && today < endOfWeek;
          
          // Filter events for selected week only
          const weekEvents = events.filter(event => {
            const eventDate = new Date(event.start.dateTime || event.start.date);
            return eventDate >= startOfWeek && eventDate < endOfWeek;
          });
          
          // Find the earliest event to determine starting hour
          let earliestHour = 24;
          if (weekEvents.length > 0) {
            earliestHour = Math.min(...weekEvents.map(event => {
              const eventDate = new Date(event.start.dateTime || event.start.date);
              return eventDate.getHours();
            }));
            // Start one hour before the earliest event, but not before 6 AM
            earliestHour = Math.max(6, earliestHour - 1);
          } else {
            earliestHour = 8; // Default to 8 AM if no events
          }
          
          const timeSlots = Array.from({length: 24 - earliestHour}, (_, i) => (earliestHour + i) + ':00');
          
          let html = '<div class="week-view">';
          
          // Fixed header with days
          html += '<div class="week-header">';
          html += '<div class="time-slot"></div>';
          weekDays.forEach((day, index) => {
            const isToday = isCurrentWeek && index === todayDay;
            const dayClass = isToday ? 'day-header current-day' : 'day-header';
            html += '<div class="' + dayClass + '">' + day + '</div>';
          });
          html += '</div>';
          
          // Scrollable body with time slots and events
          html += '<div class="week-body" id="week-body">';
          timeSlots.forEach((time, timeIndex) => {
            const currentHour = parseInt(time);
            html += '<div class="time-slot">' + time + '</div>';
            
            for (let day = 0; day < 7; day++) {
              const isToday = isCurrentWeek && day === todayDay;
              const dayColumnClass = isToday ? 'day-column current-day-column' : 'day-column';
              html += '<div class="' + dayColumnClass + '" data-day="' + day + '" data-hour="' + currentHour + '" onclick="handleWeekSlotClick(' + day + ', ' + currentHour + ')">';
              
              // Find events for this day and time
              const dayEvents = weekEvents.filter(event => {
                const eventDate = new Date(event.start.dateTime || event.start.date);
                const eventHour = eventDate.getHours();
                const eventDay = eventDate.getDay();
                return eventDay === day && eventHour === currentHour;
              });
              
              dayEvents.forEach(event => {
                html += '<div class="event-block" ' + safeOnclick('showEventDetails', event.id) + '>';
                html += (event.summary || 'Sin título').substring(0, 20);
                if (event.hangoutLink) {
                  html += '<br><a href="' + event.hangoutLink + '" target="_blank" style="color: white; text-decoration: underline;">Unirse</a>';
                }
                html += '</div>';
              });
              
              html += '</div>';
            }
          });
          html += '</div>';
          
          html += '</div>';
          
          // Add current time line if viewing current week
          if (isCurrentWeek) {
            setTimeout(() => {
              updateCurrentTimeLine();
              // Clear any existing interval
              if (currentTimeLineInterval) {
                clearInterval(currentTimeLineInterval);
              }
              // Update time line every minute
              currentTimeLineInterval = setInterval(updateCurrentTimeLine, 60000);
            }, 100);
          } else {
            // Clear interval if not viewing current week
            if (currentTimeLineInterval) {
              clearInterval(currentTimeLineInterval);
              currentTimeLineInterval = null;
            }
          }
          
          return html;
        }

        function renderMonthView(events) {
          const now = currentDate;
          const year = now.getFullYear();
          const month = now.getMonth();
          
          // Get today's date for highlighting
          const today = new Date();
          const todayDateString = today.toDateString();
          
          console.log('Rendering month view for ' + year + '-' + (month + 1) + ':', {
            totalEvents: events.length,
            currentDate: currentDate.toDateString(),
            firstDay: new Date(year, month, 1).toDateString(),
            lastDay: new Date(year, month + 1, 0).toDateString(),
            todayDateString: todayDateString
          });
          
          const firstDay = new Date(year, month, 1);
          const lastDay = new Date(year, month + 1, 0);
          const startDate = new Date(firstDay);
          startDate.setDate(startDate.getDate() - firstDay.getDay());
          
          const weekDays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
          
          let html = '<div class="month-view">';
          
          // Header row
          weekDays.forEach(day => {
            html += '<div class="day-header">' + day + '</div>';
          });
          
          // Calendar grid
          for (let i = 0; i < 42; i++) {
            const date = new Date(startDate);
            date.setDate(startDate.getDate() + i);
            
            const isCurrentMonth = date.getMonth() === month;
            const isToday = date.toDateString() === todayDateString;
            
            let dayClass = isCurrentMonth ? 'month-day' : 'month-day other-month';
            if (isToday) {
              dayClass += ' current-day-month';
            }
            
            html += '<div class="' + dayClass + '">';
            
            // Day number with special styling for today
            let dayNumberClass = 'month-day-number';
            if (isToday) {
              dayNumberClass += ' today-number';
            }
            
            html += '<div class="' + dayNumberClass + '" ' + safeOnclick('selectDayFromMonth', getLocalDateString(date)) + '>' + date.getDate() + '</div>';
            
            // Find events for this day
            const dayEvents = events.filter(event => {
              const eventDate = new Date(event.start.dateTime || event.start.date);
              return eventDate.toDateString() === date.toDateString();
            });
            
            if (dayEvents.length > 0) {
              console.log('Day ' + date.toDateString() + ' has ' + dayEvents.length + ' events:', dayEvents.map(e => e.summary));
            }
            
            dayEvents.forEach(event => {
              html += '<div class="month-event" ' + safeOnclick('showEventDetails', event.id) + '>';
              html += (event.summary || 'Sin título').substring(0, 15);
              html += '</div>';
            });
            
            html += '</div>';
          }
          
          html += '</div>';
          return html;
        }

        function refreshData() {
          const activeTab = document.querySelector('.nav-item.active').getAttribute('data-tab');
          if (activeTab === 'calendar') {
            // Check which view is active and load accordingly
            const activeView = document.querySelector('.view-btn.active')?.getAttribute('data-view') || 'week';
            loadCalendarEvents(activeView, true); // Force refresh
          } else if (activeTab === 'contacts') {
            loadContacts();
          }
        }

        // showStatus function moved to top of script

        async function syncContacts() {
          const statusDiv = document.getElementById('syncStatus');
          statusDiv.innerHTML = '<div class="status loading">Sincronizando contactos con Google Calendar...</div>';
          
          try {
            const response = await fetch('/api/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
            
            const result = await response.json();
            
            if (result.success) {
              const data = result.data;
              let message = result.message;
              
              if (data.errors && data.errors.length > 0) {
                message += '<br><br><strong>Errores:</strong><br>' + data.errors.slice(0, 5).join('<br>');
                if (data.errors.length > 5) {
                  message += '<br>... y ' + (data.errors.length - 5) + ' más';
                }
              }
              
              statusDiv.innerHTML = '<div class="status success">' + message + '</div>';
              
              // Refresh contacts list if we're on the contacts tab
              const activeTab = document.querySelector('.nav-item.active')?.getAttribute('data-tab');
              if (activeTab === 'contacts') {
                setTimeout(() => {
                  loadContacts();
                }, 1000);
              }
            } else {
              statusDiv.innerHTML = '<div class="status error">Error: ' + result.error + '</div>';
            }
          } catch (error) {
            statusDiv.innerHTML = '<div class="status error">Error: ' + error.message + '</div>';
          }
        }
        
        async function loadContacts() {
          const contactsList = document.getElementById('contactsList');
          contactsList.innerHTML = '<div class="status loading">Cargando contactos...</div>';
          
          try {
            // Load tags first to ensure colors are available
            await loadTagsAndContacts();
            
            const response = await fetch('/api/contacts');
            const result = await response.json();
            
            if (result.success) {
              if (result.data.length === 0) {
                contactsList.innerHTML = '<div class="auth-prompt"><h3>No hay contactos</h3><p>Sincroniza con Google Calendar para ver contactos</p></div>';
              } else {
                // Organize contacts by tags
                const contactsByTag = {
                  'New Lead': [],
                  'Untagged': []
                };
                
                result.data.forEach(contact => {
                  if (!contact.tags || contact.tags.length === 0) {
                    contactsByTag['Untagged'].push(contact);
                  } else {
                    contact.tags.forEach(tag => {
                      if (contactsByTag[tag]) {
                        contactsByTag[tag].push(contact);
                      } else {
                        // Create new category for custom tags
                        if (!contactsByTag[tag]) {
                          contactsByTag[tag] = [];
                        }
                        contactsByTag[tag].push(contact);
                      }
                    });
                  }
                });
                
                let html = '';
                
                // Show each category
                Object.keys(contactsByTag).forEach(tag => {
                  const contacts = contactsByTag[tag];
                  if (contacts.length > 0) {
                    const tagIcons = {
                      'New Lead': '●',
                      'Untagged': '○'
                    };
                    
                    const icon = tagIcons[tag] || '🏷️';
                    const color = getTagColor(tag);
                    
                    html += '<div style="margin-bottom: 25px;">';
                    html += '<h3 style="color: ' + color + '; margin-bottom: 15px; font-size: 18px;">' + icon + ' ' + tag + ' (' + contacts.length + ')</h3>';
                    
                    html += contacts.map(contact => {
                      const borderColor = tag === 'Untagged' ? '#e2e8f0' : color;
                      const proposalDays = contact.tags && contact.tags.includes('propuesta enviada') && contact.days_since_proposal 
                        ? '<div class="contact-proposal-days">' + contact.days_since_proposal + ' días desde propuesta</div>' 
                        : '';
                      
                      return '<div class="event-item contact-item" style="border-left: 4px solid ' + borderColor + '; cursor: pointer;" ' + safeOnclick('showContactDetails', contact.email) + '>' +
                        '<div class="event-title">' + contact.email + '</div>' +
                        '<div class="event-attendees">' + (contact.name || 'Sin nombre') + '</div>' +
                        proposalDays +
                        (contact.tags && contact.tags.length > 0 ? 
                          '<div class="contact-tags" style="margin-top: 8px;">' + 
                            contact.tags.map(t => '<span class="tag-badge ' + t.toLowerCase().replace(/\s+/g, '-') + '">' + t + '</span>').join('') +
                          '</div>' : '') +
                        (contact.notes ? '<div style="margin-top: 8px; color: #718096; font-size: 14px;">' + contact.notes.substring(0, 100) + (contact.notes.length > 100 ? '...' : '') + '</div>' : '') +
                        '<div style="margin-top: 8px; color: #718096; font-size: 12px;">Click para ver detalles</div>' +
                      '</div>';
                    }).join('');
                    
                    html += '</div>';
                  }
                });
                
                contactsList.innerHTML = html;
              }
            } else {
              contactsList.innerHTML = '<div class="status error">Error: ' + result.error + '</div>';
            }
          } catch (error) {
            contactsList.innerHTML = '<div class="status error">Error: ' + error.message + '</div>';
          }
        }

        // Global variable to store all contacts for filtering
        let allContactsData = [];

        // Enhanced loadContacts function with filtering support
        async function loadContactsWithFiltering() {
          const contactsList = document.getElementById('contactsList');
          contactsList.innerHTML = '<div class="status loading">Cargando contactos...</div>';
          
          try {
            const response = await fetch('/api/contacts');
            const result = await response.json();
            
            if (result.success) {
              allContactsData = result.data;
              
              // Load available tags for filter dropdown and colors
              await loadTagsForFilter();
              await loadTagsAndContacts();
              
              // Apply current filters
              filterContacts();
            } else {
              contactsList.innerHTML = '<div class="status error">Error: ' + result.error + '</div>';
            }
          } catch (error) {
            contactsList.innerHTML = '<div class="status error">Error: ' + error.message + '</div>';
          }
        }

        // Load tags for filter dropdown
        async function loadTagsForFilter() {
          try {
            const response = await fetch('/api/tags');
            const result = await response.json();
            
            if (result.success) {
              const tagFilter = document.getElementById('contactTagFilter');
              // Clear existing options except "All tags"
              tagFilter.innerHTML = '<option value="">Todas las etiquetas</option>';
              
              // Add available tags with edit functionality
              result.data.forEach(tagInfo => {
                const option = document.createElement('option');
                option.value = tagInfo.tag;
                option.textContent = getTagIcon(tagInfo.tag) + ' ' + tagInfo.tag + ' (' + tagInfo.count + ')';
                tagFilter.appendChild(option);
              });
              
              // Store tags data for editing and color lookup
              window.availableTagsData = result.data;
              availableTags = result.data;
              
              // Update tag colors cache
              tagColorsCache = {};
              result.data.forEach(tagInfo => {
                if (tagInfo.tag && tagInfo.color) {
                  tagColorsCache[tagInfo.tag] = tagInfo.color;
                }
              });
              
              // Add "Untagged" option
              const untaggedOption = document.createElement('option');
              untaggedOption.value = 'Untagged';
              untaggedOption.textContent = '○ Sin etiquetas';
              tagFilter.appendChild(untaggedOption);
            }
          } catch (error) {
            console.error('Error loading tags for filter:', error);
          }
        }

        // Filter contacts based on current filter settings
        function filterContacts() {
          const searchText = document.getElementById('contactSearchInput').value.toLowerCase();
          const tagFilter = document.getElementById('contactTagFilter').value;
          const sortFilter = document.getElementById('contactSortFilter').value;
          
          let filteredContacts = [...allContactsData];
          
          // Apply search filter
          if (searchText) {
            filteredContacts = filteredContacts.filter(contact => 
              contact.email.toLowerCase().includes(searchText) ||
              (contact.name && contact.name.toLowerCase().includes(searchText)) ||
              (contact.company && contact.company.toLowerCase().includes(searchText))
            );
          }
          
          // Apply tag filter
          if (tagFilter) {
            if (tagFilter === 'Untagged') {
              filteredContacts = filteredContacts.filter(contact => 
                !contact.tags || contact.tags.length === 0
              );
            } else {
              filteredContacts = filteredContacts.filter(contact => 
                contact.tags && contact.tags.includes(tagFilter)
              );
            }
          }
          
          // Apply sorting
          filteredContacts.sort((a, b) => {
            switch (sortFilter) {
              case 'name':
                const nameA = (a.name || a.email).toLowerCase();
                const nameB = (b.name || b.email).toLowerCase();
                return nameA.localeCompare(nameB);
              case 'recent':
              default:
                return new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at);
            }
          });
          
          // Update active filters display
          updateActiveFiltersDisplay(searchText, tagFilter, sortFilter);
          
          // Render filtered contacts
          renderFilteredContacts(filteredContacts);
        }

        // Update active filters display
        function updateActiveFiltersDisplay(searchText, tagFilter, sortFilter) {
          const filtersActive = document.getElementById('contactFiltersActive');
          const activeFiltersText = document.getElementById('activeFiltersText');
          
          const activeFilters = [];
          if (searchText) activeFilters.push('Búsqueda: "' + searchText + '"');
          if (tagFilter) activeFilters.push('Etiqueta: ' + tagFilter);
          if (sortFilter !== 'recent') activeFilters.push('Orden: ' + getSortLabel(sortFilter));
          
          if (activeFilters.length > 0) {
            activeFiltersText.textContent = activeFilters.join(' • ');
            filtersActive.style.display = 'block';
          } else {
            filtersActive.style.display = 'none';
          }
        }

        // Get sort label for display
        function getSortLabel(sortFilter) {
          switch (sortFilter) {
            case 'name': return 'Por nombre';
            case 'recent': return 'Más recientes';
            default: return sortFilter;
          }
        }

        // Get tag icon
        function getTagIcon(tag) {
          const tagIcons = {
            'New Lead': '●',
            'Untagged': '○'
          };
          return tagIcons[tag] || '■';
        }

        // Storage for dynamic tag colors
        let tagColorsCache = {};
        
        // Function to get tag color from cache or database
        function getTagColor(tagName) {
          if (tagColorsCache[tagName]) {
            return tagColorsCache[tagName];
          }
          
          // Default colors for special tags
          const defaultColors = {
            'New Lead': '#FF6B00',
            'Untagged': '#718096'
          };
          
          if (defaultColors[tagName]) {
            tagColorsCache[tagName] = defaultColors[tagName];
            return defaultColors[tagName];
          }
          
          // Try to get from availableTags (from database)
          if (availableTags && Array.isArray(availableTags)) {
            const tagInfo = availableTags.find(t => t.tag === tagName);
            if (tagInfo && tagInfo.color) {
              tagColorsCache[tagName] = tagInfo.color;
              return tagInfo.color;
            }
          }
          
          // Fallback color
          const fallbackColor = '#718096';
          tagColorsCache[tagName] = fallbackColor;
          return fallbackColor;
        }
        
        // Render filtered contacts
        function renderFilteredContacts(contacts) {
          const contactsList = document.getElementById('contactsList');
          
          if (contacts.length === 0) {
            contactsList.innerHTML = '<div class="auth-prompt"><h3>No se encontraron contactos</h3><p>Intenta ajustar los filtros de búsqueda</p></div>';
            return;
          }
          
          // Organize contacts by tags for display
          const contactsByTag = {};
          
          contacts.forEach(contact => {
            if (!contact.tags || contact.tags.length === 0) {
              if (!contactsByTag['Untagged']) contactsByTag['Untagged'] = [];
              contactsByTag['Untagged'].push(contact);
            } else {
              contact.tags.forEach(tag => {
                if (!contactsByTag[tag]) contactsByTag[tag] = [];
                contactsByTag[tag].push(contact);
              });
            }
          });
          
          let html = '';
          
          // Show each category
          Object.keys(contactsByTag).forEach(tag => {
            const tagContacts = contactsByTag[tag];
            if (tagContacts.length > 0) {
              const tagIcons = {
                'New Lead': '●',
                'Untagged': '○'
              };
              
              const icon = tagIcons[tag] || '🏷️';
              const color = getTagColor(tag);
              
              // Create collapsible section
              const sectionId = 'section-' + tag.toLowerCase().replace(/\s+/g, '-');
              
              html += '<div class="contact-section" style="margin-bottom: 25px;">';
              html += '<h3 class="section-header" style="color: ' + color + '; margin-bottom: 15px; font-size: 18px; cursor: pointer; user-select: none; display: flex; align-items: center; justify-content: space-between; padding: 10px 15px; background: rgba(255, 255, 255, 0.05); border-radius: 8px; transition: all 0.3s ease; border: 1px solid rgba(255, 255, 255, 0.1);" ' + safeOnclick('toggleSection', sectionId) + '>' + 
                     '<span><span class="section-icon" id="icon-' + sectionId + '">▼</span> ' + icon + ' ' + tag + ' (' + tagContacts.length + ')</span>' +
                     '<span style="font-size: 14px; opacity: 0.7;">Click para expandir/contraer</span>' +
                     '</h3>';
              
              html += '<div class="section-content" id="' + sectionId + '" style="display: block; padding-left: 15px;">';
              
              html += tagContacts.map(contact => {
                const borderColor = tag === 'Untagged' ? '#e2e8f0' : color;
                const proposalDays = contact.tags && contact.tags.includes('propuesta enviada') && contact.days_since_proposal 
                  ? '<div class="contact-proposal-days">' + contact.days_since_proposal + ' días desde propuesta</div>' 
                  : '';
                
                return '<div class="event-item contact-item" style="border-left: 4px solid ' + borderColor + '; cursor: pointer;" ' + safeOnclick('showContactDetails', contact.email) + '>' +
                  '<div class="event-title">' + contact.email + '</div>' +
                  '<div class="event-attendees">' + (contact.name || 'Sin nombre') + '</div>' +
                  proposalDays +
                  (contact.tags && contact.tags.length > 0 ? 
                    '<div class="contact-tags" style="margin-top: 8px;">' + 
                      contact.tags.map(t => {
                        const tagColor = getTagColor(t);
                        return '<span class="tag-badge" style="background: ' + tagColor + '; color: white; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-right: 8px; display: inline-block;">' + t + '</span>';
                      }).join('') +
                    '</div>' : '') +
                  (contact.notes ? '<div style="margin-top: 8px; color: #718096; font-size: 14px;">' + contact.notes.substring(0, 100) + (contact.notes.length > 100 ? '...' : '') + '</div>' : '') +
                  '<div style="margin-top: 8px; color: #718096; font-size: 12px;">Click para ver detalles</div>' +
                '</div>';
              }).join('');
              
              html += '</div></div>';
            }
          });
          
          contactsList.innerHTML = html;
        }
        
        // Function to toggle section visibility
        function toggleSection(sectionId) {
          const section = document.getElementById(sectionId);
          const icon = document.getElementById('icon-' + sectionId);
          
          if (section.style.display === 'none') {
            section.style.display = 'block';
            icon.textContent = '▼';
          } else {
            section.style.display = 'none';
            icon.textContent = '▶';
          }
        }

        // Clear all contact filters
        function clearContactFilters() {
          document.getElementById('contactSearchInput').value = '';
          document.getElementById('contactTagFilter').value = '';
          document.getElementById('contactSortFilter').value = 'recent';
          filterContacts();
        }

        // Funnel Kanban Functions
        let funnelStages = [
          { name: 'Sin etiqueta', tag: 'Untagged', color: '#718096', fixed: true }
        ];
        
        // Available tags from database for pipeline configuration
        let availableTagsForPipeline = [];
        
        let funnelData = {
          contacts: [],
          metrics: {
            totalLeads: 0,
            conversionRate: 0,
            avgStageTime: 0
          }
        };

        async function loadFunnelData() {
          try {
            // Load pipeline configuration from localStorage
            loadPipelineConfiguration();
            
            // Load contacts
            const contactsResponse = await fetch('/api/contacts');
            const contactsResult = await contactsResponse.json();
            
            if (contactsResult.success) {
              funnelData.contacts = contactsResult.data;
              
              // Load available tags to sync colors
              const tagsResponse = await fetch('/api/tags');
              const tagsResult = await tagsResponse.json();
              
              if (tagsResult.success) {
                // Update stages with actual colors from database
                const dbTags = tagsResult.data;
                funnelStages = funnelStages.map(stage => {
                  const dbTag = dbTags.find(t => t.tag === stage.tag);
                  if (dbTag) {
                    return { ...stage, color: dbTag.color };
                  }
                  return stage;
                });
              }
              
              renderFunnelBoard();
            }
          } catch (error) {
            console.error('Error loading funnel data:', error);
          }
        }


        function renderFunnelBoard() {
          const kanbanBoard = document.getElementById('kanbanBoard');
          kanbanBoard.innerHTML = '';
          
          funnelStages.forEach(stage => {
            const stageContacts = funnelData.contacts.filter(contact => {
              if (!contact.tags || contact.tags.length === 0) {
                return stage.tag === 'Untagged'; // Untagged contacts go to "Sin etiqueta"
              }
              return contact.tags.includes(stage.tag);
            });
            
            // Sort 'propuesta enviada' contacts by days (highest first)
            if (stage.tag === 'propuesta enviada') {
              stageContacts.sort((a, b) => {
                const aDays = a.days_since_proposal || 0;
                const bDays = b.days_since_proposal || 0;
                return bDays - aDays; // Descending order (mayor a menor)
              });
            }
            
            const columnHtml = 
              '<div class="kanban-column" data-stage="' + stage.tag + '">' +
                '<div class="kanban-column-header">' +
                  '<div class="kanban-column-title" style="color: ' + stage.color + ';">' +
                    stage.name +
                  '</div>' +
                  '<div class="kanban-column-actions">' +
                    '<div class="kanban-column-count">' + stageContacts.length + '</div>' +
                    (!stage.fixed ? '<button class="kanban-column-remove" onclick="removeModuleFromPipeline(\'' + stage.tag + '\')" title="Eliminar módulo">×</button>' : '') +
                  '</div>' +
                '</div>' +
                '<div class="kanban-cards" id="cards-' + stage.tag.replace(/\s+/g, '-') + '" ' +
                     'ondrop="dropCard(event, \'' + stage.tag + '\')" ' +
                     'ondragover="allowDrop(event)" ' +
                     'ondragleave="dragLeave(event)">' +
                  stageContacts.map(contact => renderKanbanCard(contact)).join('') +
                  (stageContacts.length === 0 ? 
                    '<div class="empty-column-message">Arrastra contactos aquí</div>' : '') +
                '</div>' +
              '</div>';
            
            kanbanBoard.innerHTML += columnHtml;
          });
        }

        function renderKanbanCard(contact) {
          const notes = contact.notes ? contact.notes.substring(0, 80) + '...' : '';
          const daysSinceProposal = contact.days_since_proposal;
          
          // Show days counter for 'propuesta enviada' contacts
          const proposalInfo = contact.tags && contact.tags.includes('propuesta enviada') && daysSinceProposal 
            ? '<div class="kanban-card-proposal-days">' + daysSinceProposal + ' días desde propuesta</div>' 
            : '';
          
          return '<div class="kanban-card" ' +
                   'draggable="true" ' +
                   'ondragstart="dragStart(event, \'' + contact.email + '\')" ' +
                   'onclick="showContactDetails(\'' + contact.email + '\')">' +
                 '<div class="kanban-card-header">' +
                   '<div>' +
                     '<div class="kanban-card-name">' + (contact.name || 'Sin nombre') + '</div>' +
                     '<div class="kanban-card-email">' + contact.email + '</div>' +
                   '</div>' +
                 '</div>' +
                 proposalInfo +
                 (notes ? '<div class="kanban-card-notes">' + notes + '</div>' : '') +
               '</div>';
        }

        // Drag and Drop Functions
        function dragStart(event, email) {
          event.dataTransfer.setData('text/plain', email);
          event.target.style.opacity = '0.5';
          event.target.style.transform = 'rotate(5deg)';
          
          // Add visual feedback to all drop zones
          document.querySelectorAll('.kanban-cards').forEach(container => {
            container.style.transition = 'all 0.3s ease';
          });
        }

        function allowDrop(event) {
          event.preventDefault();
          event.stopPropagation();
          
          // Find the kanban-cards container
          const cardsContainer = event.target.closest('.kanban-cards');
          if (cardsContainer) {
            cardsContainer.classList.add('drag-over');
          }
        }

        function dragLeave(event) {
          event.preventDefault();
          event.stopPropagation();
          
          // Only remove drag-over if we're actually leaving the container
          const cardsContainer = event.target.closest('.kanban-cards');
          if (cardsContainer && !cardsContainer.contains(event.relatedTarget)) {
            cardsContainer.classList.remove('drag-over');
          }
        }

        function dropCard(event, newStage) {
          event.preventDefault();
          event.stopPropagation();
          
          const email = event.dataTransfer.getData('text/plain');
          
          // Remove drag-over class from all containers
          document.querySelectorAll('.kanban-cards').forEach(container => {
            container.classList.remove('drag-over');
          });
          
          // Reset card styles
          document.querySelectorAll('.kanban-card').forEach(card => {
            card.style.opacity = '1';
            card.style.transform = 'none';
          });
          
          // Find contact and update stage
          const contact = funnelData.contacts.find(c => c.email === email);
          if (contact) {
            updateContactStage(contact, newStage);
          }
        }

        async function updateContactStage(contact, newStage) {
          try {
            // Remove old stage tags and add new one
            const updatedTags = contact.tags ? contact.tags.filter(tag => 
              !funnelStages.find(s => s.tag === tag)
            ) : [];
            
            // If moving to "Sin etiqueta", don't add any tag (leave empty)
            if (newStage !== 'Untagged' && !updatedTags.includes(newStage)) {
              updatedTags.push(newStage);
            }
            
            // Update contact tags in database
            const response = await fetch('/api/contacts/' + contact.email + '/tags', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tags: updatedTags })
            });
            
            if (response.ok) {
              // Update local data
              contact.tags = updatedTags;
              
              // Refresh board
              renderFunnelBoard();
            } else {
              alert('Error actualizando etapa del contacto');
            }
          } catch (error) {
            console.error('Error updating contact stage:', error);
            alert('Error actualizando etapa del contacto');
          }
        }

        // Pipeline Module Management Functions
        function showAddModuleModal() {
          // Load available tags first
          loadAvailableTagsForPipeline();
          document.getElementById('addModuleModal').style.display = 'block';
        }

        function closeAddModuleModal() {
          document.getElementById('addModuleModal').style.display = 'none';
          document.getElementById('moduleTagSelect').value = '';
          document.getElementById('modulePreview').style.display = 'none';
        }

        async function loadAvailableTagsForPipeline() {
          try {
            const response = await fetch('/api/tags');
            const result = await response.json();
            
            if (result.success) {
              availableTagsForPipeline = result.data;
              populateModuleTagSelect();
            }
          } catch (error) {
            console.error('Error loading tags for pipeline:', error);
          }
        }

        function populateModuleTagSelect() {
          const select = document.getElementById('moduleTagSelect');
          select.innerHTML = '<option value="">Selecciona una etiqueta...</option>';
          
          // Filter out tags that are already in the pipeline
          const usedTags = funnelStages.map(stage => stage.tag);
          const availableTags = availableTagsForPipeline.filter(tag => 
            !usedTags.includes(tag.tag)
          );
          
          availableTags.forEach(tag => {
            const option = document.createElement('option');
            option.value = tag.tag;
            option.textContent = tag.tag + ' (' + tag.count + ' contactos)';
            option.dataset.color = tag.color;
            select.appendChild(option);
          });
          
          // Add event listener for preview
          select.addEventListener('change', showModulePreview);
        }

        function showModulePreview() {
          const select = document.getElementById('moduleTagSelect');
          const selectedTag = select.value;
          const previewDiv = document.getElementById('modulePreview');
          const previewTitle = document.getElementById('previewTitle');
          
          if (selectedTag) {
            const tagData = availableTagsForPipeline.find(tag => tag.tag === selectedTag);
            if (tagData) {
              previewTitle.textContent = tagData.tag;
              previewTitle.style.color = tagData.color;
              previewDiv.style.display = 'block';
            }
          } else {
            previewDiv.style.display = 'none';
          }
        }

        function addModuleToPipeline() {
          const select = document.getElementById('moduleTagSelect');
          const selectedTag = select.value;
          
          if (!selectedTag) {
            alert('Por favor selecciona una etiqueta');
            return;
          }
          
          const tagData = availableTagsForPipeline.find(tag => tag.tag === selectedTag);
          if (!tagData) {
            alert('Error: etiqueta no encontrada');
            return;
          }
          
          // Add new module to pipeline
          funnelStages.push({
            name: tagData.tag,
            tag: tagData.tag,
            color: tagData.color,
            fixed: false
          });
          
          // Save pipeline configuration
          savePipelineConfiguration();
          
          // Refresh funnel display
          renderFunnelBoard();
          
          closeAddModuleModal();
        }

        function savePipelineConfiguration() {
          // Save to localStorage for persistence
          const pipelineConfig = funnelStages.map(stage => ({
            name: stage.name,
            tag: stage.tag,
            color: stage.color,
            fixed: stage.fixed
          }));
          
          localStorage.setItem('funnelPipelineConfig', JSON.stringify(pipelineConfig));
        }

        function loadPipelineConfiguration() {
          try {
            const saved = localStorage.getItem('funnelPipelineConfig');
            if (saved) {
              const config = JSON.parse(saved);
              // Only load non-fixed stages (keep "Sin etiqueta" always first)
              const nonFixedStages = config.filter(stage => !stage.fixed);
              funnelStages = [
                { name: 'Sin etiqueta', tag: 'Untagged', color: '#718096', fixed: true },
                ...nonFixedStages
              ];
            }
          } catch (error) {
            console.error('Error loading pipeline configuration:', error);
          }
        }

        function removeModuleFromPipeline(stageTag) {
          if (stageTag === 'Untagged') {
            alert('No se puede eliminar la columna "Sin etiqueta"');
            return;
          }
          
          if (confirm('¿Estás seguro de que quieres eliminar este módulo del pipeline?')) {
            funnelStages = funnelStages.filter(stage => stage.tag !== stageTag);
            savePipelineConfiguration();
            renderFunnelBoard();
          }
        }

        function refreshFunnelData() {
          loadFunnelData();
        }

        // Finance Tab Functions
        let currentUFValue = 37000; // Default fallback value
        let currentFinanceYear = new Date().getFullYear();
        let currentFinanceMonth = new Date().getMonth() + 1;
        
        async function loadFinanceData() {
          try {
            // Load current UF value first
            await loadCurrentUFValue();
            
            // Update month display
            updateMonthDisplay();
            
            // Load monthly billing data
            await loadMonthlyBillingData();
            
            // Calculate totals
            calculateMonthlyTotals();
            
          } catch (error) {
            console.error('Error loading finance data:', error);
            showStatus('Error cargando datos financieros', 'error');
          }
        }
        
        function updateMonthDisplay() {
          const monthNames = [
            'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
            'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
          ];
          
          const monthDisplay = monthNames[currentFinanceMonth - 1] + ' ' + currentFinanceYear;
          document.getElementById('currentMonthDisplay').textContent = monthDisplay;
        }
        
        function navigateMonth(direction) {
          currentFinanceMonth += direction;
          
          if (currentFinanceMonth > 12) {
            currentFinanceMonth = 1;
            currentFinanceYear++;
          } else if (currentFinanceMonth < 1) {
            currentFinanceMonth = 12;
            currentFinanceYear--;
          }
          
          updateMonthDisplay();
          loadMonthlyBillingData();
          calculateMonthlyTotals();
        }

        async function loadCurrentUFValue() {
          try {
            const response = await fetch('/api/uf-value');
            const data = await response.json();
            
            const currentUFElement = document.getElementById('currentUF');
            if (data.success) {
              currentUFValue = data.data.value;
              currentUFElement.textContent = '$ ' + currentUFValue.toLocaleString('es-CL');
            } else {
              currentUFValue = data.fallback;
              currentUFElement.textContent = '$ ' + currentUFValue.toLocaleString('es-CL');
            }
          } catch (error) {
            console.error('Error loading UF value:', error);
            currentUFValue = 37000; // Fallback value
            document.getElementById('currentUF').textContent = 'Error';
          }
        }

        async function loadMonthlyBillingData() {
          try {
            const response = await fetch('/api/monthly-billing/' + currentFinanceYear + '/' + currentFinanceMonth);
            const data = await response.json();
            
            const tbody = document.getElementById('financeTableBody');
            
            if (data.success && data.data.length > 0) {
              tbody.innerHTML = '';
              
              data.data.forEach(client => {
                const row = document.createElement('tr');
                
                // Calculate base price in CLP
                let basePriceInCLP = 0;
                let basePriceDisplay = 'Sin precio';
                
                if (client.base_monthly_price) {
                  if (client.base_currency === 'UF') {
                    basePriceInCLP = client.base_monthly_price * currentUFValue;
                    basePriceDisplay = formatCLP(basePriceInCLP) + ' (' + formatUF(client.base_monthly_price) + ')';
                  } else {
                    basePriceInCLP = client.base_monthly_price;
                    basePriceDisplay = formatCLP(basePriceInCLP);
                  }
                }
                
                // Calculate final price in CLP
                let finalPriceInCLP = 0;
                let finalPriceDisplay = 'Sin precio';
                
                if (client.final_price) {
                  if (client.final_currency === 'UF') {
                    finalPriceInCLP = client.final_price * currentUFValue;
                    finalPriceDisplay = formatCLP(finalPriceInCLP) + ' (' + formatUF(client.final_price) + ')';
                  } else {
                    finalPriceInCLP = client.final_price;
                    finalPriceDisplay = formatCLP(finalPriceInCLP);
                  }
                }
                
                // Calculate adjustment
                const adjustmentAmount = client.adjustment_amount || 0;
                let adjustmentDisplay = '$0';
                let adjustmentClass = 'zero';
                
                if (adjustmentAmount > 0) {
                  adjustmentDisplay = '+' + formatCLP(adjustmentAmount);
                  adjustmentClass = 'positive';
                } else if (adjustmentAmount < 0) {
                  adjustmentDisplay = '-' + formatCLP(Math.abs(adjustmentAmount));
                  adjustmentClass = 'negative';
                }
                
                row.innerHTML = 
                  '<td>' + (client.company || client.name || 'Sin empresa') + '</td>' +
                  '<td>' + client.email + '</td>' +
                  '<td>' + basePriceDisplay + '</td>' +
                  '<td><span class="adjustment-amount ' + adjustmentClass + '">' + adjustmentDisplay + '</span></td>' +
                  '<td>' + finalPriceDisplay + '</td>' +
                  '<td>' +
                    '<span class="currency-badge ' + (client.final_currency ? client.final_currency.toLowerCase() : 'clp') + '">' + (client.final_currency || 'CLP') + '</span>' +
                  '</td>' +
                  '<td>' +
                    '<div class="finance-actions">' +
                      '<button class="btn btn-sm btn-primary" onclick="openMonthlyBillingModal(' + client.contact_id + ')">' +
                        'Editar' +
                      '</button>' +
                    '</div>' +
                  '</td>';
                
                tbody.appendChild(row);
              });
            } else {
              tbody.innerHTML = '<tr><td colspan="7" class="no-data">No hay clientes activos para este mes</td></tr>';
            }
          } catch (error) {
            console.error('Error loading monthly billing:', error);
            document.getElementById('financeTableBody').innerHTML = '<tr><td colspan="7" class="no-data">Error cargando datos</td></tr>';
          }
        }

        function calculateMonthsActive(startDate) {
          if (!startDate) return 0;
          
          const start = new Date(startDate);
          const now = new Date();
          
          const months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
          return Math.max(0, months);
        }

        function formatDate(dateString) {
          if (!dateString) return '';
          const date = new Date(dateString);
          return date.toLocaleDateString('es-CL');
        }

        async function calculateMonthlyTotals() {
          try {
            const response = await fetch('/api/monthly-billing/' + currentFinanceYear + '/' + currentFinanceMonth);
            const data = await response.json();
            
            if (data.success) {
              let totalCLP = 0;
              let totalUF = 0;
              let totalCLPFromUF = 0;
              
              data.data.forEach(client => {
                if (client.final_price) {
                  if (client.final_currency === 'UF') {
                    totalUF += parseFloat(client.final_price);
                    totalCLPFromUF += parseFloat(client.final_price) * currentUFValue;
                  } else {
                    totalCLP += parseFloat(client.final_price);
                  }
                }
              });
              
              // Total CLP includes both direct CLP and converted UF
              const grandTotalCLP = totalCLP + totalCLPFromUF;
              
              document.getElementById('totalCLP').textContent = formatCLP(grandTotalCLP);
              document.getElementById('totalUF').textContent = formatUF(totalUF);
            }
          } catch (error) {
            console.error('Error calculating totals:', error);
          }
        }
        
        let currentBillingContactId = null;
        let currentBillingData = null;
        
        async function openMonthlyBillingModal(contactId) {
          currentBillingContactId = contactId;
          
          try {
            // Get current billing data
            const response = await fetch('/api/monthly-billing/' + currentFinanceYear + '/' + currentFinanceMonth);
            const data = await response.json();
            
            if (data.success) {
              const clientData = data.data.find(client => client.contact_id === contactId);
              
              if (clientData) {
                currentBillingData = clientData;
                populateMonthlyBillingModal(clientData);
                document.getElementById('monthlyBillingModal').style.display = 'block';
              } else {
                showStatus('Cliente no encontrado', 'error');
              }
            } else {
              showStatus('Error cargando datos de facturación', 'error');
            }
          } catch (error) {
            console.error('Error opening monthly billing modal:', error);
            showStatus('Error abriendo modal de facturación', 'error');
          }
        }
        
        function populateMonthlyBillingModal(clientData) {
          // Update client info
          document.getElementById('billingClientName').textContent = clientData.company || clientData.name || 'Sin empresa';
          document.getElementById('billingClientEmail').textContent = clientData.email;
          
          // Update period
          const monthNames = [
            'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
            'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
          ];
          const monthDisplay = monthNames[currentFinanceMonth - 1] + ' ' + currentFinanceYear;
          document.getElementById('billingPeriod').textContent = monthDisplay;
          
          // Calculate and display prices
          let basePriceInCLP = 0;
          let basePriceDisplay = 'Sin precio';
          
          if (clientData.base_monthly_price) {
            if (clientData.base_currency === 'UF') {
              basePriceInCLP = clientData.base_monthly_price * currentUFValue;
              basePriceDisplay = '$' + basePriceInCLP.toLocaleString('es-CL', { maximumFractionDigits: 0 }) + ' (' + clientData.base_monthly_price + ' UF)';
            } else {
              basePriceInCLP = clientData.base_monthly_price;
              basePriceDisplay = '$' + basePriceInCLP.toLocaleString('es-CL');
            }
          }
          
          document.getElementById('billingBasePrice').textContent = basePriceDisplay;
          
          // Current adjustment
          const adjustmentAmount = clientData.adjustment_amount || 0;
          let adjustmentDisplay = '$0';
          
          if (adjustmentAmount > 0) {
            adjustmentDisplay = '+$' + adjustmentAmount.toLocaleString('es-CL');
          } else if (adjustmentAmount < 0) {
            adjustmentDisplay = '-$' + Math.abs(adjustmentAmount).toLocaleString('es-CL');
          }
          
          document.getElementById('billingCurrentAdjustment').textContent = adjustmentDisplay;
          
          // Final price
          let finalPriceInCLP = 0;
          let finalPriceDisplay = 'Sin precio';
          
          if (clientData.final_price) {
            if (clientData.final_currency === 'UF') {
              finalPriceInCLP = clientData.final_price * currentUFValue;
              finalPriceDisplay = '$' + finalPriceInCLP.toLocaleString('es-CL', { maximumFractionDigits: 0 }) + ' (' + clientData.final_price + ' UF)';
            } else {
              finalPriceInCLP = clientData.final_price;
              finalPriceDisplay = '$' + finalPriceInCLP.toLocaleString('es-CL');
            }
          }
          
          document.getElementById('billingFinalPrice').textContent = finalPriceDisplay;
          
          // Populate form fields
          document.getElementById('billingAdjustedPrice').value = clientData.final_price || clientData.base_monthly_price || '';
          document.getElementById('billingCurrency').value = clientData.final_currency || clientData.base_currency || 'CLP';
          document.getElementById('billingAdjustmentReason').value = clientData.adjustment_reason || '';
          document.getElementById('billingStatus').value = clientData.billing_status || 'pending';
          document.getElementById('billingCustomReason').value = '';
        }
        
        function closeMonthlyBillingModal() {
          document.getElementById('monthlyBillingModal').style.display = 'none';
          currentBillingContactId = null;
          currentBillingData = null;
        }
        
        async function saveMonthlyBilling() {
          if (!currentBillingContactId) return;
          
          const adjustedPrice = document.getElementById('billingAdjustedPrice').value;
          const currency = document.getElementById('billingCurrency').value;
          const adjustmentReason = document.getElementById('billingAdjustmentReason').value;
          const customReason = document.getElementById('billingCustomReason').value;
          const billingStatus = document.getElementById('billingStatus').value;
          
          const finalReason = customReason || adjustmentReason || 'Precio base del contrato';
          
          if (!adjustedPrice) {
            showStatus('Por favor ingrese un precio ajustado', 'error');
            return;
          }
          
          await updateMonthlyBilling(currentBillingContactId, adjustedPrice, finalReason, currency, billingStatus);
          closeMonthlyBillingModal();
        }
        
        async function updateMonthlyBilling(contactId, adjustedPrice, adjustmentReason, currency, billingStatus) {
          try {
            const response = await fetch('/api/monthly-billing/' + contactId + '/' + currentFinanceYear + '/' + currentFinanceMonth, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                adjusted_price: parseFloat(adjustedPrice),
                currency: currency || 'CLP',
                adjustment_reason: adjustmentReason,
                adjustment_type: 'manual',
                billing_status: billingStatus || 'pending'
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              showStatus('Facturación mensual actualizada exitosamente', 'success');
              loadMonthlyBillingData();
              calculateMonthlyTotals();
            } else {
              showStatus('Error actualizando facturación: ' + result.error, 'error');
            }
          } catch (error) {
            console.error('Error updating monthly billing:', error);
            showStatus('Error actualizando facturación mensual', 'error');
          }
        }

        function editFinanceData(contactId) {
          // This will integrate with the existing contact modal
          // For now, we'll open the regular contact modal
          fetch('/api/contacts/' + contactId)
            .then(response => response.json())
            .then(data => {
              if (data.success) {
                openContactModal(data.contact);
              }
            })
            .catch(error => {
              console.error('Error loading contact:', error);
              showStatus('Error cargando contacto', 'error');
            });
        }

        // Finance Sub-tabs Functions
        let currentActiveFinanceTab = 'resumen';
        let currentResumenYear = new Date().getFullYear();
        let currentResumenMonth = new Date().getMonth() + 1;
        let currentProyectosYear = new Date().getFullYear();
        let currentProyectosMonth = new Date().getMonth() + 1;

        function switchFinanceSubTab(tabName) {
          // Update active tab button
          document.querySelectorAll('.finance-sub-tab').forEach(tab => {
            tab.classList.remove('active');
          });
          document.querySelector('[onclick="switchFinanceSubTab(\'' + tabName + '\')"]').classList.add('active');
          
          // Update active content
          document.querySelectorAll('.finance-sub-content').forEach(content => {
            content.classList.remove('active');
          });
          document.getElementById(tabName + '-content').classList.add('active');
          
          currentActiveFinanceTab = tabName;
          
          // Load appropriate data based on tab
          if (tabName === 'resumen') {
            loadResumenData();
          } else if (tabName === 'flujo') {
            loadFinanceData();
          } else if (tabName === 'proyectos') {
            loadProyectosData();
          }
        }

        function navigateMonthResumen(direction) {
          currentResumenMonth += direction;
          
          if (currentResumenMonth > 12) {
            currentResumenMonth = 1;
            currentResumenYear++;
          } else if (currentResumenMonth < 1) {
            currentResumenMonth = 12;
            currentResumenYear--;
          }
          
          updateMonthDisplayResumen();
          loadResumenData();
        }

        function navigateMonthProyectos(direction) {
          currentProyectosMonth += direction;
          
          if (currentProyectosMonth > 12) {
            currentProyectosMonth = 1;
            currentProyectosYear++;
          } else if (currentProyectosMonth < 1) {
            currentProyectosMonth = 12;
            currentProyectosYear--;
          }
          
          updateMonthDisplayProyectos();
          loadProyectosData();
        }

        function updateMonthDisplayResumen() {
          const monthNames = [
            'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
            'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
          ];
          
          const monthDisplay = monthNames[currentResumenMonth - 1] + ' ' + currentResumenYear;
          document.getElementById('currentMonthDisplayResumen').textContent = monthDisplay;
        }

        function updateMonthDisplayProyectos() {
          const monthNames = [
            'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
            'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
          ];
          
          const monthDisplay = monthNames[currentProyectosMonth - 1] + ' ' + currentProyectosYear;
          document.getElementById('currentMonthDisplayProyectos').textContent = monthDisplay;
        }

        // Format Chilean money amounts
        function formatCLP(amount) {
          return '$' + Math.round(amount).toLocaleString('es-CL');
        }
        
        function formatUF(amount) {
          if (amount % 1 === 0) {
            return 'UF' + Math.round(amount).toLocaleString('es-CL');
          } else {
            return 'UF' + amount.toLocaleString('es-CL', { maximumFractionDigits: 1 });
          }
        }

        async function loadResumenData() {
          try {
            updateMonthDisplayResumen();
            
            // Load financial summary data
            const response = await fetch('/api/financial-summary/' + currentResumenYear + '/' + currentResumenMonth);
            const data = await response.json();
            
            if (data.success) {
              const backendUFValue = data.data.currentUFValue;
              
              // Update summary cards
              document.getElementById('totalCLPResumen').textContent = formatCLP(data.data.monthlyBilling.totalCLP);
              document.getElementById('totalUFResumen').textContent = formatUF(data.data.monthlyBilling.totalUF);
              document.getElementById('totalProjectsCLP').textContent = formatCLP(data.data.projects.totalCLP);
              document.getElementById('totalMonthlyIncome').textContent = formatCLP(data.data.monthlyBilling.totalCLP + data.data.projects.totalCLP);
              
              // Load resumen table
              const tbody = document.getElementById('resumenTableBody');
              tbody.innerHTML = '';
              
              // Add monthly billing entries
              data.data.monthlyBilling.clients.forEach(client => {
                const row = document.createElement('tr');
                let amountDisplay = 'Sin precio';
                let currencyDisplay = 'CLP';
                
                if (client.final_price) {
                  if (client.final_currency === 'UF') {
                    amountDisplay = formatUF(client.final_price);
                    currencyDisplay = 'UF';
                  } else {
                    amountDisplay = formatCLP(client.final_price);
                    currencyDisplay = 'CLP';
                  }
                }
                
                row.innerHTML = 
                  '<td>Flujo Mensual</td>' +
                  '<td>' + (client.company || client.name || client.email) + '</td>' +
                  '<td>' + amountDisplay + '</td>' +
                  '<td>' + currencyDisplay + '</td>' +
                  '<td>Activo</td>';
                tbody.appendChild(row);
              });
              
              // Add project entries
              data.data.projects.payments.forEach(payment => {
                const row = document.createElement('tr');
                let amountDisplay = 'Sin monto';
                
                if (payment.amount) {
                  if (payment.currency === 'UF') {
                    amountDisplay = formatUF(payment.amount);
                  } else {
                    amountDisplay = formatCLP(payment.amount);
                  }
                }
                
                row.innerHTML = 
                  '<td>Proyecto</td>' +
                  '<td>' + payment.project_name + '</td>' +
                  '<td>' + amountDisplay + '</td>' +
                  '<td>' + payment.currency + '</td>' +
                  '<td>' + (payment.payment_status === 'pending' ? 'Pendiente' : 'Pagado') + '</td>';
                tbody.appendChild(row);
              });
              
              if (data.data.monthlyBilling.clients.length === 0 && data.data.projects.payments.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="no-data">No hay datos para este mes</td></tr>';
              }
            }
          } catch (error) {
            console.error('Error loading resumen data:', error);
            document.getElementById('resumenTableBody').innerHTML = '<tr><td colspan="5" class="no-data">Error cargando datos</td></tr>';
          }
        }

        async function loadProyectosData() {
          try {
            updateMonthDisplayProyectos();
            
            // Load projects data
            const response = await fetch('/api/projects/' + currentProyectosYear + '/' + currentProyectosMonth);
            const data = await response.json();
            
            if (data.success) {
              // Update summary cards
              document.getElementById('activeProjectsCount').textContent = data.data.activeProjects;
              document.getElementById('monthlyProjectIncome').textContent = '$ ' + data.data.monthlyIncome.toLocaleString('es-CL');
              document.getElementById('pendingProjectPayments').textContent = '$ ' + data.data.pendingPayments.toLocaleString('es-CL');
              
              // Load projects table
              const tbody = document.getElementById('projectsTableBody');
              tbody.innerHTML = '';
              
              if (data.data.projects.length > 0) {
                data.data.projects.forEach(project => {
                  const row = document.createElement('tr');
                  row.innerHTML = 
                    '<td>' + project.project_name + '</td>' +
                    '<td>' + (project.client_name || project.client_email) + '</td>' +
                    '<td>$ ' + project.total_amount.toLocaleString('es-CL') + '</td>' +
                    '<td>$ ' + project.paid_amount.toLocaleString('es-CL') + '</td>' +
                    '<td>$ ' + project.pending_amount.toLocaleString('es-CL') + '</td>' +
                    '<td>' + (project.project_status === 'active' ? 'Activo' : 'Completado') + '</td>' +
                    '<td>' +
                      '<button class="btn btn-sm btn-secondary" onclick="viewProjectDetails(' + project.id + ')">Ver</button>' +
                      '<button class="btn btn-sm btn-primary" onclick="addProjectPayment(' + project.id + ')">Pago</button>' +
                    '</td>';
                  tbody.appendChild(row);
                });
              } else {
                tbody.innerHTML = '<tr><td colspan="7" class="no-data">No hay proyectos para este mes</td></tr>';
              }
            }
          } catch (error) {
            console.error('Error loading proyectos data:', error);
            document.getElementById('projectsTableBody').innerHTML = '<tr><td colspan="7" class="no-data">Error cargando proyectos</td></tr>';
          }
        }

        function showCreateProjectModal() {
          // TODO: Implement create project modal
          alert('Funcionalidad de crear proyecto próximamente');
        }

        function viewProjectDetails(projectId) {
          // TODO: Implement project details view
          alert('Ver detalles del proyecto: ' + projectId);
        }

        function addProjectPayment(projectId) {
          // TODO: Implement add payment modal
          alert('Agregar pago al proyecto: ' + projectId);
        }

        // Override the original loadContacts function to use the new filtering version
        const originalLoadContacts = loadContacts;
        loadContacts = function() {
          // Check if we're on the contacts tab
          const activeTab = document.querySelector('.nav-item.active')?.getAttribute('data-tab');
          if (activeTab === 'contacts') {
            loadContactsWithFiltering();
          } else {
            originalLoadContacts();
          }
        };
        
        // Variables para el modal de crear eventos
        let eventAttendees = [];
        let attendeeTags = {}; // Para almacenar etiquetas por email
        
        // Función para abrir el modal de crear evento
        async function openCreateEventModal(prefillDate = null, prefillTime = null) {
          document.getElementById('createEventModal').style.display = 'block';
          
          // Cargar etiquetas antes de mostrar el modal
          await loadTagsForEvent();
          
          populateSimplifiedDateTimeOptions(prefillDate, prefillTime);
          
          // Resetear duración por defecto
          document.getElementById('eventDuration').value = '30';
          updateDurationButtons();
          
          // Inicializar lista de asistentes vacía
          eventAttendees = [];
          updateAttendeesList();
          
          // Inicializar event listeners
          setTimeout(initializeEventListeners, 100);
        }
        
        // Función para cerrar el modal
        function closeCreateEventModal() {
          document.getElementById('createEventModal').style.display = 'none';
          document.getElementById('createEventForm').reset();
          eventAttendees = [];
          attendeeTags = {}; // Limpiar etiquetas
          updateAttendeesList();
        }
        
        // Función para agregar asistente
        function addAttendee() {
          const emailInput = document.getElementById('attendeeEmail');
          const email = emailInput.value.trim();
          
          if (!email) {
            alert('Por favor ingresa un email');
            return;
          }
          
          if (!validateEmail(email)) {
            alert('Por favor ingresa un email válido');
            return;
          }
          
          if (eventAttendees.includes(email)) {
            alert('Este email ya está en la lista de asistentes');
            return;
          }
          
          eventAttendees.push(email);
          emailInput.value = '';
          updateAttendeesList();
        }
        
        // Función para remover asistente
        function removeAttendee(email) {
          eventAttendees = eventAttendees.filter(attendee => attendee !== email);
          delete attendeeTags[email]; // Remover etiqueta también
          updateAttendeesList();
        }
        
        // Función para generar opciones de etiquetas dinámicas
        function generateTagOptions(selectedTag) {
          if (!availableTags || availableTags.length === 0) {
            return '<option value="New Lead" selected>New Lead</option>';
          }
          
          return availableTags.map(tagInfo => {
            const tag = tagInfo.tag;
            const isSelected = tag === selectedTag;
            return '<option value="' + tag + '"' + (isSelected ? ' selected' : '') + '>' + tag + '</option>';
          }).join('');
        }

        // Función para actualizar etiqueta de asistente
        function updateAttendeeTag(email, tag) {
          if (tag) {
            attendeeTags[email] = tag;
          } else {
            delete attendeeTags[email];
          }
        }
        
        // Función para actualizar la lista de asistentes
        function updateAttendeesList() {
          const attendeesList = document.getElementById('attendeesList');
          
          if (eventAttendees.length === 0) {
            attendeesList.innerHTML = '<div style="text-align: center; color: #718096; font-style: italic;">No hay asistentes agregados</div>';
            return;
          }
          
          attendeesList.innerHTML = eventAttendees.map(email => {
            const isExternal = !email.includes('@intothecom.com') && !email.includes('@intothecom');
            const currentTag = attendeeTags[email] || (availableTags.length > 0 ? availableTags[0].tag : 'New Lead');
            
            // Asegurar que los externos tengan etiqueta por defecto
            if (isExternal && !attendeeTags[email]) {
              attendeeTags[email] = availableTags.length > 0 ? availableTags[0].tag : 'New Lead';
            }
            
            return '<div class="attendee-item">' +
              '<div class="attendee-info">' +
                '<span class="attendee-email">' + email + '</span>' +
                (isExternal ? 
                  '<div class="attendee-tags">' +
                    '<select class="attendee-tag-select" onchange="updateAttendeeTag(\'' + email + '\', this.value)">' +
                      generateTagOptions(currentTag) +
                    '</select>' +
                  '</div>' : 
                  '<span class="internal-badge">Interno</span>'
                ) +
              '</div>' +
              '<button class="remove-attendee" onclick="removeAttendee(\'' + email + '\')">Remover</button>' +
            '</div>';
          }).join('');
        }
        
        // Función para validar email
        function validateEmail(email) {
          const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          return re.test(email);
        }
        
        // Función para formatear fecha para input
        function formatDateForInput(date) {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return year + '-' + month + '-' + day;
        }
        
        // Función para formatear hora para input
        function formatTimeForInput(date) {
          const hours = String(date.getHours()).padStart(2, '0');
          const minutes = String(date.getMinutes()).padStart(2, '0');
          return hours + ':' + minutes;
        }
        
        // Función para formatear hora para select
        function formatTimeForSelect(date) {
          const hours = String(date.getHours()).padStart(2, '0');
          const minutes = String(date.getMinutes()).padStart(2, '0');
          return hours + ':' + minutes;
        }
        
        // Función para poblar las opciones de fecha/hora simplificadas
        function populateSimplifiedDateTimeOptions(prefillDate = null, prefillTime = null) {
          const select = document.getElementById('eventStartDateTime');
          const now = new Date();
          
          
          // Generar opciones para los próximos 14 días
          const options = [];
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          
          for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
            const currentDay = new Date(today.getTime() + dayOffset * 24 * 60 * 60 * 1000);
            
            // Solo mostrar horas futuras para hoy
            let startHour = dayOffset === 0 ? Math.max(now.getHours(), 8) : 8;
            let endHour = 20; // Hasta las 8 PM
            
            for (let hour = startHour; hour <= endHour; hour++) {
              for (let minute = 0; minute < 60; minute += 15) {
                const optionDate = new Date(currentDay);
                optionDate.setHours(hour, minute, 0, 0);
                
                // No mostrar horarios pasados
                if (optionDate > now) {
                  const value = optionDate.toISOString();
                  const display = formatSimplifiedDateTime(optionDate, dayOffset);
                  options.push({ value, display });
                }
              }
            }
          }
          
          select.innerHTML = options.map(option => 
            '<option value="' + option.value + '">' + option.display + '</option>'
          ).join('');
          
          // Seleccionar la opción más cercana a la hora solicitada
          if (prefillDate && prefillTime) {
            // Crear fecha target usando el formato YYYY-MM-DD y la hora
            const [year, month, day] = prefillDate.split('-');
            const [hours, minutes] = prefillTime.split(':');
            const targetDateTime = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hours), parseInt(minutes), 0, 0);
            
            
            // Encontrar la opción más cercana
            let closestOption = null;
            let minDiff = Infinity;
            
            for (const option of options) {
              const optionDate = new Date(option.value);
              const diff = Math.abs(optionDate.getTime() - targetDateTime.getTime());
              if (diff < minDiff) {
                minDiff = diff;
                closestOption = option;
              }
            }
            
            if (closestOption) {
              select.value = closestOption.value;
            }
          }
        }
        
        // Función para formatear la hora de display (estilo Google Calendar)
        function formatTimeDisplay(hour, minute) {
          const ampm = hour >= 12 ? 'PM' : 'AM';
          const displayHour = hour % 12 || 12;
          const displayMinute = minute === 0 ? '' : ':' + String(minute).padStart(2, '0');
          return displayHour + displayMinute + ' ' + ampm;
        }
        
        // Función para actualizar la hora de fin automáticamente
        function updateEndTimeBasedOnStart() {
          const startTime = document.getElementById('eventStartTime').value;
          const endTimeSelect = document.getElementById('eventEndTime');
          
          if (startTime) {
            const [startHour, startMinute] = startTime.split(':').map(Number);
            const startDateTime = new Date();
            startDateTime.setHours(startHour, startMinute, 0, 0);
            
            // Agregar 1 hora por defecto
            const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);
            const endTime = formatTimeForSelect(endDateTime);
            
            endTimeSelect.value = endTime;
          }
        }
        
        // Función para formatear fecha/hora simplificada
        function formatSimplifiedDateTime(date, dayOffset) {
          const days = ['Hoy', 'Mañana', 'Pasado mañana'];
          const weekdays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
          const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
          
          let dayDisplay;
          if (dayOffset < 3) {
            dayDisplay = days[dayOffset];
          } else {
            dayDisplay = weekdays[date.getDay()] + ' ' + date.getDate() + ' ' + months[date.getMonth()];
          }
          
          const timeDisplay = formatTimeDisplay(date.getHours(), date.getMinutes());
          return dayDisplay + ' a las ' + timeDisplay;
        }
        
        // Función para seleccionar duración
        function selectDuration(minutes) {
          // Actualizar valor hidden
          document.getElementById('eventDuration').value = minutes;
          
          // Actualizar botones
          updateDurationButtons();
        }
        
        // Función para actualizar botones de duración
        function updateDurationButtons() {
          const selectedDuration = parseInt(document.getElementById('eventDuration').value);
          
          document.querySelectorAll('.duration-btn').forEach(btn => {
            btn.classList.remove('active');
            if (parseInt(btn.dataset.duration) === selectedDuration) {
              btn.classList.add('active');
            }
          });
        }
        
        // Función para cargar etiquetas disponibles para eventos
        async function loadTagsForEvent() {
          try {
            const response = await fetch('/api/tags');
            const result = await response.json();
            
            if (result.success && result.data && result.data.length > 0) {
              availableTags = result.data;
              
              // Actualizar cache de colores
              tagColorsCache = {};
              result.data.forEach(tagInfo => {
                if (tagInfo.tag && tagInfo.color) {
                  tagColorsCache[tagInfo.tag] = tagInfo.color;
                }
              });
            } else {
              // Fallback a etiquetas por defecto
              availableTags = [
                { tag: 'New Lead', color: '#FF6B00', count: 0 },
                { tag: 'Cliente', color: '#48bb78', count: 0 },
                { tag: 'Prospecto', color: '#ed8936', count: 0 }
              ];
            }
          } catch (error) {
            console.error('Error loading tags for event:', error);
            // Fallback a etiquetas por defecto
            availableTags = [
              { tag: 'New Lead', color: '#FF6B00', count: 0 },
              { tag: 'Cliente', color: '#48bb78', count: 0 },
              { tag: 'Prospecto', color: '#ed8936', count: 0 }
            ];
          }
        }
        
        // Función para crear el evento
        async function createNewEvent() {
          const form = document.getElementById('createEventForm');
          const formData = new FormData(form);
          
          // Validar campos requeridos
          const title = formData.get('summary');
          const startDateTime = formData.get('startDateTime');
          const duration = parseInt(formData.get('duration'));
          
          if (!title || !startDateTime || !duration) {
            alert('Por favor completa todos los campos requeridos');
            return;
          }
          
          // Calcular fecha/hora de fin
          const startDate = new Date(startDateTime);
          const endDate = new Date(startDate.getTime() + duration * 60 * 1000);
          
          // Preparar datos del evento
          const eventData = {
            summary: title,
            description: formData.get('description'),
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            attendees: eventAttendees.map(email => email.trim()),
            notes: formData.get('notes'),
            attendeeTags: attendeeTags
          };
          
          try {
            const response = await fetch('/api/events', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(eventData)
            });
            
            // Leer la respuesta una sola vez
            const result = await response.json();
            
            // Verificar si la respuesta HTTP es exitosa
            if (!response.ok) {
              const errorMessage = result.error || 'Error del servidor';
              throw new Error('HTTP ' + response.status + ': ' + errorMessage);
            }
            
            if (result.success) {
              // Cerrar modal inmediatamente para mejor UX
              closeCreateEventModal();
              
              // Recargar eventos del calendario
              loadEventsWithCurrentView();
              
              // Debug: Log the result structure
              console.log('Event creation result:', result);
              console.log('Event data:', result.data);
              console.log('Event ID:', result.data ? result.data.id : 'NO ID');
              
              // Etiquetar automáticamente correos externos (en background)
              // Usar setTimeout para hacer esto completamente asíncrono y evitar errores
              setTimeout(() => {
                try {
                  if (eventAttendees && eventAttendees.length > 0) {
                    const externalAttendees = eventAttendees.filter(email => 
                      !email.includes('@intothecom.com') && !email.includes('@intothecom')
                    );
                    
                    if (externalAttendees.length > 0 && result.data && result.data.id) {
                      // Usar etiquetas asignadas individualmente para cada asistente
                      for (const email of externalAttendees) {
                        // Validar que las variables existen
                        if (typeof attendeeTags === 'undefined') {
                          console.warn('attendeeTags is undefined, skipping tag sync');
                          continue;
                        }
                        if (typeof availableTags === 'undefined') {
                          console.warn('availableTags is undefined, using default tag');
                          availableTags = [{ tag: 'New Lead', count: 0 }];
                        }
                        
                        const tag = attendeeTags[email] || (availableTags.length > 0 ? availableTags[0].tag : 'New Lead');
                        syncAttendeeTags(result.data.id, [email], [tag]).catch(error => {
                          console.error('Error syncing attendee tags for', email, ':', error);
                          // No mostrar error al usuario, es proceso en background
                        });
                      }
                    } else if (externalAttendees.length > 0) {
                      console.warn('Cannot sync attendee tags: Event ID not available or no external attendees');
                    }
                  }
                } catch (syncError) {
                  console.error('Error in background attendee tag sync:', syncError);
                  // No mostrar error al usuario, es proceso en background
                }
              }, 100);
              
              // Mostrar notificación de éxito (opcional)
              console.log('Reunión creada exitosamente');
            } else {
              alert('Error al crear la reunión: ' + result.error);
            }
          } catch (error) {
            console.error('Error creating event:', error);
            
            // Mostrar mensaje específico según el tipo de error
            if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
              alert('Error de conexión. Verifica tu conexión a internet e intenta nuevamente.');
            } else if (error.message.includes('401')) {
              alert('Error de autenticación. Por favor reconecta tu cuenta de Google Calendar.');
            } else {
              alert('Error al crear la reunión: ' + (error.message || 'Error desconocido'));
            }
          }
        }
        
        // Función para sincronizar etiquetas de asistentes
        async function syncAttendeeTags(eventId, attendees, tags) {
          try {
            for (const attendeeEmail of attendees) {
              await fetch('/api/sync-attendee-tags', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  eventId: eventId,
                  attendeeEmail: attendeeEmail,
                  tags: tags
                })
              });
            }
            console.log('Attendee tags synchronized successfully');
          } catch (error) {
            console.error('Error syncing attendee tags:', error);
          }
        }
        
        // Función para cargar eventos con la vista actual
        function loadEventsWithCurrentView() {
          loadCalendarEvents(currentView, true); // true para forzar refresh
        }
        
        // Función para manejar click en slots de la vista semana
        function handleWeekSlotClick(dayIndex, hour) {
          // Verificar si hay eventos en este slot
          const weekSlot = event.target;
          const hasEvents = weekSlot.querySelector('.event-block');
          
          // Solo crear evento si no hay eventos existentes
          if (!hasEvents) {
            // Calcular la fecha del slot clickeado
            const selectedDate = new Date(currentDate);
            const startOfWeek = new Date(selectedDate.getTime() - (selectedDate.getDay() * 24 * 60 * 60 * 1000));
            const targetDate = new Date(startOfWeek.getTime() + (dayIndex * 24 * 60 * 60 * 1000));
            
            // Formatear fecha y hora
            const dateString = formatDateForInput(targetDate);
            const timeString = String(hour).padStart(2, '0') + ':00';
            
            
            // Abrir modal con fecha y hora pre-rellenadas
            openCreateEventModal(dateString, timeString);
          }
        }
        
        // Permitir Enter para agregar asistente
        function initializeEventListeners() {
          // Inicializar cuando se abra el modal
          const attendeeInput = document.getElementById('attendeeEmail');
          if (attendeeInput) {
            // Remover listener anterior si existe
            attendeeInput.removeEventListener('keypress', handleAttendeeKeyPress);
            // Agregar nuevo listener
            attendeeInput.addEventListener('keypress', handleAttendeeKeyPress);
          }
        }
        
        function handleAttendeeKeyPress(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            addAttendee();
          }
        }
        
      </script>
      
      <!-- Modal para crear nueva reunión -->
      <div id="createEventModal" class="modal" style="display: none;">
        <div class="modal-content">
          <div class="modal-header">
            <h3>Nueva Reunión</h3>
            <button class="close-btn" onclick="closeCreateEventModal()">&times;</button>
          </div>
          <div class="modal-body">
            <form id="createEventForm">
              <div class="form-group">
                <label for="eventTitle">Título de la reunión *</label>
                <input type="text" id="eventTitle" name="summary" required class="form-control" placeholder="Ej: Reunión con cliente">
              </div>
              
              <div class="form-group">
                <label for="eventStartDateTime">¿Cuándo? *</label>
                <select id="eventStartDateTime" name="startDateTime" required class="form-control datetime-dropdown">
                  <!-- Options will be populated by JavaScript -->
                </select>
              </div>
              
              <div class="form-group">
                <label for="eventDuration">¿Cuánto tiempo? *</label>
                <div class="duration-options">
                  <button type="button" class="duration-btn active" data-duration="30" onclick="selectDuration(30)">30 min</button>
                  <button type="button" class="duration-btn" data-duration="60" onclick="selectDuration(60)">1 hora</button>
                  <button type="button" class="duration-btn" data-duration="90" onclick="selectDuration(90)">1.5 horas</button>
                  <button type="button" class="duration-btn" data-duration="120" onclick="selectDuration(120)">2 horas</button>
                </div>
                <input type="hidden" id="eventDuration" name="duration" value="30">
              </div>
              
              <div class="form-group">
                <label for="eventDescription">Descripción</label>
                <textarea id="eventDescription" name="description" class="form-control" rows="3" placeholder="Descripción de la reunión"></textarea>
              </div>
              
              <div class="form-group">
                <label for="eventAttendees">Asistentes</label>
                <div class="attendees-input-container">
                  <input type="email" id="attendeeEmail" class="form-control" placeholder="email@ejemplo.com">
                  <button type="button" class="btn btn-outline btn-sm" onclick="addAttendee()">Agregar</button>
                </div>
                <div id="attendeesList" class="attendees-list"></div>
              </div>
              
              <div class="form-group">
                <label for="eventNotes">Notas internas</label>
                <textarea id="eventNotes" name="notes" class="form-control" rows="2" placeholder="Notas privadas (no visibles para asistentes)"></textarea>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline" onclick="closeCreateEventModal()">Cancelar</button>
            <button type="button" class="btn btn-primary" onclick="createNewEvent()">Crear Reunión</button>
          </div>
        </div>
      </div>
      
    </body>
    </html>
  `);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 CRM Server running on port ' + PORT);
  console.log('📱 Web interface: http://localhost:' + PORT);
  console.log('🔗 API endpoints:');
  console.log('   GET  /api/contacts - Get all contacts');
  console.log('   GET  /api/contacts/new - Get new contacts');
  console.log('   POST /api/sync - Manual sync');
  console.log('   GET  /api/contacts/:contactId/attachments - Get attachments');
  console.log('   POST /api/contacts/:contactId/attachments - Upload attachment');
  console.log('   GET  /api/contacts/:contactId/attachments/:attachmentId/download - Download attachment');
  console.log('   DELETE /api/contacts/:contactId/attachments/:attachmentId - Delete attachment');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

module.exports = app;/* Force rebuild Tue Jul 15 11:34:05 -04 2025 */
/* Deploy force 2025-07-15 11:56:35 */
