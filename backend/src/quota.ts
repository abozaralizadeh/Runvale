export class QuotaError extends Error {}

// Counts uses per UTC day, in memory. A restart resets the count, which is fine for a fair-use cap.
export class DailyQuota {
  private day = '';
  private total = 0;
  private readonly perIp = new Map<string, number>();

  constructor(
    private readonly what: string,
    private readonly perIpCap: number,
    private readonly totalCap: number,
  ) {}

  take(ip: string) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.total = 0;
      this.perIp.clear();
    }
    const used = this.perIp.get(ip) ?? 0;
    if (used >= this.perIpCap) throw new QuotaError(`You've used today's ${this.perIpCap} ${this.what}. Try again tomorrow.`);
    if (this.total >= this.totalCap) throw new QuotaError(`This server has hit today's limit for ${this.what}. Try again tomorrow.`);
    this.perIp.set(ip, used + 1);
    this.total++;
  }
}
