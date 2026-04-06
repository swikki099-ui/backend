const { db } = require('../db');

/**
 * getQR: Generate a Base64 encoded JSON payload for the QR code.
 */
function getQR(collegeId) {
    const payload = {
        id: collegeId,
        ts: Date.now()
    };
    
    // Encode to Base64
    const jsonString = JSON.stringify(payload);
    return Buffer.from(jsonString).toString('base64');
}

/**
 * scanQR: Decode and verify a QR payload or raw physical barcode.
 * Returns the student's safe profile data if found.
 */
async function scanQR(qrData) {
    let payload;
    let isDigitalQR = false;
    
    // 1. Detect format (Digital QR vs Physical Barcode)
    try {
        // Digital QRs are Base64 encoded JSON
        const decodedString = Buffer.from(qrData, 'base64').toString('utf-8');
        payload = JSON.parse(decodedString);
        if (payload && payload.id) {
            isDigitalQR = true;
        }
    } catch (error) {
        // Not a valid Digital QR, treat as raw Physical Barcode
        console.log(`📡 Scan detected as raw physical barcode: ${qrData}`);
    }

    // 2. Fetch user based on detected format
    try {
        const query = isDigitalQR 
            ? `SELECT name, roll_no, course, branch, semester, phone, email, profile_image 
               FROM users WHERE college_id = ?`
            : `SELECT name, roll_no, course, branch, semester, phone, email, profile_image 
               FROM users WHERE barcd_id = ?`;
        
        const searchValue = isDigitalQR ? payload.id : qrData;

        const result = await db.execute({
            sql: query,
            args: [searchValue]
        });

        const user = result.rows[0];
        if (!user) {
            const errorMsg = isDigitalQR 
                ? 'Verification failed: Student not found for this Digital ID'
                : 'Verification failed: Physical barcode not recognized';
            throw new Error(errorMsg);
        }

        // Return the safe profile data
        return {
            status: "verified",
            verifiedAt: new Date().toISOString(),
            profile: user
        };
    } catch (error) {
        console.error('❌ ID Scan Database Error:', error.message);
        throw error;
    }
}

module.exports = { getQR, scanQR };

