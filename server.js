require('dotenv').config();
require('./utils/logger'); // Start capturing terminal logs immediately
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

// Import modular routes
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const appRoutes = require('./routes/app');
const idRoutes = require('./routes/id');
const profileRoutes = require('./routes/profile');
const adminRoutes = require('./routes/admin');
const { logActivity } = require('./utils/activityLogger');

const app = express();
const PORT = process.env.PORT || 3000;

// View Engine Setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Trust Vercel's HTTPS proxy for correct req.protocol and cookies
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // to parse form bodies
app.use(cookieParser());

// Global Middleware to catch misplaced Supabase OAuth codes (Whitelist fallback)
app.use((req, res, next) => {
    if (req.query.code && (req.path === '/' || req.path === '/admin')) {
        console.log(`[Smart Redirect] Catching OAuth code at ${req.path}, forwarding to admin callback.`);
        return res.redirect(`/admin/auth/callback?code=${req.query.code}`);
    }
    next();
});

// Active Request Logger (shows up in your Admin Server Logs)
app.use((req, res, next) => {
    if (!req.url.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg)$/)) {
        console.log(`[HTTP] ${req.method} ${req.url}`);
    }
    next();
});

// Routes
// Anything interacting directly with tokens or authorization logic bypasses /api
app.use('/auth', authRoutes);

// General data endpoints protected by custom generic session headers
app.use('/api', apiRoutes);

// App update endpoint for version checking
app.use('/app', appRoutes);

// Digital Student ID QR system
app.use('/id', idRoutes);

// Profile completion system
app.use('/profile', profileRoutes);

// Admin Dashboard UI (Server-Side Rendered)
app.use('/admin', adminRoutes);


// Root Endpoint for deployment verification
app.get('/', (req, res) => {
    res.json({
        status: "success",
        message: "ITS College Backend API is successfully running on Vercel 🚀",
        endpoints: ["/auth/login", "/auth/logout", "/api/profile", "/api/attendance/overall", "/api/timetable"]
    });
});

// Global unhandled error handler
app.use((err, req, res, next) => {
    console.error('[System Fault Error]', err);
    res.status(500).json({ error: 'Internal Server Architecture Error', message: err.message });
});

// Process-level crash catchers (prints to terminal before dying)
process.on('uncaughtException', (err) => {
    console.error('\n🚨 FATAL CRASH: Uncaught Exception 🚨\n', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('\n🚨 FATAL CRASH: Unhandled Promise Rejection 🚨\n', reason);
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`✅ Production-Ready Refactored Backend Server running on http://localhost:${PORT}`);
        
        // Log startup to activity feed
        logActivity('system', 'System Online', 'Backend server started successfully.', {
            icon: 'zap',
            color: 'green'
        }).catch(() => {});
    });
}

module.exports = app;
