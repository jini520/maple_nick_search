/** 넥슨 오픈 API 호출당 초당 상한 (문서 기준) */
export const NEXON_MAX_REQUESTS_PER_SECOND = 500;

/**
 * 토큰 버킷: 용량만큼 즉시 쓸 수 있고, 초당 `refillPerSecond`만큼 다시 채워진다.
 * 슬라이딩 1초 창보다 **응답이 빠를 때 다음 요청을 더 일찍**보낼 수 있어 처리량이 좋아진다.
 * `acquire()`는 직렬화되어 토큰 차감이 경쟁 상태 없이 이뤄진다.
 */
export class TokenBucketLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefillMs: number;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    capacity = NEXON_MAX_REQUESTS_PER_SECOND,
    refillPerSecond = NEXON_MAX_REQUESTS_PER_SECOND
  ) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMs = refillPerSecond / 1000;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const delta = Math.max(0, now - this.lastRefillMs);
    this.lastRefillMs = now;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + delta * this.refillPerMs
    );
  }

  private async takeOne(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const need = 1 - this.tokens;
      const waitMs = Math.ceil(need / this.refillPerMs);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(1000, Math.max(1, waitMs)))
      );
    }
  }

  acquire(): Promise<void> {
    const job = this.chain.then(() => this.takeOne());
    this.chain = job.catch(() => {});
    return job;
  }
}
