const API_BASE = 'https://itsapi.aperptech.com/api';
const sessionStore = require('../utils/sessionStore');

/**
 * Log in to the College API to acquire a JWT token.
 */
async function loginUser(email, password) {
    const response = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, userType: 1 })
    });
    
    // Check if college API returns HTML error pages silently
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        throw new Error(`Login failed (Internal College Error): ${text.substring(0, 50)}...`);
    }
    
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || 'Invalid Credentials');
    }
    
    // College API can return `token` or `access_token` depending on endpoint state
    return data.token || data.access_token;
}

/**
 * Make an authenticated fetch request to the College API.
 * Automatically handles 401 Unauthorized errors by silently refreshing
 * the token using the stored user credentials before retrying.
 */
async function secureFetch(endpoint, sessionId, res = null, method = 'GET', body = null) {
    const session = sessionStore.decrypt(sessionId);
    if (!session) {
        throw new Error('Session expired or invalid. Please login again.');
    }

    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${session.token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {})
        }
    };
    if (body) options.body = JSON.stringify(body);

    // Initial Request
    let response = await fetch(`${API_BASE}${endpoint}`, options);

    // Auto-Refresh Logic!
    if (response.status === 401) {
        console.log(`[Auto-Refresh] Token expired for ${session.email}. Retrieving new token...`);
        try {
            // Relogin with stored credentials
            const newToken = await loginUser(session.email, session.password);
            
            // Generate newly issued session object/token
            session.token = newToken;
            const newSessionId = sessionStore.encrypt(session);
            
            // Forward it to the client for subsequent requests if we can
            if (res && typeof res.setHeader === 'function') {
                res.setHeader('x-new-session-id', newSessionId);
            }

            // Retry original request seamlessly
            options.headers['Authorization'] = `Bearer ${newToken}`;
            response = await fetch(`${API_BASE}${endpoint}`, options);
            console.log(`[Auto-Refresh] Successfully refreshed and retried request.`);
        } catch (error) {
            throw new Error('Auto-refresh logic failed. Credentials might have changed. Please relogin.');
        }
    }

    // Attempt to safely parse expected JSON response
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
        throw new Error(`Upstream College API responded with non-JSON format (Status: ${response.status})`);
    }

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || `Upstream API request failed for ${endpoint}`);
    }
    
    return data;
}

module.exports = { loginUser, secureFetch };
