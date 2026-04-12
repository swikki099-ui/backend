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

// GET /app/features
// Public endpoint for the mobile app to check UI toggles & maintenance status
router.get('/features', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('feature_settings')
            .select('*')
            .eq('id', 1)
            .single();

        if (error) throw error;
        
        return res.json(data);
    } catch (e) {
        console.error('CRITICAL: Feature check failed:', e.message);
        // Fallback to fully permissive state if DB is unreachable to prevent app lockouts
        return res.json({
            qr_enabled: true,
            barcode_enabled: true,
            login_enabled: true,
            maintenance_mode: false,
            maintenance_message: ""
        });
    }
});

// GET /app/announcements
// Returns all currently published announcements, newest first
router.get('/announcements', async (req, res) => {
    try {
        const now = new Date().toISOString();
        const { data, error } = await supabase
            .from('announcements')
            .select('id, title, body, target_course, target_branch, target_semester, publish_at')
            .or(`publish_at.is.null,publish_at.lte.${now}`)
            .order('publish_at', { ascending: false, nullsFirst: true });

        if (error) throw error;
        
        return res.json(data || []);
    } catch (e) {
        console.error('Announcements fetch failed:', e.message);
        return res.json([]);
    }
});

module.exports = router;
