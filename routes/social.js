const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { db, supabase } = require('../db');
const sessionStore = require('../utils/sessionStore');
const { uploadToCloudinary, deleteFromCloudinary } = require('../services/cloudinaryService');

const router = express.Router();

// Multer memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit for posts (pdfs/imgs)
});

/**
 * 🛡️ The Guillotine Middleware
 * Extracts session, verifies Turso, checks Global Admin Switches & Bans.
 */
const requireSocialAccess = async (req, res, next) => {
    let sessionId = req.headers['x-session-id'] || req.headers['authorization'];
    if (!sessionId) return res.status(401).json({ error: 'Unauthorized.' });

    if (sessionId.toLowerCase().startsWith('bearer ')) {
        sessionId = sessionId.slice(7);
    }

    try {
        const session = sessionStore.decrypt(sessionId);
        if (!session || !session.user_id) throw new Error('Invalid token');

        // 1. Verify User & Get College ID
        const userRes = await db.execute({
            sql: "SELECT id, college_id FROM users WHERE id = ?",
            args: [session.user_id]
        });

        if (userRes.rows.length === 0) {
            return res.status(403).json({ error: 'Account deleted.' });
        }

        const user = userRes.rows[0];

        // 2. Oracle Checks
        const [settingsRes, banRes] = await Promise.all([
            supabase.from('feature_settings').select('social_enabled, maintenance_mode, maintenance_message').eq('id', 1).single(),
            supabase.from('user_bans').select('reason').eq('college_id', user.college_id).eq('is_active', true).maybeSingle()
        ]);

        if (settingsRes.data) {
            if (settingsRes.data.maintenance_mode) {
                return res.status(503).json({ error: settingsRes.data.maintenance_message || 'System under maintenance.' });
            }
            if (!settingsRes.data.social_enabled) {
                return res.status(503).json({ error: 'The Social Hub is currently locked down by the Administrator.' });
            }
        }

        if (banRes.data) {
            return res.status(403).json({ error: 'Your account is suspended.', reason: banRes.data.reason });
        }

        req.userId = user.id;
        next();
    } catch(err) {
        return res.status(401).json({ error: 'Session expired or invalid.' });
    }
};

/**
 * GET /social/feed
 * Retrieves paginated posts with author JOINs and like status.
 */
router.get('/feed', requireSocialAccess, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        // Massive JOIN query to fulfill architectural requirements
        const feedSql = `
            SELECT 
                p.id, p.content, p.media_url, p.media_type, p.created_at, p.is_repost,
                u.name as author_name, u.semester as author_semester, u.section as author_section, u.profile_image as author_image,
                (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes_count,
                (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comments_count,
                EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = ?) as has_liked,
                op.content as original_content,
                ou.name as original_author_name
            FROM social_posts p
            JOIN users u ON p.user_id = u.id
            LEFT JOIN social_posts op ON p.original_post_id = op.id
            LEFT JOIN users ou ON op.user_id = ou.id
            ORDER BY p.created_at DESC
            LIMIT ? OFFSET ?
        `;

        const feedData = await db.execute({
            sql: feedSql,
            args: [req.userId, limit, offset]
        });

        res.json(feedData.rows);
    } catch (e) {
        console.error("Feed Error:", e);
        res.status(500).json({ error: 'Internal server error fetching feed.' });
    }
});

/**
 * POST /social/post
 * Create a new text post with optional media.
 */
