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

  const fromName = "Secret Work";

  const msg = {
    to: toEmail,
    from: { email: env.emailFrom, name: fromName },
    replyTo: { email: env.emailFrom, name: fromName },
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

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:24px;padding-bottom:16px;">
              <p style="margin:0;color:#A1A1AA;font-size:12px;line-height:1.6;font-family:Arial,sans-serif;">
                This is a transactional email sent by Secret Work.
              </p>
              <p style="margin:4px 0 0 0;color:#D4D4D8;font-size:11px;font-family:Arial,sans-serif;">
                Secret Work | secret-work-backend.onrender.com | ${env.emailFrom}
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
    console.log("SendGrid email sent. Status:", response.statusCode);
  } catch (err) {
    const sgError = err?.response?.body?.errors?.[0]?.message || err.message || err;
    console.error("SendGrid error:", sgError);
    throw new Error(`Email send failed: ${sgError}`);
  }
}

module.exports = { sendPasswordResetEmail };
