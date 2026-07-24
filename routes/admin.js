const express = require('express');
const { db, supabase } = require('../db');
const { requireAdmin } = require('../middleware/adminAuth');
const { createSupabaseServerClient } = require('../utils/supabaseServer');
const sysLogger = require('../utils/logger');
const { logActivity } = require('../utils/activityLogger');
const { sendBulkEmail, sendPersonalizedEmail, checkSmtpConnection } = require('../utils/mailer');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const { uploadToCloudinary } = require('../services/cloudinaryService');
const { getApiKey: getByseApiKey } = require('../services/byseService');
const { deleteFile: deleteFromB2 } = require('../services/b2Service');

// Configure Multer for email attachments
// NOTE: Use /tmp for Vercel serverless compatibility (read-only filesystem)
const upload = multer({ 
    dest: '/tmp/mail-temp/',
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit per file
});

// Configure Multer for social uploads (Memory storage)
const socialUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const libraryUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit for library docs
});

const router = express.Router();

// Dual AJAX / redirect response helper
function respondOrRedirect(req, res, redirectUrl, data, err) {
    if (err) {
        if (req.xhr || req.get('Accept')?.includes('json'))
            return res.status(500).json({ error: err.message || err });
        return res.status(500).send(err.message || err);
    }
    if (req.xhr || req.get('Accept')?.includes('json'))
        return res.json({ success: true, ...data });
    res.redirect(redirectUrl);
}

// Apply admin protection to all routes in this file
router.use(requireAdmin);

// Add Template Globals (Sidebar helpers)
router.use(async (req, res, next) => {
    res.locals.currentPath = req.path;
    res.locals.adminUser = req.adminUser;
    
    // Pass public Supabase config to frontend for Realtime
    res.locals.supabaseConfig = {
        url: process.env.SUPABASE_URL,
        anonKey: process.env.SUPABASE_ANON_KEY
    };

    // Auto-fetch banned count for the sidebar badge
    try {
        const { count } = await supabase.from('user_bans').select('id', { count: 'exact' }).eq('is_active', true);
        res.locals.bannedCount = count || 0;
    } catch (e) {
        res.locals.bannedCount = 0;
    }

    // Auto-fetch pending social reports
    try {
        const reportRes = await db.execute("SELECT COUNT(*) as count FROM post_reports WHERE status = 'pending'");
        res.locals.pendingReportsCount = reportRes.rows[0].count;
    } catch (e) {
        res.locals.pendingReportsCount = 0;
    }

    next();
});

// ─────────────────────────────────────────────
//  LIVE ACTIVITY
// ─────────────────────────────────────────────

router.get('/activity', async (req, res) => {
    try {
        const { data: history } = await supabase
            .from('activity_feed')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(20);

        res.render('live-activity', { 
            history: history || []
        });
    } catch (err) {
        res.status(500).send('Error loading activity feed');
    }
});

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

async function logAudit(adminUser, action, targetType, targetId, metadata = {}) {
    try {
        await supabase.from('admin_audit_logs').insert({
            admin_id: adminUser?.id,
            admin_email: adminUser?.email,
            action,
            target_type: targetType,
            target_id: String(targetId),
            metadata
        });
    } catch (e) {
        console.error('Audit log failed:', e.message);
    }
}

async function getAppSettings() {
    try {
        const { data, error } = await supabase
            .from('app_settings')
            .select('*')
            .eq('is_current', true)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        
        if (error) throw error;
        // Strict database priority. Fallback to a safe minimum if DB is empty.
        return data || { version: '1.0.0', force: false, message: 'Settings initialized.', download_url: '#' };
    } catch (e) {
        console.error('Critical: Failed to fetch App Settings from Supabase:', e.message);
        return { version: '0.0.0', force: false, message: 'System error fetching settings.', download_url: '#' };
    }
}

/**
 * Ensures the SYSTEM_ADMIN user exists in Turso for social posting.
 */
async function ensureAdminUser() {
    try {
        const adminRes = await db.execute({
            sql: "SELECT id FROM users WHERE college_id = 'SYSTEM_ADMIN'",
            args: []
        });

        if (adminRes.rows.length === 0) {
            console.log('[Admin] Initializing SYSTEM_ADMIN record...');
            await db.execute({
                sql: "INSERT INTO users (college_id, name, profile_image, profile_complete) VALUES ('SYSTEM_ADMIN', 'Official Admin', '', 1)",
                args: []
            });
            return await ensureAdminUser(); // Recursive call to get the new ID
        }
        return adminRes.rows[0].id;
    } catch (e) {
        console.error('[Admin] Failed to ensure admin user:', e.message);
        return null;
    }
}

// ─────────────────────────────────────────────
//  AUTHENTICATION (Public)
// ─────────────────────────────────────────────

router.get('/login', (req, res) => {
    res.render('login', { error: req.query.error || null });
});

router.get('/auth/discord', async (req, res) => {
    const supabaseServer = createSupabaseServerClient(req, res);
    const { data, error } = await supabaseServer.auth.signInWithOAuth({
        provider: 'discord',
        options: {
            redirectTo: `${req.protocol}://${req.get('host')}/admin/auth/callback`,
            skipBrowserRedirect: false
        }
    });
    
    if (error) {
        return res.redirect('/admin/login?error=' + encodeURIComponent(error.message));
    }

    if (data && data.url) {
        return res.redirect(data.url);
    }

    res.redirect('/admin/login?error=' + encodeURIComponent('Failed to initialize Discord login.'));
});

router.get('/auth/github', async (req, res) => {
    const supabaseServer = createSupabaseServerClient(req, res);
    const { data, error } = await supabaseServer.auth.signInWithOAuth({
        provider: 'github',
        options: {
            redirectTo: `${req.protocol}://${req.get('host')}/admin/auth/callback`,
            skipBrowserRedirect: false
        }
    });

    if (error) {
        return res.redirect('/admin/login?error=' + encodeURIComponent(error.message));
    }

    if (data && data.url) {
        return res.redirect(data.url);
    }

    res.redirect('/admin/login?error=' + encodeURIComponent('Failed to initialize GitHub login.'));
});

router.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (code) {
        const supabaseServer = createSupabaseServerClient(req, res);
        const { error } = await supabaseServer.auth.exchangeCodeForSession(code);
        if (error) {
            console.error('Auth callback error:', error.message);
            return res.redirect('/admin/login?error=' + encodeURIComponent('Authentication failed: ' + error.message));
        }
    }
    res.redirect('/admin');
});

router.get('/logout', async (req, res) => {
    const supabaseServer = createSupabaseServerClient(req, res);
    await supabaseServer.auth.signOut();
    res.redirect('/admin/login');
});

// ─────────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const [
            usersCountRes, profilesCompletedRes, recentUsersRes, activeTodayRes, bansRes,
            facultyRes, eventsRes, postsRes
        ] = await Promise.all([
            db.execute('SELECT COUNT(*) as count FROM users'),
            db.execute('SELECT COUNT(*) as count FROM users WHERE profile_complete = 1'),
            db.execute('SELECT name, roll_no, email, course, semester, section, created_at FROM users ORDER BY id DESC LIMIT 6'),
            db.execute("SELECT COUNT(*) as count FROM users WHERE last_active_at >= datetime('now', '-1 day')"),
            supabase.from('user_bans').select('id', { count: 'exact' }).eq('is_active', true),
            db.execute('SELECT COUNT(*) as count FROM faculty'),
            db.execute('SELECT COUNT(*) as count FROM calendar_events'),
            db.execute('SELECT COUNT(*) as count FROM social_posts'),
        ]);

        const appSettings = await getAppSettings();

        const totalUsers = usersCountRes.rows[0].count;
        const profilesDone = profilesCompletedRes.rows[0].count;

        res.render('dashboard', {
            stats: {
                totalUsers,
                profilesCompleted: profilesDone,
                profileRate: totalUsers > 0 ? Math.round((profilesDone / totalUsers) * 100) : 0,
                dau:              activeTodayRes.rows[0].count,
                activeBans:       bansRes.count || 0,
                totalFaculty:     facultyRes.rows[0].count,
                totalEvents:      eventsRes.rows[0].count,
                totalPosts:       postsRes.rows[0].count,
            },
            recentUsers: recentUsersRes.rows,
            appVersion:  appSettings.version,
            appForce:    appSettings.force,
        });
    } catch (err) {
        console.error('Dashboard Error:', err);
        res.status(500).send('Internal Server Error');
    }
});

