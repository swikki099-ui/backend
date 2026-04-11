const { supabase } = require('../db');

/**
 * Log a system or user activity to the real-time activity feed.
 * @param {string} type - 'login', 'sync', 'ban', 'update', 'mail', 'system'
 * @param {string} title - Short title for the activity
 * @param {string} description - Brief description of the event
 * @param {object} options - Optional: { icon, color, metadata }
 */
async function logActivity(type, title, description, options = {}) {
    try {
        const { icon = 'activity', color = 'blue', metadata = {} } = options;
        
        const { error } = await supabase.from('activity_feed').insert({
            type,
            title,
            description,
            icon,
            color,
            metadata
        });

        if (error) throw error;
        
        // Console log for debugging
        console.log(`[ACTIVITY] ${type.toUpperCase()}: ${title} - ${description}`);
        
    } catch (err) {
        console.error('❌ Failed to log activity:', err.message);
    }
}

module.exports = { logActivity };
