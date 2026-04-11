const { createServerClient, parseCookieHeader, serializeCookieHeader } = require('@supabase/ssr');

/**
 * Creates a Supabase client that reads/writes auth cookies per-request.
 * Used for: signInWithOAuth, exchangeCodeForSession, getUser.
 * Uses SUPABASE_ANON_KEY (not service key) — safe for auth flows.
 */
function createSupabaseServerClient(req, res) {
    return createServerClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY,
        {
            cookies: {
                getAll() {
                    return parseCookieHeader(req.headers.cookie ?? '');
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) => {
                        res.cookie(name, value, {
                            ...options,
                            httpOnly: true,
                            secure: process.env.NODE_ENV === 'production',
                        });
                    });
                },
            },
        }
    );
}

module.exports = { createSupabaseServerClient };
