// Development-only OTP cache: one unreferenced timer and a hard capacity limit.
export class OtpStore {
  private entries = new Map<string, { code: string; expiresAt: number }>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private capacity = 10_000) {
    this.timer = setInterval(() => this.prune(), 30_000);
    this.timer.unref();
  }
  private prune() {
    const now = Date.now();
    for (const [phone, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(phone);
  }
  set(phone: string, entry: { code: string; expiresAt: number }) {
    this.prune();
    this.entries.delete(phone);
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(phone, entry);
  }
  delete(phone: string) {
    this.entries.delete(phone);
  }
  snapshot() {
    this.prune();
    return [...this.entries].map(([phone, entry]) => ({
      phone,
      code: entry.code,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    }));
  }
  close() {
    clearInterval(this.timer);
    this.entries.clear();
  }
}
