const express = require('express');
const { secureFetch } = require('../services/apiService');

const router = express.Router();

const { db, supabase } = require('../db');
const sessionStore = require('../utils/sessionStore');

// Helper to determine status code
const handleError = (res, error) => {
    if (error.message.includes('Session expired') || error.message.includes('Invalid')) {
        return res.status(401).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
};

// Middleware: Extract and enforce valid session footprint for all /api endpoints
router.use(async (req, res, next) => {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) {
        return res.status(401).json({ error: 'Unauthorized: Missing x-session-id header.' });
    }
    req.sessionId = sessionId; 

    try {
        const session = sessionStore.decrypt(sessionId);
        if (!session || !session.user_id) {
            return res.status(401).json({ error: 'Invalid or malformed session footprint.' });
        }

        // 1. Check Turso DB & Update DAU
        // Use RETURNING to capture their college_id efficiently in one swoop.
        const userRes = await db.execute({
            sql: "UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING college_id",
            args: [session.user_id]
        });

        if (userRes.rows.length === 0) {
            // User was deleted entirely via the Admin Panel User Management
            return res.status(403).json({ error: 'Your account has been deleted by an administrator.' });
        }

        const collegeId = userRes.rows[0].college_id;

        // 2. Parallel check: Admin bans & Global Maintenance Mode
        const [settingsRes, banRes] = await Promise.all([
            supabase.from('feature_settings').select('maintenance_mode, maintenance_message').eq('id', 1).single(),
            supabase.from('user_bans').select('reason').eq('college_id', collegeId).eq('is_active', true).maybeSingle()
        ]);

        if (settingsRes.data && settingsRes.data.maintenance_mode) {
            return res.status(503).json({ error: settingsRes.data.maintenance_message || 'System is currently under maintenance.' });
        }

        if (banRes.data) {
            return res.status(403).json({ error: 'Your account is suspended.', reason: banRes.data.reason });
        }

    } catch(err) {
        console.error('API Verification Error:', err.message);
        return res.status(401).json({ error: 'Session verification failed.' });
    }
    
    next();
});

// GET /api/profile
router.get('/profile', async (req, res) => {
    try {
        const data = await secureFetch('/profile', req.sessionId, res);
        res.json(data);
    } catch (error) { handleError(res, error); }
});

// GET /api/attendance/overall
router.get('/attendance/overall', async (req, res) => {
    try {
        const data = await secureFetch('/my/final/attendances', req.sessionId, res);
        res.json(data);
    } catch (error) { handleError(res, error); }
});

// GET /api/attendance/monthly
router.get('/attendance/monthly', async (req, res) => {
    try {
        const { month, session = "2025-2026" } = req.query;
        if (!month) {
            return res.status(400).json({ error: 'Missing required query parameter "month".' });
        }
        const data = await secureFetch(`/my/attendances?month=${month}&session=${session}`, req.sessionId, res);
        res.json(data);
    } catch (error) { handleError(res, error); }
});

// GET /api/notifications
router.get('/notifications', async (req, res) => {
    try {
        const data = await secureFetch('/notifications', req.sessionId, res);
        res.json(data);
    } catch (error) { handleError(res, error); }
});

// GET /api/information
router.get('/information', async (req, res) => {
    try {
        const data = await secureFetch('/college/information', req.sessionId, res);
        res.json(data);
    } catch (error) { handleError(res, error); }
});

// GET /api/timetable
router.get('/timetable', async (req, res) => {
    try {
        const { session = "2025-2026", id = "14" } = req.query;
        const data = await secureFetch(`/student/timetables/${session}/${id}`, req.sessionId, res);
        res.json(data);
    } catch (error) { handleError(res, error); }
});

// GET /api/calendar
router.get('/calendar', async (req, res) => {
    try {
        const { session = "2025-2026", title = "" } = req.query;
        const data = await secureFetch(`/student/calendardayslist/${session}?title=${title}`, req.sessionId, res);
        res.json(data);
    } catch (error) { handleError(res, error); }
});

module.exports = router;
