const express = require('express');
const appConfig = require('../config/appConfig');

const router = express.Router();

// GET /app/version
router.get('/version', (req, res) => {
    // Check if any of the required environment variables are missing
    if (!appConfig.version || !appConfig.force || !appConfig.message || !appConfig.downloadUrl) {
        return res.status(500).json({
            error: 'Server Misconfiguration',
            message: 'App update environment variables are missing or incomplete.'
        });
    }

    // Return the app version details
    res.json({
        version: appConfig.version,
        force: appConfig.force === 'true',
        message: appConfig.message,
        downloadUrl: appConfig.downloadUrl
    });
});

module.exports = router;
