const express = require('express');
const https = require('https');
const multer = require('multer');
const crypto = require('crypto');
const { db, supabase } = require('../db');
const sessionStore = require('../utils/sessionStore');
const { uploadToCloudinary, deleteFromCloudinary } = require('../services/cloudinaryService');
const { getApiKey, getUploadServer, getThumbnail, uploadVideo: uploadToByse, deleteVideo: deleteFromByse } = require('../services/byseService');
const { uploadFile: uploadToB2, deleteFile: deleteFromB2, getDownloadUrl: getB2DownloadUrl, getUploadAuth: getB2UploadAuth } = require('../services/b2Service');

const router = express.Router();

// Multer memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB limit for posts (videos, images, pdfs)
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
            supabase.from('feature_settings').select('maintenance_mode, maintenance_message').eq('id', 1).single(),
            supabase.from('user_bans').select('reason').eq('college_id', user.college_id).eq('is_active', true).maybeSingle()
        ]);

        if (settingsRes.data) {
            if (settingsRes.data.maintenance_mode) {
                return res.status(503).json({ error: settingsRes.data.maintenance_message || 'System under maintenance.' });
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
            p.id, p.content, p.media_url, p.media_type, p.video_url, p.video_file_id, p.video_thumbnail, p.created_at, p.is_repost,
                u.name as author_name, u.semester as author_semester, u.section as author_section, u.profile_image as author_image,
                u.verify_badge as author_verified,
                (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes_count,
                (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comments_count,
                EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = ?) as has_liked,
                op.content as original_content,
                ou.name as original_author_name,
                ou.verify_badge as original_author_verified
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

        // Fill in fallback thumbnail for legacy ImageKit posts
        const rows = feedData.rows.map(row => {
            if (!row.video_thumbnail && row.video_url && row.video_url.includes('ik.imagekit.io')) {
                const url = new URL(row.video_url);
                const parts = url.pathname.split('/');
                const endpoint = parts[1];
                const filePath = parts.slice(2).join('/');
                row.video_thumbnail = `${url.origin}/${endpoint}/tr:n-media_library_thumbnail/${filePath}`;
            }
            return row;
        });

        res.json(rows);
    } catch (e) {
        console.error("Feed Error:", e);
        res.status(500).json({ error: 'Internal server error fetching feed.' });
    }
});

/**
 * GET /social/user/posts
 * Retrieves all posts authored by the current user.
 */
router.get('/user/posts', requireSocialAccess, async (req, res) => {
    try {
        const userPostsSql = `
            SELECT 
                p.id, p.content, p.media_url, p.media_type, p.video_url, p.video_file_id, p.video_thumbnail, p.created_at, p.is_repost,
                u.name as author_name, u.semester as author_semester, u.section as author_section, u.profile_image as author_image,
                u.verify_badge as author_verified,
                (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes_count,
                (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comments_count,
                EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = ?) as has_liked,
                op.content as original_content,
                ou.name as original_author_name,
                ou.verify_badge as original_author_verified
            FROM social_posts p
            JOIN users u ON p.user_id = u.id
            LEFT JOIN social_posts op ON p.original_post_id = op.id
            LEFT JOIN users ou ON op.user_id = ou.id
            WHERE p.user_id = ?
            ORDER BY p.created_at DESC
        `;

        const postsData = await db.execute({
            sql: userPostsSql,
            args: [req.userId, req.userId]
        });

        const rows = postsData.rows.map(row => {
            if (!row.video_thumbnail && row.video_url && row.video_url.includes('ik.imagekit.io')) {
                const url = new URL(row.video_url);
                const parts = url.pathname.split('/');
                const endpoint = parts[1];
                const filePath = parts.slice(2).join('/');
                row.video_thumbnail = `${url.origin}/${endpoint}/tr:n-media_library_thumbnail/${filePath}`;
            }
            return row;
        });

        res.json(rows);
    } catch (e) {
        console.error("User Posts Error:", e);
        res.status(500).json({ error: 'Failed to fetch your post history.' });
    }
});

/**
 * DELETE /social/post/:id
 * Allows a user to delete their own post.
 */
