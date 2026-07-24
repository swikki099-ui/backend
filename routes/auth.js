const express = require('express');
const { checkConnection, supabase } = require('../db');
const { loginAndSync, getUserById, encryptPassword, decryptPassword, getLinkedSupabaseId, linkSupabaseAccount, getUserBySupabaseId } = require('../services/authService');
const { loginUser } = require('../services/apiService');
const sessionStore = require('../utils/sessionStore');
const { logActivity } = require('../utils/activityLogger');


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
        // ✅ 1. Check Global Feature Toggles (Maintenance & Login Locks)
        const { data: settings } = await supabase
            .from('feature_settings')
            .select('login_enabled, maintenance_mode, maintenance_message')
            .eq('id', 1)
            .single();

        if (settings) {
            if (settings.maintenance_mode) {
                return res.status(503).json({ error: settings.maintenance_message || 'System is currently under maintenance. Please try again later.' });
            }
            if (!settings.login_enabled) {
                return res.status(403).json({ error: 'Logins are currently suspended by the administrator.' });
            }
        }
        // Authenticate, Fetch Profile, and Upsert to Turso
        const { user, token } = await loginAndSync(email, password);

        // ✅ Check if user is banned in Supabase admin DB
        const { data: ban } = await supabase
            .from('user_bans')
            .select('reason, expires_at')
            .eq('college_id', user.college_id)
            .eq('is_active', true)
            .single();

        if (ban) {
            const expiry = ban.expires_at ? ` Until: ${new Date(ban.expires_at).toLocaleDateString('en-IN')}` : ' (Permanent)';
            return res.status(403).json({ error: `Your account has been suspended.${expiry}`, reason: ban.reason });
        }

        // Generate a secure encrypted token for the frontend client.
        // We include the user's ID from our database and their password for auto-refresh logic.
        const sessionId = sessionStore.encrypt({
            user_id: user.id,
            email,
            password,
            token
        });

        // Log successful login activity
        logActivity('login', 'Student Login', `${user.name} (${user.roll_no}) logged in.`, {
            icon: 'user',
            color: 'blue',
            metadata: { user_id: user.id, email: user.email }
        }).catch(() => { });

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

    // Lazy update DAU
    try {
        db.execute({
            sql: "UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?",
            args: [session.user_id]
        }).catch(() => { });
    } catch (err) { }

    try {
        const user = await getUserById(session.user_id);
        if (!user) {
            return res.status(404).json({ error: 'User not found. Your account might have been deleted.' });
        }

        // ✅ Check Admin Bans & Maintenance Mode
        const [banRes, settingsRes] = await Promise.all([
            supabase
                .from('user_bans')
                .select('reason, expires_at')
                .eq('college_id', user.college_id)
                .eq('is_active', true)
                .single(),
            supabase
                .from('feature_settings')
                .select('maintenance_mode, maintenance_message')
                .eq('id', 1)
                .single()
        ]);

        if (settingsRes.data && settingsRes.data.maintenance_mode) {
            return res.status(503).json({ error: settingsRes.data.maintenance_message || 'System is currently under maintenance.' });
        }

        if (banRes.data) {
            return res.status(403).json({ error: 'Your account has been suspended.', reason: banRes.data.reason });
        }

        // Map database fields to the format expected by the app (ProfileResponse)
        const mappedUser = {
            id: user.id,
            fullName: user.name,
            rollNo: user.roll_no,
            studentId: user.college_id,
            email: user.email,
            mobile: user.phone,
            course: { courseFullName: user.course },
            branch: { branchFullName: user.branch },
            currentSemester: user.semester,
            currentSection: user.section,
            picture: user.profile_image,  // Map profile_image to picture
            barcode_id: user.barcode_id
        };

        // A profile is complete only if profile_complete flag is set AND they have both a barcode and a profile image.
        const isActuallyComplete = !!user.profile_complete && !!user.barcode_id && !!user.profile_image;

        res.json({
            user: mappedUser,
            profile_complete: isActuallyComplete
        });
    } catch (error) {
        console.error('❌ Internal server error in /me:', error);
        res.status(500).json({ error: 'Error retrieving user data' });
    }
});


/**
 * GET /auth/linked-status
 * Check if the current user has linked a Supabase account.
 */
router.get('/linked-status', async (req, res) => {
    let sessionId = req.headers['authorization'];
    if (!sessionId) return res.status(401).json({ error: 'No authorization session found' });
    if (sessionId.toLowerCase().startsWith('bearer ')) sessionId = sessionId.slice(7);
    const session = sessionStore.decrypt(sessionId);
    if (!session || !session.user_id) return res.status(401).json({ error: 'Invalid or expired session' });

    const supabaseId = await getLinkedSupabaseId(session.user_id);
    res.json({ linked: !!supabaseId, supabaseUserId: supabaseId || null });
});

/**
 * POST /auth/link-account
 * Link a Supabase user ID to the current user's account.
 * Body: { supabaseUserId: string }
 */
router.post('/link-account', async (req, res) => {
    let sessionId = req.headers['authorization'];
    if (!sessionId) return res.status(401).json({ error: 'No authorization session found' });
    if (sessionId.toLowerCase().startsWith('bearer ')) sessionId = sessionId.slice(7);
    const session = sessionStore.decrypt(sessionId);
    if (!session || !session.user_id) return res.status(401).json({ error: 'Invalid or expired session' });

    const { supabaseUserId } = req.body;
    if (!supabaseUserId) return res.status(400).json({ error: 'supabaseUserId is required' });

    // Check if this Supabase user is already linked to another account
    const existing = await getUserBySupabaseId(supabaseUserId);
    if (existing && existing.id !== session.user_id) {
        return res.status(409).json({ error: 'This Google/GitHub account is already linked to another user.' });
    }

    await linkSupabaseAccount(session.user_id, supabaseUserId);

    logActivity('link', 'Account Linked', `User #${session.user_id} linked their account to Supabase user ${supabaseUserId}.`, {
        icon: 'link',
        color: 'purple',
        metadata: { user_id: session.user_id, supabaseUserId }
    }).catch(() => {});

    res.json({ success: true, message: 'Account linked successfully' });
});

/**
 * POST /auth/login-with-oauth
 * Login using a linked Supabase/OAuth account.
 * Body: { supabaseUserId: string }
 */
router.post('/login-with-oauth', async (req, res) => {
    const { supabaseUserId } = req.body;
    if (!supabaseUserId) return res.status(400).json({ error: 'supabaseUserId is required' });

    // Find the Turso user linked to this Supabase ID
    const user = await getUserBySupabaseId(supabaseUserId);
    if (!user) return res.status(404).json({ error: 'No linked account found. Please sign in with your college credentials first and link your account.' });

    // Decrypt the stored password and authenticate with ERP
    try {
        const password = decryptPassword(user.password_hash);
        const { token } = await loginUser(user.email || user.college_id, password);

        const sessionId = sessionStore.encrypt({
            user_id: user.id,
            email: user.email,
            password,
            token
        });

        logActivity('login', 'OAuth Login', `${user.name} (${user.roll_no}) logged in via OAuth.`, {
            icon: 'user',
            color: 'purple',
            metadata: { user_id: user.id, provider: 'supabase' }
        }).catch(() => {});

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
        console.error('❌ OAuth login error:', error);
        res.status(401).json({ error: 'Failed to authenticate with college system. Try logging in with email and password to refresh your credentials.' });
    }
});

/**
 * POST /auth/logout
 */
router.post('/logout', (req, res) => {
    res.json({ message: 'Logged out successfully' });
});

module.exports = router;

