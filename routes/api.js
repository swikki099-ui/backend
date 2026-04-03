const express = require('express');
const { secureFetch } = require('../services/apiService');

const router = express.Router();

// Middleware: Extract and enforce valid session footprint for all /api endpoints
router.use((req, res, next) => {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) {
        return res.status(401).json({ error: 'Unauthorized: Missing x-session-id header.' });
    }
    req.sessionId = sessionId; // Pass along the encrypted token string
    next();
});

// GET /api/profile
router.get('/profile', async (req, res) => {
    try {
        const data = await secureFetch('/profile', req.sessionId, res);
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/attendance/overall
router.get('/attendance/overall', async (req, res) => {
    try {
        const data = await secureFetch('/my/final/attendances', req.sessionId, res);
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
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
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/notifications
router.get('/notifications', async (req, res) => {
    try {
        const data = await secureFetch('/notifications', req.sessionId, res);
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/information
router.get('/information', async (req, res) => {
    try {
        const data = await secureFetch('/college/information', req.sessionId, res);
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/timetable
router.get('/timetable', async (req, res) => {
    try {
        const { session = "2025-2026", id = "14" } = req.query;
        const data = await secureFetch(`/student/timetables/${session}/${id}`, req.sessionId, res);
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/calendar
router.get('/calendar', async (req, res) => {
    try {
        const { session = "2025-2026", title = "" } = req.query;
        const data = await secureFetch(`/student/calendardayslist/${session}?title=${title}`, req.sessionId, res);
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;
