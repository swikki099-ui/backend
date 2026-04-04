const { db } = require('../db');

/**
 * Generate a Base64 encoded JSON payload for the QR code.
 */
function generateQR(collegeId) {
    const payload = {
        id: collegeId,
        ts: Date.now()
    };
    
    // Encode to Base64
    const jsonString = JSON.stringify(payload);
    return Buffer.from(jsonString).toString('base64');
}

/**
 * Decode and verify a QR payload, returning the student's safe profile data.
 */
async function verifyScan(qrData) {
    let payload;
    
    // 1. Decode Base64 safely
    try {
        const decodedString = Buffer.from(qrData, 'base64').toString('utf-8');
        payload = JSON.parse(decodedString);
    } catch (error) {
        throw new Error('Invalid QR Data: could not decode payload');
    }

    // 2. Validate essential fields
    if (!payload.id) {
        throw new Error('Invalid QR Data: missing identifier');
    }

    // 3. Fetch user from Turso using college_id
    try {
        const result = await db.execute({
            sql: `SELECT name, roll_no, course, branch, semester, phone, email, profile_image 
                  FROM users WHERE college_id = ?`,
            args: [payload.id]
        });

        const user = result.rows[0];
        if (!user) {
            throw new Error('Verification failed: Student not found in database');
        }

        // Return the safe profile data
        return {
            status: "verified",
            verifiedAt: new Date().toISOString(),
            profile: user
        };
    } catch (error) {
        // Log sensitive database errors but throw clean UI-friendly errors
        console.error('❌ ID Scan Database Error:', error.message);
        throw error;
    }
}

module.exports = { generateQR, verifyScan };
