const express = require('express');
const multer = require('multer');
const sessionStore = require('../utils/sessionStore');
const { completeProfile, bindBarcode } = require('../services/profileService');

const router = express.Router();

// Multer configuration for memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only images are allowed (JPG, PNG, WEBP)'), false);
        }
    }
});

/**
 * Authentication Middleware
 */
const authenticate = (req, res, next) => {
    let sessionId = req.headers['authorization'];
    if (!sessionId) {
        return res.status(401).json({ error: 'No authorization session found' });
    }

    if (sessionId.toLowerCase().startsWith('bearer ')) {
        sessionId = sessionId.slice(7);
    }

    const session = sessionStore.decrypt(sessionId);
    if (!session || !session.user_id) {
        return res.status(401).json({ error: 'Invalid or expired session' });
    }

    req.userId = session.user_id;
    next();
};

/**
 * POST /profile/complete
 * Upload profileImage and idCardImage.
 */
router.post('/complete', authenticate, upload.fields([
    { name: 'profileImage', maxCount: 1 },
    { name: 'idCardImage', maxCount: 1 }
]), async (req, res) => {
    try {
        const profileImage = req.files['profileImage'] ? req.files['profileImage'][0] : null;
        const idCardImage = req.files['idCardImage'] ? req.files['idCardImage'][0] : null;
        const { confirmedBarcode } = req.body;

        if (!profileImage || !idCardImage) {
            return res.status(400).json({ error: 'Both profileImage and idCardImage are required' });
        }

        const result = await completeProfile(req.userId, profileImage, idCardImage, confirmedBarcode);
        
        if (!result.success) {
            return res.status(200).json(result); // Return 200 to handle fallback gracefully in frontend
        }

        res.json(result);
    } catch (error) {
        console.error('❌ Profile completion error:', error);
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /profile/bind-barcode
 * Manually bind a barcode to a user.
 */
router.post('/bind-barcode', authenticate, async (req, res) => {
    const { barcode } = req.body;

    if (!barcode) {
        return res.status(400).json({ error: 'Barcode is required' });
    }

    try {
        const result = await bindBarcode(req.userId, barcode);
        res.json(result);
    } catch (error) {
        console.error('❌ Barcode binding error:', error);
        res.status(400).json({ error: error.message });
    }
});

module.exports = router;