router.get('/logout', async (req, res) => {
    const supabaseServer = createSupabaseServerClient(req, res);
    await supabaseServer.auth.signOut();
    res.redirect('/admin/login');
});

// ─────────────────────────────────────────────
//  USERS MANAGEMENT
// ─────────────────────────────────────────────

router.get('/users', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 15;
    const offset = (page - 1) * limit;
    const search = req.query.q || '';
    const status = req.query.status || ''; // 'complete', 'incomplete'

    try {
        // Build query
        let sql = 'SELECT * FROM users WHERE 1=1';
        let countSql = 'SELECT COUNT(*) as count FROM users WHERE 1=1';
        const args = [];

        if (search) {
            const pattern = `%${search}%`;
            sql += ' AND (name LIKE ? OR email LIKE ? OR roll_no LIKE ? OR college_id LIKE ?)';
            countSql += ' AND (name LIKE ? OR email LIKE ? OR roll_no LIKE ? OR college_id LIKE ?)';
            args.push(pattern, pattern, pattern, pattern);
        }

        if (status === 'complete') {
            sql += ' AND profile_complete = 1';
            countSql += ' AND profile_complete = 1';
        } else if (status === 'incomplete') {
            sql += ' AND (profile_complete = 0 OR profile_complete IS NULL)';
            countSql += ' AND (profile_complete = 0 OR profile_complete IS NULL)';
        }

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        const queryArgs = [...args, limit, offset];

        const [usersRes, countRes] = await Promise.all([
            db.execute({ sql, args: queryArgs }),
            db.execute({ sql: countSql, args })
        ]);

        const totalUsers = countRes.rows[0].count;
        const totalPages = Math.ceil(totalUsers / limit);

        res.render('users', {
            users: usersRes.rows,
            page,
            totalPages,
            totalUsers,
            search,
            status
        });
    } catch (err) {
        res.status(500).send('Error loading users: ' + err.message);
    }
});

