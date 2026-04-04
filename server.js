require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Import modular routes
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const appRoutes = require('./routes/app');
const idRoutes = require('./routes/id');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
// Anything interacting directly with tokens or authorization logic bypasses /api
app.use('/auth', authRoutes);

// General data endpoints protected by custom generic session headers
app.use('/api', apiRoutes);

// App update endpoint for version checking
app.use('/app', appRoutes);

// Digital Student ID QR system
app.use('/id', idRoutes);


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

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`✅ Production-Ready Refactored Backend Server running on http://localhost:${PORT}`);
    });
}

module.exports = app;
