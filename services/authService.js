const { loginUser, getUserProfile } = require('./apiService');
const { sendWelcomeEmail } = require('../utils/mailer');
const { logActivity } = require('../utils/activityLogger');

/**
 * Perform login with College API and sync user profile data to Turso.
 */
async function loginAndSync(email, password) {
    // 1. Authenticate with College API
    const token = await loginUser(email, password);

    // 2. Fetch latest profile data
    const profile = await getUserProfile(token);

    // 3. Extract required fields as per requirements
    const userData = {
        college_id: profile._id || profile.id,
        name: profile.fullName,
        roll_no: profile.rollNo,
        course: profile.course?.courseFullName || '',
        branch: profile.branch?.branchFullName || '',
        semester: profile.currentSemester || 0,
        section: profile.currentSection || '',
        email: profile.email || email, // Use provided email if profile doesn't have it
        phone: profile.mobile || profile.phoneNumber || '',
        profile_image: profile.picture || ''
    };

    console.log(`🔍 Extracted User Data for Syncing: ${userData.name} (${userData.college_id})`);

    // 4. Sync with Turso DB (UPSERT)
    try {
        console.log(`📡 Connecting to Turso to sync data...`);
        const existingUser = await db.execute({
            sql: 'SELECT id FROM users WHERE college_id = ?',
            args: [userData.college_id]
        });

        if (existingUser.rows.length === 0) {
            console.log(`🆕 Creating NEW user: ${userData.name}`);
            await db.execute({
                sql: `INSERT INTO users (
                    college_id, name, roll_no, course, branch, semester, section, email, phone, profile_image
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    userData.college_id, userData.name, userData.roll_no, userData.course,
                    userData.branch, userData.semester, userData.section, userData.email,
                    userData.phone, userData.profile_image
                ]
            });

            // Log new registration activity
            logActivity('sync', 'New Student Registered', `${userData.name} (${userData.roll_no}) joined the platform!`, {
                icon: 'user-plus',
                color: 'green',
                metadata: { college_id: userData.college_id }
            }).catch(() => { });

            // Trigger Welcome Email (Async - don't block login)
            sendWelcomeEmail(userData).catch(e => console.error('Welcome Mail Error:', e));
        } else {
            console.log(`🔄 UPDATING existing user: ${userData.name}`);
            await db.execute({
                sql: `UPDATE users SET 
                    name = ?, roll_no = ?, course = ?, branch = ?, semester = ?, 
                    section = ?, email = ?, phone = ?, 
                    profile_image = COALESCE(NULLIF(?, ''), profile_image), 
                    updated_at = CURRENT_TIMESTAMP
                    WHERE college_id = ?`,
                args: [
                    userData.name, userData.roll_no, userData.course, userData.branch,
                    userData.semester, userData.section, userData.email, userData.phone,
                    userData.profile_image, userData.college_id
                ]
            });

            // Log update activity
            logActivity('sync', 'Profile Updated', `${userData.name} synchronized their data.`, {
                icon: 'refresh',
                color: 'indigo',
                metadata: { college_id: userData.college_id }
            }).catch(() => { });
        }

        const finalUser = await db.execute({
            sql: 'SELECT * FROM users WHERE college_id = ?',
            args: [userData.college_id]
        });

        console.log(`✅ User sync completed successfully for ${userData.name}`);

        return {
            user: finalUser.rows[0],
            token: token
        };
    } catch (error) {
        console.error('❌ Error syncing user to Turso:', error);
        throw new Error('Failed to synchronize user data with local database.');
    }
}


/**
 * Retrieve a user from the database by their internal ID.
 */
async function getUserById(id) {
    const result = await db.execute({
        sql: 'SELECT * FROM users WHERE id = ?',
        args: [id]
    });
    return result.rows[0];
}

/**
 * getUserByCollegeId: Search for a student by their Roll Number or College ID.
 */
async function getUserByCollegeId(collegeId) {
    const result = await db.execute({
        sql: 'SELECT * FROM users WHERE roll_no = ? OR college_id = ?',
        args: [collegeId, collegeId]
    });
    return result.rows[0];
}

module.exports = { loginAndSync, getUserById, getUserByCollegeId };