router.get('/users/export-csv', async (req, res) => {
    try {
        const { rows } = await db.execute('SELECT * FROM users ORDER BY created_at DESC');
        if (rows.length === 0) return res.status(404).send('No users found to export.');

        const headers = ['id', 'college_id', 'roll_no', 'name', 'email', 'course', 'branch', 'semester', 'section', 'phone', 'barcode_id', 'profile_complete', 'created_at'];
        const csv = [headers.join(',')];
        for (const u of rows) {
            csv.push(headers.map(h => {
                const val = u[h] != null ? String(u[h]).replace(/"/g, '""') : '';
                return `"${val}"`;
            }).join(','));
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="users-export.csv"');
        res.send(csv.join('\n'));
    } catch (err) {
        res.status(500).send('Export failed: ' + err.message);
    }
});

router.get('/users/:id', async (req, res) => {
    try {
        const userRes = await db.execute({
            sql: 'SELECT * FROM users WHERE id = ?',
            args: [req.params.id]
        });

        if (userRes.rows.length === 0) return res.status(404).send('User not found');
        const user = userRes.rows[0];

        // Also check for ban status
        const { data: ban } = await supabase
            .from('user_bans')
            .select('*')
            .eq('college_id', user.college_id)
            .eq('is_active', true)
            .maybeSingle();

        res.render('user-detail', {
            user,
            ban,
            flash: req.query.banned ? { type: 'success', message: 'User has been banned.' } :
                   req.query.unbanned ? { type: 'success', message: 'Ban has been lifted.' } :
                   req.query.saved ? { type: 'success', message: 'Profile updated successfully.' } : null
        });
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

router.get('/users/:id/edit', async (req, res) => {
    try {
        const userRes = await db.execute({
            sql: 'SELECT * FROM users WHERE id = ?',
            args: [req.params.id]
        });
        if (userRes.rows.length === 0) return res.status(404).send('User not found');
        res.render('user-edit', { user: userRes.rows[0], success: req.query.saved || null });
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

router.post('/users/:id/edit', async (req, res) => {
    const { name, roll_no, email, course, branch, semester, barcode_id } = req.body;
    try {
        await db.execute({
            sql: 'UPDATE users SET name = ?, roll_no = ?, email = ?, course = ?, branch = ?, semester = ?, barcode_id = ? WHERE id = ?',
            args: [name, roll_no, email, course, branch, parseInt(semester), barcode_id, req.params.id]
        });

            await logAudit(req.adminUser, 'edit_user', 'user', req.params.id, { name, roll_no });
        respondOrRedirect(req, res, `/admin/users/${req.params.id}?saved=1`);
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.post('/users/:id/action', async (req, res) => {
    const { _action, reason, expires_at } = req.body;
    const userId = req.params.id;

    try {
        const userRes = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });
        if (userRes.rows.length === 0) return res.status(404).send('User not found');
        const user = userRes.rows[0];

        if (_action === 'ban') {
            // Check if already banned
            const { data: existingBan } = await supabase
                .from('user_bans')
                .select('id')
                .eq('college_id', user.college_id)
                .eq('is_active', true)
                .maybeSingle();
            if (existingBan) {
                return respondOrRedirect(req, res, null, null, new Error('User is already banned.'));
            }
            const { error } = await supabase.from('user_bans').insert({
                college_id: user.college_id,
                user_name: user.name,
                reason: reason || 'Violation of terms',
                banned_by: req.adminUser?.id,
                expires_at: expires_at || null,
                is_active: true
            });
            if (error) throw error;
            await logAudit(req.adminUser, 'ban_user', 'user', userId, { reason });
            return respondOrRedirect(req, res, `/admin/users/${userId}?banned=1`);
        } else if (_action === 'unban') {
            const { error } = await supabase
                .from('user_bans')
                .update({ is_active: false, updated_at: new Date() })
                .eq('college_id', user.college_id)
                .eq('is_active', true);
            if (error) throw error;
            await logAudit(req.adminUser, 'unban_user', 'user', userId);
            return respondOrRedirect(req, res, `/admin/users/${userId}?unbanned=1`);
        } else if (_action === 'delete') {
            await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [userId] });
            await logAudit(req.adminUser, 'delete_user', 'user', userId, { name: user.name });
            return respondOrRedirect(req, res, '/admin/users');
        }

        respondOrRedirect(req, res, `/admin/users/${userId}`);
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

// ─────────────────────────────────────────────
//  BANS
// ─────────────────────────────────────────────

router.get('/bans', async (req, res) => {
    try {
        const { data: bans } = await supabase
            .from('user_bans')
            .select('*')
            .eq('is_active', true)
            .order('created_at', { ascending: false });

        res.render('bans', { bans: bans || [] });
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

router.post('/bans/:id/unban', async (req, res) => {
    try {
        const { data: banRecord } = await supabase
            .from('user_bans')
            .select('user_name, college_id')
            .eq('id', req.params.id)
            .single();

        const { error } = await supabase
            .from('user_bans')
            .update({ is_active: false })
            .eq('id', req.params.id);

        if (error) throw error;
        await logAudit(req.adminUser, 'unban_user', 'ban_record', req.params.id);
        
        // Log to Activity Feed
        if (banRecord) {
            logActivity('unban', 'User Unbanned', `${banRecord.user_name || banRecord.college_id} has been unsuspended.`, {
                icon: 'unlock',
                color: 'green'
            }).catch(() => {});
        }

        respondOrRedirect(req, res, '/admin/bans');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

// ─────────────────────────────────────────────
//  APP UPDATES (VERSIONING)
// ─────────────────────────────────────────────

router.get('/app-update', async (req, res) => {
    try {
        const currentVersion = await getAppSettings();
        const { data: history } = await supabase
            .from('app_settings')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(10);

        res.render('app-update', { 
            currentVersion, 
            history: history || [],
            flash: req.query.success ? { type: 'success', message: 'New update published successfully' } : null
        });
    } catch (err) {
        console.error('Update Page Error:', err);
        res.status(500).send('Error loading update management');
    }
});

router.post('/app-update', async (req, res) => {
    const { version, message, download_url, release_notes, force } = req.body;
    try {
        // Mark old current as false
        await supabase.from('app_settings').update({ is_current: false }).eq('is_current', true);

        const { error } = await supabase.from('app_settings').insert({
            version,
            message,
            download_url,
            release_notes: release_notes || '',
            force: force === 'on',
            published_by: req.adminUser?.id,
            is_current: true,
        });

        if (error) throw error;
        await logAudit(req.adminUser, 'publish_app_update', 'system', version, { download_url });
        
        // Log to Activity Feed
        logActivity('update', 'App Update Published', `Version v${version} is now live!`, {
            icon: 'upload',
            color: 'blue'
        }).catch(() => {});

        respondOrRedirect(req, res, '/admin/app-update?success=1');
    } catch (err) {
        console.error('Publish Update Error:', err);
        respondOrRedirect(req, res, null, null, err);
    }
});

// ─────────────────────────────────────────────
//  ANNOUNCEMENTS
// ─────────────────────────────────────────────

router.get('/announcements', async (req, res) => {
    try {
        const { data: announcements } = await supabase
            .from('announcements')
            .select('*')
            .order('created_at', { ascending: false });

        res.render('announcements', { announcements: announcements || [] });
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

router.get('/announcements/new', (req, res) => {
    res.render('announcement-form', { announcement: null });
});

router.post('/announcements', async (req, res) => {
    const { title, body, target_course, target_branch, target_semester, publish_at } = req.body;
    try {
        const { error } = await supabase.from('announcements').insert({
            title,
            body,
            target_course: target_course || null,
            target_branch: target_branch || null,
            target_semester: target_semester ? parseInt(target_semester) : null,
            publish_at: publish_at || new Date().toISOString(),
            created_by: req.adminUser?.id,
        });

        if (error) throw error;
        await logAudit(req.adminUser, 'create_announcement', 'announcement', title);
        respondOrRedirect(req, res, '/admin/announcements');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.post('/announcements/:id/delete', async (req, res) => {
    try {
        const { error } = await supabase.from('announcements').delete().eq('id', req.params.id);
        if (error) throw error;
        respondOrRedirect(req, res, '/admin/announcements');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

// ─────────────────────────────────────────────
//  MAIL TEMPLATES
// ─────────────────────────────────────────────

router.get('/mail/templates', async (req, res) => {
    try {
        const { data: templates } = await supabase
            .from('admin_mail_templates')
            .select('*')
            .order('created_at', { ascending: false });

        res.render('mail-templates', { templates: templates || [] });
    } catch (err) {
        res.status(500).send('Error loading templates: ' + err.message);
    }
});

router.get('/mail/templates/new', (req, res) => {
    res.render('mail-template-form', { template: null });
});

router.post('/mail/templates', async (req, res) => {
    const { name, subject, body } = req.body;
    try {
        const { error } = await supabase.from('admin_mail_templates').insert({
            name, subject, body,
            created_by: req.adminUser?.id
        });
        if (error) throw error;
        await logAudit(req.adminUser, 'create_template', 'mail_template', name);
        respondOrRedirect(req, res, '/admin/mail/templates');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.get('/mail/templates/:id/edit', async (req, res) => {
    try {
        const { data: template } = await supabase
            .from('admin_mail_templates')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (!template) return res.status(404).send('Template not found');
        res.render('mail-template-form', { template });
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

router.post('/mail/templates/:id', async (req, res) => {
    const { name, subject, body } = req.body;
    try {
        const { error } = await supabase
            .from('admin_mail_templates')
            .update({ name, subject, body })
            .eq('id', req.params.id);

        if (error) throw error;
        await logAudit(req.adminUser, 'edit_template', 'mail_template', name);
        res.redirect('/admin/mail/templates');
    } catch (err) {
        res.status(500).send('Update failed: ' + err.message);
    }
});

router.post('/mail/templates/:id/delete', async (req, res) => {
    try {
        const { error } = await supabase
            .from('admin_mail_templates')
            .delete()
            .eq('id', req.params.id);

        if (error) throw error;
        res.redirect('/admin/mail/templates');
    } catch (err) {
        res.status(500).send('Delete failed');
    }
});

// ─────────────────────────────────────────────
//  MAILING SYSTEM
// ─────────────────────────────────────────────

router.get('/mail', async (req, res) => {
    try {
        const { data: mailings } = await supabase
            .from('admin_mailings')
            .select('*')
            .order('created_at', { ascending: false });

        res.render('mail-history', { mailings: mailings || [] });
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

router.get('/mail/compose', async (req, res) => {
    try {
        console.log('--- Fetching Broadcast Audience Props ---');
        const [templatesRes, branchesRes, semestersRes, sectionsRes] = await Promise.all([
            supabase.from('admin_mail_templates').select('*').order('name', { ascending: true }),
            db.execute('SELECT DISTINCT branch FROM users ORDER BY branch ASC'),
            db.execute('SELECT DISTINCT semester FROM users ORDER BY semester ASC'),
            db.execute('SELECT DISTINCT section FROM users ORDER BY section ASC')
        ]);
        
        const getUniqueValues = (rows, key) => {
            if (!rows || !Array.isArray(rows)) return [];
            return [...new Set(rows.map(r => {
                if (typeof r === 'object' && r !== null) {
                    // Try exact key, then lowercase, then uppercase
                    return r[key] || r[key.toLowerCase()] || r[key.toUpperCase()] || null;
                }
                return null;
            }))].filter(v => v !== null && v !== undefined && String(v).trim() !== '').sort();
        };

        const branches = getUniqueValues(branchesRes.rows, 'branch');
        const semesters = getUniqueValues(semestersRes.rows, 'semester');
        const sections = getUniqueValues(sectionsRes.rows, 'section');

        console.log(`--- Broadcast Filters ---`);
        console.log('Raw Branches Sample:', (branchesRes.rows || []).slice(0, 2));
        console.log(`Final Lists -> Br: ${branches.length}, Sem: ${semesters.length}, Sec: ${sections.length}`);

        res.render('mail-compose', { 
            templates: templatesRes.data || [],
            branches,
            semesters,
            sections
        });
    } catch (err) {
        console.error('Compose Error:', err);
        res.render('mail-compose', { 
            templates: [], branches: [], semesters: [], sections: [] 
        });
    }
});

router.post('/mail/send', upload.array('attachments', 3), async (req, res) => {
    const { subject, body, target_branch, target_semester, target_section, target_individual, content_type } = req.body;
    const files = req.files || [];
    const isHtml = content_type !== 'plain';

    try {
        // Get all student data for personalization
        let sql = 'SELECT * FROM users WHERE email IS NOT NULL';
        const args = [];
        
        // Handle Individual Targeting (Overrides groups)
        if (target_individual && target_individual.trim() !== '') {
            sql += ' AND (email = ? OR roll_no = ?)';
            args.push(target_individual.trim());
            args.push(target_individual.trim());
        } else {
            // Handle Group Targeting
            if (target_branch) { 
                sql += ' AND branch = ?'; 
                args.push(target_branch); 
            }
            if (target_semester) { 
                sql += ' AND semester = ?'; 
                args.push(parseInt(target_semester)); 
            }
            if (target_section) { 
                sql += ' AND section = ?'; 
                args.push(target_section); 
            }
        }

        const studentRes = await db.execute({ sql, args });
        const students = studentRes.rows;

        if (students.length === 0) {
            // Cleanup files if no recipients
            files.forEach(f => fs.unlinkSync(f.path));
            return respondOrRedirect(req, res, null, null, new Error('No student found matching criteria'));
        }

        // Send personalized emails in a loop
        let sentCount = 0;
        let skipCount = 0;

        for (const student of students) {
            try {
                await sendPersonalizedEmail(student, subject, body, { 
                    attachments: files,
                    isHtml: isHtml 
                });
                sentCount++;
            } catch (mailErr) {
                console.error(`Failed to send mail to ${student.email}:`, mailErr.message);
                skipCount++;
            }
        }

        // Cleanup temporary files
        files.forEach(f => {
            try { fs.unlinkSync(f.path); } catch(e) {}
        });

        await supabase.from('admin_mailings').insert({
            subject, body,
            target_criteria: { 
                branch: target_branch, 
                semester: target_semester, 
                section: target_section,
                individual: target_individual || null,
                attachments: files.length,
                format: isHtml ? 'html' : 'plain'
            },
            recipient_count: sentCount,
            status: skipCount === 0 ? 'sent' : 'partially_failed',
            sent_by: req.adminUser?.id
        });

        await logAudit(req.adminUser, 'send_mail_broadcast', 'system', subject, { 
            recipients: sentCount,
            format: isHtml ? 'html' : 'plain',
            files: files.length
        });
        respondOrRedirect(req, res, '/admin/mail?success=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

// ─────────────────────────────────────────────
//  SYSTEM MONITORING
// ─────────────────────────────────────────────

router.get('/audit-logs', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    try {
        const [logsRes, countRes] = await Promise.all([
            supabase
                .from('admin_audit_logs')
                .select('*')
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1),
            supabase
                .from('admin_audit_logs')
                .select('id', { count: 'exact', head: true })
        ]);

        if (logsRes.error) throw logsRes.error;

        const totalLogs = countRes.count || 0;
        const totalPages = Math.ceil(totalLogs / limit);

        res.render('audit-logs', { 
            logs: logsRes.data || [],
            page,
            totalPages
        });
    } catch (err) {
        res.status(500).send('Error loading audit logs: ' + err.message);
    }
});

router.get('/server-logs', (req, res) => {
    res.render('server-logs', { logs: sysLogger.getLogs() });
});

router.get('/server-logs/data', (req, res) => {
    const logs = sysLogger.getLogs().map(l => ({
        timestamp: l.timestamp.toISOString(),
        type: l.type,
        message: l.message,
    }));
    res.json({ logs });
});

router.post('/server-logs/clear', (req, res) => {
    sysLogger.clearLogs();
    res.json({ success: true });
});

const cloudinarySdk = require('cloudinary').v2;
const API_BASE = 'https://itsapi.aperptech.com/api';
async function checkEndpoint(url, timeout = 5000) {
    try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(id);
        return { status: res.ok ? 'reachable' : 'error', code: res.status };
    } catch (e) {
        return { status: e.name === 'AbortError' ? 'timeout' : 'unreachable', code: null };
    }
}

async function checkCloudinary() {
    try {
        if (!process.env.CLOUDINARY_URL && !process.env.CLOUDINARY_CLOUD_NAME) return { status: 'unconfigured', code: null };
        const res = await cloudinarySdk.api.ping();
        return { status: 'connected', code: res?.status || 200 };
    } catch (e) {
        return { status: 'error', code: e?.http_code || null };
    }
}

async function checkByse() {
    try {
        const key = await getByseApiKey();
        if (!key) return { status: 'unconfigured' };
        return { status: 'configured' };
    } catch (e) {
        return { status: 'error', message: e.message };
    }
}

async function checkB2() {
    try {
        const res = await db.execute({ sql: "SELECT value FROM app_config WHERE key = 'b2_application_key_id'" });
        if (!res.rows[0]?.value) return { status: 'unconfigured' };
        return { status: 'configured' };
    } catch (e) {
        return { status: 'error', message: e.message };
    }
}

router.get('/health', async (req, res) => {
    const ms = process.memoryUsage();
    const uptimeSec = process.uptime();

    const results = await Promise.allSettled([
        db.execute('SELECT 1').then(() => 'connected').catch(() => 'error'),
        supabase.from('app_settings').select('id').limit(1).then(r => r.error ? 'error' : 'connected').catch(() => 'error'),
        checkSmtpConnection(),
        db.execute('SELECT COUNT(*) as count FROM users').then(r => r.rows[0].count).catch(() => '?'),
        db.execute('SELECT COUNT(*) as count FROM faculty').then(r => r.rows[0].count).catch(() => '?'),
        db.execute('SELECT COUNT(*) as count FROM calendar_events').then(r => r.rows[0].count).catch(() => '?'),
        db.execute('SELECT COUNT(*) as count FROM social_posts').then(r => r.rows[0].count).catch(() => '?'),
        checkEndpoint(API_BASE),
        checkEndpoint(`${API_BASE}/college/information`),
        checkCloudinary(),
        checkByse(),
        checkB2(),
    ]);

    const get = (i, def) => results[i]?.status === 'fulfilled' ? results[i].value : def;

    res.render('health', {
        health: {
            turso: get(0, 'error'),
            supabase: get(1, 'error'),
            smtp: get(2, { status: 'unconfigured', message: '' }).status,
            smtpMessage: get(2, { status: 'unconfigured', message: '' }).message,
            uptime: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`,
            nodeVersion: process.version,
            env: process.env.NODE_ENV || 'development',
            platform: process.platform,
            totalUsers: get(3, '?'),
            totalFaculty: get(4, '?'),
            totalCalendarEvents: get(5, '?'),
            totalSocialPosts: get(6, '?'),
            memoryUsage: `${Math.round(ms.heapUsed / 1024 / 1024)} MB`,
            checkedAt: new Date().toLocaleString('en-IN'),
            collegeApi: get(7, { status: 'unreachable', code: null }),
            collegeInfo: get(8, { status: 'unreachable', code: null }),
            cloudinary: get(9, { status: 'unreachable', code: null }),
            byse: get(10, { status: 'unreachable' }),
            b2: get(11, { status: 'unreachable' }),
        }
    });
});

// ─────────────────────────────────────────────
//  ADMIN PROFILE & SOCIAL HUB
// ─────────────────────────────────────────────

router.get('/profile', async (req, res) => {
    try {
        await ensureAdminUser();
        const adminRes = await db.execute("SELECT * FROM users WHERE college_id = 'SYSTEM_ADMIN'");
        res.render('admin-profile', { 
            adminItem: adminRes.rows[0],
            flash: req.query.success ? { type: 'success', message: 'Profile updated successfully' } : null
        });
    } catch (err) {
        res.status(500).send('Error loading admin profile');
    }
});

router.post('/profile', socialUpload.single('profileImage'), async (req, res) => {
    const { name } = req.body;
    try {
        let profileImageUrl = null;
        if (req.file) {
            const uploadResult = await uploadToCloudinary(req.file.buffer, req.file.mimetype);
            profileImageUrl = uploadResult.url;
        }

        if (profileImageUrl) {
            await db.execute({
                sql: "UPDATE users SET name = ?, profile_image = ? WHERE college_id = 'SYSTEM_ADMIN'",
                args: [name, profileImageUrl]
            });
        } else {
            await db.execute({
                sql: "UPDATE users SET name = ? WHERE college_id = 'SYSTEM_ADMIN'",
                args: [name]
            });
        }

        await logAudit(req.adminUser, 'update_admin_profile', 'system', 'SYSTEM_ADMIN', { name });
        respondOrRedirect(req, res, '/admin/profile?success=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.get('/social/post', (req, res) => {
    res.render('admin-post-form', { 
        flash: req.query.success ? { type: 'success', message: 'Post published to Social Hub!' } : null
    });
});

router.post('/social/post', socialUpload.fields([{ name: 'media', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
    const { content } = req.body;
    try {
        const adminUserId = await ensureAdminUser();
        if (!adminUserId) throw new Error('Could not identify system admin user.');

        let mediaUrl = null;
        let mediaType = null;
        let publicId = null;
        let b2FileId = null;
        let b2FileName = null;
        let videoUrl = null;
        let videoFileId = null;

        if (req.files?.media?.[0]) {
            const file = req.files.media[0];
            if (file.mimetype.startsWith('image/')) {
                const uploadResult = await uploadToCloudinary(file.buffer, file.mimetype);
                mediaUrl = `${uploadResult.url}|${uploadResult.public_id}`;
                mediaType = 'image';
                publicId = uploadResult.public_id;
            } else {
                const { uploadFile: uploadToB2 } = require('../services/b2Service');
                const result = await uploadToB2(file.buffer, file.originalname, file.mimetype);
                const dlBase = `${req.protocol}://${req.get('host')}/social/download/document`;
                mediaUrl = `${dlBase}/${result.fileName}|${result.fileId}|${file.originalname}`;
                mediaType = 'document';
                b2FileId = result.fileId;
                b2FileName = result.fileName;
            }
        }

        if (req.files?.video?.[0]) {
            const { uploadVideo } = require('../services/byseService');
            const result = await uploadVideo(req.files.video[0].buffer, req.files.video[0].originalname, req.files.video[0].mimetype);
            videoUrl = result.url;
            videoFileId = result.fileId;
            mediaType = 'video';
        }

        const postId = crypto.randomUUID();
        await db.execute({
            sql: `INSERT INTO social_posts (id, user_id, content, media_url, media_type, video_url, video_file_id, b2_file_id, b2_file_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [postId, adminUserId, content || '', mediaUrl, mediaType, videoUrl, videoFileId, b2FileId, b2FileName]
        });

        await logAudit(req.adminUser, 'admin_social_post', 'post', postId, { content: (content || '').substring(0, 50) });
        
        // Log to Activity Feed
        logActivity('social', 'Official Admin Post', 'A new official update has been posted to the Social Hub.', {
            icon: 'message-square',
            color: 'purple'
        }).catch(() => {});

        respondOrRedirect(req, res, '/admin/social/post?success=1');
    } catch (err) {
        console.error('Admin Post Error:', err);
        respondOrRedirect(req, res, null, null, err);
    }
});

// ─────────────────────────────────────────────
//  SOCIAL MODERATION
// ─────────────────────────────────────────────

router.get('/social', async (req, res) => {
    try {
        const [postsRes, reportsRes] = await Promise.all([
            db.execute(`
                SELECT p.*, u.name as author_name, u.semester, u.section, u.verify_badge,
                (SELECT COUNT(*) FROM post_reports WHERE post_id = p.id AND status = 'pending') as report_count
                FROM social_posts p 
                JOIN users u ON p.user_id = u.id 
                ORDER BY p.created_at DESC LIMIT 50
            `),
            db.execute(`
                SELECT r.*, p.content, u.name as reporter_name
                FROM post_reports r
                JOIN social_posts p ON r.post_id = p.id
                JOIN users u ON r.user_id = u.id
                WHERE r.status = 'pending'
                ORDER BY r.created_at DESC
            `)
        ]);

        res.render('admin-social', {
            posts: postsRes.rows || [],
            reports: reportsRes.rows || [],
            flash: req.query.success ? { type: 'success', message: 'Action completed successfully' } : null
        });
    } catch (err) {
        res.status(500).send('Error loading social moderation: ' + err.message);
    }
});

router.post('/social/post/:id/delete', async (req, res) => {
    try {
        const { deleteFromCloudinary } = require('../services/cloudinaryService');
        const { deleteVideo } = require('../services/byseService');
        const postRes = await db.execute({ sql: `SELECT media_url, media_type, video_file_id, b2_file_id, b2_file_name FROM social_posts WHERE id = ?`, args: [req.params.id]});
        
        if (postRes.rows.length > 0) {
            const post = postRes.rows[0];
            if (post.media_url && post.media_type === 'image') {
                const parts = post.media_url.split('|');
                if (parts.length > 1) {
                    await deleteFromCloudinary(parts[1]).catch(() => {});
                }
            }
            if (post.b2_file_id && post.b2_file_name) {
                await deleteFromB2(post.b2_file_id, post.b2_file_name);
            }
            if (post.video_file_id) {
                await deleteVideo(post.video_file_id);
            }
        }

        await db.execute({ sql: `DELETE FROM social_posts WHERE id = ?`, args: [req.params.id]});
        respondOrRedirect(req, res, '/admin/social?success=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.post('/social/report/:id/dismiss', async (req, res) => {
    try {
        await db.execute({ sql: `UPDATE post_reports SET status = 'dismissed' WHERE id = ?`, args: [req.params.id]});
        respondOrRedirect(req, res, '/admin/social?success=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

// ─────────────────────────────────────────────
//  APP SETTINGS (FEATURE TOGGLES)
// ─────────────────────────────────────────────

router.get('/app-settings', async (req, res) => {
    try {
        const { data: settings, error } = await supabase
            .from('feature_settings')
            .select('*')
            .eq('id', 1)
            .single();

        if (error) throw error;

        res.render('app-settings', { 
            settings: settings || {},
            flash: req.query.success ? { type: 'success', message: 'Settings updated successfully' } : null
        });
    } catch (err) {
        console.error('Settings Fetch Error:', err);
        res.status(500).send('Error loading settings');
    }
});

router.post('/app-settings', async (req, res) => {
    const { qr_enabled, barcode_enabled, login_enabled, social_enabled, maintenance_mode, maintenance_message } = req.body;
    
    try {
        const updateData = {
            qr_enabled: qr_enabled === 'on',
            barcode_enabled: barcode_enabled === 'on',
            login_enabled: login_enabled === 'on',
            social_enabled: social_enabled === 'on',
            maintenance_mode: maintenance_mode === 'on',
            maintenance_message,
            updated_at: new Date(),
            updated_by: req.adminUser?.id
        };

        const { error } = await supabase
            .from('feature_settings')
            .update(updateData)
            .eq('id', 1);

        if (error) throw error;

        await logAudit(req.adminUser, 'update_app_settings', 'system', '1', updateData);

        respondOrRedirect(req, res, '/admin/app-settings?success=1');
    } catch (err) {
        console.error('Settings Update Error:', err);
        respondOrRedirect(req, res, null, null, err);
    }
});

// ─────────────────────────────────────────────
//  MEDIA SETTINGS (Byse.sx)
// ─────────────────────────────────────────────

router.get('/media-settings', async (req, res) => {
    try {
        const [byseRes, b2IdRes, b2KeyRes, b2BucketRes, b2NameRes, libAdminsRes] = await Promise.all([
            db.execute({ sql: "SELECT value FROM app_config WHERE key = 'byse_api_key'" }),
            db.execute({ sql: "SELECT value FROM app_config WHERE key = 'b2_application_key_id'" }),
            db.execute({ sql: "SELECT value FROM app_config WHERE key = 'b2_application_key'" }),
            db.execute({ sql: "SELECT value FROM app_config WHERE key = 'b2_bucket_id'" }),
            db.execute({ sql: "SELECT value FROM app_config WHERE key = 'b2_bucket_name'" }),
            db.execute({ sql: "SELECT value FROM app_config WHERE key = 'library_admins'" })
        ]);
        res.render('media-settings', {
            byseApiKey: byseRes.rows[0]?.value || '',
            b2ApplicationKeyId: b2IdRes.rows[0]?.value || '',
            b2ApplicationKey: b2KeyRes.rows[0]?.value || '',
            b2BucketId: b2BucketRes.rows[0]?.value || '',
            b2BucketName: b2NameRes.rows[0]?.value || '',
            libraryAdmins: libAdminsRes.rows[0]?.value || '',
            flash: null
        });
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

router.post('/media-settings', async (req, res) => {
    try {
        const { byse_api_key } = req.body;
        if (byse_api_key) {
            await db.execute({
                sql: 'INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                args: ['byse_api_key', byse_api_key]
            });
        }

        await logAudit(req.adminUser, 'update_media_settings', 'system', 'byse');
        respondOrRedirect(req, res, '/admin/media-settings?saved=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.post('/media-settings/library', async (req, res) => {
    try {
        const { library_admins } = req.body;
        await db.execute({
            sql: 'INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
            args: ['library_admins', library_admins || '']
        });
        await logAudit(req.adminUser, 'update_library_settings', 'system', 'library');
        respondOrRedirect(req, res, '/admin/media-settings?saved=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

// ─────────────────────────────────────────────
//  LIBRARY MANAGEMENT
// ─────────────────────────────────────────────

router.get('/library', async (req, res) => {
    try {
        const search = (req.query.q || '').trim();
        let sql = `SELECT ld.*, u.profile_image as uploader_image
                   FROM library_documents ld
                   LEFT JOIN users u ON ld.user_id = u.id`;
        const args = [];
        if (search) {
            sql += ` WHERE ld.caption LIKE ? OR ld.mime_type LIKE ?`;
            args.push(`%${search}%`, `%${search}%`);
        }
        sql += ` ORDER BY ld.created_at DESC`;

        const docsRes = await db.execute({ sql, args });
        let documents = docsRes.rows || [];

        res.render('admin-library', {
            documents,
            search,
            viewMode: req.query.view || 'grid',
            flash: req.query.success ? { type: 'success', message: 'Document uploaded successfully' } :
                   req.query.deleted ? { type: 'success', message: 'Document deleted successfully' } :
                   req.query.error ? { type: 'error', message: req.query.error } : null
        });
    } catch (err) {
        res.status(500).send('Error loading library: ' + err.message);
    }
});

router.post('/library/upload', libraryUpload.single('document'), async (req, res) => {
    try {
        const { caption } = req.body;
        if (!caption || !caption.trim()) {
            return respondOrRedirect(req, res, '/admin/library?error=' + encodeURIComponent('Caption is required'), null, new Error('Caption is required'));
        }
        if (!req.file) {
            return respondOrRedirect(req, res, '/admin/library?error=' + encodeURIComponent('File is required'), null, new Error('File is required'));
        }

        const { uploadFile: uploadToB2 } = require('../services/b2Service');
        const result = await uploadToB2(req.file.buffer, req.file.originalname, req.file.mimetype);

        await db.execute({
            sql: `INSERT INTO library_documents (user_id, user_name, caption, b2_file_name, b2_file_id, mime_type, file_size)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [
                0, 'Admin',
                caption.trim(), result.fileName, result.fileId,
                req.file.mimetype, req.file.buffer.length
            ]
        });

        await logAudit(req.adminUser, 'upload_library_doc', 'library', result.fileName, { caption });
        respondOrRedirect(req, res, '/admin/library?success=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.get('/library/download/:id', async (req, res) => {
    try {
        const docRes = await db.execute({
            sql: 'SELECT b2_file_name, b2_file_id, caption FROM library_documents WHERE id = ?',
            args: [req.params.id]
        });
        if (docRes.rows.length === 0) return res.status(404).send('Document not found');
        const doc = docRes.rows[0];
        const { getDownloadUrl } = require('../services/b2Service');
        const url = await getDownloadUrl(doc.b2_file_name);
        res.redirect(url);
    } catch (err) {
        res.status(500).send('Download failed: ' + err.message);
    }
});

router.post('/library/:id/delete', async (req, res) => {
    try {
        const docRes = await db.execute({
            sql: 'SELECT id, b2_file_name, b2_file_id FROM library_documents WHERE id = ?',
            args: [req.params.id]
        });
        if (docRes.rows.length === 0) {
            return res.status(404).send('Document not found');
        }
        const doc = docRes.rows[0];
        if (doc.b2_file_id && doc.b2_file_name) {
            await deleteFromB2(doc.b2_file_id, doc.b2_file_name).catch(e => console.error('B2 delete failed:', e.message));
        }
        await db.execute({ sql: 'DELETE FROM library_documents WHERE id = ?', args: [req.params.id] });
        await logAudit(req.adminUser, 'delete_library_doc', 'library', req.params.id);
        respondOrRedirect(req, res, '/admin/library?deleted=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.post('/media-settings/b2', async (req, res) => {
    try {
        const { b2_application_key_id, b2_application_key, b2_bucket_id, b2_bucket_name } = req.body;
        const updates = [
            ['b2_application_key_id', b2_application_key_id],
            ['b2_application_key', b2_application_key],
            ['b2_bucket_id', b2_bucket_id],
            ['b2_bucket_name', b2_bucket_name]
        ];
        for (const [key, value] of updates) {
            if (value) {
                await db.execute({
                    sql: 'INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                    args: [key, value]
                });
            }
        }
        await logAudit(req.adminUser, 'update_media_settings', 'system', 'b2');
        respondOrRedirect(req, res, '/admin/media-settings?saved=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});



// ─────────────────────────────────────────────
//  FACULTY MANAGEMENT
// ─────────────────────────────────────────────

router.get('/faculty', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 30;
    const offset = (page - 1) * limit;
    const search = req.query.q || '';

    try {
        let sql = 'SELECT * FROM faculty WHERE 1=1';
        let countSql = 'SELECT COUNT(*) as count FROM faculty WHERE 1=1';
        const args = [];

        if (search) {
            const pattern = `%${search}%`;
            sql += ' AND (name LIKE ? OR employee_id LIKE ? OR designation LIKE ? OR department LIKE ?)';
            countSql += ' AND (name LIKE ? OR employee_id LIKE ? OR designation LIKE ? OR department LIKE ?)';
            args.push(pattern, pattern, pattern, pattern);
        }

        sql += ' ORDER BY name ASC LIMIT ? OFFSET ?';
        const queryArgs = [...args, limit, offset];

        const [facultyRes, countRes] = await Promise.all([
            db.execute({ sql, args: queryArgs }),
            db.execute({ sql: countSql, args })
        ]);

        const totalFaculty = countRes.rows[0].count;
        const totalPages = Math.ceil(totalFaculty / limit);

        res.render('faculty', {
            faculty: facultyRes.rows,
            page,
            totalPages,
            totalFaculty,
            search,
            flash: req.query.success ? { type: 'success', message: 'Faculty created successfully' } :
                   req.query.saved ? { type: 'success', message: 'Faculty updated successfully' } :
                   req.query.deleted ? { type: 'success', message: 'Faculty deleted successfully' } : null
        });
    } catch (err) {
        res.status(500).send('Error loading faculty: ' + err.message);
    }
});

router.get('/faculty/new', (req, res) => {
    res.render('faculty-form', { faculty: null });
});

router.get('/faculty/:id/edit', async (req, res) => {
    try {
        const facultyRes = await db.execute({ sql: 'SELECT * FROM faculty WHERE id = ?', args: [req.params.id] });

        if (facultyRes.rows.length === 0) return res.status(404).send('Faculty not found');

        res.render('faculty-form', {
            faculty: facultyRes.rows[0]
        });
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

router.post('/faculty', async (req, res) => {
    try {
        const body = req.body || {};
        const { employee_id, name, designation, department, email, phone, qualification, specialization, profile_image, is_active } = body;
        if (!employee_id || !name) return res.status(400).send('employee_id and name are required');
        await db.execute({
            sql: `INSERT INTO faculty (employee_id, name, designation, department, email, phone, qualification, specialization, profile_image, is_active)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [employee_id, name, designation, department, email, phone, qualification, specialization, profile_image || null, is_active === 'on' ? 1 : 0]
        });
        await logAudit(req.adminUser, 'create_faculty', 'faculty', employee_id, { name, department });
        respondOrRedirect(req, res, '/admin/faculty?success=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/faculty/import', (req, res) => {
    res.render('faculty-import', { flash: req.query.success ? { type: 'success', message: 'Faculty imported successfully' } : null });
});

router.post('/faculty/import', importUpload.single('jsonFile'), async (req, res) => {
    try {
        const body = req.body || {};
        let rawJson;
        if (req.file) {
            rawJson = req.file.buffer.toString('utf-8');
        } else if (body.jsonData && body.jsonData.trim()) {
            rawJson = body.jsonData;
        } else {
            return res.status(400).send('Please upload a JSON file or paste JSON data.');
        }

        let facultyArray;
        try {
            facultyArray = JSON.parse(rawJson);
        } catch (e) {
            return res.status(400).send('Invalid JSON format');
        }

        if (!Array.isArray(facultyArray)) {
            return res.status(400).send('JSON must be an array of faculty objects');
        }

        const totalInFile = facultyArray.length;
        let created = 0;
        let updated = 0;
        let errors = [];

        for (const f of facultyArray) {
            try {
                if (!f.employee_id || !f.name) {
                    errors.push(`Missing employee_id or name for: ${JSON.stringify(f)}`);
                    continue;
                }

                const existing = await db.execute({
                    sql: 'SELECT id FROM faculty WHERE employee_id = ?',
                    args: [f.employee_id]
                });

                if (existing.rows.length > 0) {
                    await db.execute({
                        sql: `UPDATE faculty SET
                              name = ?, designation = ?, department = ?, email = ?,
                              phone = ?, qualification = ?, specialization = ?,
                              profile_image = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
                              WHERE employee_id = ?`,
                        args: [
                            f.name, f.designation || null, f.department || null, f.email || null,
                            f.phone || null, f.qualification || null, f.specialization || null,
                            f.profile_image || null, f.is_active !== undefined ? (f.is_active ? 1 : 0) : 1,
                            f.employee_id
                        ]
                    });
                    updated++;
                } else {
                    await db.execute({
                        sql: `INSERT INTO faculty (employee_id, name, designation, department, email, phone, qualification, specialization, profile_image, is_active)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        args: [
                            f.employee_id, f.name, f.designation || null, f.department || null,
                            f.email || null, f.phone || null, f.qualification || null,
                            f.specialization || null, f.profile_image || null, f.is_active !== undefined ? (f.is_active ? 1 : 0) : 1
                        ]
                    });
                    created++;
                }
            } catch (e) {
                errors.push(`${f.employee_id || 'unknown'}: ${e.message}`);
            }
        }

        await logAudit(req.adminUser, 'import_faculty', 'faculty', 'bulk', { created, updated, errors: errors.length });

        const flash = { type: 'success', message: `Import complete: ${created} created, ${updated} updated (${totalInFile} records in file)` };
        if (errors.length) flash.message += `, ${errors.length} errors`;

        if (req.xhr || req.get('Accept')?.includes('json')) {
            res.json({ success: true, message: flash.message });
        } else {
            res.render('faculty-import', { flash });
        }
    } catch (err) {
        res.status(500).send('Import failed: ' + err.message);
    }
});

router.post('/faculty/:id', async (req, res) => {
    try {
        const body = req.body || {};
        const { employee_id, name, designation, department, email, phone, qualification, specialization, profile_image, is_active } = body;
        if (!employee_id || !name) return res.status(400).send('employee_id and name are required');
        await db.execute({
            sql: `UPDATE faculty SET
                  employee_id = ?, name = ?, designation = ?, department = ?,
                  email = ?, phone = ?, qualification = ?, specialization = ?,
                  profile_image = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?`,
            args: [employee_id, name, designation, department, email, phone, qualification, specialization, profile_image || null, is_active === 'on' ? 1 : 0, req.params.id]
        });
        await logAudit(req.adminUser, 'update_faculty', 'faculty', req.params.id, { name, department });
        respondOrRedirect(req, res, `/admin/faculty/${req.params.id}/edit?saved=1`);
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.post('/faculty/:id/delete', async (req, res) => {
    try {
        await db.execute({ sql: 'DELETE FROM faculty WHERE id = ?', args: [req.params.id] });
        await logAudit(req.adminUser, 'delete_faculty', 'faculty', req.params.id);
        respondOrRedirect(req, res, '/admin/faculty?deleted=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

// ─────────────────────────────────────────────
//  CALENDAR MANAGEMENT
// ─────────────────────────────────────────────

router.get('/calendar', async (req, res) => {
    const search = req.query.q || '';

    try {
        let calSource = 'custom';
        try {
            const cfg = await db.execute({ sql: "SELECT value FROM app_config WHERE key = 'calendar_source'", args: [] });
            if (cfg.rows.length > 0 && cfg.rows[0].value) calSource = cfg.rows[0].value;
        } catch (_) {}

        let proxiedData = null;
        let proxiedError = null;

        if (calSource === 'proxied') {
            try {
                const proxiedRes = await fetch(`${API_BASE}/student/calendardayslist/2025-2026?title=${encodeURIComponent(search)}`, {
                    headers: { 'Content-Type': 'application/json' }
                });
                if (proxiedRes.ok) {
                    proxiedData = await proxiedRes.json();
                } else {
                    proxiedError = `College API returned status ${proxiedRes.status}`;
                }
            } catch (e) {
                proxiedError = e.message;
            }
        }

        let events = [];
        let totalEvents = 0;

        if (calSource === 'custom') {
            let sql = 'SELECT * FROM calendar_events WHERE 1=1';
            let countSql = 'SELECT COUNT(*) as count FROM calendar_events WHERE 1=1';
            const args = [];

            if (search) {
                const pattern = `%${search}%`;
                sql += ' AND (title LIKE ? OR description LIKE ?)';
                countSql += ' AND (title LIKE ? OR description LIKE ?)';
                args.push(pattern, pattern);
            }

            sql += ' ORDER BY date ASC, id ASC';

            const [eventsRes, countRes] = await Promise.all([
                db.execute({ sql, args }),
                db.execute({ sql: countSql, args })
            ]);

            events = eventsRes.rows;
            totalEvents = countRes.rows[0].count;
        }

        res.render('calendar', {
            calSource,
            search,
            proxiedData,
            proxiedError,
            events,
            totalEvents,
            flash: req.query.success ? { type: 'success', message: 'Calendar imported successfully' } :
                   req.query.deleted ? { type: 'success', message: 'Calendar event deleted' } :
                   req.query.cleared ? { type: 'success', message: 'All custom events cleared' } : null
        });
    } catch (err) {
        res.status(500).send('Error loading calendar: ' + err.message);
    }
});

router.post('/calendar/source', async (req, res) => {
    try {
        const { source } = req.body;
        if (source !== 'proxied' && source !== 'custom') {
            return res.status(400).send('Invalid source. Must be "proxied" or "custom".');
        }
        await db.execute({
            sql: "INSERT INTO app_config (key, value, updated_at) VALUES ('calendar_source', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP",
            args: [source, source]
        });
        await logAudit(req.adminUser, 'update_calendar_source', 'system', '1', { source });
        respondOrRedirect(req, res, '/admin/calendar');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.get('/calendar/import', (req, res) => {
    res.render('calendar-import', {
        flash: req.query.success ? { type: 'success', message: 'Calendar imported successfully' } : null
    });
});

router.post('/calendar/import', async (req, res) => {
    try {
        const { jsonData } = req.body;
        if (!jsonData || !jsonData.trim()) {
            return res.status(400).send('JSON data is required');
        }

        let eventsArray;
        try {
            eventsArray = JSON.parse(jsonData);
        } catch (e) {
            return res.status(400).send('Invalid JSON format');
        }

        if (!Array.isArray(eventsArray)) {
            return res.status(400).send('JSON must be an array of event objects');
        }

        let imported = 0;
        let errors = [];

        for (const ev of eventsArray) {
            try {
                if (!ev.title || !ev.date) {
                    errors.push(`Missing title or date for: ${JSON.stringify(ev).substring(0, 50)}`);
                    continue;
                }

                await db.execute({
                    sql: `INSERT INTO calendar_events (title, date, description, type) VALUES (?, ?, ?, ?)`,
                    args: [ev.title, ev.date, ev.description || null, ev.type || 'general']
                });
                imported++;
            } catch (e) {
                errors.push(`${ev.title}: ${e.message}`);
            }
        }

        await logAudit(req.adminUser, 'import_calendar', 'calendar', 'bulk', { imported, errors: errors.length });

        const flash = { type: 'success', message: `Import complete: ${imported} events imported` };
        if (errors.length) flash.message += `, ${errors.length} errors`;

        if (req.xhr || req.get('Accept')?.includes('json')) {
            res.json({ success: true, message: flash.message });
        } else {
            res.render('calendar-import', { flash });
        }
    } catch (err) {
        res.status(500).send('Import failed: ' + err.message);
    }
});

router.post('/calendar/events/:id/delete', async (req, res) => {
    try {
        await db.execute({ sql: 'DELETE FROM calendar_events WHERE id = ?', args: [req.params.id] });
        await logAudit(req.adminUser, 'delete_calendar_event', 'calendar', req.params.id);
        respondOrRedirect(req, res, '/admin/calendar?deleted=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.post('/calendar/clear', async (req, res) => {
    try {
        await db.execute('DELETE FROM calendar_events');
        await logAudit(req.adminUser, 'clear_calendar', 'calendar', 'all');
        respondOrRedirect(req, res, '/admin/calendar?cleared=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

// ─────────────────────────────────────────────
//  CHAT CONTROL
// ─────────────────────────────────────────────

router.get('/chat', async (req, res) => {
    try {
        const [messagesRes, bansRes] = await Promise.all([
            db.execute({ sql: 'SELECT * FROM chat_messages ORDER BY is_pinned DESC, created_at ASC' }),
            db.execute({ sql: 'SELECT cb.*, u.name as user_name FROM chat_bans cb LEFT JOIN users u ON cb.user_id = u.id ORDER BY cb.created_at DESC' })
        ]);

        const messages = messagesRes.rows.map(m => ({
            ...m,
            mentions: JSON.parse(m.mentions || '[]'),
            reactions: JSON.parse(m.reactions || '{}'),
        }));

        res.render('chat', { messages, bans: bansRes.rows, flash: null });
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

router.post('/chat/delete', async (req, res) => {
    try {
        const ids = req.body.ids;
        if (!ids || (Array.isArray(ids) && ids.length === 0)) {
            return res.status(400).send('No message IDs provided.');
        }
        const idList = Array.isArray(ids) ? ids : [ids];
        await db.execute({
            sql: `UPDATE chat_messages SET is_deleted = 1, message = NULL, gif_url = NULL, sticker_url = NULL WHERE id IN (${idList.map(() => '?').join(',')})`,
            args: idList
        });
        await logAudit(req.adminUser, 'delete_chat_messages', 'chat', 'bulk', { count: idList.length });
        respondOrRedirect(req, res, '/admin/chat?deleted=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.post('/chat/ban', async (req, res) => {
    try {
        const { user_id, reason } = req.body;
        if (!user_id || !reason) return respondOrRedirect(req, res, null, null, new Error('User ID and reason required.'));
        await db.execute({
            sql: 'INSERT OR REPLACE INTO chat_bans (user_id, banned_by, reason) VALUES (?, ?, ?)',
            args: [user_id, req.adminUser?.id, reason]
        });
        await logAudit(req.adminUser, 'ban_chat_user', 'chat', user_id, { reason });
        respondOrRedirect(req, res, '/admin/chat?banned=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.post('/chat/unban', async (req, res) => {
    try {
        const { user_id } = req.body;
        await db.execute({ sql: 'DELETE FROM chat_bans WHERE user_id = ?', args: [user_id] });
        await logAudit(req.adminUser, 'unban_chat_user', 'chat', user_id);
        respondOrRedirect(req, res, '/admin/chat?unbanned=1');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.post('/chat/pin/:id', async (req, res) => {
    try {
        await db.execute({
            sql: 'UPDATE chat_messages SET is_pinned = 1 WHERE id = ?',
            args: [req.params.id]
        });
        respondOrRedirect(req, res, '/admin/chat');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.post('/chat/unpin/:id', async (req, res) => {
    try {
        await db.execute({
            sql: 'UPDATE chat_messages SET is_pinned = 0 WHERE id = ?',
            args: [req.params.id]
        });
        respondOrRedirect(req, res, '/admin/chat');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

router.post('/chat/send', async (req, res) => {
    try {
        const { message, parent_id } = req.body;
        if (!message || !message.trim()) return respondOrRedirect(req, res, null, null, new Error('Message is required.'));

        await db.execute({
            sql: `INSERT INTO chat_messages (user_id, name, message, parent_id, message_type, verify_badge)
                  VALUES (-1, 'Moderator', ?, ?, 'text', 1)`,
            args: [message.trim(), parent_id || null]
        });

        respondOrRedirect(req, res, '/admin/chat');
    } catch (err) {
        respondOrRedirect(req, res, null, null, err);
    }
});

module.exports = router;