router.delete('/post/:id', requireSocialAccess, async (req, res) => {
    try {
        const postId = req.params.id;

        // 1. Verify ownership
        const postRes = await db.execute({
            sql: "SELECT id, media_url, video_file_id, b2_file_id, b2_file_name, user_id FROM social_posts WHERE id = ?",
            args: [postId]
        });

        if (postRes.rows.length === 0) {
            return res.status(404).json({ error: 'Post not found.' });
        }

        const post = postRes.rows[0];
        if (post.user_id !== req.userId) {
            return res.status(403).json({ error: 'You can only delete your own posts.' });
        }

        // 2. Cleanup Cloudinary images
        if (post.media_url) {
            try {
                const urls = JSON.parse(post.media_url);
                if (Array.isArray(urls)) {
                    for (const entry of urls) {
                        const parts = entry.split('|');
                        const publicId = parts.length > 1 ? parts[1] : null;
                        if (publicId && publicId.length > 20) {
                            await deleteFromCloudinary(publicId).catch(err => console.error("Cloudinary Cleanup Failed:", err));
                        }
                    }
                }
            } catch {
                const parts = post.media_url.split('|');
                const publicId = parts.length > 1 ? parts[1] : null;
                if (publicId) {
                    await deleteFromCloudinary(publicId).catch(err => console.error("Cloudinary Cleanup Failed:", err));
                }
            }
        }

        // Cleanup B2 documents
        if (post.b2_file_id && post.b2_file_name) {
            await deleteFromB2(post.b2_file_id, post.b2_file_name).catch(err => console.error("B2 Cleanup Failed:", err));
        }

        // Cleanup Byse.sx video
        if (post.video_file_id) {
            await deleteFromByse(post.video_file_id).catch(err => console.error("Byse Cleanup Failed:", err));
        }

        // 3. Delete from Turso (Likes and comments will be orphaned or CASCADE if set, 
        // but we'll manually ensure clean up if we didn't use foreign key cascades).
        // For simplicity, let's assume we want to clean them up.
        await db.batch([
            { sql: "DELETE FROM post_likes WHERE post_id = ?", args: [postId] },
            { sql: "DELETE FROM post_comments WHERE post_id = ?", args: [postId] },
            { sql: "DELETE FROM social_posts WHERE id = ?", args: [postId] }
        ], "write");

        res.json({ success: true, message: 'Post deleted successfully.' });
    } catch (e) {
        console.error("Delete Error:", e);
        res.status(500).json({ error: 'Failed to delete post.' });
    }
});

/**
 * POST /social/post
 * Create a new text post with optional media.
 */
