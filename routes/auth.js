const express = require('express');
const { checkConnection } = require('../db');
const { loginAndSync, getUserById } = require('../services/authService');
const sessionStore = require('../utils/sessionStore');


const router = express.Router();

/**
 * GET /auth/status
 * Check the record connection status.
 */
router.get('/status', async (req, res) => {
    const status = await checkConnection();
    res.json(status);
});


/**
 * POST /auth/login
 * Log in to the College API, sync user data to Turso, and issue a session.
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        // Authenticate, Fetch Profile, and Upsert to Turso
        const { user, token } = await loginAndSync(email, password);
        
        // Generate a secure encrypted token for the frontend client.
        // We include the user's ID from our database and their password for auto-refresh logic.
        const sessionId = sessionStore.encrypt({ 
            user_id: user.id, 
            email, 
            password, 
            token 
        });

        res.json({ 
            message: 'Login successful', 
            sessionId,
            user: {
                id: user.id,
                name: user.name,
                roll_no: user.roll_no,
                email: user.email,
                profile_image: user.profile_image,
                profile_complete: !!user.profile_complete
            }
        });
    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(401).json({ error: error.message });
    }
});

/**
 * GET /auth/me
 * Return the currently logged-in user details from the database.
 */
router.get('/me', async (req, res) => {
    let sessionId = req.headers['authorization'];
    
    if (!sessionId) {
        return res.status(401).json({ error: 'No authorization session found' });
    }

    // Clean up "Bearer " prefix if it exists (case-insensitive)
    if (sessionId.toLowerCase().startsWith('bearer ')) {
        sessionId = sessionId.slice(7);
    }


    const session = sessionStore.decrypt(sessionId);
    if (!session || !session.user_id) {
        return res.status(401).json({ error: 'Invalid or expired session' });
    }

    console.log(`📡 Fetching personal profile for user_id: ${session.user_id}`);

    try {
        const user = await getUserById(session.user_id);
        if (!user) {
            return res.status(404).json({ error: 'User not found in local database' });
        }

        // A profile is complete only if profile_complete is true AND they have a barcode bound.
        const isActuallyComplete = !!user.profile_complete && !!user.barcode_id;

        res.json({ 
            user,
            profile_complete: isActuallyComplete
        });
    } catch (error) {
        console.error('❌ Internal server error in /me:', error);
        res.status(500).json({ error: 'Error retrieving user data' });
    }
});


/**
 * POST /auth/logout
 */
router.post('/logout', (req, res) => {
    res.json({ message: 'Logged out successfully' });
});

module.exports = router;

