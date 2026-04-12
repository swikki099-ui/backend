const express = require('express');
const { db, supabase } = require('../db');
const { requireAdmin } = require('../middleware/adminAuth');
const { createSupabaseServerClient } = require('../utils/supabaseServer');
const sysLogger = require('../utils/logger');
const { logActivity } = require('../utils/activityLogger');
const { sendBulkEmail, sendPersonalizedEmail, checkSmtpConnection } = require('../utils/mailer');
const multer = require('multer');
const fs = require('fs');

// Configure Multer for email attachments
// NOTE: Use /tmp for Vercel serverless compatibility (read-only filesystem)
const upload = multer({ 
    dest: '/tmp/mail-temp/',
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit per file
});

const router = express.Router();

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
        const [usersCountRes, profilesCompletedRes, recentUsersRes, activeTodayRes, bansRes] = await Promise.all([
            db.execute('SELECT COUNT(*) as count FROM users'),
            db.execute('SELECT COUNT(*) as count FROM users WHERE profile_complete = 1'),
            db.execute('SELECT name, roll_no, email, course, created_at FROM users ORDER BY id DESC LIMIT 6'),
            db.execute("SELECT COUNT(*) as count FROM users WHERE last_active_at >= datetime('now', '-1 day')"),
            supabase.from('user_bans').select('id', { count: 'exact' }).eq('is_active', true),
        ]);

        const appSettings = await getAppSettings();

        res.render('dashboard', {
            stats: {
                totalUsers:       usersCountRes.rows[0].count,
                profilesCompleted: profilesCompletedRes.rows[0].count,
                dau:              activeTodayRes.rows[0].count,
                activeBans:       bansRes.count || 0,
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

        res.render('user-detail', { user, ban });
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
        res.render('user-edit', { user: userRes.rows[0] });
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
        res.redirect(`/admin/users/${req.params.id}?saved=1`);
    } catch (err) {
        res.status(500).send('Save failed: ' + err.message);
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
            const { error } = await supabase.from('user_bans').insert({
                college_id: user.college_id,
                user_name: user.name,
                reason: reason || 'Violation of terms',
                banned_by: req.adminUser?.id,
                expires_at: expires_at || null
            });
            if (error) throw error;
            await logAudit(req.adminUser, 'ban_user', 'user', userId, { reason });
        } else if (_action === 'delete') {
            await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [userId] });
            await logAudit(req.adminUser, 'delete_user', 'user', userId, { name: user.name });
            return res.redirect('/admin/users');
        }

        res.redirect(`/admin/users/${userId}`);
    } catch (err) {
        res.status(500).send('Action failed: ' + err.message);
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
        const { error } = await supabase
            .from('user_bans')
            .update({ is_active: false })
            .eq('id', req.params.id);

        if (error) throw error;
        await logAudit(req.adminUser, 'unban_user', 'ban_record', req.params.id);
        
        // Log to Activity Feed
        logActivity('unban', 'User Unbanned', `${banRecord.user_name || banRecord.college_id} has been unsuspended.`, {
            icon: 'unlock',
            color: 'green'
        }).catch(() => {});

        res.redirect('/admin/bans');
    } catch (err) {
        res.status(500).send('Unban failed: ' + err.message);
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

        res.redirect('/admin/app-update?success=1');
    } catch (err) {
        console.error('Publish Update Error:', err);
        res.status(500).send('Failed to publish update: ' + err.message);
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
            publish_at: publish_at || null,
            created_by: req.adminUser?.id,
        });

        if (error) throw error;
        await logAudit(req.adminUser, 'create_announcement', 'announcement', title);
        res.redirect('/admin/announcements');
    } catch (err) {
        res.status(500).send('Failed: ' + err.message);
    }
});

router.post('/announcements/:id/delete', async (req, res) => {
    try {
        const { error } = await supabase.from('announcements').delete().eq('id', req.params.id);
        if (error) throw error;
        res.redirect('/admin/announcements');
    } catch (err) {
        res.status(500).send('Delete failed');
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
        res.redirect('/admin/mail/templates');
    } catch (err) {
        res.status(500).send('Save failed: ' + err.message);
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
            return res.status(400).send('No student found matching criteria');
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
        res.redirect('/admin/mail?success=1');
    } catch (err) {
        res.status(500).send('Mail failed: ' + err.message);
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

router.get('/health', async (req, res) => {
    const ms = process.memoryUsage();
    const uptimeSec = process.uptime();
    const [tursoStatus, supabaseStatus, smtpRes, usersCount] = await Promise.all([
        db.execute('SELECT 1').then(() => 'connected').catch(() => 'error'),
        supabase.from('app_settings').select('id').limit(1).then(r => r.error ? 'error' : 'connected').catch(() => 'error'),
        checkSmtpConnection(),
        db.execute('SELECT COUNT(*) as count FROM users').then(r => r.rows[0].count).catch(() => '?'),
    ]);

    res.render('health', {
        health: {
            turso: tursoStatus,
            supabase: supabaseStatus,
            smtp: smtpRes.status,
            smtpMessage: smtpRes.message,
            uptime: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`,
            nodeVersion: process.version,
            env: process.env.NODE_ENV || 'development',
            platform: process.platform,
            totalUsers: usersCount,
            memoryUsage: `${Math.round(ms.heapUsed / 1024 / 1024)} MB`,
            checkedAt: new Date().toLocaleString('en-IN'),
        }
    });
});

// ─────────────────────────────────────────────
//  SOCIAL MODERATION
// ─────────────────────────────────────────────

router.get('/social', async (req, res) => {
    try {
        const [postsRes, reportsRes] = await Promise.all([
            db.execute(`
                SELECT p.*, u.name as author_name, 
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
        const postRes = await db.execute({ sql: `SELECT media_url, media_type FROM social_posts WHERE id = ?`, args: [req.params.id]});
        
        if (postRes.rows.length > 0 && postRes.rows[0].media_url) {
            const parts = postRes.rows[0].media_url.split('|');
            if (parts.length > 1) {
                await deleteFromCloudinary(parts[1], postRes.rows[0].media_type === 'document' ? 'raw' : 'image');
            }
        }

        // Deleting from Turso cascades to likes, comments, and reports
        await db.execute({ sql: `DELETE FROM social_posts WHERE id = ?`, args: [req.params.id]});
        res.redirect('/admin/social?success=1');
    } catch (err) {
        res.status(500).send('Failed to nuke post: ' + err.message);
    }
});

router.post('/social/report/:id/dismiss', async (req, res) => {
    try {
        await db.execute({ sql: `UPDATE post_reports SET status = 'dismissed' WHERE id = ?`, args: [req.params.id]});
        res.redirect('/admin/social?success=1');
    } catch (err) {
        res.status(500).send('Failed to dismiss report: ' + err.message);
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
    const { qr_enabled, barcode_enabled, login_enabled, maintenance_mode, maintenance_message } = req.body;
    
    try {
        const updateData = {
            qr_enabled: qr_enabled === 'on',
            barcode_enabled: barcode_enabled === 'on',
            login_enabled: login_enabled === 'on',
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

        res.redirect('/admin/app-settings?success=1');
    } catch (err) {
        console.error('Settings Update Error:', err);
        res.status(500).send('Error updating settings: ' + err.message);
    }
});

module.exports = router;
