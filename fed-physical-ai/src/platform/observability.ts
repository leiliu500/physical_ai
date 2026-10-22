export class Metrics {
  requests = 0;
  errors = 0;
  denied = 0;
  telemetry = 0;
  durationMs = 0;
  render(ready: boolean, revision: number): string {
    const metrics: Record<string, number> = {
      reserve_http_requests_total: this.requests,
      reserve_http_errors_total: this.errors,
      reserve_access_denied_total: this.denied,
      reserve_telemetry_accepted_total: this.telemetry,
      reserve_http_duration_seconds_sum: this.durationMs / 1000,
      reserve_controller_ready: ready ? 1 : 0,
      reserve_state_revision: revision,
    };
    return (
      Object.entries(metrics)
        .map(
          ([k, v]) =>
            `# TYPE ${k} ${k.endsWith('_total') || k.endsWith('_sum') ? 'counter' : 'gauge'}\n${k} ${v}`,
        )
        .join('\n') + '\n'
    );
  }
}
export class RateLimiter {
  private buckets = new Map<string, { count: number; reset: number }>();
  constructor(
    private maximum: number,
    private capacity = 10000,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    for (const [k, b] of this.buckets) if (b.reset <= now) this.buckets.delete(k);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.capacity) return false;
      bucket = { count: 0, reset: now + 60000 };
      this.buckets.set(key, bucket);
    }
    return ++bucket.count <= this.maximum;
  }
}
export function logger(
  level: 'info' | 'error' | 'silent',
): (record: Record<string, unknown>) => void {
  return (record) => {
    if (level === 'silent' || (level === 'error' && record.level !== 'error')) return;
    process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n');
  };
}
