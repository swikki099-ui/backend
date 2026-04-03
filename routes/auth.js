const express = require('express');
const crypto = require('crypto');
const { loginUser } = require('../services/apiService');
const sessionStore = require('../utils/sessionStore');

const router = express.Router();

// POST /auth/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        // Authenticate with college API
        const token = await loginUser(email, password);
        
        // Generate a secure encrypted token for the frontend client
        // This abstracts away the target JWT, ensuring it stays hidden natively in the backend cache.
        const sessionId = sessionStore.encrypt({ email, password, token });

        res.json({ message: 'Login successful', sessionId });
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

// POST /auth/logout
router.post('/logout', (req, res) => {
    // Stateless sessions cannot be explicitly deleted server-side without a blacklist. 
    // The client dropping the token is sufficient for this scope.
    res.json({ message: 'Logged out successfully' });
});

module.exports = router;
