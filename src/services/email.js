const sgMail = require("@sendgrid/mail");
const { env } = require("../config/env");

function ensureEmailConfigured() {
  if (!env.sendgridApiKey) {
    throw new Error("GRID_API_KEY is missing");
  }
  sgMail.setApiKey(env.sendgridApiKey);
}

async function sendPasswordResetEmail({ toEmail, otpCode }) {
  ensureEmailConfigured();

  const msg = {
    to: toEmail,
    from: env.emailFrom,
    subject: "Your password reset code",
    text: `Your password reset code is ${otpCode}. This code expires in 10 minutes.`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
        <h2>Password reset code</h2>
        <p>Use this code to reset your password:</p>
        <p style="font-size:30px;font-weight:700;letter-spacing:4px">${otpCode}</p>
        <p>This code expires in 10 minutes.</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `,
  };

  await sgMail.send(msg);
}

module.exports = { sendPasswordResetEmail };
