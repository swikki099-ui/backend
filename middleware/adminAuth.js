const { createSupabaseServerClient } = require('../utils/supabaseServer');

// Whitelist of allowed admin emails per provider
const AUTHORIZED_ADMINS = {
    discord: ['kingshubham557@gmail.com'],
    github: ['swikki099@gmail.com']
};

/**
 * Middleware to protect /admin/* routes using Supabase SSR session cookies.
 */
async function requireAdmin(req, res, next) {
    const path = req.path || '';
    
    // Allow public auth paths through
    const isPublic = path.includes('/login') || 
                     path.includes('/auth/discord') || 
                     path.includes('/auth/github') || 
                     path.includes('/auth/callback');

    if (isPublic) return next();

    try {
        const supabaseServer = createSupabaseServerClient(req, res);
        const { data: { user }, error } = await supabaseServer.auth.getUser();

        if (error || !user) {
            console.log('[requireAdmin] Auth failed/no user, redirecting to /admin/login');
            return res.redirect('/admin/login?error=' + encodeURIComponent('Please log in using your Admin account to continue.'));
        }

        // Identify provider and enforce specific email allowlist
        const provider = user.app_metadata?.provider;
        const userEmail = (user.email || '').toLowerCase();
        const allowedEmails = AUTHORIZED_ADMINS[provider] || [];

        if (!allowedEmails.includes(userEmail)) {
            console.warn(`[requireAdmin] Access Denied: Provider ${provider}, Email ${userEmail}`);
            // Clear stale session
            await supabaseServer.auth.signOut();
            return res.render('login', {
                error: `Access denied. Your ${provider} account (${userEmail}) is not authorized for this action.`
            });
        }

        req.adminUser = user;
        next();
    } catch (err) {
        console.error('Admin auth error:', err.message);
        res.redirect('/admin/login?error=' + encodeURIComponent('Middleware Auth Error: ' + err.message));
    }
}

module.exports = { requireAdmin };
