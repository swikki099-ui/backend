const { createClient } = require('@libsql/client');

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
        barcode_id TEXT UNIQUE,
        profile_complete BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Safeguard: Ensure profile_complete column exists if table was created previously
    try {
      await db.execute("ALTER TABLE users ADD COLUMN profile_complete BOOLEAN DEFAULT 0");
      console.log('✅ Added profile_complete column');
    } catch (e) {
      if (!e.message.includes("duplicate column name")) {
        console.warn('⚠️ Column check warning:', e.message);
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

// Automatically init DB on start
initDb();

module.exports = { db, checkConnection };