router.post('/post', requireSocialAccess, upload.single('media'), async (req, res) => {
    try {
        const { content } = req.body;
        if (!content && !req.file) {
            return res.status(400).json({ error: 'Post must contain text or media.' });
        }

        let mediaUrl = null;
        let mediaType = null;
        let publicId = null;

        if (req.file) {
            const uploadResult = await uploadToCloudinary(req.file.buffer, req.file.mimetype);
            mediaUrl = uploadResult.url;
            mediaType = uploadResult.type;
            publicId = uploadResult.public_id; // Stored in media_url for simplicity or derived later
        }

        const postId = crypto.randomUUID();
        await db.execute({
            sql: `INSERT INTO social_posts (id, user_id, content, media_url, media_type) VALUES (?, ?, ?, ?, ?)`,
            args: [postId, req.userId, content || '', publicId ? `${mediaUrl}|${publicId}` : mediaUrl, mediaType]
        });

        res.json({ success: true, message: 'Post created.' });
    } catch (e) {
        console.error("Post Creation Error:", e);
        res.status(500).json({ error: 'Failed to create post.' });
    }
});

/**
 * POST /social/post/:id/like
 */
router.post('/post/:id/like', requireSocialAccess, async (req, res) => {
    try {
        const postId = req.params.id;
        
        // Toggle logic based on existence
        const existing = await db.execute({ sql: `SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?`, args: [postId, req.userId]});
        
        if (existing.rows.length > 0) {
            await db.execute({ sql: `DELETE FROM post_likes WHERE post_id = ? AND user_id = ?`, args: [postId, req.userId]});
            res.json({ liked: false });
        } else {
            await db.execute({ sql: `INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)`, args: [postId, req.userId]});
            res.json({ liked: true });
        }
    } catch (e) {
        res.status(500).json({ error: 'Action failed.' });
    }
});

/**
 * POST /social/post/:id/comment
 */
router.post('/post/:id/comment', requireSocialAccess, async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) return res.status(400).json({ error: 'Comment cannot be empty.'});

        const commentId = crypto.randomUUID();
        await db.execute({
            sql: `INSERT INTO post_comments (id, post_id, user_id, content) VALUES (?, ?, ?, ?)`,
            args: [commentId, req.params.id, req.userId, content]
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to add comment.' });
    }
});

/**
 * GET /social/post/:id/comments
 */
router.get('/post/:id/comments', requireSocialAccess, async (req, res) => {
    try {
        const comments = await db.execute({
            sql: `
                SELECT c.id, c.content, c.created_at, u.name as author_name, u.profile_image as author_image 
                FROM post_comments c 
                JOIN users u ON c.user_id = u.id 
                WHERE c.post_id = ? 
                ORDER BY c.created_at ASC
            `,
            args: [req.params.id]
        });
        res.json(comments.rows);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch comments.' });
    }
});

/**
 * POST /social/post/:id/report
 */
router.post('/post/:id/report', requireSocialAccess, async (req, res) => {
    try {
        const reportId = crypto.randomUUID();
        await db.execute({
            sql: `INSERT INTO post_reports (id, post_id, user_id, reason) VALUES (?, ?, ?, ?)`,
            args: [reportId, req.params.id, req.userId, req.body.reason || 'Flagged by user']
        });
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Reporting failed.' });
    }
});

/**
 * DELETE /social/post/:id
 * Only the author can delete it.
 */
router.delete('/post/:id', requireSocialAccess, async (req, res) => {
    try {
        const post = await db.execute({ sql: `SELECT user_id, media_url, media_type FROM social_posts WHERE id = ?`, args: [req.params.id]});
        if (post.rows.length === 0) return res.status(404).json({ error: 'Post not found.'});
        
        if (post.rows[0].user_id !== req.userId) {
            return res.status(403).json({ error: 'You are not the author of this post.'});
        }

        // Delete from Cloudinary if media exists
        if (post.rows[0].media_url) {
            const parts = post.rows[0].media_url.split('|');
            if (parts.length > 1) {
                const publicId = parts[1];
                await deleteFromCloudinary(publicId, post.rows[0].media_type === 'document' ? 'raw' : 'image');
            }
        }

        await db.execute({ sql: `DELETE FROM social_posts WHERE id = ?`, args: [req.params.id]});
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Failed to delete.'});
    }
});

module.exports = router;
