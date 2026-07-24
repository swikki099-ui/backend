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

    // 2. Faculty Table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS faculty (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        designation TEXT,
        department TEXT,
        email TEXT,
        phone TEXT,
        qualification TEXT,
        specialization TEXT,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Ensure columns are present (Simple safeguards for existing tables)
    const columns = [
      "ALTER TABLE users ADD COLUMN barcode_id TEXT",
      "ALTER TABLE users ADD COLUMN profile_complete BOOLEAN DEFAULT 0",
      "ALTER TABLE users ADD COLUMN profile_image TEXT",
      "ALTER TABLE users ADD COLUMN last_active_at DATETIME",
      "ALTER TABLE faculty ADD COLUMN profile_image TEXT",
      "ALTER TABLE chat_messages ADD COLUMN is_pinned INTEGER DEFAULT 0",
      "ALTER TABLE chat_messages ADD COLUMN semester INTEGER",
      "ALTER TABLE chat_messages ADD COLUMN section TEXT",
      "ALTER TABLE chat_messages ADD COLUMN verify_badge INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN verify_badge INTEGER DEFAULT 0",
      "ALTER TABLE social_posts ADD COLUMN video_url TEXT",
      "ALTER TABLE social_posts ADD COLUMN video_file_id TEXT",
      "ALTER TABLE social_posts ADD COLUMN video_thumbnail TEXT",
      "ALTER TABLE social_posts ADD COLUMN b2_file_id TEXT",
      "ALTER TABLE social_posts ADD COLUMN b2_file_name TEXT",
      "ALTER TABLE chat_messages ADD COLUMN voice_url TEXT",
    ];

    for (const sql of columns) {
      try {
        await db.execute(sql);
      } catch (e) {
        // Silently skip if column already exists or table is locked
      }
    }

    // 3. Faculty Table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS faculty (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        designation TEXT,
        department TEXT,
        email TEXT,
        phone TEXT,
        qualification TEXT,
        specialization TEXT,
        profile_image TEXT,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Calendar Events Table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        description TEXT,
        type TEXT DEFAULT 'general',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 5. App Config (key-value settings)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 6. Chat Messages Table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        roll_no TEXT,
        profile_image TEXT,
        message TEXT,
        parent_id INTEGER,
        mentions TEXT DEFAULT '[]',
        reactions TEXT DEFAULT '{}',
        message_type TEXT DEFAULT 'text',
        gif_url TEXT,
        sticker_url TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 7. Library Documents Table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS library_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        caption TEXT NOT NULL,
        b2_file_name TEXT NOT NULL,
        b2_file_id TEXT,
        mime_type TEXT DEFAULT 'application/octet-stream',
        file_size INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 8. Chat Bans Table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS chat_bans (
        user_id INTEGER PRIMARY KEY,
        banned_by INTEGER,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

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

// Fixup: ensure existing bans have is_active set (legacy records before column default)
async function fixupBans() {
    try {
        const { error } = await supabase
            .from('user_bans')
            .update({ is_active: true })
            .is('is_active', null);
        if (error) throw error;
        console.log('✅ Fixed existing bans (is_active = null → true)');
    } catch (e) {
        // Silently skip if table/column doesn't exist yet
    }
}

// Automatically init DB on start
initDb();
fixupBans();

module.exports = { db, checkConnection, supabase };
