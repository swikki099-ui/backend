const cloudinary = require('cloudinary').v2;

// Auto-configures using CLOUDINARY_URL environment variable if present.
// Otherwise, make sure the user added it to .env
if (process.env.CLOUDINARY_URL) {
    cloudinary.config(); 
}

/**
 * Uploads a file buffer to Cloudinary
 * @param {Buffer} buffer - The file buffer
 * @param {string} mimeType - The mimetype of the file (e.g., 'image/png')
 * @returns {Promise<Object>} - The Cloudinary upload result
 */
const uploadToCloudinary = (buffer, mimeType) => {
    return new Promise((resolve, reject) => {
        let resourceType = 'auto'; // Images/video
        if (mimeType === 'application/pdf' || mimeType.includes('document')) {
            resourceType = 'raw'; // Must use raw for PDFs on free tier usually
        }

        const uploadStream = cloudinary.uploader.upload_stream(
            { 
                folder: 'its_social_feed',
                resource_type: resourceType
            },
            (error, result) => {
                if (error) {
                    console.error("Cloudinary Upload Error:", error);
                    return reject(error);
                }
                resolve({
                    url: result.secure_url,
                    public_id: result.public_id,
                    type: resourceType === 'raw' ? 'document' : 'image'
                });
            }
        );

        uploadStream.end(buffer);
    });
};

const deleteFromCloudinary = async (publicId, resourceType = 'image') => {
    try {
        if (!publicId) return;
        await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    } catch (e) {
        console.error("Failed to delete from Cloudinary:", e);
    }
};

module.exports = {
    uploadToCloudinary,
    deleteFromCloudinary
};
