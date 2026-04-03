const express = require('express');
const appConfig = require('../config/appConfig');

const router = express.Router();

// GET /app/version
router.get('/version', (req, res) => {
    // Specifically check for each required variable to aid troubleshooting
    const missing = [];
    if (!appConfig.version) missing.push('APP_VERSION');
    if (!appConfig.force) missing.push('APP_FORCE');
    if (!appConfig.message) missing.push('APP_MESSAGE');
    if (!appConfig.downloadUrl) missing.push('APP_DOWNLOAD_URL');

    if (missing.length > 0) {
        return res.status(500).json({
            error: 'Server Misconfiguration',
            message: `App update environment variables are missing or incomplete: ${missing.join(', ')}`
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
