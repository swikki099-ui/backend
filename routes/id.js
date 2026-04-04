const express = require('express');
const { generateQR, verifyScan } = require('../services/idService');
const { getUserById } = require('../services/authService');
const sessionStore = require('../utils/sessionStore');

const router = express.Router();

/**
 * GET /id/qr
 * Generates a QR payload for the currently logged-in student.
 */
router.get('/qr', async (req, res) => {
    const sessionId = req.headers['authorization'];

    if (!sessionId) {
        return res.status(401).json({ error: 'Unauthorized: No session token provided' });
    }

    const session = sessionStore.decrypt(sessionId);
    if (!session || !session.user_id) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired session' });
    }

    try {
        // Fetch current user from DB to get their college_id
        const user = await getUserById(session.user_id);
        if (!user) {
            return res.status(404).json({ error: 'User profile not found' });
        }

        // Generate the Base64 QR payload
        const qrData = generateQR(user.college_id);

        res.json({ qrData });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate QR data' });
    }
});

/**
 * POST /id/scan
 * Decodes and verifies a QR code payload, returning safe student profile data.
 */
router.post('/scan', async (req, res) => {
    const { qrData } = req.body;

    if (!qrData) {
        return res.status(400).json({ error: 'Missing QR data in request body' });
    }

    try {
        // Decode and verify the scan
        const verifiedResult = await verifyScan(qrData);
        res.json(verifiedResult);
    } catch (error) {
        // Distinguish between handled validation errors and unknown system errors
        const isValidationError = error.message.includes('Invalid QR') || error.message.includes('Verification failed');
        res.status(isValidationError ? 400 : 500).json({ 
            error: error.message || 'Verification process encountered an unexpected error.' 
        });
    }
});

module.exports = router;
