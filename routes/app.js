const express = require('express');
const { supabase } = require('../db');

const router = express.Router();

// GET /app/version
// Strictly reads from Supabase app_settings table (managed via Admin Panel).
router.get('/version', async (req, res) => {
    try {
        // Source of Truth: Supabase DB (Managed by Admin Panel)
        const { data, error } = await supabase
            .from('app_settings')
            .select('version, force, message, download_url')
            .eq('is_current', true)
            .maybeSingle();

        if (error) throw error;

        if (data) {
            return res.json({
                version:     data.version,
                force:       data.force === true,
                message:     data.message,
                downloadUrl: data.download_url,
            });
        }
        
        // Catastrophic Fallback: Only if DB table is empty
        return res.json({
            version: '1.0.0',
            force: false,
            message: 'Software is up to date.',
            downloadUrl: '#'
        });

    } catch (e) {
        console.error('CRITICAL: Version check failed:', e.message);
        // Return a safe response to prevent app crash
        res.status(500).json({
            error: 'Server Error',
            message: 'Unable to verify application version'
        });
    }
});

module.exports = router;
