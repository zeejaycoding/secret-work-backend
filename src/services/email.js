const sgMail = require("@sendgrid/mail");
const { env } = require("../config/env");

function ensureEmailConfigured() {
  if (!env.sendgridApiKey) {
    throw new Error("SENDGRID_API_KEY is missing");
  }

  const fromEmail = String(env.emailFrom || "").trim();
  if (fromEmail && /@gmail\.com|@yahoo\.com|@outlook\.com|@hotmail\.com/i.test(fromEmail)) {
    console.warn(
      "Warning: using a free email provider as the SendGrid sender can reduce inbox placement. Set EMAIL_FROM to a verified custom-domain address like noreply@yourdomain.com."
    );
  }

  sgMail.setApiKey(env.sendgridApiKey);
}

async function sendPasswordResetEmail({ toEmail, otpCode }) {
  ensureEmailConfigured();

  const fromName = env.emailFromName || "Secret Work";
  const fromEmail = String(
    env.transactionalEmailFrom || env.emailFrom || "noreply@secretwork.app"
  ).trim();

  const msg = {
    to: toEmail,
    from: { email: fromEmail, name: fromName },
    replyTo: { email: replyEmail, name: fromName },
    subject: "Reset your Secret Work password",
    text: [
      `Hi,`,
      ``,
      `You received this email because someone requested a password reset for your Secret Work account.`,
      ``,
      `Your verification code is: ${otpCode}`,
      ``,
      `This code expires in 10 minutes.`,
      `If you did not request this, you can safely ignore this email. Your password will not be changed.`,
      ``,
      `Secret Work Support`,
      `https://secret-work-backend.onrender.com`,
    ].join("\n"),
    html: `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Secret Work - Password Reset</title>
</head>
<body style="margin:0;padding:0;background-color:#F4F4F5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F4F5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">

          <!-- Header with brand -->
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:48px;height:48px;border-radius:24px;background-color:#E50914;text-align:center;vertical-align:middle;">
                    <span style="color:#fff;font-size:20px;font-weight:700;line-height:48px;display:inline-block;font-family:Arial,sans-serif;">SW</span>
                  </td>
                  <td style="padding-left:12px;">
                    <span style="color:#1A1A1A;font-size:20px;font-weight:700;font-family:Arial,sans-serif;">Secret Work</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- White card -->
          <tr>
            <td style="background-color:#FFFFFF;border-radius:12px;padding:40px 36px;border:1px solid #E5E5E5;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">

              <tr>
                <td style="padding-bottom:16px;">
                  <h1 style="margin:0;color:#1A1A1A;font-size:22px;font-weight:700;font-family:Arial,sans-serif;">Password Reset</h1>
                </td>
              </tr>

              <tr>
                <td style="padding-bottom:28px;">
                  <p style="margin:0;color:#525252;font-size:15px;line-height:1.6;font-family:Arial,sans-serif;">
                    You received this email because someone requested a password reset for your <strong>Secret Work</strong> account. Use the code below to set a new password.
                  </p>
                </td>
              </tr>

              <!-- OTP Box -->
              <tr>
                <td style="padding-bottom:24px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="background-color:#FEF2F2;border:2px solid #E50914;border-radius:10px;padding:20px 0;text-align:center;">
                        <p style="margin:0 0 6px 0;color:#71717A;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;font-family:Arial,sans-serif;">Your verification code</p>
                        <p style="margin:0;color:#E50914;font-size:36px;font-weight:700;letter-spacing:8px;font-family:'Courier New',Courier,monospace;">${otpCode}</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Expiry -->
              <tr>
                <td style="padding-bottom:24px;">
                  <p style="margin:0;color:#A1A1AA;font-size:13px;text-align:center;font-family:Arial,sans-serif;">
                    This code expires in <strong style="color:#525252;">10 minutes</strong>.
                  </p>
                </td>
              </tr>

              <!-- Divider -->
              <tr>
                <td style="padding-bottom:20px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="border-top:1px solid #E5E5E5;font-size:0;line-height:0;">&nbsp;</td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Security -->
              <tr>
                <td>
                  <p style="margin:0;color:#71717A;font-size:13px;line-height:1.6;font-family:Arial,sans-serif;">
                    If you did not request a password reset, you can safely ignore this email. Your password will not change.
                  </p>
                </td>
              </tr>

              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:24px;padding-bottom:16px;">
              <p style="margin:0;color:#A1A1AA;font-size:12px;line-height:1.6;font-family:Arial,sans-serif;">
                This is a transactional email sent by Secret Work.
              </p>
              <p style="margin:4px 0 0 0;color:#D4D4D8;font-size:11px;font-family:Arial,sans-serif;">
                Secret Work | secret-work-backend.onrender.com | ${fromEmail}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    categories: ["password-reset"],
    headers: {
      "X-Mailer": "SecretWork",
    },
  };

  try {
    const [response] = await sgMail.send(msg);
    console.log("SendGrid email sent. Status:", response.statusCode);
  } catch (err) {
    const sgError = err?.response?.body?.errors?.[0]?.message || err.message || err;
    console.error("SendGrid error:", sgError);
    throw new Error(`Email send failed: ${sgError}`);
  }
}

async function sendNotificationEmail({ toEmail, title, message }) {
  ensureEmailConfigured();

  const fromName = env.emailFromName || "Secret Work";
  const fromEmail = String(env.emailFrom || "noreply@secretwork.app").trim();
  const replyEmail = String(env.replyToEmail || env.emailFrom || fromEmail).trim();

  const msg = {
    to: toEmail,
    from: { email: fromEmail, name: fromName },
    replyTo: { email: replyEmail, name: fromName },
    subject: title,
    text: message,
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background-color:#F4F4F5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F4F5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:48px;height:48px;border-radius:24px;background-color:#E50914;text-align:center;vertical-align:middle;">
                    <span style="color:#fff;font-size:20px;font-weight:700;line-height:48px;display:inline-block;font-family:Arial,sans-serif;">SW</span>
                  </td>
                  <td style="padding-left:12px;">
                    <span style="color:#1A1A1A;font-size:20px;font-weight:700;font-family:Arial,sans-serif;">Secret Work</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:#FFFFFF;border-radius:12px;padding:36px 32px;border:1px solid #E5E5E5;">
              <h1 style="margin:0 0 12px 0;color:#1A1A1A;font-size:20px;font-weight:700;font-family:Arial,sans-serif;">${title}</h1>
              <p style="margin:0;color:#525252;font-size:15px;line-height:1.6;font-family:Arial,sans-serif;white-space:pre-line;">${message}</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;padding-bottom:16px;">
              <p style="margin:0;color:#A1A1AA;font-size:12px;line-height:1.6;font-family:Arial,sans-serif;">
                This is a notification sent by Secret Work.
              </p>
              <p style="margin:4px 0 0 0;color:#D4D4D8;font-size:11px;font-family:Arial,sans-serif;">
                Secret Work | secret-work-backend.onrender.com
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    headers: {
      "List-Unsubscribe": `<mailto:${env.emailFrom}?subject=unsubscribe>`,
      "X-Mailer": "SecretWork",
    },
  };

  try {
    const [response] = await sgMail.send(msg);
    console.log("SendGrid notification sent to:", toEmail, "Status:", response.statusCode);
  } catch (err) {
    const sgError = err?.response?.body?.errors?.[0]?.message || err.message || err;
    console.error("SendGrid notification error:", sgError);
    throw new Error(`Email send failed: ${sgError}`);
  }
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendChatReplyEmail({ toEmail, userName, userQuery, reply }) {
  ensureEmailConfigured();

  const firstName = String(userName || "there").trim().split(/\s+/)[0] || "there";
  const safeQuery = escapeHtml(userQuery);
  const safeReply = escapeHtml(reply);
  const fromName = env.emailFromName || "Secret Work";
  const fromEmail = String(env.emailFrom || "noreply@secretwork.app").trim();
  const replyEmail = String(env.replyToEmail || env.emailFrom || fromEmail).trim();

  const msg = {
    to: toEmail,
    from: { email: fromEmail, name: fromName },
    replyTo: { email: replyEmail, name: fromName },
    subject: "We replied to your support message",
    text: [
      `Hi ${firstName},`,
      ``,
      `Thanks for reaching out to Secret Work support. Here is our reply:`,
      ``,
      `You asked:`,
      userQuery,
      ``,
      `Our reply:`,
      reply,
      ``,
      `If you need anything else, just open Live Chat in the app and we'll be happy to help.`,
      ``,
      `Secret Work Support`,
      `https://secret-work-backend.onrender.com`,
    ].join("\n"),
    html: `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>Secret Work - Support Reply</title>
</head>
<body style="margin:0;padding:0;background-color:#F4F4F5;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F4F5;">

    <!-- Hidden preheader -->
    <tr>
      <td style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">
        Hi ${firstName}, we've replied to your support message.
      </td>
    </tr>

    <!-- Red gradient hero -->
    <tr>
      <td style="background-image:linear-gradient(135deg,#E50914 0%,#B0060F 60%,#8A040B 100%);background-color:#E50914;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding:48px 16px 56px 16px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:60px;height:60px;border-radius:30px;background-color:#FFFFFF;text-align:center;vertical-align:middle;box-shadow:0 8px 24px rgba(0,0,0,0.25);">
                    <span style="color:#E50914;font-size:26px;font-weight:800;line-height:60px;display:inline-block;font-family:Verdana,Arial,sans-serif;">SW</span>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0 0;color:#FFFFFF;font-size:22px;font-weight:800;letter-spacing:0.5px;font-family:Verdana,Arial,sans-serif;">Secret Work</p>
              <p style="margin:6px 0 0 0;color:#FFD5D8;font-size:13px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;font-family:Arial,sans-serif;">Support Team</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Body -->
    <tr>
      <td align="center" style="padding:0 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- White card (pulled up over the hero) -->
          <tr>
            <td style="background-color:#FFFFFF;border-radius:14px;padding:40px 40px 32px 40px;margin-top:-28px;box-shadow:0 12px 40px rgba(0,0,0,0.08);">

              <!-- Greeting -->
              <tr>
                <td style="padding-bottom:22px;">
                  <h1 style="margin:0;color:#1A1A1A;font-size:23px;font-weight:800;font-family:Verdana,Arial,sans-serif;">Hi ${firstName}, 👋</h1>
                  <p style="margin:10px 0 0 0;color:#525252;font-size:15px;line-height:1.65;font-family:Arial,sans-serif;">
                    Thanks for reaching out to <strong style="color:#1A1A1A;">Secret Work</strong>.
                    We've reviewed your message and here's our answer.
                  </p>
                </td>
              </tr>

              <!-- Your question -->
              <tr>
                <td style="padding-bottom:26px;">
                  <p style="margin:0 0 9px 0;color:#8A8A90;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;font-family:Arial,sans-serif;">You asked</p>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="background-color:#F8F8FA;border:1px solid #ECECEF;border-left:4px solid #E50914;border-radius:10px;padding:16px 18px;">
                        <p style="margin:0;color:#4B4B55;font-size:14px;line-height:1.6;font-family:Arial,sans-serif;">${safeQuery}</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Our reply -->
              <tr>
                <td style="padding-bottom:30px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="background-color:#FFF5F6;border:1px solid #FDE3E4;border-radius:12px;padding:20px;">
                        <table role="presentation" cellpadding="0" cellspacing="0">
                          <tr>
                            <td style="width:36px;height:36px;border-radius:18px;background-color:#E50914;text-align:center;vertical-align:middle;">
                              <span style="color:#fff;font-size:14px;font-weight:700;line-height:36px;display:inline-block;font-family:Verdana,Arial,sans-serif;">SW</span>
                            </td>
                            <td style="padding-left:12px;vertical-align:middle;">
                              <p style="margin:0;color:#1A1A1A;font-size:14px;font-weight:800;font-family:Verdana,Arial,sans-serif;">Secret Work Support</p>
                              <p style="margin:2px 0 0 0;color:#A1A1AA;font-size:11px;font-family:Arial,sans-serif;">Reply to your message</p>
                            </td>
                          </tr>
                        </table>
                        <p style="margin:14px 0 0 0;color:#26262C;font-size:15px;line-height:1.7;font-family:Arial,sans-serif;">${safeReply}</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- CTA -->
              <tr>
                <td align="center" style="padding-bottom:26px;">
                  <a href="https://secret-work-backend.onrender.com" style="display:inline-block;background-color:#E50914;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:700;font-family:Verdana,Arial,sans-serif;padding:15px 34px;border-radius:9px;box-shadow:0 6px 18px rgba(229,9,20,0.30);">Open the App</a>
                </td>
              </tr>

              <!-- Divider -->
              <tr>
                <td style="padding-bottom:22px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="border-top:1px solid #ECECEF;font-size:0;line-height:0;">&nbsp;</td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Follow up note -->
              <tr>
                <td>
                  <p style="margin:0;color:#6B6B73;font-size:13px;line-height:1.65;font-family:Arial,sans-serif;">
                    Still have questions? Open <strong style="color:#3B3B43;">Live Chat</strong> in the app anytime
                    — our team is always here to help. You can also reply directly to this email.
                  </p>
                </td>
              </tr>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding:26px 16px 34px 16px;">
              <p style="margin:0;color:#A1A1AA;font-size:12px;line-height:1.6;font-family:Arial,sans-serif;">
                You received this email because you sent a message through the Secret Work app.
              </p>
              <p style="margin:8px 0 0 0;color:#B9B9C2;font-size:12px;font-family:Arial,sans-serif;">
                <a href="mailto:${replyEmail}" style="color:#B9B9C2;text-decoration:none;">${replyEmail}</a>
                &nbsp;·&nbsp; secret-work-backend.onrender.com
              </p>
              <p style="margin:6px 0 0 0;color:#D4D4D8;font-size:11px;font-family:Arial,sans-serif;">
                Secret Work &copy; ${new Date().getFullYear()}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    headers: {
      "List-Unsubscribe": `<mailto:${replyEmail}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "X-Mailer": "SecretWork",
      "List-ID": "Secret Work <secretwork>",
    },
  };

  try {
    const [response] = await sgMail.send(msg);
    console.log("SendGrid chat reply sent to:", toEmail, "Status:", response.statusCode);
  } catch (err) {
    const sgError = err?.response?.body?.errors?.[0]?.message || err.message || err;
    console.error("SendGrid chat reply error:", sgError);
    throw new Error(`Email send failed: ${sgError}`);
  }
}

module.exports = { sendPasswordResetEmail, sendNotificationEmail, sendChatReplyEmail };
