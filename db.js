const { createClient } = require('@libsql/client');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

const url = process.env.TURSO_DB_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

// Logging for deployment debugging
if (url) {
  console.log('✅ Found TURSO_DB_URL');
} else {
  console.warn('⚠️ TURSO_DB_URL is MISSING from environment variables.');
}

const db = createClient({
  url: url || 'file:local.db', 
  authToken: authToken,
});


/**
 * Initialize the database schema.
 */
async function initDb() {
  try {
    // 1. Core Users Table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        college_id TEXT UNIQUE NOT NULL,
        name TEXT,
        roll_no TEXT,
        course TEXT,
        branch TEXT,
        semester INTEGER,
        section TEXT,
        email TEXT,
        phone TEXT,
        profile_image TEXT,
        barcode_id TEXT,
        profile_complete BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Ensure columns are present (Simple safeguards for existing tables)
    const columns = [
      "ALTER TABLE users ADD COLUMN barcode_id TEXT",
      "ALTER TABLE users ADD COLUMN profile_complete BOOLEAN DEFAULT 0",
      "ALTER TABLE users ADD COLUMN profile_image TEXT",
      "ALTER TABLE users ADD COLUMN last_active_at DATETIME"
    ];

    for (const sql of columns) {
      try {
        await db.execute(sql);
      } catch (e) {
        // Silently skip if column already exists or table is locked
      }
    }

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
  }
}

/**
 * Test the database connection.
 */
async function checkConnection() {
  try {
    const result = await db.execute("SELECT 1");
    return { status: "connected", message: "Successfully connected to Turso" };
  } catch (error) {
    return { status: "error", message: error.message };
  }
}

// Supabase configuration for Admin Auth and Admin DB
const supabaseUrl = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || 'placeholder';
const supabase = createSupabaseClient(supabaseUrl, supabaseKey);

// Automatically init DB on start
initDb();

module.exports = { db, checkConnection, supabase };
