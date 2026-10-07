import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Escape karakter HTML agar judul/isi alarm aman dipakai dengan
 * `parse_mode: 'HTML'` milik Telegram Bot API.
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private configErrorLogged = false;

  constructor(private readonly prisma: PrismaService) {}

  private getConfig(): { botToken: string; chatId: string } {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_NOC_CHAT_ID;
    const missing: string[] = [];
    if (!botToken) missing.push('TELEGRAM_BOT_TOKEN');
    if (!chatId) missing.push('TELEGRAM_NOC_CHAT_ID');
    if (missing.length > 0) {
      if (!this.configErrorLogged) {
        this.logger.error(
          `Konfigurasi Telegram belum lengkap. Env yang hilang: ${missing.join(', ')}`,
        );
        this.configErrorLogged = true;
      }
      throw new Error(
        `Konfigurasi Telegram belum lengkap, env yang hilang: ${missing.join(', ')}`,
      );
    }
    // Dilempar di atas bila ada yang hilang — aman untuk non-null assertion.
    return { botToken: botToken as string, chatId: chatId as string };
  }

  private async persistLog(args: {
    chatId: string;
    textLength: number;
    status: 'SENT' | 'FAILED';
    error: string | null;
  }): Promise<void> {
    try {
      await this.prisma.notificationLog.create({
        data: {
          channel: 'TELEGRAM',
          recipient: args.chatId,
          template: 'noc-alarm',
          payload: {
            chatId: args.chatId,
            textLength: args.textLength,
          },
          status: args.status,
          sentAt: args.status === 'SENT' ? new Date() : undefined,
          error: args.error ?? undefined,
        },
      });
    } catch (logErr) {
      this.logger.warn(
        `Gagal menyimpan NotificationLog (TELEGRAM/${args.status}): ${
          logErr instanceof Error ? logErr.message : String(logErr)
        }`,
      );
    }
  }

  /**
   * Kirim pesan teks ke chat NOC via Telegram Bot API.
   * Dipakai untuk alarm NOC: link down, mass LOS, kegagalan worker, dsb.
   */
  async sendMessage(text: string): Promise<void> {
    const { botToken, chatId } = this.getConfig();
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    try {
      await axios.post(
        url,
        {
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        },
        { timeout: 15000 },
      );
      await this.persistLog({
        chatId,
        textLength: text.length,
        status: 'SENT',
        error: null,
      });
      this.logger.log(`Pesan Telegram NOC terkirim ke chat ${chatId}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.persistLog({
        chatId,
        textLength: text.length,
        status: 'FAILED',
        error: message,
      });
      this.logger.error(`Gagal kirim pesan Telegram NOC: ${message}`);
      throw err;
    }
  }

  /**
   * Format alarm standar NOC lalu kirim via sendMessage.
   * Format: 🚨 <b>{title}</b>\n{body}\n🕐 {timestamp id-ID}
   */
  async sendAlarm(title: string, body: string): Promise<void> {
    const timestamp = new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
    await this.sendMessage(`🚨 <b>${escapeHtml(title)}</b>\n${escapeHtml(body)}\n🕐 ${timestamp}`);
  }
}