router.post('/post', requireSocialAccess, upload.array('media', 4), async (req, res) => {
    try {
        const { content, video_url, video_file_id, video_thumbnail, b2_file_id, b2_file_name, original_name } = req.body;
        const files = req.files || [];
        if (!content && files.length === 0 && !video_url && !b2_file_id) {
            return res.status(400).json({ error: 'Post must contain text or media.' });
        }

        let mediaEntries = [];
        let b2FileId = null;
        let b2FileName = null;

        // Client-side B2 upload (bypasses Vercel 4.5MB limit)
        if (b2_file_id && b2_file_name) {
            const dlBase = `${req.protocol}://${req.get('host')}/social/download/document`;
            mediaEntries.push(`${dlBase}/${b2_file_name}|${b2_file_id}|${original_name || 'document'}`);
            b2FileId = b2_file_id;
            b2FileName = b2_file_name;
        }

        // Server-uploaded files via multipart (images, small docs)
        if (files.length > 0) {
            for (const file of files) {
                if (file.mimetype.startsWith('image/')) {
                    const uploadResult = await uploadToCloudinary(file.buffer, file.mimetype);
                    mediaEntries.push(`${uploadResult.url}|${uploadResult.public_id}`);
                } else {
                    const result = await uploadToB2(file.buffer, file.originalname, file.mimetype);
                    const dlBase = `${req.protocol}://${req.get('host')}/social/download/document`;
                    mediaEntries.push(`${dlBase}/${result.fileName}|${result.fileId}|${file.originalname}`);
                    b2FileId = result.fileId;
                    b2FileName = result.fileName;
                }
            }
        }

        // Auto-fetch thumbnail from Byse if video_file_id present but no thumbnail provided
        let finalThumbnail = video_thumbnail || null;
        if (video_file_id && !finalThumbnail) {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const fetched = await getThumbnail(video_file_id);
                    if (fetched) { finalThumbnail = fetched; break; }
                } catch (_) {}
                if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
            }
        }

        const postId = crypto.randomUUID();
        let mediaType = null;
        if (video_url) mediaType = 'video';
        else if (mediaEntries.length > 0) {
            const hasImage = files.length > 0 && files.some(f => f.mimetype.startsWith('image/'));
            mediaType = hasImage ? 'image' : 'document';
        }

        await db.execute({
            sql: `INSERT INTO social_posts (id, user_id, content, media_url, media_type, video_url, video_file_id, video_thumbnail, b2_file_id, b2_file_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                postId,
                req.userId,
                content || '',
                mediaEntries.length > 0 ? JSON.stringify(mediaEntries) : null,
                mediaType,
                video_url || null,
                video_file_id || null,
                finalThumbnail,
                b2FileId,
                b2FileName
            ]
        });

        res.json({ success: true, message: 'Post created.', postId });
    } catch (e) {
        console.error("Post Creation Error:", e);
        res.status(500).json({ error: 'Failed to create post.' });
    }
});

/**
 * GET /social/upload/video/auth
 * Returns Byse.sx upload server URL and API key for client-side upload.
 * The app uploads directly to Byse to bypass Vercel's 4.5MB body limit.
 */
router.get('/upload/video/auth', requireSocialAccess, async (req, res) => {
    try {
        const apiKey = await getApiKey();
        if (!apiKey) return res.status(500).json({ error: 'Byse not configured.' });

        const uploadServer = await getUploadServer();
        res.json({ uploadServer, apiKey });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /social/video/thumbnail
 * Returns the thumbnail URL for a Byse video filecode.
 */
router.get('/video/thumbnail', requireSocialAccess, async (req, res) => {
    try {
        const { filecode } = req.query;
        if (!filecode) return res.status(400).json({ error: 'Missing filecode parameter.' });
        const thumbnail = await getThumbnail(filecode);
        if (!thumbnail) return res.status(404).json({ error: 'Thumbnail not available.' });
        res.json({ thumbnail });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /social/upload/document/auth
 * Returns B2 upload URL + authorization token for client-side upload
 * (bypasses Vercel's 4.5MB body limit for large documents).
 */
router.get('/upload/document/auth', requireSocialAccess, async (req, res) => {
    try {
        const auth = await getB2UploadAuth();
        if (!auth) return res.status(500).json({ error: 'B2 not configured.' });
        res.json(auth);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /social/post/:id/repost
 * Creates a new post record marking it as a repost.
 */
router.post('/post/:id/repost', requireSocialAccess, async (req, res) => {
    try {
        const originalPostId = req.params.id;
        console.log(`[Social] Repost attempt for ID: ${originalPostId} by user: ${req.userId}`);
        
        // 1. Verify original exists
        const original = await db.execute({ 
            sql: `SELECT 1 FROM social_posts WHERE id = ?`, 
            args: [originalPostId] 
        });
        
        if (original.rows.length === 0) {
            console.log(`[Social] 404: original post ${originalPostId} not found.`);
            return res.status(404).json({ error: 'Original post not found.' });
        }

        // 2. Create the repost
        const repostId = crypto.randomUUID();
        await db.execute({
            sql: `INSERT INTO social_posts (id, user_id, original_post_id, is_repost) VALUES (?, ?, ?, 1)`,
            args: [repostId, req.userId, originalPostId]
        });

        res.json({ success: true, message: 'Post reposted.' });
    } catch (e) {
        console.error("Repost Error:", e);
        res.status(500).json({ error: 'Failed to repost.' });
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
 * GET /social/download/document/:fileName
 * Redirects to a B2 signed download URL.
 */
router.get('/download/document/*fileName', async (req, res) => {
    try {
        const fileName = Array.isArray(req.params.fileName) ? req.params.fileName.join('/') : (req.params.fileName || '');
        if (!fileName) return res.status(404).json({ error: 'File not specified.' });
        const url = await getB2DownloadUrl(fileName);
        if (!url) return res.status(404).json({ error: 'Download URL not available.' });
        res.redirect(url);
    } catch (e) {
        res.status(500).json({ error: 'Download failed: ' + e.message });
    }
});

module.exports = router;
