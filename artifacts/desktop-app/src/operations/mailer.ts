import tls from "node:tls";

const GMAIL_HOST = "smtp.gmail.com";
const GMAIL_PORT = 465;
const DEFAULT_SENDER = "email.gaia.verf@gmail.com";

function smtpLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function messageBody(to: string, code: string): string {
  return [
    `From: Inventory Scanner <${DEFAULT_SENDER}>`,
    `To: ${smtpLine(to)}`,
    "Subject: Inventory Scanner credential recovery code",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Your Inventory Scanner recovery code is: ${code}`,
    "",
    "This code expires in 15 minutes. If you did not request it, no action is required.",
  ].join("\r\n");
}

export function recoveryEmailConfigured(): boolean {
  return Boolean(process.env.INVENTORY_GMAIL_APP_PASSWORD?.trim());
}

export async function sendRecoveryCode(to: string, code: string): Promise<void> {
  const appPassword = process.env.INVENTORY_GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  if (!appPassword) {
    throw new Error(
      "Credential recovery email is not configured. Set INVENTORY_GMAIL_APP_PASSWORD on the Production computer using a Gmail app password.",
    );
  }

  await new Promise<void>((resolve, reject) => {
    const socket = tls.connect({
      host: GMAIL_HOST,
      port: GMAIL_PORT,
      servername: GMAIL_HOST,
      rejectUnauthorized: true,
    });
    socket.setEncoding("utf8");
    socket.setTimeout(15_000);

    let buffer = "";
    const pending: Array<{
      expected: number;
      command?: string;
      resolve: () => void;
      reject: (error: Error) => void;
    }> = [];

    const fail = (error: Error) => {
      while (pending.length) pending.shift()?.reject(error);
      socket.destroy();
      reject(error);
    };

    const command = (expected: number, value?: string) => new Promise<void>((done, failed) => {
      pending.push({ expected, command: value, resolve: done, reject: failed });
      if (value) socket.write(`${value}\r\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const match = /(?:^|\r\n)(\d{3})([ -])([^\r\n]*)\r\n/.exec(buffer);
        if (!match) break;
        const end = (match.index ?? 0) + match[0].length;
        buffer = buffer.slice(end);
        if (match[2] === "-") continue;
        const waiter = pending.shift();
        if (!waiter) continue;
        const status = Number(match[1]);
        if (status !== waiter.expected) {
          waiter.reject(new Error(`Gmail SMTP returned ${status}: ${match[3]}`));
        } else {
          waiter.resolve();
        }
      }
    });
    socket.on("timeout", () => fail(new Error("Gmail SMTP timed out while sending the recovery email.")));
    socket.on("error", (error) => fail(error));

    void (async () => {
      try {
        await command(220);
        await command(250, "EHLO inventory-scanner");
        await command(334, "AUTH LOGIN");
        await command(334, Buffer.from(DEFAULT_SENDER).toString("base64"));
        await command(235, Buffer.from(appPassword).toString("base64"));
        await command(250, `MAIL FROM:<${DEFAULT_SENDER}>`);
        await command(250, `RCPT TO:<${smtpLine(to)}>`);
        await command(354, "DATA");
        await command(250, `${messageBody(to, code)}\r\n.`);
        await command(221, "QUIT");
        socket.end();
        resolve();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}
