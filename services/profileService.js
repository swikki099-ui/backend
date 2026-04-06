const { db } = require('../db');
const { uploadFile } = require('./storageService');
const { readBarcode } = require('../utils/barcodeReader');

/**
 * Complete the profile process.
 * 1. Upload profile image.
 * 2. Upload ID card image.
 * 3. Extract barcode from ID card.
 * 4. Update the user record.
 */
async function completeProfile(userId, profileImage, idCardImage, confirmedBarcode = null) {
    if (!profileImage || !idCardImage) {
        throw new Error('Profile and ID card images are required.');
    }

    console.log(`👤 Processing profile completion for User: ${userId}`);

    // 1. Upload Profile Image
    const profileImageUrl = await uploadFile(profileImage.buffer, profileImage.originalname, 'profiles');
    
    // 2. Upload ID Card Image (Not saved to DB but kept in storage)
    const idCardUrl = await uploadFile(idCardImage.buffer, idCardImage.originalname, 'id-cards');

    // 3. Extract Barcode (Skip if already confirmed by app)
    const barcode = confirmedBarcode || await readBarcode(idCardImage.buffer);

    if (!barcode) {
        return {
            success: false,
            message: "Barcode not detected. Please try again or use manual scan.",
            profileImageUrl,
            idCardUrl
        };
    }

    // 4. Ensure barcode uniqueness
    const existing = await db.execute({
        sql: 'SELECT id FROM users WHERE barcode_id = ? AND id != ?',
        args: [barcode, userId]
    });

    if (existing.rows.length > 0) {
        throw new Error('This barcode is already registered to another user.');
    }

    // 5. Update user
    await db.execute({
        sql: `UPDATE users SET 
            profile_image = ?, 
            barcode_id = ?, 
            profile_complete = 1, 
            updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?`,
        args: [profileImageUrl, barcode, userId]
    });

    return {
        success: true,
        message: "Profile completed successfully.",
        barcode: barcode,
        profileImageUrl: profileImageUrl
    };
}

/**
 * Handle manual barcode binding.
 */
async function bindBarcode(userId, barcode) {
    if (!barcode) {
        throw new Error('Barcode is required.');
    }

    // Check uniqueness
    const existing = await db.execute({
        sql: 'SELECT id FROM users WHERE barcode_id = ? AND id != ?',
        args: [barcode, userId]
    });

    if (existing.rows.length > 0) {
        throw new Error('This barcode is already registered to another user.');
    }

    // Update user
    await db.execute({
        sql: `UPDATE users SET 
            barcode_id = ?, 
            profile_complete = 1, 
            updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?`,
        args: [barcode, userId]
    });

    return {
        success: true,
        message: "Barcode bound successfully. Profile complete."
    };
}

module.exports = { completeProfile, bindBarcode };
