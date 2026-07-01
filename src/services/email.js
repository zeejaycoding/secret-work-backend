const https = require("https");
const { env } = require("../config/env");

function postJson(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (response) => {
        let responseBody = "";

        response.on("data", (chunk) => {
          responseBody += chunk;
        });

        response.on("end", () => {
          const status = response.statusCode || 500;

          if (status >= 200 && status < 300) {
            resolve(responseBody);
            return;
          }

          reject(new Error(`Email API failed (${status}): ${responseBody}`));
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function sendPasswordResetEmail({ toEmail, otpCode }) {
  if (!env.resendApiKey || !env.resendFromEmail) {
    console.warn("RESEND_API_KEY or RESEND_FROM_EMAIL missing. OTP email not sent.");
    console.info(`Password reset OTP for ${toEmail}: ${otpCode}`);
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2>Password reset code</h2>
      <p>Use the verification code below to reset your password.</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:4px">${otpCode}</p>
      <p>This code expires in 10 minutes.</p>
      <p>If you did not request this, you can safely ignore this email.</p>
    </div>
  `;

  const text = [
    "Password reset code",
    "",
    `Your code: ${otpCode}`,
    "This code expires in 10 minutes.",
    "If you did not request this, you can ignore this email.",
  ].join("\n");

  await postJson(
    "https://api.resend.com/emails",
    {
      from: env.resendFromEmail,
      to: [toEmail],
      subject: "Your password reset code",
      html,
      text,
    },
    {
      Authorization: `Bearer ${env.resendApiKey}`,
    }
  );
}

module.exports = { sendPasswordResetEmail };
