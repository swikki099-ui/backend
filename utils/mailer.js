const nodemailer = require('nodemailer');
const { supabase } = require('../db');

const gmailUser = process.env.GMAIL_USER;
const gmailPass = process.env.GMAIL_PASS;

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: gmailUser,
        pass: gmailPass
    }
});

/**
 * Replace placeholders in a string with student data
 */
function replacePlaceholders(template, student) {
    if (!template) return '';
    return template
        .replace(/{{name}}/g, student.name || 'Student')
        .replace(/{{roll_no}}/g, student.roll_no || 'N/A')
        .replace(/{{branch}}/g, student.branch || 'N/A')
        .replace(/{{semester}}/g, student.semester || 'N/A')
        .replace(/{{section}}/g, student.section || 'N/A');
}

/**
 * Send personalized email to a single student
 */
async function sendPersonalizedEmail(student, subject, body, options = {}) {
    const { attachments = [], isHtml = true } = options;
    if (!student.email) return { error: 'No email found' };

    const personalSubject = replacePlaceholders(subject, student);
    const personalBody = replacePlaceholders(body, student);

    if (!gmailUser || !gmailPass) {
        console.log(`[SIMULATION] Personal Email to ${student.email}: ${personalSubject}`);
        return { simulation: true, email: student.email };
    }

    const mailOptions = {
        from: `"Neuro DEV (Unofficial ITS App)" <${gmailUser}>`,
        to: student.email,
        subject: personalSubject,
        attachments: attachments.map(f => ({
            filename: f.originalname,
            path: f.path
        }))
    };

    if (isHtml) {
        mailOptions.html = personalBody;
    } else {
        mailOptions.text = personalBody;
    }

    return await transporter.sendMail(mailOptions);
}

/**
 * Send bulk email to students (Basic)
 */
async function sendBulkEmail(recipients, subject, htmlBody, attachments = []) {
    if (!gmailUser || !gmailPass) {
        console.warn('⚠️ SMTP NOT CONFIGURED: Running in Simulation Mode');
        return { simulation: true, count: recipients.length };
    }

    const mailOptions = {
        from: `"Neuro DEV (Unofficial ITS App)" <${gmailUser}>`,
        to: recipients.join(','),
        subject: subject,
        html: htmlBody,
        attachments: attachments.map(f => ({
            filename: f.originalname,
            path: f.path
        }))
    };

    return await transporter.sendMail(mailOptions);
}

/**
 * Check SMTP Connection Health
 */
async function checkSmtpConnection() {
    if (!gmailUser || !gmailPass) {
        return { status: 'unconfigured', message: 'Credentials missing in .env' };
    }
    try {
        await transporter.verify();
        return { status: 'connected', message: 'SMTP Hub OK' };
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}

/**
 * Automatically fetch the "Welcome Email" template and send to student
 */
async function sendWelcomeEmail(student) {
    try {
        const { data: template, error } = await supabase
            .from('admin_mail_templates')
            .select('*')
            .eq('name', 'Welcome Email')
            .maybeSingle();

        if (error) throw error;
        if (!template) {
            console.warn('⚠️ Welcome Email template not found in database.');
            return;
        }

        console.log(`📧 Sending automated Welcome Email to: ${student.email}`);
        return await sendPersonalizedEmail(student, template.subject, template.body);
    } catch (err) {
        console.error('❌ Failed to send Welcome Email:', err.message);
    }
}

module.exports = {
    sendBulkEmail,
    sendPersonalizedEmail,
    sendWelcomeEmail,
    checkSmtpConnection
};
